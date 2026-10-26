/**
 * Factory for the `propose_index` mutation resolver: the signed approval of an
 * index recommendation, or a direct index change, under the index capability.
 *
 * - `add` appends a declared index to a proposed type's TypeProposal row and
 *   reinstalls the type; storage builds it in the background after commit.
 * - `orderedBy` sets a proposed type's natural order the same way, and storage
 *   swaps its derived indexes.
 * - `remove` drops an engine-owned, non-unique index the engine no longer
 *   wants, on any type (`Dataset.dropEngineIndex`, which re-checks it live).
 *   An index wanted only because a proposed type's `indexesJson` declares it
 *   is retracted first: the declaration leaves the row, peers are told, and
 *   the index is dropped.
 * - `dismiss` closes a recommendation without acting on it.
 *
 * A referenced `_system/IndexRecommendation` must be `open`, and moves to
 * `accepted` or `dismissed` by a conditional update from `open`, claimed
 * before the audit event and the effect and given back (to `open`) if the
 * effect fails, so a caller never learns it was closed after its own effect. Its rows are
 * writable by any index-capability holder, so nothing in one is trusted: an
 * `add` must still be unserved by the type's index plan (as the advisor's
 * supersede pass decides) and its declaration validates as a direct one does;
 * `remove` is checked against the catalog. When that evidence no longer
 * holds the call is refused `recommendation_stale` and the row superseded.
 *
 * Every write here goes through the namespaces' base datasets, outside the
 * caller's transaction: a `DROP INDEX CONCURRENTLY` cannot run beside it, and
 * a superseded mark must outlive the refusal that rolls the transaction back.
 * Each one is stamped with the caller's identity.
 *
 * Audit: every applied call writes one `_system/AuditEvent` (`index_proposed`)
 * once its checks have passed and before its first effect (for a drop, under
 * the table lock, just before `DROP INDEX`), so no effect lands unaudited. For
 * a recommendation the event's id derives from the recommendation's, written
 * insert-only, so a retry after a partial failure converges without a second
 * event.
 */

import { randomUUID } from 'node:crypto';
import { planServesShape, uuidFromName } from '@mnmal-ai/substrate-compose';
import { RESERVED_AUTOCRUD_FIELD_NAMES, resolveIdentity } from '@mnmal-ai/substrate-sdk';
import type {
  ActorIdentity,
  Dataset,
  IndexDecl,
  OrderedBy,
  RequestContext,
  ResolverArgs,
  Row
} from '@mnmal-ai/substrate-types';
import {
  applyTypeIndexOptions,
  assertValidTypeIndexOptions,
  sameJson,
  type TypeIndexOptions,
  typeIndexOptionsOf
} from './apply.js';
import type { PubSub } from './config.js';
import { ensureStorageAfterCommit, notifyAfterCommit } from './engine-write.js';
import { ProposalError, type ProposalErrorCode } from './errors.js';
import { proposalLockKey, withProposalLock } from './proposal-lock.js';
import type { NamespaceBinding, RegistryStore } from './registry-store.js';

const SYSTEM_NAMESPACE = '_system';
const RECOMMENDATION_TYPE = 'IndexRecommendation';
const ACTIONS = ['add', 'remove', 'dismiss', 'orderedBy'] as const;
type IndexAction = (typeof ACTIONS)[number];

/** `dropEngineIndex` refusal codes, passed through as the call's own. */
const DROP_REFUSALS: ReadonlySet<string> = new Set([
  'unknown_index',
  'not_engine_owned',
  'unique_index',
  'still_desired'
]);

export interface ProposeIndexResolverDeps {
  registryStore: RegistryStore;
  /** Base (non-transactional) dataset of any namespace, `_system` included. */
  datasetFor: (ns: string) => Dataset | undefined;
  pubsub: PubSub;
  channelFor: (ns: string) => string;
}

export interface ProposeIndexInput {
  recommendationId?: string;
  namespace: string;
  type: string;
  action: IndexAction;
  declaration?: IndexDecl;
  orderedBy?: OrderedBy;
  indexName?: string;
  reason: string;
}

/** A read row without the engine fields reads add (`shortId`), for writing back. */
function bodyOf(row: Row): Row {
  const body = { ...row };
  for (const name of RESERVED_AUTOCRUD_FIELD_NAMES) delete body[name];
  return body;
}

function invalid(param: string, message: string): ProposalError {
  return new ProposalError('invalid_params', message, { param });
}

function closed(id: unknown, state?: unknown): ProposalError {
  return new ProposalError(
    'recommendation_closed',
    `index recommendation '${String(id)}' is no longer open${state === undefined ? '' : ` (${String(state)})`}`,
    state === undefined ? {} : { state }
  );
}

function parseInput(params: Record<string, unknown>): ProposeIndexInput {
  for (const key of ['namespace', 'type', 'reason'] as const) {
    if (typeof params[key] !== 'string' || (key !== 'reason' && params[key] === '')) {
      throw invalid(key, `'${key}' must be a${key === 'reason' ? '' : ' non-empty'} string`);
    }
  }
  if (!(ACTIONS as readonly unknown[]).includes(params.action)) {
    throw invalid('action', `'action' must be one of ${ACTIONS.join(', ')}`);
  }
  for (const key of ['recommendationId', 'indexName'] as const) {
    if (params[key] !== undefined && typeof params[key] !== 'string') {
      throw invalid(key, `'${key}' must be a string`);
    }
  }
  return params as unknown as ProposeIndexInput;
}

export function makeProposeIndexResolver(
  deps: ProposeIndexResolverDeps
): (ctx: RequestContext, args: ResolverArgs) => Promise<Row> {
  return async (ctx, args) => {
    const input = parseInput(args.params ?? {});
    // One call at a time per type, across processes when the dataset can lock.
    const lockOn = deps.datasetFor(SYSTEM_NAMESPACE) ?? args.dataset;
    const run = (): Promise<Row> => proposeIndex(deps, ctx, args, input);
    if (lockOn === undefined) return run();
    return withProposalLock(lockOn, proposalLockKey('index', input.namespace, input.type), run);
  };
}

/** What one call has to work with, shared by the action handlers. */
interface Call {
  deps: ProposeIndexResolverDeps;
  args: ResolverArgs;
  input: ProposeIndexInput;
  identity: ActorIdentity;
  rec: Row | undefined;
  /** Writes the call's audit event (once; a retry's insert is a no-op). */
  audit: (detail: Record<string, unknown>) => Promise<void>;
  /** Supersedes the recommendation, then refuses `recommendation_stale`. */
  stale: (reason: string, code?: string) => Promise<never>;
  /** Claims the recommendation (open → `state`), or refuses `recommendation_closed`. */
  claim: (state: ClosedState) => Promise<void>;
  /** Gives a claim back after a failed effect; a failed release is logged. */
  release: () => Promise<void>;
}

type ClosedState = 'accepted' | 'dismissed' | 'superseded';

async function proposeIndex(
  deps: ProposeIndexResolverDeps,
  ctx: RequestContext,
  args: ResolverArgs,
  input: ProposeIndexInput
): Promise<Row> {
  const identity = resolveIdentity(ctx);
  const system = deps.datasetFor(SYSTEM_NAMESPACE);
  const now = new Date();
  const rec = input.recommendationId === undefined ? undefined : await openRecommendation();
  async function openRecommendation(): Promise<Row> {
    const id = input.recommendationId as string;
    const row =
      system === undefined
        ? undefined
        : (await system.read(RECOMMENDATION_TYPE, { id, limit: 1 })).rows[0];
    if (row === undefined) {
      throw new ProposalError('unknown_recommendation', `no index recommendation '${id}'`);
    }
    if (row.state !== 'open') throw closed(id, row.state);
    if (row.namespace !== input.namespace || row.type !== input.type) {
      throw invalid(
        'recommendationId',
        `recommendation '${id}' is for ${row.namespace}/${row.type}`
      );
    }
    if (input.action !== 'dismiss' && row.action !== input.action) {
      throw invalid('action', `recommendation '${id}' recommends '${String(row.action)}'`);
    }
    return row;
  }

  // Derived from the recommendation, so a retry's insert finds the first one.
  const auditId =
    rec === undefined ? randomUUID() : uuidFromName(`index_proposed:${String(rec.id)}`);
  let audited: Record<string, unknown> | undefined;
  const audit = async (detail: Record<string, unknown>): Promise<void> => {
    if (audited !== undefined) return;
    audited = detail;
    await system?.write(
      'AuditEvent',
      [
        {
          id: auditId,
          ts: now.toISOString(),
          actorKid: identity.id,
          kind: 'index_proposed',
          targetKid: `${input.namespace}/${input.type}`,
          clientIp: null,
          details: {
            action: input.action,
            reason: input.reason,
            recommendationId: rec?.id ?? null,
            ...detail
          }
        }
      ],
      { identity, now, insertOnly: true }
    );
  };

  /** Moves the recommendation (if any) from `open` to `state`, atomically. */
  const close = async (state: ClosedState): Promise<void> => {
    if (rec === undefined || system === undefined) return;
    const { matched } = await system.conditionalUpdate(
      RECOMMENDATION_TYPE,
      rec.id,
      { state: 'open' },
      { state },
      identity,
      now
    );
    if (!matched) throw closed(rec.id);
  };

  // The state this call claimed the recommendation as, until it is released.
  let claimed: ClosedState | undefined;
  const claim = async (state: ClosedState): Promise<void> => {
    await close(state);
    if (rec !== undefined && system !== undefined) claimed = state;
  };
  /** Gives a claim back (claimed → open) when the work behind it failed. */
  const release = async (): Promise<void> => {
    const state = claimed;
    if (state === undefined || rec === undefined || system === undefined) return;
    claimed = undefined;
    const fail = (why: string): void => {
      process.stderr.write(
        `[substrate-proposals] index recommendation ${String(rec.id)} stays ${state} after a failed ${input.action}: ${why}\n`
      );
    };
    try {
      const { matched } = await system.conditionalUpdate(
        RECOMMENDATION_TYPE,
        rec.id,
        { state },
        { state: 'open' },
        identity,
        now
      );
      if (!matched) fail('it was changed meanwhile');
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err));
    }
  };

  const stale = async (reason: string, code?: string): Promise<never> => {
    await release();
    await close('superseded');
    throw new ProposalError(
      'recommendation_stale',
      `index recommendation '${String(rec?.id)}' no longer holds: ${reason}`,
      code !== undefined ? { reason: code } : {}
    );
  };

  // Claim, then audit, then the effect: a recommendation another writer
  // closed first is refused before anything lands, and a failed effect gives
  // its claim back.
  const call: Call = { deps, args, input, identity, rec, audit, stale, claim, release };
  try {
    switch (input.action) {
      case 'dismiss': {
        if (rec === undefined) {
          throw invalid('recommendationId', "'dismiss' needs a recommendationId");
        }
        await claim('dismissed');
        await audit({});
        break;
      }
      case 'remove': {
        await removeIndex(call, system, auditId);
        break;
      }
      case 'add':
      case 'orderedBy': {
        await changeProposedType(call);
        break;
      }
    }
  } catch (err) {
    await release();
    throw err;
  }

  return {
    id: auditId,
    action: input.action,
    namespace: input.namespace,
    type: input.type,
    recommendationId: rec?.id ?? null,
    indexName: (audited?.indexName as string | undefined) ?? null
  } as Row;
}

/** The applied, live TypeProposal row of `type`, or undefined (a code-defined type). */
async function proposalOf(binding: NamespaceBinding, type: string): Promise<Row | undefined> {
  return (
    await binding.dataset.read('TypeProposal', {
      where: {
        AND: [
          { typeName: { eq: type } },
          { applied: { eq: true } },
          { supersededByCode: { eq: false } },
          { archived: { eq: false } }
        ]
      },
      limit: 1
    })
  ).rows[0];
}

/**
 * Stores `next` on the proposal row, reinstalls the type with it, and tells
 * peers once the caller's transaction commits.
 */
async function storeTypeIndexOptions(
  call: Call,
  binding: NamespaceBinding,
  proposal: Row,
  next: TypeIndexOptions
): Promise<void> {
  const { deps, args, input, identity } = call;
  // No indexes is stored, and installed, as none at all, as replay reads it.
  const { indexes: all, ...rest } = next;
  const opts: TypeIndexOptions = { ...rest, ...(all?.length ? { indexes: all } : {}) };
  await binding.dataset.write(
    'TypeProposal',
    [
      {
        ...bodyOf(proposal),
        indexesJson: opts.indexes !== undefined ? JSON.stringify(opts.indexes) : null,
        orderedByJson: opts.orderedBy !== undefined ? JSON.stringify(opts.orderedBy) : null
      }
    ],
    { identity }
  );
  applyTypeIndexOptions({
    namespace: input.namespace,
    typeName: input.type,
    ...opts,
    registryStore: deps.registryStore,
    dataset: binding.dataset,
    edges: binding.edges
  });
  await notifyAfterCommit(args, () =>
    deps.pubsub.notify(deps.channelFor(input.namespace), String(proposal.id))
  );
}

/** `remove`: retract a proposed declaration if that is all that wants it, then drop. */
async function removeIndex(
  call: Call,
  system: Dataset | undefined,
  auditId: string
): Promise<void> {
  const { deps, input, rec } = call;
  const name = input.indexName ?? (rec?.indexName as string | null | undefined) ?? undefined;
  if (name === undefined) throw invalid('indexName', "'remove' needs an indexName");
  const dataset = deps.datasetFor(input.namespace);
  await call.claim('accepted');

  // A recommendation's evidence is that nothing wants the index; a declared
  // one is wanted, so it is not retracted on a recommendation's word.
  if (rec === undefined && dataset?.indexDeclarationOf !== undefined) {
    const owned = deps.registryStore.ownsNamespace(input.namespace);
    const binding = owned ? deps.registryStore.getBinding(input.namespace) : undefined;
    const proposal = binding === undefined ? undefined : await proposalOf(binding, input.type);
    const decl =
      proposal === undefined ? undefined : await dataset.indexDeclarationOf(input.type, name);
    const current = proposal === undefined ? {} : typeIndexOptionsOf(proposal);
    const kept = (current.indexes ?? []).filter((d) => !sameJson(d, decl));
    if (
      binding !== undefined &&
      proposal !== undefined &&
      decl !== undefined &&
      kept.length < (current.indexes ?? []).length
    ) {
      await call.audit({ indexName: name, retracted: decl });
      await storeTypeIndexOptions(call, binding, proposal, { ...current, indexes: kept });
    }
  }

  try {
    if (dataset?.dropEngineIndex === undefined) {
      throw Object.assign(new Error(`no index ${name} on ${input.namespace}/${input.type}`), {
        code: 'unknown_index'
      });
    }
    await dataset.dropEngineIndex(input.type, name, {
      beforeDrop: () => call.audit({ indexName: name })
    });
  } catch (err) {
    const code = (err as { code?: unknown }).code;
    if (typeof code !== 'string' || !DROP_REFUSALS.has(code)) throw err;
    const message = err instanceof Error ? err.message : String(err);
    if (rec !== undefined) {
      // A retry after a drop whose recommendation was not yet closed: done, not stale.
      const done =
        code === 'unknown_index' &&
        (await system?.read('AuditEvent', { id: auditId, limit: 1 }))?.rows[0] !== undefined;
      if (done) return;
      await call.stale(message, code);
    }
    await call.release();
    throw new ProposalError(code as ProposalErrorCode, message, { indexName: name });
  }
}

/** `add` or `orderedBy` on a proposed type: update its row, then its registry entry. */
async function changeProposedType(call: Call): Promise<void> {
  const { deps, args, input, rec, stale } = call;
  const { namespace: ns, type } = input;
  const codeDefined = (): ProposalError =>
    new ProposalError(
      'index_on_code_defined_type',
      `${ns}/${type} is defined in code by the plugin that owns namespace '${ns}'; ` +
        `declare its ${input.action === 'add' ? 'index' : 'orderedBy'} there`,
      { namespace: ns }
    );
  if (!deps.registryStore.ownsNamespace(ns)) throw codeDefined();
  const binding = deps.registryStore.getBinding(ns);
  const entry = binding.registry.get(type);
  if (entry?.kind !== 'type') {
    throw new ProposalError('unknown_type', `no type '${type}' in namespace '${ns}'`);
  }
  const proposal = await proposalOf(binding, type);
  if (proposal === undefined) throw codeDefined();

  const current = typeIndexOptionsOf(proposal);
  let next: TypeIndexOptions;
  let detail: Record<string, unknown>;
  if (input.action === 'add') {
    let decl: unknown = input.declaration;
    if (decl === undefined && rec !== undefined) {
      try {
        decl = JSON.parse(rec.declarationJson as string);
      } catch {
        return stale('its declaration is not JSON');
      }
    }
    if (decl === undefined) throw invalid('declaration', "'add' needs a declaration");
    const indexes = current.indexes ?? [];
    const known = indexes.some((d) => sameJson(d, decl));
    // Live evidence: the shape is still unserved. Skipped when the declaration
    // is already stored, a retry whose own index now serves it.
    if (rec !== undefined && !known) {
      const plan = (await binding.dataset.indexPlan?.(type, ns)) ?? { indexes: [] };
      const served = planServesShape(plan, String(rec.shape));
      if (served === undefined) return stale('its read shape does not parse');
      if (served) return stale('an index the type already has serves its read shape');
    }
    next = { ...current, indexes: known ? indexes : [...indexes, decl as IndexDecl] };
    detail = { declaration: decl };
  } else {
    if (input.orderedBy === undefined) {
      throw invalid('orderedBy', "'orderedBy' needs an orderedBy");
    }
    next = { ...current, orderedBy: input.orderedBy };
    detail = { orderedBy: input.orderedBy };
  }
  try {
    assertValidTypeIndexOptions(type, entry.fields, next);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (rec !== undefined) return stale(message);
    throw invalid(input.action === 'add' ? 'declaration' : 'orderedBy', message);
  }

  await call.claim('accepted');
  await call.audit(detail);
  await storeTypeIndexOptions(call, binding, proposal, next);
  ensureStorageAfterCommit(args.afterTx, binding.dataset, type);
}

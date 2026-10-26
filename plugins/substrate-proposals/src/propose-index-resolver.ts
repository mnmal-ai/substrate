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
 * - `dismiss` closes a recommendation without acting on it.
 *
 * A referenced `_system/IndexRecommendation` must be `open`, and moves to
 * `accepted` or `dismissed`. Its rows are writable by any index-capability
 * holder, so nothing in one is trusted: an `add` declaration is validated as a
 * direct one is, and `remove` is checked against the catalog. When that
 * evidence no longer holds the call is refused `recommendation_stale` and the
 * row is set `superseded`.
 *
 * Every write here goes through the namespaces' base datasets, outside the
 * caller's transaction: a `DROP INDEX CONCURRENTLY` cannot run beside it, and
 * a superseded mark must outlive the refusal that rolls the transaction back.
 * Each one is stamped with the caller's identity, and every applied call
 * writes a `_system/AuditEvent` (`index_proposed`).
 */

import { randomUUID } from 'node:crypto';
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
  type TypeIndexOptions,
  typeIndexOptionsOf
} from './apply.js';
import type { PubSub } from './config.js';
import { ensureStorageAfterCommit, notifyAfterCommit } from './engine-write.js';
import { ProposalError, type ProposalErrorCode } from './errors.js';
import { proposalLockKey, withProposalLock } from './proposal-lock.js';
import type { RegistryStore } from './registry-store.js';

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

async function proposeIndex(
  deps: ProposeIndexResolverDeps,
  ctx: RequestContext,
  args: ResolverArgs,
  input: ProposeIndexInput
): Promise<Row> {
  const identity = resolveIdentity(ctx);
  const system = deps.datasetFor(SYSTEM_NAMESPACE);
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
    if (row.state !== 'open') {
      throw new ProposalError(
        'recommendation_closed',
        `index recommendation '${id}' is already ${String(row.state)}`,
        { state: row.state }
      );
    }
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

  /** Marks the recommendation (if any) `state`, as the caller. */
  const close = async (state: 'accepted' | 'dismissed' | 'superseded'): Promise<void> => {
    if (rec === undefined || system === undefined) return;
    await system.write(RECOMMENDATION_TYPE, [{ ...bodyOf(rec), state }], { identity });
  };

  /** The recommendation's evidence no longer holds: supersede it, then refuse. */
  const stale = async (reason: string, code?: string): Promise<never> => {
    await close('superseded');
    throw new ProposalError(
      'recommendation_stale',
      `index recommendation '${String(rec?.id)}' no longer holds: ${reason}`,
      code !== undefined ? { reason: code } : {}
    );
  };

  let detail: Record<string, unknown> = {};
  switch (input.action) {
    case 'dismiss': {
      if (rec === undefined)
        throw invalid('recommendationId', "'dismiss' needs a recommendationId");
      await close('dismissed');
      break;
    }
    case 'remove': {
      const name = input.indexName ?? (rec?.indexName as string | null | undefined) ?? undefined;
      if (name === undefined) throw invalid('indexName', "'remove' needs an indexName");
      const dataset = deps.datasetFor(input.namespace);
      try {
        if (dataset?.dropEngineIndex === undefined) {
          throw Object.assign(new Error(`no index ${name} on ${input.namespace}/${input.type}`), {
            code: 'unknown_index'
          });
        }
        await dataset.dropEngineIndex(input.type, name);
      } catch (err) {
        const code = (err as { code?: unknown }).code;
        if (typeof code !== 'string' || !DROP_REFUSALS.has(code)) throw err;
        const message = err instanceof Error ? err.message : String(err);
        if (rec !== undefined) await stale(message, code);
        throw new ProposalError(code as ProposalErrorCode, message, { indexName: name });
      }
      await close('accepted');
      detail = { indexName: name };
      break;
    }
    case 'add':
    case 'orderedBy': {
      detail = await changeProposedType(deps, args, input, identity, rec, stale);
      await close('accepted');
      break;
    }
  }

  const id = randomUUID();
  await system?.write(
    'AuditEvent',
    [
      {
        id,
        ts: new Date().toISOString(),
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
    { identity }
  );
  return {
    id,
    action: input.action,
    namespace: input.namespace,
    type: input.type,
    recommendationId: rec?.id ?? null,
    indexName: (detail.indexName as string | undefined) ?? null
  } as Row;
}

/** `add` or `orderedBy` on a proposed type: update its row, then its registry entry. */
async function changeProposedType(
  deps: ProposeIndexResolverDeps,
  args: ResolverArgs,
  input: ProposeIndexInput,
  identity: ActorIdentity,
  rec: Row | undefined,
  stale: (reason: string) => Promise<never>
): Promise<Record<string, unknown>> {
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
  const proposal = (
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
    const known = indexes.some((d) => JSON.stringify(d) === JSON.stringify(decl));
    next = { ...current, indexes: known ? indexes : [...indexes, decl as IndexDecl] };
    detail = { declaration: decl };
  } else {
    if (input.orderedBy === undefined) throw invalid('orderedBy', "'orderedBy' needs an orderedBy");
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

  await binding.dataset.write(
    'TypeProposal',
    [
      {
        ...bodyOf(proposal),
        indexesJson: next.indexes !== undefined ? JSON.stringify(next.indexes) : null,
        orderedByJson: next.orderedBy !== undefined ? JSON.stringify(next.orderedBy) : null
      }
    ],
    { identity }
  );
  applyTypeIndexOptions({
    namespace: ns,
    typeName: type,
    ...next,
    registryStore: deps.registryStore,
    dataset: binding.dataset,
    edges: binding.edges
  });
  await notifyAfterCommit(args, () => deps.pubsub.notify(deps.channelFor(ns), String(proposal.id)));
  ensureStorageAfterCommit(args.afterTx, binding.dataset, type);
  return detail;
}

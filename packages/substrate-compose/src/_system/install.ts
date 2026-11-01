/**
 * `_system` namespace wire-up. Spec §5.12.
 *
 * Registers `Key`, `Invite`, `AuditEvent` and the enum-verdict type with
 * admin-gated autoCRUD. Returns a live `KeyRegistry` whose cache is
 * synchronously updated by `Key` create/update/delete/purge.
 *
 * Invalidation strategy: we wrap the `Registry` surface that
 * `installAutoCrud` writes into. The `Key` mutations get their resolver
 * replaced by a thin wrapper that awaits the underlying resolver, then calls
 * `registry.install(row)` (create/update) or `registry.evict(kid)`
 * (delete/purge), and returns the original value.
 *
 * Admin policy: every registered resolver gets
 * `and(requireCapability(adminCapability), requireNamespace('_system'))`. A
 * deployment's token must carry BOTH the admin claim AND a namespace grant
 * that covers `_system`. The per-frame engine gate already enforces the ns
 * check once a frame lands, but the policy copy makes `_system` safe against
 * any future resolver-direct call path.
 *
 * HS256 rejection: `createKey` and `updateKey`
 * fail fast with a `ResolverFrameError('hmac_not_allowed', ...)` when
 * `params.algorithm` is anything other than 'EdDSA' | 'RS256' | 'ES256'. The
 * engine catches this class and surfaces it as an envelope error with
 * `code: 'hmac_not_allowed'` (HTTP 200, `envelope.errors`), rather than the
 * generic `resolver_error` a plain Error would produce. Done in a resolver
 * pre-write rather than a policy because the check is value-dependent
 * (algorithm is a param on the frame, not a property of the identity) and
 * the client deserves a dedicated code to branch on.
 */

import { ResolverFrameError } from '@mnmal-ai/substrate-core';
import {
  and,
  decodeList,
  denyVerbs,
  grantEntryError,
  isActiveAdminKeyRow,
  or,
  requireCapability,
  requireNamespace
} from '@mnmal-ai/substrate-policy';
import { type AutoCrudResolver, installAutoCrud, resolveIdentity } from '@mnmal-ai/substrate-sdk';
import type {
  Dataset,
  EdgesStore,
  FieldDef,
  Policy,
  Registry,
  RequestContext,
  ResolverArgs,
  Row,
  WriteRow
} from '@mnmal-ai/substrate-types';
import { createKeyedMutex } from '@mnmal-ai/substrate-types';
import type { StoreProfileName } from '../advisor/profiles.js';
import { type CreateKeyRegistryOptions, createKeyRegistry, type KeyRegistry } from './registry.js';
import {
  ADVISOR_STATE_FIELDS,
  ADVISOR_STATE_TYPE,
  AUDIT_EVENT_FIELDS,
  AUDIT_EVENT_TYPE,
  type AuditEventKind,
  ENUM_VERDICT_FIELDS,
  ENUM_VERDICT_TYPE,
  INDEX_RECOMMENDATION_FIELDS,
  INDEX_RECOMMENDATION_TYPE,
  INVITE_FIELDS,
  INVITE_TYPE,
  KEY_ALGORITHMS,
  KEY_FIELDS,
  KEY_TYPE,
  STORE_PROFILE_FIELDS,
  STORE_PROFILE_ID,
  STORE_PROFILE_TYPE,
  SYSTEM_NAMESPACE
} from './types.js';

/** The capability that changes indexes: the store profile and index recommendations. */
export const INDEX_CAPABILITY = 'substrate.index';

/** Advisory-lock key held by key writes that can remove an admin. */
const KEY_WRITE_LOCK = 'substrate-system:key-write';

export interface InstallSystemNamespaceOptions {
  registry: Registry;
  dataset: Dataset;
  edges: EdgesStore;
  /**
   * Capability name that grants admin on `_system`. Matches the binary's
   * `SUBSTRATE_ADMIN_CAPABILITY` env var; defaults to the literal `'admin'` when
   * the env var is unset.
   */
  adminCapability?: string;
  /** Forwarded to `createKeyRegistry`. */
  now?: () => Date;
  onWarn?: CreateKeyRegistryOptions['onWarn'];
  /**
   * Forwarded to `createKeyRegistry` — opt-in periodic re-prime interval
   * (ms) that bounds cross-instance revocation staleness.
   * Omit / non-positive → disabled.
   */
  reprimeIntervalMs?: number;
  /** Seeds the `StoreProfile` row when it does not exist yet. Default `personal`. */
  storeProfile?: StoreProfileName;
}

export interface InstalledSystemNamespace {
  /** The `KeyRegistry` tied to this namespace's dataset. */
  keyRegistry: KeyRegistry;
}

/**
 * Wrap a `Registry` so `register` AND `replace` calls for the configured
 * mutation names route their resolver through `wrap(resolver, mutationName)`.
 * Other type names pass through untouched. `get` is a transparent passthrough.
 *
 * This is the seam autoCRUD writes into — we cannot modify the resolver after
 * the fact because `Registry.register` throws on duplicates. `replace` is
 * wrapped too so live type extension (e.g. via `applyFieldProposal`) won't
 * silently drop the wrapper.
 */
function wrapRegistryMutations(
  registry: Registry,
  interceptors: Record<string, (base: AutoCrudResolver) => AutoCrudResolver>
): Registry {
  const keyName = (key: Parameters<Registry['register']>[0]): string =>
    typeof key === 'string' ? key : key.name;

  const wrapInput = <I extends Parameters<Registry['register']>[1]>(name: string, input: I): I => {
    const interceptor = interceptors[name];
    if (interceptor === undefined) return input;
    return {
      ...input,
      // The interceptor's AutoCrudResolver shape is a structural subset of the
      // Registry resolver shape (no AsyncIterable). The cast is safe at
      // every callsite below — autoCRUD never registers stream resolvers.
      resolver: interceptor(input.resolver as AutoCrudResolver) as I['resolver']
    };
  };

  return {
    register: (key, input): void => registry.register(key, wrapInput(keyName(key), input)),
    replace: (key, input): void => registry.replace(key, wrapInput(keyName(key), input)),
    get: (key) => registry.get(key),
    has: (key): boolean => registry.has(key),
    all: () => registry.all(),
    // Must be forwarded by hand: the member is optional, so omitting it compiles
    // but silently makes the `_system` published schema uncacheable.
    get epoch(): number | undefined {
      return registry.epoch;
    }
  };
}

/**
 * Pull the `id` out of an autoCRUD resolver return shape. Covers:
 *   - `Row` (create / update merged row) — `id` is a top-level field.
 *   - `{ id, deleted }` (delete) — same.
 *   - `{ id, purged }` (purge) — same.
 *   - `null` (update miss, delete miss) — no id to invalidate.
 *
 * Arrays and `ReadResult` shapes yield null.
 */
function extractIdForInvalidation(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return null;
  if (typeof value !== 'object') return null;
  const obj = value as Record<string, unknown>;
  if ('rows' in obj) return null;
  const id = obj.id;
  if (typeof id === 'string' && id.length > 0) return id;
  return null;
}

/**
 * Hand the registry the row the resolver just returned.
 *
 * NEVER re-read here: this runs inside the writing transaction, and a read can
 * miss the uncommitted write (evicting a just-created key) or return the stale
 * pre-update row (re-caching a revoked key as live). The resolver's return
 * value is already the full post-write row.
 */
function installFromResult(
  registry: KeyRegistry,
  result: unknown,
  kid: string,
  warn: CreateKeyRegistryOptions['onWarn']
): void {
  if (result === null || typeof result !== 'object') {
    warn?.('substrate_key_registry_uninstallable_result', { kid });
    return;
  }
  if (!registry.install(result as Row)) {
    warn?.('substrate_key_registry_malformed_row', { kid });
  }
}

/**
 * Returns the `kid` field of an autoCRUD resolver result when it is a
 * non-empty string, otherwise null. Delete results (`{ id, deleted }`) carry
 * no kid, so destructive ops must pre-read the row's kid.
 */
function extractKidForInvalidation(value: unknown): string | null {
  if (value !== null && typeof value === 'object') {
    const kid = (value as Record<string, unknown>).kid;
    if (typeof kid === 'string' && kid.length > 0) return kid;
  }
  return null;
}

/**
 * Resolve the actor `kid` for an audit emit. Identity carries `kid` when the
 * bearer token matched a keyed entry (dataset Key or a file entry with
 * an explicit kid). When identity or kid is absent, fall back to the subject
 * claim (`identity.id`). An emit with no resolvable actor is a boundary
 * violation — throw so the enclosing tx rolls back rather than persisting a
 * nameless audit row.
 */
function resolveActorKid(ctx: RequestContext): string {
  const identity = ctx.identity;
  if (identity !== null) {
    const kid = identity.kid;
    if (typeof kid === 'string' && kid.length > 0) return kid;
    if (typeof identity.id === 'string' && identity.id.length > 0) return identity.id;
  }
  throw new Error('AuditEvent: actorKid is empty — audit emit without a verified identity');
}

export interface AuditEmitInput {
  actorKid: string;
  kind: AuditEventKind;
  targetKid?: string | undefined;
  clientIp?: string | undefined;
  details: Record<string, unknown>;
  now: Date;
}

/**
 * Build the AuditEvent row. Shared between the interceptor emits (which
 * write via `args.dataset` to stay in-tx) and the route emits (which write via
 * the ambient dataset post-tx). The dataset assigns the `id`.
 */
export function buildAuditRow(input: AuditEmitInput): WriteRow {
  const row: WriteRow = {
    ts: input.now.toISOString(),
    actorKid: input.actorKid,
    kind: input.kind,
    targetKid: input.targetKid ?? null,
    clientIp: input.clientIp ?? null,
    details: input.details
  };
  return row;
}

/**
 * Write an audit event inside the active tx (interceptor path). `args.dataset`
 * is engine-injected with the tx-scoped handle; using it guarantees atomicity
 * with the wrapping mutation — if this throws, the tx rolls back and the
 * original mutation never commits.
 *
 * An emit failure propagates out of the interceptor, rolling back the entire
 * frame: audit-emit failure blocks the operation.
 */
async function emitAuditInTx(
  ctx: RequestContext,
  args: ResolverArgs,
  input: AuditEmitInput
): Promise<void> {
  const dataset = args.dataset;
  if (dataset === undefined) {
    // engine-invoked paths always supply `args.dataset`; a missing handle is
    // a direct-call unit-test scenario where audit emission is out of scope.
    // Treat as a boundary failure rather than silently skipping — audit
    // emission is SYNCHRONOUS by spec.
    throw new Error('AuditEvent: args.dataset is undefined — audit emit requires a tx handle');
  }
  // Pass the substrate auto-fill hint so `_metadata.createdBy` / `updatedBy`
  // land populated from the request identity rather than null.
  await dataset.write(AUDIT_EVENT_TYPE, [buildAuditRow(input)], {
    identity: resolveIdentity(ctx),
    now: ctx.now
  });
}

/**
 * Record a `destructive_op_refused` audit row when the kill switch refuses a
 * `_system` purge. The refusal rolls back the mutate it is part of, so the row
 * is written after that transaction settles (`args.afterTx`), through the
 * install closure's `_system` dataset; called outside a transaction, it is
 * written at once. The identity hint mirrors `emitAuditInTx` so
 * `_metadata.createdBy` lands populated.
 */
async function emitRefusalAudit(
  ctx: RequestContext,
  dataset: Dataset,
  args: ResolverArgs,
  surface: string,
  targetKid: string | undefined
): Promise<void> {
  const write = async (): Promise<void> => {
    await dataset.write(
      AUDIT_EVENT_TYPE,
      [
        buildAuditRow({
          actorKid: resolveActorKid(ctx),
          kind: 'destructive_op_refused',
          targetKid,
          clientIp: ctx.clientIp,
          details: { surface, params: args.params },
          now: ctx.now
        })
      ],
      { identity: resolveIdentity(ctx), now: ctx.now }
    );
  };
  if (args.afterTx !== undefined) args.afterTx(write);
  else await write();
}

/**
 * Check whether a bootstrap event has already been recorded for this dataset.
 * Idempotent across restarts — the first live key triggers one bootstrap event
 * and subsequent composes see the prior row and no-op.
 */
async function bootstrapEventExists(dataset: Dataset): Promise<boolean> {
  // Filter server-side on `kind`: an unfiltered page scan would miss the
  // bootstrap row once the table outgrows the page, causing duplicate emits.
  const res = await dataset.read(AUDIT_EVENT_TYPE, {
    where: { kind: { eq: 'bootstrap' } },
    limit: 1
  });
  return res.rows.length > 0;
}

/**
 * Emit a bootstrap audit event iff the dataset has ≥1 Key AND no prior
 * bootstrap event exists. Idempotent — safe to call on every compose(). First
 * boot with keys → one event. Subsequent boots → no-op. Empty dataset → no-op
 * (no actor to attribute to; bootstrap is synthesised lazily once keys exist).
 */
export async function backfillBootstrapAuditIfNeeded(dataset: Dataset): Promise<void> {
  if (await bootstrapEventExists(dataset)) return;
  const keysRead = await dataset.read(KEY_TYPE, { limit: 1 });
  const firstKey = keysRead.rows[0];
  if (firstKey === undefined) return;
  const kid = firstKey.kid;
  if (typeof kid !== 'string' || kid.length === 0) {
    throw new Error(`_system/Key row ${String(firstKey.id)} has no kid`);
  }
  const name = typeof firstKey.name === 'string' ? firstKey.name : '';
  // One instant for both the body's `ts` and `_metadata.createdAt`.
  const now = new Date();
  // Auto-fill hint so `_metadata.createdBy` mirrors `actorKid: 'bootstrap'`.
  await dataset.write(
    AUDIT_EVENT_TYPE,
    [
      buildAuditRow({
        // Attributed to the bootstrap process, not the key that happened to
        // exist first.
        actorKid: 'bootstrap',
        kind: 'bootstrap',
        details: { bootKeyKid: kid, bootKeyName: name },
        now
      })
    ],
    { identity: { kind: 'system', id: 'bootstrap' }, now }
  );
}

/**
 * Throws a `ResolverFrameError` with
 * `code: 'hmac_not_allowed'` on HS256 / missing algorithm / unknown algorithm
 * so the engine surfaces a structured envelope error instead of persisting an
 * unverifiable key row. Runs inside the autoCRUD resolver's tx, so the throw
 * rolls back any partial writes for the enclosing frame.
 */
function assertAllowedAlgorithm(params: ResolverArgs['params']): void {
  const algorithm = params?.algorithm;
  if (typeof algorithm !== 'string') {
    throw new ResolverFrameError(
      'hmac_not_allowed',
      `Key: params.algorithm is required and must be one of ${[...KEY_ALGORITHMS].join(', ')}`,
      { field: 'algorithm', allowed: [...KEY_ALGORITHMS] }
    );
  }
  if (!KEY_ALGORITHMS.has(algorithm as never)) {
    throw new ResolverFrameError(
      'hmac_not_allowed',
      `Key: algorithm '${algorithm}' is not supported — symmetric algs (e.g. HS256) are rejected at the store boundary; use 'EdDSA' | 'RS256' | 'ES256'`,
      { field: 'algorithm', supplied: algorithm, allowed: [...KEY_ALGORITHMS] }
    );
  }
}

export async function installSystemNamespace(
  opts: InstallSystemNamespaceOptions
): Promise<InstalledSystemNamespace> {
  const adminCapability = opts.adminCapability ?? 'admin';
  const adminGate: Policy = and(
    requireCapability(adminCapability),
    requireNamespace(SYSTEM_NAMESPACE)
  );

  const keyRegistryOpts: CreateKeyRegistryOptions = { dataset: opts.dataset };
  if (opts.now !== undefined) keyRegistryOpts.now = opts.now;
  if (opts.onWarn !== undefined) keyRegistryOpts.onWarn = opts.onWarn;
  if (opts.reprimeIntervalMs !== undefined) {
    keyRegistryOpts.reprimeIntervalMs = opts.reprimeIntervalMs;
  }
  const keyRegistry = createKeyRegistry(keyRegistryOpts);

  // --- Key ---
  //
  // Wrap create/update/delete/purge so the cache stays coherent with the
  // dataset. The list/get paths don't mutate, so they pass through untouched.
  //
  // Audit-trail emission: `createKey` and `updateKey` emit a `AuditEvent` inside the SAME tx —
  // `args.dataset` is the tx handle, so the audit row either lands with the
  // key write or both roll back on an emit failure. `ctx.clientIp` is
  // populated by the HTTP route's `buildContext` with trust gating already
  // applied; interceptors read it verbatim (never re-apply XFF rules).
  //
  // Guards that hold whoever the caller is. The key verbs are reachable
  // through plain `mutate` as well as the `/_system/keys` routes and the CLI,
  // so these run here, in the write's own transaction: a stored grant must
  // parse (else every request bearing that kid 500s in `candidatesFor`), and
  // no write may leave zero active admins. The confirmable gates (`widen`,
  // `allowAdmin`) stay with the routes and CLI that offer the confirmation.
  const keysFor = async (args: ResolverArgs): Promise<Array<Row>> =>
    // Unpaged on purpose: a partial table silently weakens the lockout count.
    (await (args.dataset ?? opts.dataset).read(KEY_TYPE, {})).rows;
  const assertGrantParses = (row: Record<string, unknown>): void => {
    const err = grantEntryError(decodeList(row.namespaces), decodeList(row.capabilities));
    if (err !== null) {
      throw new ResolverFrameError(
        'invalid_grant_entry',
        `${err} — each entry is '<namespace>' or '<namespace>:<cap>[+<cap>...]'.`
      );
    }
  };
  const assertAdminSurvives = (rows: Array<Row>, targetId: unknown, next: Row | null): void => {
    const isAdmin = (r: Row): boolean => isActiveAdminKeyRow(r, adminCapability);
    const after = [...rows.filter((r) => r.id !== targetId), ...(next === null ? [] : [next])];
    if (rows.some(isAdmin) && !after.some(isAdmin)) {
      throw new ResolverFrameError(
        'last_active_admin',
        'refusing a key write that would leave no active admin key — rotate instead via `substrate-admin rotate`.'
      );
    }
  };
  // Serialises key writes that can remove an admin, so two concurrent revokes
  // cannot each count the other's admin as still live. On a tx-bound pg
  // dataset the lock is held until commit; the local mutex covers datasets
  // without one.
  const localKeyLock = createKeyedMutex();
  const lockedKeyWrite =
    (fn: AutoCrudResolver): AutoCrudResolver =>
    (ctx, args) => {
      const ds = args.dataset ?? opts.dataset;
      const run = () => fn(ctx, args);
      return ds.withAdvisoryLock !== undefined
        ? ds.withAdvisoryLock(KEY_WRITE_LOCK, run)
        : localKeyLock(KEY_WRITE_LOCK, run);
    };
  const isLive = (row: Row | undefined): boolean =>
    row !== undefined && row.revokedAt == null && row._deletedAt == null;

  const keyInterceptors: Record<string, (base: AutoCrudResolver) => AutoCrudResolver> = {
    createKey: (base) =>
      lockedKeyWrite(async (ctx: RequestContext, args: ResolverArgs) => {
        assertAllowedAlgorithm(args.params);
        assertGrantParses(args.params ?? {});
        // Checked under the lock, so of two concurrent registrations of one kid
        // the second sees the first (the pg unique index would refuse it as 500).
        const newKid = args.params?.kid;
        if (
          isLive(args.params as Row) &&
          (await keysFor(args)).some((r) => r.kid === newKid && isLive(r))
        ) {
          throw new ResolverFrameError(
            'kid_already_live',
            `kid '${String(newKid)}' is already registered and live — rotate or revoke it before re-registering`
          );
        }
        const result = await base(ctx, args);
        const kid = extractKidForInvalidation(result);
        if (kid !== null) {
          const params = args.params ?? {};
          await emitAuditInTx(ctx, args, {
            actorKid: resolveActorKid(ctx),
            kind: 'key_created',
            targetKid: kid,
            clientIp: ctx.clientIp,
            details: {
              name: params.name,
              capabilities: params.capabilities,
              namespaces: params.namespaces
            },
            now: ctx.now
          });
          installFromResult(keyRegistry, result, kid, opts.onWarn);
        }
        return result;
      }),
    updateKey: (base) =>
      lockedKeyWrite(async (ctx: RequestContext, args: ResolverArgs) => {
        if (args.params?.kid !== undefined) {
          throw new Error('Key.kid is immutable; rotate or re-register instead of changing kid');
        }
        // Only enforce algorithm if the update touches it — otherwise a revoke
        // (which only sets `revokedAt`) shouldn't fail on a missing algorithm.
        if (args.params?.algorithm !== undefined) {
          assertAllowedAlgorithm(args.params);
        }
        const params = args.params ?? {};
        const rows = await keysFor(args);
        const target = rows.find((r) => r.id === params.id);
        if (target !== undefined) {
          const next = { ...target, ...params } as Row;
          // Only a grant the caller supplies is checked: a stored grant that no
          // longer parses must stay revocable.
          if (params.namespaces !== undefined || params.capabilities !== undefined) {
            assertGrantParses(next);
          }
          assertAdminSurvives(rows, target.id, next);
        }
        // Decided before the write: a dataset may hand back the stored row itself.
        const wasLive = isLive(target);
        const result = await base(ctx, args);
        const kid = extractKidForInvalidation(result);
        // A rotated kid keeps its revoked rows beside the live one, and the
        // cache is keyed by kid: writing an already-revoked row through would
        // overwrite the live key.
        if (kid !== null && wasLive) {
          // Emit `key_revoked` when the update frame sets a non-empty
          // `revokedAt`. There is no prior-value probe, so re-setting an
          // already-revoked key emits a redundant event. Other updates skip it.
          const revokedAt = args.params?.revokedAt;
          if (revokedAt !== undefined && revokedAt !== null && revokedAt !== '') {
            await emitAuditInTx(ctx, args, {
              actorKid: resolveActorKid(ctx),
              kind: 'key_revoked',
              targetKid: kid,
              clientIp: ctx.clientIp,
              details: { revokedAt },
              now: ctx.now
            });
          }
          installFromResult(keyRegistry, result, kid, opts.onWarn);
        }
        return result;
      }),
    deleteKey: (base) =>
      lockedKeyWrite(async (ctx: RequestContext, args: ResolverArgs) => {
        // Pre-read the kid BEFORE delete: the result only carries { id, deleted },
        // and the cache is keyed by the kid FIELD, which can differ from the row
        // id. A pre-read row with no kid is malformed — skip eviction.
        const targetId = typeof args.params?.id === 'string' ? args.params.id : undefined;
        let kidToEvict: string | null = null;
        if (targetId !== undefined) {
          const rows = await keysFor(args);
          const target = rows.find((r) => r.id === targetId);
          assertAdminSurvives(rows, targetId, null);
          // Evict only for the live row: the kid's other rows are revoked history.
          if (isLive(target)) kidToEvict = extractKidForInvalidation(target);
        }
        const result = await base(ctx, args);
        if (kidToEvict !== null) keyRegistry.evict(kidToEvict);
        return result;
      }),
    purgeKey: (base) =>
      lockedKeyWrite(async (ctx: RequestContext, args: ResolverArgs) => {
        // Pre-read the kid BEFORE purge, as for deleteKey. If the kill
        // switch refuses, nothing was deleted and the catch below skips the
        // evict.
        const targetId = typeof args.params?.id === 'string' ? args.params.id : undefined;
        let kidToEvict: string | null = null;
        if (targetId !== undefined) {
          const ds = args.dataset ?? opts.dataset;
          const { rows } = await ds.read(KEY_TYPE, { id: targetId, includeDeleted: true });
          assertAdminSurvives(await keysFor(args), targetId, null);
          // As for deleteKey: a revoked or soft-deleted row is not the cached one.
          if (isLive(rows[0])) kidToEvict = extractKidForInvalidation(rows[0]);
        }
        try {
          const result = await base(ctx, args);
          if (kidToEvict !== null) keyRegistry.evict(kidToEvict);
          return result;
        } catch (err) {
          // Kill-switch refusal: emit `destructive_op_refused` BEFORE re-throw so
          // the engine surfaces the envelope error to the client. The re-throw
          // is load-bearing — without it the client sees a successful no-op.
          if (err instanceof ResolverFrameError && err.code === 'destructive_ops_disabled') {
            // targetKid is the key's KID, not the row UUID; a kid-less row
            // surfaces as undefined rather than mislabelling the row id.
            const targetKid = kidToEvict ?? undefined;
            await emitRefusalAudit(ctx, opts.dataset, args, 'purge_substrate_key', targetKid);
          }
          throw err;
        }
      })
  };

  const wrappedForSubstrateKey = wrapRegistryMutations(opts.registry, keyInterceptors);
  installAutoCrud(wrappedForSubstrateKey, KEY_TYPE, opts.dataset, opts.edges, {
    fields: mergeIdField(KEY_FIELDS),
    policy: adminGate,
    purgeable: true,
    adminCapability
  });

  // --- Invite ---
  //
  // No cache to keep coherent. `createInvite` emits an `invite_created`
  // event inside the same tx as the insert. The `/invites` route dispatches
  // through `engine.mutate(createInvite)`, so this interceptor is the
  // single emit site — the route must not emit too.
  const inviteInterceptors: Record<string, (base: AutoCrudResolver) => AutoCrudResolver> = {
    createInvite: (base) => async (ctx: RequestContext, args: ResolverArgs) => {
      const result = await base(ctx, args);
      const inviteId = extractIdForInvalidation(result);
      if (inviteId !== null) {
        const params = args.params ?? {};
        await emitAuditInTx(ctx, args, {
          actorKid: resolveActorKid(ctx),
          kind: 'invite_created',
          targetKid: inviteId,
          clientIp: ctx.clientIp,
          details: {
            capabilities: params.capabilities,
            namespaces: params.namespaces,
            expiresAt: params.expiresAt
          },
          now: ctx.now
        });
      }
      return result;
    },
    purgeInvite: (base) => async (ctx: RequestContext, args: ResolverArgs) => {
      try {
        return await base(ctx, args);
      } catch (err) {
        // Kill-switch refusal: emit `destructive_op_refused`, then re-throw so
        // the engine surfaces the envelope error.
        if (err instanceof ResolverFrameError && err.code === 'destructive_ops_disabled') {
          const targetKid = typeof args.params?.id === 'string' ? args.params.id : undefined;
          await emitRefusalAudit(ctx, opts.dataset, args, 'purge_substrate_invite', targetKid);
        }
        throw err;
      }
    }
  };
  const wrappedForSubstrateInvite = wrapRegistryMutations(opts.registry, inviteInterceptors);
  installAutoCrud(wrappedForSubstrateInvite, INVITE_TYPE, opts.dataset, opts.edges, {
    fields: mergeIdField(INVITE_FIELDS),
    policy: adminGate,
    purgeable: true,
    adminCapability
  });

  // --- AuditEvent ---
  //
  // Append-only audit trail. AutoCRUD installs the full CRUD
  // surface under the admin gate for operator compliance (e.g. purge when
  // retention becomes an issue); normal code paths never call update/delete —
  // interceptors and routes only ever emit via `create`.
  //
  // Kill-switch wiring: `purgeAuditEvent` is intercepted to emit a
  // `destructive_op_refused` audit row when `SUBSTRATE_HARD_DELETE=refuse`. Yes,
  // refusing-to-purge-an-audit-row writes another audit row — by design, the
  // refusal trail is itself audit-eligible. Cannot recurse: `emitRefusalAudit`
  // uses `dataset.write(...)` (a create, not a destructive op) so no gate fires.
  const auditInterceptors: Record<string, (base: AutoCrudResolver) => AutoCrudResolver> = {
    purgeAuditEvent: (base) => async (ctx: RequestContext, args: ResolverArgs) => {
      try {
        return await base(ctx, args);
      } catch (err) {
        if (err instanceof ResolverFrameError && err.code === 'destructive_ops_disabled') {
          const targetKid = typeof args.params?.id === 'string' ? args.params.id : undefined;
          await emitRefusalAudit(ctx, opts.dataset, args, 'purge_substrate_audit_event', targetKid);
        }
        throw err;
      }
    }
  };
  const wrappedForSubstrateAuditEvent = wrapRegistryMutations(opts.registry, auditInterceptors);
  installAutoCrud(wrappedForSubstrateAuditEvent, AUDIT_EVENT_TYPE, opts.dataset, opts.edges, {
    fields: mergeIdField(AUDIT_EVENT_FIELDS),
    policy: adminGate,
    purgeable: true,
    adminCapability
  });

  // --- EnumCheckVerdict ---
  //
  // Durable `substrate check-enums --record` verdicts, under the admin gate so
  // "verified" cannot be minted by anonymous callers. Upsert-by-key, not
  // append-only: one live verdict per (namespace, type, field), rewritten each
  // run. No interceptors: a purged verdict is restored by the next run.
  installAutoCrud(opts.registry, ENUM_VERDICT_TYPE, opts.dataset, opts.edges, {
    fields: mergeIdField(ENUM_VERDICT_FIELDS),
    policy: adminGate,
    purgeable: true,
    adminCapability
  });

  // --- StoreProfile, IndexRecommendation ---
  //
  // Read and changed by an admin, or by a holder of `substrate.index` on
  // `_system` (the operator or a designated reviewing agent). The advisor
  // writes recommendations through the dataset, not through these verbs.
  const indexGate: Policy = or(
    adminGate,
    and(requireCapability(INDEX_CAPABILITY), requireNamespace(SYSTEM_NAMESPACE))
  );
  installAutoCrud(opts.registry, STORE_PROFILE_TYPE, opts.dataset, opts.edges, {
    fields: mergeIdField(STORE_PROFILE_FIELDS),
    policy: indexGate,
    adminCapability
  });
  installAutoCrud(opts.registry, INDEX_RECOMMENDATION_TYPE, opts.dataset, opts.edges, {
    fields: mergeIdField(INDEX_RECOMMENDATION_FIELDS),
    policy: indexGate,
    purgeable: true,
    adminCapability
  });
  // Admins read the advisor's baseline; every write verb is refused for
  // everyone, so evidence behind a `remove` cannot be backdated by a caller.
  installAutoCrud(opts.registry, ADVISOR_STATE_TYPE, opts.dataset, opts.edges, {
    fields: mergeIdField(ADVISOR_STATE_FIELDS),
    policy: and(
      adminGate,
      denyVerbs(['create', 'update', 'delete'], 'AdvisorState is written by the index advisor only')
    ),
    adminCapability
  });
  // Seeded once: a profile changed live outlives the env var on restart.
  await opts.dataset.write(
    STORE_PROFILE_TYPE,
    [
      {
        id: STORE_PROFILE_ID,
        profile: opts.storeProfile ?? 'personal',
        updatedReason:
          opts.storeProfile === undefined ? 'default' : 'seeded from SUBSTRATE_STORE_PROFILE'
      }
    ],
    { insertOnly: true, identity: { kind: 'system', id: 'bootstrap' } }
  );

  // §5.12 bootstrap audit — idempotent across restarts. See
  // `backfillBootstrapAuditIfNeeded` for the ruleset. Fires after autoCRUD is
  // registered so a test-seeded dataset with pre-existing keys (but no audit
  // rows) gets its one-off bootstrap event lazily on first compose.
  await backfillBootstrapAuditIfNeeded(opts.dataset);

  return { keyRegistry };
}

/**
 * Prepend an explicit `id: string` field to the given field map. autoCRUD
 * treats `id` as always-present for query purposes, but we publish it into
 * the schema so clients can select it explicitly.
 */
function mergeIdField(fields: Record<string, FieldDef>): Record<string, FieldDef> {
  const idDef: FieldDef = { kind: 'scalar', type: 'string', indexed: true };
  // Object-spread order: a caller-declared `id` overrides this one.
  return { id: idDef, ...fields };
}

// Re-export Row so downstream modules that consume the install result but
// want row-shape typing don't need to cross-import from substrate-types.
export type { Row } from '@mnmal-ai/substrate-types';

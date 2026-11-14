/**
 * Shared helpers used by the propose_* resolvers.
 */

import { emitFieldEvents } from '@mnmal-ai/substrate-compose';
import {
  type Dataset,
  type EngineHandle,
  type Registry,
  type RegistryEntry,
  type RequestContext,
  type ResolverArgs,
  ResolverFrameError,
  type Row
} from '@mnmal-ai/substrate-types';
import { TRUSTED_WRITE } from './capability.js';

/**
 * Run the autoCRUD create-or-update `op` registered on `registry` inside the
 * caller's own transaction (`args.dataset`), and return the resulting row.
 * A nested `engine.mutate` would open a second transaction, and so take a
 * second pooled connection, beside the one the proposal already holds.
 *
 * @throws ResolverFrameError `policy_denied` when its policy denies
 * @throws Error when `op` is not registered or returns no row
 */
export async function writeInTx(
  registry: Registry,
  ctx: RequestContext,
  args: ResolverArgs,
  op: string,
  params: Record<string, unknown>,
  /** Skip the op's policy: the caller has already authorised the whole write. */
  skipPolicy = false,
  /** Also skip the removal gate on TypeProposal writes (see {@link TRUSTED_WRITE}). */
  trusted = false
): Promise<Row> {
  const entry = registry.get(op);
  if (entry === undefined) throw new Error(`'${op}' is not registered`);
  const opCtx: RequestContext = {
    ...ctx,
    entry: op,
    ...(entry.verb !== undefined ? { verb: entry.verb } : {})
  };
  const opArgs: ResolverArgs = { ...args, params, fields: { id: true } };
  if (trusted) (opArgs as { [TRUSTED_WRITE]?: true })[TRUSTED_WRITE] = true;
  const decision = skipPolicy ? undefined : entry.policy?.(opCtx, opArgs);
  if (decision !== undefined && !decision.allow) {
    throw new ResolverFrameError(
      'policy_denied',
      `'${op}' denied: ${decision.reason ?? 'policy denied'}`
    );
  }
  const row = await entry.resolver(opCtx, opArgs);
  if (row === null || typeof row !== 'object' || Array.isArray(row)) {
    throw new Error(`'${op}' returned no row`);
  }
  return row as Row;
}

/**
 * Run `install` against the live `registry`, and take back every entry it
 * added or replaced if it throws or the caller's transaction rolls back, so
 * the schema never outlives the proposal row that justifies it. An entry
 * something else has replaced since is left alone.
 */
export function applyUntilRollback(
  args: ResolverArgs,
  registry: Registry,
  install: () => void,
  afterUndo: () => void
): void {
  const before = new Map(registry.all());
  const changedSince = (): Array<[string, RegistryEntry]> =>
    [...registry.all()].filter(([key, entry]) => before.get(key) !== entry);
  const undo = (installed: Array<[string, RegistryEntry]>): void => {
    for (const [key, entry] of installed) {
      if (registry.get(key) !== entry) continue;
      const prior = before.get(key);
      if (prior !== undefined) registry.replace(key, prior);
      else registry.unregister?.(key);
    }
    afterUndo();
  };
  try {
    install();
  } catch (err) {
    undo(changedSince());
    throw err;
  }
  if (args.afterTx === undefined) return;
  const installed = changedSince();
  args.afterTx(async ({ committed }) => {
    if (!committed) undo(installed);
  });
}

/**
 * Run `notify` once the caller's transaction commits, so a peer reacting to it
 * reads the committed row, and skip it on a rollback. Outside a transaction
 * (no `afterTx`) it runs at once.
 */
export async function notifyAfterCommit(
  args: ResolverArgs,
  notify: () => Promise<void>
): Promise<void> {
  if (args.afterTx === undefined) {
    await notify();
    return;
  }
  args.afterTx(async ({ committed }) => {
    if (committed) await notify();
  });
}

const pendingStorage = new Set<Promise<void>>();

/** Resolves once every storage preparation started so far has settled. */
export async function storageSettled(): Promise<void> {
  await Promise.all([...pendingStorage]);
}

/** One plugin instance's background storage work, which its stop aborts and awaits. */
export interface StorageScope {
  readonly signal: AbortSignal;
  readonly pending: Set<Promise<void>>;
}

function prepareStorage(
  dataset: Dataset,
  type: string,
  handle: EngineHandle | undefined,
  scope?: StorageScope
): void {
  if (scope?.signal.aborted === true) return;
  const work = (async (): Promise<void> => {
    try {
      // A field added to a live type is held in jsonb until the promotion sweep
      // gives it a column, so no ADD COLUMN waits on a busy table here.
      const prepared = await dataset.ensureTypeStorage?.(type, {
        newFields: 'pending',
        ...(scope ? { signal: scope.signal } : {})
      });
      const pending = prepared?.pending ?? [];
      // Only what went pending: none on a store without per-type tables (F12).
      if (handle !== undefined && pending.length > 0) {
        await emitFieldEvents(
          handle,
          pending.map((field) => ({
            kind: 'field_pending' as const,
            namespace: dataset.namespace,
            type,
            field,
            attempts: 0
          }))
        ).catch((err: unknown) => {
          process.stderr.write(
            `[substrate-proposals] field_pending for ${dataset.namespace}/${type} not audited: ` +
              `${err instanceof Error ? err.message : String(err)}\n`
          );
        });
      }
    } catch (err) {
      process.stderr.write(
        `[substrate-proposals] storage for ${dataset.namespace}/${type} not prepared: ` +
          `${err instanceof Error ? err.message : String(err)}\n`
      );
    }
  })();
  pendingStorage.add(work);
  scope?.pending.add(work);
  void work.finally(() => {
    pendingStorage.delete(work);
    scope?.pending.delete(work);
  });
}

/**
 * Starts preparing `type`'s storage on the namespace's base `dataset` once the
 * caller's transaction has committed (at once when there is none), never
 * inside it: index builds run CONCURRENTLY and would wait forever on it. It
 * runs in the background, because the lock waits and index builds have no
 * bound and must not hold the caller's response; rows written meanwhile land
 * in the DEFAULT partition and are moved. A failure is logged and never
 * undoes the committed proposal; the next boot or proposal retries.
 * A field added to a type that already has a table is recorded `pending`, and
 * one `field_pending` `_system/AuditEvent` per such field is written and
 * announced through `handle` (F11, F12). {@link storageSettled} awaits it;
 * `scope`'s signal aborts it.
 */
export function ensureStorageAfterCommit(
  afterTx: ResolverArgs['afterTx'],
  dataset: Dataset,
  type: string,
  handle: EngineHandle | undefined,
  scope?: StorageScope
): void {
  if (afterTx === undefined) {
    prepareStorage(dataset, type, handle, scope);
    return;
  }
  afterTx(async ({ committed }) => {
    if (committed) prepareStorage(dataset, type, handle, scope);
  });
}

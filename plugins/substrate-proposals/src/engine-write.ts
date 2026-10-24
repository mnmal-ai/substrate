/**
 * Shared helpers used by the propose_* resolvers.
 */

import type {
  Dataset,
  Registry,
  RegistryEntry,
  RequestContext,
  ResolverArgs,
  Row
} from '@mnmal-ai/substrate-types';

/**
 * Run the autoCRUD create-or-update `op` registered on `registry` inside the
 * caller's own transaction (`args.dataset`), and return the resulting row.
 * A nested `engine.mutate` would open a second transaction, and so take a
 * second pooled connection, beside the one the proposal already holds.
 *
 * @throws Error when `op` is not registered, its policy denies, or it returns no row
 */
export async function writeInTx(
  registry: Registry,
  ctx: RequestContext,
  args: ResolverArgs,
  op: string,
  params: Record<string, unknown>
): Promise<Row> {
  const entry = registry.get(op);
  if (entry === undefined) throw new Error(`'${op}' is not registered`);
  const opCtx: RequestContext = {
    ...ctx,
    entry: op,
    ...(entry.verb !== undefined ? { verb: entry.verb } : {})
  };
  const opArgs: ResolverArgs = { ...args, params, fields: { id: true } };
  const decision = entry.policy?.(opCtx, opArgs);
  if (decision !== undefined && !decision.allow) {
    throw new Error(`'${op}' denied: ${decision.reason ?? 'policy denied'}`);
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

/**
 * Prepares `type`'s storage on the namespace's base `dataset` once the
 * caller's transaction has committed (at once when there is none), never
 * inside it: index builds run CONCURRENTLY and would wait forever on it. A
 * failure is logged and never undoes the committed proposal. The type's rows
 * stay readable meanwhile, and the next boot or proposal retries.
 */
export async function ensureStorageAfterCommit(
  afterTx: ResolverArgs['afterTx'],
  dataset: Dataset,
  type: string
): Promise<void> {
  const ensure = async (): Promise<void> => {
    try {
      await dataset.ensureTypeStorage?.(type);
    } catch (err) {
      process.stderr.write(
        `[substrate-proposals] storage for ${dataset.namespace}/${type} not prepared: ` +
          `${err instanceof Error ? err.message : String(err)}\n`
      );
    }
  };
  if (afterTx === undefined) return ensure();
  afterTx(async ({ committed }) => {
    if (committed) await ensure();
  });
}

/**
 * How a proposal row gate holds still the row it checks: found as the write
 * finds it, locked until the write's transaction ends, and, for a mutate
 * array, locked with the array's other rows in id order.
 */

import { resolveEntityRows } from '@mnmal-ai/substrate-sdk';
import {
  BatchElementError,
  type BatchResolver,
  type Id,
  type RegistryEntryResolver,
  type ResolverArgs,
  ResolverFrameError,
  type Row
} from '@mnmal-ai/substrate-types';

/** `raw` as `coerceId` takes it: a string or a number, else nothing. */
function idOf(raw: unknown): Id | undefined {
  return typeof raw === 'string' || typeof raw === 'number' ? raw : undefined;
}

/**
 * The live row of `type` that `id` names, found as the update resolver finds
 * it (`id` as `coerceId` takes it, then a raw id or a short id), locked until
 * the transaction ends and read again under the lock: a concurrent write of
 * the row has committed by then, or waits for this transaction. Null when
 * there is no such row, or no id or dataset to find it by.
 *
 * @throws ResolverFrameError `policy_denied` when the dataset can neither
 *   lock the row nor runs its transactions one at a time
 */
export async function lockedRow(
  type: string,
  id: unknown,
  dataset: ResolverArgs['dataset']
): Promise<Row | null> {
  const given = idOf(id);
  if (given === undefined || dataset === undefined) return null;
  if (dataset.lockForUpdate === undefined && dataset.serialTransactions !== true) {
    throw new ResolverFrameError(
      'policy_denied',
      `cannot hold the ${type} row still to check this write: the store neither locks rows nor runs one transaction at a time`
    );
  }
  const found = (await resolveEntityRows(dataset, type, [given]))[0] ?? null;
  if (found === null) return null;
  await dataset.lockForUpdate?.(type, [found.id]);
  return (await dataset.read(type, { id: found.id, includeDeleted: false })).rows[0] ?? null;
}

/**
 * A guarded update or delete entry's resolver for a mutate array: locks every
 * row the array names, in id order as writes lock rows, then runs each
 * element through `resolver` in turn. Each element's own check finds its row
 * already locked, so two arrays naming the same rows in different orders
 * queue rather than deadlock. Where the dataset takes no row locks, the
 * elements' own checks decide.
 *
 * @throws BatchElementError naming the element `resolver` refused
 */
export function lockedInIdOrder(type: string, resolver: RegistryEntryResolver): BatchResolver {
  return async (ctx, list) => {
    const dataset = list[0]?.dataset;
    if (dataset?.lockForUpdate !== undefined) {
      const found = await resolveEntityRows(
        dataset,
        type,
        list.map((args) => idOf(args.params?.id))
      );
      const ids = found.flatMap((row) => (row === null ? [] : [row.id]));
      if (ids.length > 0) await dataset.lockForUpdate(type, ids);
    }
    const out: Array<Row | null> = [];
    for (const [i, args] of list.entries()) {
      try {
        out.push((await resolver(ctx, args)) as Row | null);
      } catch (err) {
        throw new BatchElementError(i, err);
      }
    }
    return out;
  };
}

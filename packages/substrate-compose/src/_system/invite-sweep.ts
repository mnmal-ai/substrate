/**
 * Expired-unconsumed `Invite` reaper. Spec §5.12.
 *
 * Deletes `Invite` rows where `consumedAt IS NULL` and
 * `expiresAt < now()`. Consumed invites are kept as audit trail. Soft-delete
 * (tombstone), not hard-delete.
 *
 * Talks to the `_system` dataset directly rather than through `engine.mutate`:
 * the `deleteInvite` resolver is admin-gated and the sweep is internal
 * maintenance, not an admin request. One `tx.tombstone()` inside
 * `withTransaction` deletes every match all-or-nothing.
 *
 * Returns the number of rows deleted. The caller drives cadence.
 */

import type { Dataset } from '@mnmal-ai/substrate-types';
import { INVITE_TYPE } from './types.js';

export interface RunInviteSweepOptions {
  /** Test seam for deterministic cutoff evaluation. Defaults to `() => new Date()`. */
  now?: () => Date;
}

export interface InviteSweepResult {
  /** Count of rows soft-deleted by this call. */
  deleted: number;
}

/**
 * One reap cycle. Reads the dataset for expired-unconsumed invites, then
 * issues one transactional tombstone spanning every match. Idempotent —
 * subsequent calls on an already-swept dataset return `{ deleted: 0 }`.
 */
export async function runInviteSweep(
  dataset: Dataset,
  opts: RunInviteSweepOptions = {}
): Promise<InviteSweepResult> {
  const now = opts.now ?? ((): Date => new Date());
  const cutoff = now();

  // Filter: consumedAt IS NULL AND expiresAt < cutoff. Both fields are
  // `field.date()` in INVITE_FIELDS — date operators are in the
  // dataset's capability set (memory + pg both support `lt` / `eq: null`).
  // Unbounded read — the invite table is tiny (minted rarely) and the
  // expired window is capped by the reaper cadence.
  const { rows } = await dataset.read(INVITE_TYPE, {
    where: {
      consumedAt: { eq: null },
      expiresAt: { lt: cutoff }
    }
  });

  if (rows.length === 0) return { deleted: 0 };

  const ids = rows.map((r) => r.id as string);

  // One tombstone call inside withTransaction: either every target row gets
  // its `_deletedAt` stamped or none do. pg honours this as a single UPDATE
  // RETURNING in one tx; memory does the whole op synchronously.
  let deleted = 0;
  await dataset.withTransaction(async (tx) => {
    const result = await tx.tombstone(INVITE_TYPE, ids);
    deleted = result.deleted;
  });

  return { deleted };
}

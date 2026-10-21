/**
 * Sweep-cycle step — runs the edge sweep, then (optionally) reaps expired
 * idempotency rows, then (optionally) purges tombstoned rows + edges past
 * their retention horizon, attributing any failure to the right stage so
 * stderr logging points operators at the real source.
 *
 * The chain is a four-step sequence:
 *   1. edge-sweep — reconciles cross-ref edges (§6.3).
 *   2. idempotency-reap — drops expired §5.13 dedup rows. Skipped when no
 *      idempotency store is configured.
 *   3. tombstone-purge — hard-deletes `rows` / `edges` whose
 *      `deleted_at` is older than `SUBSTRATE_TOMBSTONE_RETENTION_DAYS`. Skipped
 *      when not pg-backed (memory mode is ephemeral).
 *   4. embeddings-gc — reaps `embeddings` and `lexical` rows whose backing
 *      `rows` row is gone or soft-deleted (no delete path touches the
 *      plugin-owned tables, so vectors and text orphan without this). Skipped
 *      when not pg-backed.
 *
 * Each step's failure is wrapped in `SweepStageError` carrying the stage
 * tag so the caller's `.catch` formats `sweep cycle failed [stage]: …`.
 * Each step is a caller-supplied thunk.
 */

import type { SweepState } from '@mnmal-ai/substrate-types';

export type SweepStage = 'edge-sweep' | 'idempotency-reap' | 'tombstone-purge' | 'embeddings-gc';

export class SweepStageError extends Error {
  override readonly name = 'SweepStageError';
  readonly stage: SweepStage;
  constructor(stage: SweepStage, cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.stage = stage;
  }
}

export interface TombstonePurgeResult {
  rows: number;
  edges: number;
}

export interface SweepCycleResult {
  state: SweepState;
  /** `reapExpired()` return value if the reap arm ran; `undefined` otherwise. */
  reap?: unknown;
  /** Tombstone-purge counts when the purge arm ran; `undefined` otherwise. */
  tombstonePurge?: TombstonePurgeResult;
  /** Orphaned-embedding count when the embeddings-gc arm ran; `undefined` otherwise. */
  embeddingsGc?: number;
}

export async function runSweepCycle(
  sweepFn: () => Promise<SweepState>,
  reapFn: (() => Promise<unknown>) | null,
  purgeFn: (() => Promise<TombstonePurgeResult>) | null = null,
  embeddingsGcFn: (() => Promise<number>) | null = null
): Promise<SweepCycleResult> {
  let nextState: SweepState;
  try {
    nextState = await sweepFn();
  } catch (err) {
    throw new SweepStageError('edge-sweep', err);
  }
  let reap: unknown;
  if (reapFn !== null) {
    try {
      reap = await reapFn();
    } catch (err) {
      throw new SweepStageError('idempotency-reap', err);
    }
  }
  let tombstonePurge: TombstonePurgeResult | undefined;
  if (purgeFn !== null) {
    try {
      tombstonePurge = await purgeFn();
    } catch (err) {
      throw new SweepStageError('tombstone-purge', err);
    }
  }
  let embeddingsGc: number | undefined;
  if (embeddingsGcFn !== null) {
    try {
      embeddingsGc = await embeddingsGcFn();
    } catch (err) {
      throw new SweepStageError('embeddings-gc', err);
    }
  }
  const result: SweepCycleResult = { state: nextState };
  if (reap !== undefined) result.reap = reap;
  if (tombstonePurge !== undefined) result.tombstonePurge = tombstonePurge;
  if (embeddingsGc !== undefined) result.embeddingsGc = embeddingsGc;
  return result;
}

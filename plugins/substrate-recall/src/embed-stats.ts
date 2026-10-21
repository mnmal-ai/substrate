/**
 * Observable counter for embed write-path outcomes. Embed failures are
 * swallowed to stderr so writes never fail on them; this counter makes them
 * visible via a snapshot (GET /embed-stats).
 *
 * Deliberately process-local: counts reset on restart.
 */

export interface EmbedStatsSnapshot {
  /** Wall-clock ISO timestamp when the counter was initialised. */
  readonly since: string;
  /** Total writes observed (success + failure + skip). */
  readonly writes: number;
  /** Writes that produced a vector AND upserted into embeddings. */
  readonly successes: number;
  /** Writes whose embedder or sql call threw. */
  readonly failures: number;
  /**
   * Writes whose `embed.source` returned the null sentinel — the row was
   * declared un-indexable, so nothing was embedded and any existing
   * embedding was removed. Neither a success nor a failure.
   */
  readonly skips: number;
  /** Most recent failure, or null when no failures have occurred since boot. */
  readonly lastFailure: { rowId: string; error: string; at: string } | null;
  /** Caught exceptions in the expansion try/catch (resolver threw or fetchEmbeddings threw). */
  readonly expansionFailures: number;
}

export interface EmbedStats {
  /** Record a successful embed → upsert cycle. */
  recordSuccess(): void;
  /** Record a failure (embedder or sql). `error` is the stringified error message. */
  recordFailure(rowId: string, error: string): void;
  /** Record a write whose source returned the null sentinel (row un-indexed). */
  recordSkip(): void;
  /** Record a caught exception in the expansion try/catch (resolver or fetchEmbeddings threw). */
  recordExpansionFailure(): void;
  /** Read-only snapshot of the current counts + last failure. */
  snapshot(): EmbedStatsSnapshot;
}

/**
 * Build a fresh EmbedStats instance. Each `createRecallPlugin(...)` call
 * gets its own counter unless one is supplied.
 */
export function createEmbedStats(now: () => Date = () => new Date()): EmbedStats {
  const since = now().toISOString();
  let writes = 0;
  let successes = 0;
  let failures = 0;
  let skips = 0;
  let expansionFailures = 0;
  let lastFailure: { rowId: string; error: string; at: string } | null = null;

  return {
    recordSuccess(): void {
      writes++;
      successes++;
    },
    recordFailure(rowId: string, error: string): void {
      writes++;
      failures++;
      lastFailure = { rowId, error, at: now().toISOString() };
    },
    recordSkip(): void {
      writes++;
      skips++;
    },
    recordExpansionFailure(): void {
      expansionFailures++;
    },
    snapshot(): EmbedStatsSnapshot {
      return { since, writes, successes, failures, skips, lastFailure, expansionFailures };
    }
  };
}

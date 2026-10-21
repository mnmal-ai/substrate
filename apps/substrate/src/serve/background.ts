/**
 * serve/background.ts — background timers: sweep, invite reaper, sentinel
 * watcher.
 */

import { runInviteSweep, SYSTEM_NAMESPACE } from '@mnmal-ai/substrate-compose';
import type { Engine, MemoryBridgeRegistry } from '@mnmal-ai/substrate-core';
import { loadSweepState, runSweep, saveSweepState } from '@mnmal-ai/substrate-core';
import type { MemoryDatasetRegistry } from '@mnmal-ai/substrate-dataset-memory';
import {
  type PgDataset,
  type PgEdgesStore,
  tryWithPgAdvisoryLock
} from '@mnmal-ai/substrate-dataset-pg';
import { makeAuthorizationProvider } from '@mnmal-ai/substrate-policy';
import { PgEmbeddingsStore, PgLexicalStore } from '@mnmal-ai/substrate-recall';
import {
  type SentinelClientConfig,
  type SentinelClientHandle,
  startSentinelClient
} from '@mnmal-ai/substrate-sentinel-client';
import type {
  Dataset,
  EdgesStore,
  IdempotencyStore,
  SweepDeps,
  SweepState
} from '@mnmal-ai/substrate-types';
import type { Sql } from 'postgres';
import { runSweepCycle, SweepStageError } from '../sweep-cycle.js';
import type { ParsedConfig } from './config.js';
import { MS_PER_DAY } from './config.js';
import type { RecallStores } from './stores.js';

/** Wall-clock one sweep tick may spend walking edge batches before it yields. */
const SWEEP_TICK_BUDGET_MS = 30_000;
const SWEEP_LOCK_KEY = 'substrate:sweep';

export interface BackgroundHandles {
  sweepTimer: NodeJS.Timeout;
  inviteSweepTimer: NodeJS.Timeout | null;
  sentinelClient: SentinelClientHandle | null;
}

export function startBackground(args: {
  config: ParsedConfig;
  sweepDeps: SweepDeps;
  idempotencyStore: IdempotencyStore | null;
  dataset: Dataset;
  edges: EdgesStore;
  storeSql: Sql | null;
  stores: Pick<RecallStores, 'recallStore' | 'lexicalStore'>;
  composedDatasets: MemoryDatasetRegistry;
  sentinelClientConfig: SentinelClientConfig | null;
  bridgeRegistry: MemoryBridgeRegistry;
  engine: Engine;
}): BackgroundHandles {
  const {
    config,
    sweepDeps,
    idempotencyStore,
    dataset,
    edges,
    storeSql,
    stores,
    composedDatasets,
    sentinelClientConfig,
    bridgeRegistry,
    engine
  } = args;
  const { recallStore, lexicalStore } = stores;

  // Tombstone purge runs on the sweep cadence when pg-backed. The purge
  // horizon is recomputed each tick so it drifts forward with wall-clock.
  const tombstoneRetentionMs = config.tombstoneRetentionDays * MS_PER_DAY;
  const pgDatasetForPurge: PgDataset | null = storeSql !== null ? (dataset as PgDataset) : null;
  const pgEdgesForPurge: PgEdgesStore | null = storeSql !== null ? (edges as PgEdgesStore) : null;

  // The cursor lives in `_system` so a restart resumes the scan where it left off.
  const cursorDataset = composedDatasets.get(SYSTEM_NAMESPACE);
  let sweepState: SweepState = { lastSweptCursor: null };
  const sweepFn = async (): Promise<SweepState> => {
    const state = cursorDataset === undefined ? sweepState : await loadSweepState(cursorDataset);
    const next = await runSweep(sweepDeps, state, undefined, SWEEP_TICK_BUDGET_MS);
    if (cursorDataset !== undefined) await saveSweepState(cursorDataset, next);
    return next;
  };
  // One cycle at a time in this process; on pg, one across every process
  // sharing the database — a tick that finds the lock held is skipped.
  let sweepRunning = false;
  const sweepTimer = setInterval(() => {
    if (sweepRunning) return;
    sweepRunning = true;
    // §5.13 — piggy-back expired-idempotency reap on the edge-sweep cadence
    // so long-running deployments don't accumulate stale rows. Sequenced
    // after the edge sweep so a single tick failure surfaces one log line.
    // A reap error is caught in the same chain and logged to stderr tagged
    // with its stage; it doesn't crash the process or prevent the next tick.
    const reapFn =
      idempotencyStore !== null
        ? (): Promise<unknown> => idempotencyStore.reapExpired() as Promise<unknown>
        : null;
    // Third stage: hard-delete tombstoned rows + edges
    // past their retention horizon. Pg-backed only; the dataset's
    // `purgeTombstonedRows` is substrate-wide so one call covers every
    // namespace's tombstones in the shared `rows` table.
    const purgeFn =
      pgDatasetForPurge !== null && pgEdgesForPurge !== null
        ? async (): Promise<{ rows: number; edges: number }> => {
            const olderThan = new Date(Date.now() - tombstoneRetentionMs);
            const rowsResult = await pgDatasetForPurge.purgeTombstonedRows({ olderThan });
            const edgesResult = await pgEdgesForPurge.purgeTombstonedEdges({ olderThan });
            return { rows: rowsResult.deleted, edges: edgesResult.deleted };
          }
        : null;
    // Fourth stage: reap embeddings and lexical rows whose backing
    // rows row is gone or soft-deleted. No delete path touches the
    // plugin-owned tables (deliberately no FK), so without this GC the
    // HNSW index accretes vectors, and `lexical` keeps the text, of deleted
    // rows forever. Sequenced after tombstone-purge so a row hard-deleted
    // this tick sheds both in the same tick. Pg-only — the in-memory stores
    // are ephemeral.
    const pgRecall = recallStore instanceof PgEmbeddingsStore ? recallStore : null;
    const pgLexical = lexicalStore instanceof PgLexicalStore ? lexicalStore : null;
    const embeddingsGcFn =
      pgRecall !== null || pgLexical !== null
        ? async (): Promise<number> =>
            ((await pgRecall?.purgeOrphans()) ?? 0) + ((await pgLexical?.purgeOrphans()) ?? 0)
        : null;
    const cycle = () => runSweepCycle(sweepFn, reapFn, purgeFn, embeddingsGcFn);
    const run =
      storeSql === null
        ? cycle()
        : tryWithPgAdvisoryLock(storeSql, SWEEP_LOCK_KEY, cycle).then((r) => {
            if (r.acquired) return r.value;
            // Another process holds the sweep lock and runs this tick.
            process.stdout.write(`sweep.skipped ${JSON.stringify({ reason: 'lock_held' })}\n`);
            return null;
          });
    run
      .then((result) => {
        if (result === null) return;
        const { state, reap, tombstonePurge, embeddingsGc } = result;
        sweepState = state;
        if (reap !== undefined) {
          process.stdout.write(`plugin.idempotency_reap ${JSON.stringify(reap)}\n`);
        }
        if (tombstonePurge !== undefined && (tombstonePurge.rows > 0 || tombstonePurge.edges > 0)) {
          process.stdout.write(`tombstone_purge ${JSON.stringify(tombstonePurge)}\n`);
        }
        if (embeddingsGc !== undefined && embeddingsGc > 0) {
          process.stdout.write(`embeddings_gc ${JSON.stringify({ orphans: embeddingsGc })}\n`);
        }
      })
      .catch((err: unknown) => {
        if (err instanceof SweepStageError) {
          process.stderr.write(`sweep cycle failed [${err.stage}]: ${err.message}\n`);
        } else {
          process.stderr.write(
            `sweep cycle failed: ${err instanceof Error ? err.message : String(err)}\n`
          );
        }
      })
      .finally(() => {
        sweepRunning = false;
      });
  }, config.sweepIntervalMs);
  sweepTimer.unref();

  // §5.12: reap expired-unconsumed SubstrateInvites when
  // auth is enabled. No auth → no invites, so the reaper has nothing to do.
  // The `_system` dataset is always registered by compose — memory-backed
  // when `substrateNamespaceDataset` was null at wire time, pg-backed otherwise.
  let inviteSweepTimer: NodeJS.Timeout | null = null;
  if (config.auth !== null) {
    const inviteDataset = composedDatasets.get(SYSTEM_NAMESPACE);
    if (inviteDataset === undefined) {
      process.stderr.write(
        `invite sweep disabled: '${SYSTEM_NAMESPACE}' dataset missing from registry\n`
      );
    } else {
      inviteSweepTimer = setInterval(() => {
        runInviteSweep(inviteDataset)
          .then((result) => {
            process.stdout.write(`plugin.invite_sweep ${JSON.stringify(result)}\n`);
          })
          .catch((err: unknown) => {
            process.stderr.write(
              `invite sweep cycle failed: ${err instanceof Error ? err.message : String(err)}\n`
            );
          });
      }, config.inviteSweepIntervalMs);
      inviteSweepTimer.unref();
    }
  }

  // §5.11 dynamic discovery: when SUBSTRATE_SENTINEL_URL is configured, start a
  // sentinel-client that watches topology events and mutates bridgeRegistry
  // in lock-step. Absent env var → no client, behave like a static deployment.
  let sentinelClient: SentinelClientHandle | null = null;
  if (sentinelClientConfig !== null) {
    sentinelClient = startSentinelClient({
      sentinelUrl: sentinelClientConfig.url,
      bridges: bridgeRegistry,
      engine,
      creds: config.bridgeCreds,
      // Sentinel's watch/register are privileged, so the client must present a
      // credential of its own — distinct from the per-bridge ones, since the
      // sentinel is a peer we talk TO rather than a namespace we bridge FROM.
      auth: makeAuthorizationProvider(sentinelClientConfig.cred),
      metric: (name, payload) => {
        process.stdout.write(`sentinel-client.${name} ${JSON.stringify(payload ?? null)}\n`);
      },
      reconnectBaseMs: sentinelClientConfig.reconnectBaseMs,
      reconnectMaxMs: sentinelClientConfig.reconnectMaxMs
    });
    process.stdout.write(`sentinel-client: watching ${sentinelClientConfig.url}\n`);
  }

  return { sweepTimer, inviteSweepTimer, sentinelClient };
}

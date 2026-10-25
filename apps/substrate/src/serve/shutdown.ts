/**
 * serve/shutdown.ts — graceful-shutdown signal wiring.
 */

import type { SentinelClientHandle } from '@mnmal-ai/substrate-sentinel-client';
import type { ParsedConfig } from './config.js';

export interface ShutdownArgs {
  config: Pick<ParsedConfig, 'shutdownGraceMs'>;
  sweepTimer: NodeJS.Timeout;
  inviteSweepTimer: NodeJS.Timeout | null;
  sentinelClient: SentinelClientHandle | null;
  disposeBridges: () => void;
  stop: (opts?: { grace?: number; abortInFlight?: boolean }) => Promise<void>;
  closeStore: (() => Promise<void>) | null;
  /** Cancels the background index builds and waits for them to stop. */
  stopIndexBuilds?: () => Promise<void>;
}

/**
 * Re-entrancy guard: systemd retries SIGTERM under load, and a double-fire
 * here would clear already-cleared timers and call `stop()` twice. The flag
 * flips on first entry and stays set; subsequent signals just log.
 */
export function installShutdown(args: ShutdownArgs): void {
  const {
    config,
    sweepTimer,
    inviteSweepTimer,
    sentinelClient,
    disposeBridges,
    stop,
    closeStore,
    stopIndexBuilds
  } = args;
  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) {
      process.stdout.write(`received ${signal} again — already shutting down\n`);
      return;
    }
    shuttingDown = true;
    process.stdout.write(
      `\nreceived ${signal} — shutting down (grace ${config.shutdownGraceMs}ms)\n`
    );
    // A step that never settles (sql.end() waits on every in-flight query) would
    // otherwise hold the process past the grace until something sends SIGKILL.
    setTimeout(() => {
      process.stderr.write('shutdown exceeded its grace; exiting with work still pending\n');
      process.exit(1);
    }, config.shutdownGraceMs + 1000).unref();
    clearInterval(sweepTimer);
    if (inviteSweepTimer !== null) clearInterval(inviteSweepTimer);
    // A cancelled CREATE INDEX CONCURRENTLY leaves an INVALID index, which
    // the next boot's reconcile drops and rebuilds.
    const stopBuilds = stopIndexBuilds?.() ?? Promise.resolve();
    const stopSentinel =
      sentinelClient !== null
        ? sentinelClient.stop().catch((err: unknown) => {
            process.stderr.write(
              `sentinel-client stop failed: ${err instanceof Error ? err.message : String(err)}\n`
            );
          })
        : Promise.resolve();
    stopSentinel
      .then(() => {
        disposeBridges();
        return stop({ grace: config.shutdownGraceMs, abortInFlight: true });
      })
      .then(async () => {
        await stopBuilds;
        if (closeStore) await closeStore();
      })
      .then(() => {
        process.exit(0);
      })
      .catch((err: unknown) => {
        process.stderr.write(
          `shutdown error: ${err instanceof Error ? err.message : String(err)}\n`
        );
        process.exit(1);
      });
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

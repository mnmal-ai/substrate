/**
 * The production `ClusterSpawn`: one Worker per pass, torn down on
 * completion.
 *
 * No pool: crystallisation is rare and worker startup is small beside a
 * CPU-bound clustering run.
 *
 * Wall-clock timeout: a hung worker would never settle, so
 * `CrystalliseGuard.runExclusive` would never clear its in-flight flag and
 * every later crystallise call would 409 for the life of the process. The
 * timeout is a runaway guard, not a performance bound, hence the generous
 * default.
 */

import { Worker } from 'node:worker_threads';
import type { ClusterSpawn, ClusterWorkerRequest } from './run-clusterer.js';

interface WorkerReply {
  ok: boolean;
  assignments?: Int32Array;
  message?: string;
}

export interface SpawnClusterWorkerOptions {
  /** Wall-clock ceiling on one worker pass. See the module doc. */
  timeoutMs?: number;
}

/**
 * 10 minutes. A guard rail to catch a hung worker, not a cap on a
 * slow-but-legitimate pass.
 */
export const DEFAULT_CLUSTER_WORKER_TIMEOUT_MS = 10 * 60_000;

export function createSpawnClusterWorker(opts: SpawnClusterWorkerOptions = {}): ClusterSpawn {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_CLUSTER_WORKER_TIMEOUT_MS;

  return (payload: ClusterWorkerRequest) =>
    new Promise<Int32Array>((resolve, reject) => {
      const worker = new Worker(new URL('./cluster-worker.js', import.meta.url));
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;

      const finish = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        void worker.terminate();
        fn();
      };

      // Unref'd: a pending timeout must not itself keep the process alive —
      // only the worker's own event loop presence should do that.
      timer = setTimeout(() => {
        finish(() =>
          reject(
            new Error(
              `cluster worker exceeded ${timeoutMs}ms without replying — terminated to release the crystallise guard`
            )
          )
        );
      }, timeoutMs);
      timer.unref?.();

      worker.on('message', (reply: WorkerReply) => {
        finish(() => {
          if (reply.ok && reply.assignments !== undefined) {
            resolve(reply.assignments);
            return;
          }
          reject(new Error(reply.message ?? 'cluster worker failed without a message'));
        });
      });
      worker.on('error', (err) => finish(() => reject(err)));
      worker.on('exit', (code) =>
        finish(() => reject(new Error(`cluster worker exited with code ${code} before replying`)))
      );

      try {
        // `flat` is transferred, not copied — the caller has no further use
        // for the buffer. The cast is safe: `run-clusterer.ts` always builds
        // `flat` via `new Float32Array(...)`, so it is never a
        // SharedArrayBuffer (which isn't Transferable).
        worker.postMessage(payload, [payload.flat.buffer as ArrayBuffer]);
      } catch (err) {
        // Route a synchronous throw (e.g. a clone/transfer failure) through
        // `finish` so the worker still gets terminated.
        finish(() => reject(err instanceof Error ? err : new Error(String(err))));
      }
    });
}

export const spawnClusterWorker: ClusterSpawn = createSpawnClusterWorker();

import { Worker } from 'node:worker_threads';
import { describe, expect, it } from 'vitest';

const WORKER_SRC = new URL('../src/cluster-worker.ts', import.meta.url).pathname;
const LOADER = new URL('./ts-extension-loader.mjs', import.meta.url).pathname;

/** Three well-separated blobs — the shape every backend agrees on. */
function blobs(): Float32Array[] {
  const vectors: Float32Array[] = [];
  for (let blob = 0; blob < 3; blob++) {
    for (let i = 0; i < 30; i++) {
      const v = new Float32Array(8);
      v[blob * 2] = 10.0;
      v[7] = i * 0.01;
      vectors.push(v);
    }
  }
  return vectors;
}

function flatten(vectors: Float32Array[]): { flat: Float32Array; rows: number; dims: number } {
  const dims = vectors[0]!.length;
  const flat = new Float32Array(vectors.length * dims);
  for (let i = 0; i < vectors.length; i++) flat.set(vectors[i]!, i * dims);
  return { flat, rows: vectors.length, dims };
}

async function runInWorker(
  vectors: Float32Array[],
  onTick?: () => void
): Promise<{ assignments: number[]; ticks: number }> {
  const worker = new Worker(WORKER_SRC, {
    execArgv: ['--experimental-strip-types', '--import', LOADER]
  });
  let ticks = 0;
  const timer = setInterval(() => {
    ticks++;
    onTick?.();
  }, 5);

  try {
    const reply = await new Promise<{ ok: boolean; assignments?: Int32Array; message?: string }>(
      (resolve, reject) => {
        worker.on('message', resolve);
        worker.on('error', reject);
        worker.postMessage({
          ...flatten(vectors),
          params: { nComponents: 0, nNeighbors: 15, minClusterSize: 5, seed: 42 }
        });
      }
    );
    if (!reply.ok) throw new Error(reply.message ?? 'worker reported failure');
    return { assignments: Array.from(reply.assignments ?? []), ticks };
  } finally {
    clearInterval(timer);
    await worker.terminate();
  }
}

describe('cluster-worker', () => {
  it('clusters inside a Worker with no top-level side effects', async () => {
    const { assignments } = await runInWorker(blobs());
    expect(new Set(assignments.filter((l) => l >= 0)).size).toBe(3);
  }, 60_000);

  /**
   * The calling thread's 5ms timer must keep firing while the wasm kNN runs.
   * A run that blocked the event loop would produce zero ticks.
   */
  it('does not block the calling thread while it runs', async () => {
    const { ticks } = await runInWorker(blobs());
    expect(ticks).toBeGreaterThan(0);
  }, 60_000);

  it('reports a clusterer failure as a message rather than crashing the worker', async () => {
    // Rejected by the validator's `rows < max(minClusterSize, 2)` check (2 rows
    // against minClusterSize 5); the oversized nNeighbors is incidental. Any
    // clusterer rejection must reach the caller as `{ ok: false, message }`.
    const worker = new Worker(WORKER_SRC, {
      execArgv: ['--experimental-strip-types', '--import', LOADER]
    });
    try {
      const reply = await new Promise<{ ok: boolean; message?: string }>((resolve, reject) => {
        worker.on('message', resolve);
        worker.on('error', reject);
        worker.postMessage({
          ...flatten([new Float32Array([1, 0]), new Float32Array([0, 1])]),
          params: { nComponents: 0, nNeighbors: 500, minClusterSize: 5, seed: 42 }
        });
      });
      expect(reply.ok).toBe(false);
      expect(reply.message).toBeTruthy();
    } finally {
      await worker.terminate();
    }
  }, 60_000);
});

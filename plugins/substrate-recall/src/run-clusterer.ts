/**
 * Marshalling + worker orchestration for a clustering pass.
 *
 * The `spawn` seam keeps this module testable in-process: the flattening,
 * validation and result-shape checks are ordinary unit-tested code, and the
 * real `worker_threads` boundary is exercised separately by
 * `test/cluster-worker-isolation.test.ts`.
 */

import { spawnClusterWorker } from './spawn-cluster-worker.js';

export interface ClusterRunParams {
  /** 0 = skip reduction (holomap protocol convention). */
  nComponents: number;
  nNeighbors: number;
  minClusterSize: number;
  seed: number;
}

export interface ClusterWorkerRequest {
  /** Row-major flattened vectors — one copy, negligible beside an O(N²·d) kNN. */
  flat: Float32Array;
  rows: number;
  dims: number;
  params: ClusterRunParams;
}

export type ClusterSpawn = (payload: ClusterWorkerRequest) => Promise<Int32Array>;

export interface RunClustererDeps {
  spawn?: ClusterSpawn;
}

export async function runClusterer(
  vectors: readonly Float32Array[],
  params: ClusterRunParams,
  deps: RunClustererDeps = {}
): Promise<number[]> {
  if (vectors.length === 0) return [];
  const dims = vectors[0]!.length;
  for (const [i, v] of vectors.entries()) {
    if (v.length !== dims) {
      throw new Error(
        `runClusterer: vector ${i} has dimension ${v.length}, expected ${dims} — ` +
          `every candidate must come from the same embedder model`
      );
    }
  }

  const flat = new Float32Array(vectors.length * dims);
  for (let i = 0; i < vectors.length; i++) flat.set(vectors[i]!, i * dims);

  const spawn = deps.spawn ?? spawnClusterWorker;
  const assignments = await spawn({ flat, rows: vectors.length, dims, params });

  if (assignments.length !== vectors.length) {
    throw new Error(
      `runClusterer: assignment count ${assignments.length} != input count ${vectors.length}`
    );
  }
  return Array.from(assignments);
}

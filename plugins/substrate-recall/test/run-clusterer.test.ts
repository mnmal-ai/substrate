import { describe, expect, it, vi } from 'vitest';
import type { ClusterWorkerRequest } from '../src/run-clusterer.js';
import { runClusterer } from '../src/run-clusterer.js';

const PARAMS = { nComponents: 10, nNeighbors: 15, minClusterSize: 5, seed: 42 };

describe('runClusterer', () => {
  it('flattens vectors row-major and reports dimensions', async () => {
    let seen: ClusterWorkerRequest | undefined;
    const spawn = async (payload: ClusterWorkerRequest): Promise<Int32Array> => {
      seen = payload;
      return new Int32Array([0, 1]);
    };

    await runClusterer([new Float32Array([1, 2, 3]), new Float32Array([4, 5, 6])], PARAMS, {
      spawn
    });

    expect(seen?.rows).toBe(2);
    expect(seen?.dims).toBe(3);
    expect(Array.from(seen?.flat ?? [])).toEqual([1, 2, 3, 4, 5, 6]);
    expect(seen?.params).toEqual(PARAMS);
  });

  it('returns assignments as a plain number array', async () => {
    const spawn = async (): Promise<Int32Array> => new Int32Array([0, -1, 0]);
    const out = await runClusterer(
      [new Float32Array([1, 0]), new Float32Array([0, 1]), new Float32Array([1, 0])],
      PARAMS,
      { spawn }
    );
    expect(out).toEqual([0, -1, 0]);
  });

  it('returns an empty assignment list without spawning for empty input', async () => {
    const spawn = vi.fn();
    expect(await runClusterer([], PARAMS, { spawn })).toEqual([]);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('refuses ragged input', async () => {
    const spawn = async (): Promise<Int32Array> => new Int32Array([0]);
    await expect(
      runClusterer([new Float32Array([1, 2]), new Float32Array([1])], PARAMS, { spawn })
    ).rejects.toThrow(/dimension/i);
  });

  it('refuses an assignment count that disagrees with the input count', async () => {
    const spawn = async (): Promise<Int32Array> => new Int32Array([0]);
    await expect(
      runClusterer([new Float32Array([1, 0]), new Float32Array([0, 1])], PARAMS, { spawn })
    ).rejects.toThrow(/assignment count 1 != input count 2/);
  });
});

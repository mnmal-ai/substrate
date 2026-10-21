import { describe, expect, it } from 'vitest';
import { createRuntimeStats } from '../src/runtime-stats.js';

// Best of five: load from other processes only ever adds time, so the fastest
// run is the truest cost, and a real regression still slows every run.
function fastestMs(run: () => void): number {
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < 5; i++) {
    const start = performance.now();
    run();
    best = Math.min(best, performance.now() - start);
  }
  return best;
}

describe('RuntimeStats overhead', () => {
  it('recordResolve mean under 50 µs per observation (about 2 µs locally)', () => {
    const stats = createRuntimeStats({ activeSubscriptions: () => 0 });
    const numKeys = 100;
    const numObservations = 40_000;
    const keys = Array.from({ length: numKeys }, (_, i) => `ns/Type_${i}`);

    const totalMs = fastestMs(() => {
      for (let i = 0; i < numObservations; i++) {
        const key = keys[i % keys.length]!;
        stats.recordResolve({
          key,
          kind: i % 2 === 0 ? 'query' : 'mutate',
          durationMs: Math.random() * 100,
          ok: Math.random() > 0.05
        });
      }
    });

    expect((totalMs * 1000) / numObservations).toBeLessThan(50);
  });

  it('snapshot() on full 512-key table under 50 ms', () => {
    const stats = createRuntimeStats({ activeSubscriptions: () => 0 });
    const numKeys = 512;
    const keysPerKey = 391; // 200k / 512 ≈ 391

    // Fill the table to 512 keys
    for (let key = 0; key < numKeys; key++) {
      for (let i = 0; i < keysPerKey; i++) {
        stats.recordResolve({
          key: `ns/Type_${key}`,
          kind: i % 2 === 0 ? 'query' : 'mutate',
          durationMs: Math.random() * 100,
          ok: true
        });
      }
    }

    let snapshot = stats.snapshot();
    const totalMs = fastestMs(() => {
      snapshot = stats.snapshot();
    });
    expect(totalMs).toBeLessThan(50);
    expect(snapshot.resolvers).toBeDefined();
    // Should have roughly 512 keys (or close to it due to LRU)
    expect(Object.keys(snapshot.resolvers!).length).toBeGreaterThan(400);
  });
});

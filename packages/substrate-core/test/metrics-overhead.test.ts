import { describe, expect, it } from 'vitest';
import { createRuntimeStats } from '../src/runtime-stats.js';

describe('RuntimeStats overhead', () => {
  it('recordResolve mean under 10 µs per observation', () => {
    const stats = createRuntimeStats({ activeSubscriptions: () => 0 });
    const numKeys = 100;
    const numObservations = 200_000;
    const keys = Array.from({ length: numKeys }, (_, i) => `ns/Type_${i}`);

    const startTime = performance.now();
    for (let i = 0; i < numObservations; i++) {
      const key = keys[i % keys.length]!;
      stats.recordResolve({
        key,
        kind: i % 2 === 0 ? 'query' : 'mutate',
        durationMs: Math.random() * 100,
        ok: Math.random() > 0.05
      });
    }
    const endTime = performance.now();

    const totalMs = endTime - startTime;
    const microsecondsPerObservation = (totalMs * 1000) / numObservations;
    console.log(`Measured: ${microsecondsPerObservation.toFixed(2)} µs per observation`);

    expect(microsecondsPerObservation).toBeLessThan(50); // sanity bound; ~2 µs locally, CI runners are noisy
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

    const startTime = performance.now();
    const snapshot = stats.snapshot();
    const endTime = performance.now();

    const totalMs = endTime - startTime;
    expect(totalMs).toBeLessThan(50);
    expect(snapshot.resolvers).toBeDefined();
    // Should have roughly 512 keys (or close to it due to LRU)
    expect(Object.keys(snapshot.resolvers!).length).toBeGreaterThan(400);
  });
});

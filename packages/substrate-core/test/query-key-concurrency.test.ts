import { MemoryDataset, MemoryDatasetRegistry } from '@mnmal-ai/substrate-dataset-memory';
import { describe, expect, it } from 'vitest';
import { Engine, MemoryEdgesStore, type NamespaceConfig, Registry } from '../src/index.js';

describe('query key fan-out', () => {
  it('bounds how many keys of one frame run at once, and still answers every key', async () => {
    const datasets = new MemoryDatasetRegistry();
    datasets.set('a', new MemoryDataset({ namespace: 'a' }));
    const registry = new Registry();
    let inFlight = 0;
    let peak = 0;
    const frame: Record<string, { params: Record<string, unknown> }> = {};
    for (let i = 0; i < 100; i++) {
      registry.register(`T${i}`, {
        resolver: async () => {
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          await new Promise<void>((r) => setImmediate(r));
          inFlight -= 1;
          return [];
        }
      });
      frame[`a/T${i}`] = { params: {} };
    }
    const engine = new Engine({
      namespaces: new Map<string, NamespaceConfig>([['a', { registry }]]),
      datasets,
      edges: new MemoryEdgesStore({ now: () => new Date('2026-04-18T00:00:00Z') })
    });

    const env = await engine.query({ frame, ctx: { identity: null } });

    expect(Object.keys(env.data)).toHaveLength(100);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(16);
  });
});

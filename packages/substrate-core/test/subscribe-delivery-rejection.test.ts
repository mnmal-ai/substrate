/**
 * The engine does not await the snapshot frame. A transport whose `onFrame`
 * rejects on it ends the subscription with an error frame and a metric rather
 * than leaving an unhandled rejection behind.
 */

import { MemoryDataset, MemoryDatasetRegistry } from '@mnmal-ai/substrate-dataset-memory';
import type { WsResponseFrame } from '@mnmal-ai/substrate-types';
import { expect, it } from 'vitest';
import { Engine, MemoryEdgesStore, type NamespaceConfig, Registry } from '../src/index.js';

it('ends the subscription when the snapshot delivery rejects', async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (e: unknown): void => {
    unhandled.push(e);
  };
  process.on('unhandledRejection', onUnhandled);
  try {
    const datasets = new MemoryDatasetRegistry();
    datasets.set('app', new MemoryDataset({ namespace: 'app' }));
    const registry = new Registry();
    registry.register('Thing', { kind: 'type', resolver: async () => [{ id: 1 }] });
    const metrics: string[] = [];
    const engine = new Engine({
      namespaces: new Map<string, NamespaceConfig>([['app', { registry }]]),
      datasets,
      edges: new MemoryEdgesStore({ now: () => new Date() }),
      metric: (name) => {
        metrics.push(name);
      }
    });
    const frames: WsResponseFrame[] = [];
    await engine.subscribe({
      id: 's1',
      frame: { 'app/Thing': { fields: { id: true } } },
      ctx: { identity: null },
      onFrame: async (f) => {
        frames.push(f);
        if (f.kind === 'snapshot') throw new Error('encode failed');
      }
    });
    await new Promise((r) => setTimeout(r, 20));

    expect(unhandled).toEqual([]);
    expect(frames.map((f) => f.kind)).toEqual(['snapshot', 'error']);
    expect(frames[1]?.errors?.[0]?.code).toBe('snapshot_delivery_failed');
    expect(metrics).toContain('engine_frame_delivery_rejected');
    expect(engine.activeSubscriptionCount()).toBe(0);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

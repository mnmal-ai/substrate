/**
 * Walks are not pushed in v1 (typed edge walks spec, Non-goals): a
 * subscription or stream naming any walk-grammar construct is refused
 * `walks_in_subscription` before registration.
 */

import { MemoryDataset, MemoryDatasetRegistry } from '@mnmal-ai/substrate-dataset-memory';
import type { WsResponseFrame } from '@mnmal-ai/substrate-types';
import { describe, expect, it } from 'vitest';
import { Engine, MemoryEdgesStore, type NamespaceConfig, Registry } from '../src/index.js';

function buildEngine(): Engine {
  const datasets = new MemoryDatasetRegistry();
  datasets.set('ns', new MemoryDataset({ namespace: 'ns', walkReference: true }));
  const registry = new Registry();
  registry.register('Part', {
    kind: 'type',
    fields: { thing: { kind: 'crossRef', ns: 'ns', type: 'Thing', onDelete: 'set_null' } },
    resolver: async () => []
  });
  registry.register('Thing', { kind: 'type', fields: {}, resolver: async () => [] });
  return new Engine({
    namespaces: new Map<string, NamespaceConfig>([['ns', { registry }]]),
    datasets,
    edges: new MemoryEdgesStore({ now: () => new Date('2026-10-30T00:00:00Z') }),
    walksEnabled: true
  });
}

async function subscribe(
  engine: Engine,
  entry: Record<string, unknown>
): Promise<WsResponseFrame[]> {
  const frames: WsResponseFrame[] = [];
  await engine.subscribe({
    id: 'sub',
    frame: { 'ns/Thing': entry },
    ctx: {},
    onFrame: (f) => void frames.push(f)
  });
  return frames;
}

describe('subscribe — walks', () => {
  it('subscribe with a _walk is refused walks_in_subscription', async () => {
    const engine = buildEngine();
    const frames = await subscribe(engine, {
      params: { where: { _walk: { in: 'ns/Part.thing' } } },
      fields: { id: true }
    });
    expect(frames[0]?.kind).toBe('error');
    expect(frames[0]?.errors?.[0]).toMatchObject({
      code: 'walks_in_subscription',
      path: ['ns/Thing', 'where', '_walk']
    });
    expect(engine.activeSubscriptionCount()).toBe(0);
  });

  it('refuses a nested selection the same way', async () => {
    const engine = buildEngine();
    const frames = await subscribe(engine, {
      fields: { id: true, parts: { _walk: { in: 'ns/Part.thing' }, fields: { id: true } } }
    });
    expect(frames[0]?.errors?.[0]?.code).toBe('walks_in_subscription');
    expect(engine.activeSubscriptionCount()).toBe(0);
  });
});

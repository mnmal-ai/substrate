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
    edges: new MemoryEdgesStore({ now: () => new Date('2026-10-30T00:00:00Z') })
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

  it('a param merely named like a walk param is an unknown param, not a walk (#1951)', async () => {
    // _allowTableScan was accepted and ignored before 1.0.0-beta.1 (#1955).
    for (const k of ['count', 'aggregate', 'groupBy', 'having', 'offset', '_allowTableScan']) {
      const engine = buildEngine();
      const frames = await subscribe(engine, { params: { [k]: true }, fields: { id: true } });
      expect(frames[0]?.errors?.[0]).toMatchObject({
        code: 'unknown_param',
        path: ['ns/Thing', 'params', k]
      });
    }
  });
});

describe('stream — walks', () => {
  it('a stream with a _walk is refused walks_in_subscription, then ends', async () => {
    const engine = buildEngine();
    const frames: WsResponseFrame[] = [];
    engine.stream({
      id: 'str',
      frame: {
        'ns/Thing': { params: { where: { _walk: { in: 'ns/Part.thing' } } }, fields: { id: true } }
      },
      ctx: {},
      onFrame: (f) => void frames.push(f)
    });
    for (let i = 0; i < 100 && !frames.some((f) => f.kind === 'end'); i++) {
      await new Promise<void>((r) => setImmediate(r));
    }
    expect(frames.map((f) => f.kind)).toEqual(['error', 'end']);
    expect(frames[0]?.errors?.[0]).toMatchObject({
      code: 'walks_in_subscription',
      path: ['ns/Thing', 'where', '_walk']
    });
  });
});

describe('stream — walk-only params (#1951 review)', () => {
  it('a stream on a real type carrying aggregate or groupBy is still refused', async () => {
    for (const k of ['count', 'aggregate', 'groupBy', 'having', 'offset']) {
      const engine = buildEngine();
      const frames: WsResponseFrame[] = [];
      engine.stream({
        id: 'str',
        frame: {
          'ns/Thing': { params: { [k]: k === 'count' ? true : 'x' }, fields: { id: true } }
        },
        ctx: {},
        onFrame: (f) => void frames.push(f)
      });
      for (let i = 0; i < 100 && !frames.some((f) => f.kind === 'end'); i++) {
        await new Promise<void>((r) => setImmediate(r));
      }
      expect(frames.map((f) => f.kind)).toEqual(['error', 'end']);
      expect(frames[0]?.errors?.[0]).toMatchObject({
        code: 'walks_in_subscription',
        path: ['ns/Thing', k]
      });
    }
  });
});

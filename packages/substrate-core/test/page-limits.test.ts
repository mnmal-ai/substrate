/**
 * Remote list reads are bounded: a type read with no `limit` gets the default
 * page, one above the maximum is refused, and virtual types and in-process
 * callers (no `pageLimits`) are left alone.
 */

import { MemoryDataset, MemoryDatasetRegistry } from '@mnmal-ai/substrate-dataset-memory';
import type { FrameEntry } from '@mnmal-ai/substrate-types';
import { describe, expect, it } from 'vitest';
import { Engine, MemoryEdgesStore, type NamespaceConfig, Registry } from '../src/index.js';

const limits = { defaultLimit: 2, maxLimit: 5 };
const ctx = { identity: null, headers: {}, meta: {} };

function engine(): { engine: Engine; seen: Array<unknown> } {
  const seen: Array<unknown> = [];
  const record = (name: string) => {
    const reg = new Registry();
    reg.register(name, {
      kind: 'type',
      resolver: async (_c, args) => {
        seen.push(args.params?.limit);
        return [];
      }
    });
    return reg;
  };
  const datasets = new MemoryDatasetRegistry();
  datasets.set('app', new MemoryDataset({ namespace: 'app' }));
  const namespaces = new Map<string, NamespaceConfig>([
    ['app', { registry: record('Note') }],
    ['virt', { registry: record('Hit'), virtual: true }]
  ]);
  return {
    engine: new Engine({
      namespaces,
      datasets,
      edges: new MemoryEdgesStore({ now: () => new Date() })
    }),
    seen
  };
}

const read = (key: string, params?: FrameEntry['params']) => ({
  [key]: { ...(params !== undefined ? { params } : {}), fields: { id: true } }
});

describe('page limits', () => {
  it('give a read with no limit the default page', async () => {
    const { engine: e, seen } = engine();
    await e.query({ frame: read('app/Note'), ctx, pageLimits: limits });
    expect(seen).toEqual([2]);
  });

  it('refuse a limit above the maximum without running the read', async () => {
    const { engine: e, seen } = engine();
    const env = await e.query({ frame: read('app/Note', { limit: 6 }), ctx, pageLimits: limits });
    expect(env.errors?.[0]?.code).toBe('limit_exceeds_max');
    expect(seen).toEqual([]);
  });

  it('default a null limit and refuse one that is not a non-negative integer', async () => {
    const { engine: e, seen } = engine();
    await e.query({ frame: read('app/Note', { limit: null }), ctx, pageLimits: limits });
    for (const limit of ['5000', 2.5, -1, Number.POSITIVE_INFINITY]) {
      const env = await e.query({ frame: read('app/Note', { limit }), ctx, pageLimits: limits });
      expect(env.errors?.[0]?.code).toBe('invalid_limit');
    }
    expect(seen).toEqual([2]);
  });

  it('leave virtual types and in-process callers alone', async () => {
    const { engine: e, seen } = engine();
    await e.query({ frame: read('virt/Hit'), ctx, pageLimits: limits });
    await e.query({ frame: read('app/Note'), ctx });
    expect(seen).toEqual([undefined, undefined]);
  });
});

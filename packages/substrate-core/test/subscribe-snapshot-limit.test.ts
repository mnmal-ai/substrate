/**
 * A subscription snapshot is bounded: the snapshot read asks for one row past
 * the cap, and a snapshot larger than the cap is refused rather than shipped.
 */

import { MemoryDataset, MemoryDatasetRegistry } from '@mnmal-ai/substrate-dataset-memory';
import type { WsResponseFrame } from '@mnmal-ai/substrate-types';
import { expect, it } from 'vitest';
import { Engine, MemoryEdgesStore, type NamespaceConfig, Registry } from '../src/index.js';

it('refuses a snapshot with more rows than the snapshot limit', async () => {
  const datasets = new MemoryDatasetRegistry();
  datasets.set('app', new MemoryDataset({ namespace: 'app' }));
  const limits: unknown[] = [];
  const registry = new Registry();
  registry.register('Thing', {
    kind: 'type',
    resolver: async (_ctx, args) => {
      limits.push(args.params?.limit);
      return [{ id: 1 }, { id: 2 }, { id: 3 }];
    }
  });
  const engine = new Engine({
    namespaces: new Map<string, NamespaceConfig>([['app', { registry }]]),
    datasets,
    edges: new MemoryEdgesStore({ now: () => new Date() }),
    subscriptions: { snapshotLimit: 2 }
  });
  const frames: WsResponseFrame[] = [];
  await engine.subscribe({
    id: 's1',
    frame: { 'app/Thing': { fields: { id: true } } },
    ctx: { identity: null },
    onFrame: (f) => {
      frames.push(f);
    }
  });

  expect(limits).toEqual([3]);
  expect(frames.map((f) => f.kind)).toEqual(['error']);
  expect(frames[0]?.errors?.[0]?.code).toBe('snapshot_too_large');
  expect(engine.activeSubscriptionCount()).toBe(0);
});

it('counts only the rows a row policy lets the subscriber see, reading on past hidden ones', async () => {
  const datasets = new MemoryDatasetRegistry();
  datasets.set('app', new MemoryDataset({ namespace: 'app' }));
  // 30 rows in pages of 3; the subscriber may see rows 7 and 23.
  const all = Array.from({ length: 30 }, (_, i) => ({ id: i + 1 }));
  const registry = new Registry();
  registry.register('Thing', {
    kind: 'type',
    policy: () => ({
      allow: true,
      obligations: [
        { kind: 'row-filter', predicate: (_ctx: unknown, row: { id: number }) => row.id % 16 === 7 }
      ]
    }),
    resolver: async (_ctx, args) => {
      const start = Number(args.params?.cursor ?? 0);
      const rows = all.slice(start, start + 3);
      const end = start + rows.length;
      return { rows, hasMore: end < all.length, nextCursor: String(end) };
    }
  });
  const engine = new Engine({
    namespaces: new Map<string, NamespaceConfig>([['app', { registry }]]),
    datasets,
    edges: new MemoryEdgesStore({ now: () => new Date() }),
    subscriptions: { snapshotLimit: 2 }
  });
  const frames: WsResponseFrame[] = [];
  await engine.subscribe({
    id: 's1',
    frame: { 'app/Thing': { fields: { id: true } } },
    ctx: { identity: null },
    onFrame: (f) => {
      frames.push(f);
    }
  });

  expect(frames[0]?.kind).toBe('snapshot');
  expect((frames[0]?.data as Record<string, unknown> | undefined)?.['app/Thing']).toEqual([
    { id: 7 },
    { id: 23 }
  ]);
});

it('stops reading a fully hidden snapshot after ten reads worth of rows', async () => {
  const datasets = new MemoryDatasetRegistry();
  datasets.set('app', new MemoryDataset({ namespace: 'app' }));
  let scanned = 0;
  const registry = new Registry();
  registry.register('Thing', {
    kind: 'type',
    policy: () => ({
      allow: true,
      obligations: [{ kind: 'row-filter', predicate: () => false }]
    }),
    resolver: async (_ctx, args) => {
      const start = Number(args.params?.cursor ?? 0);
      const rows = Array.from({ length: 3 }, (_, i) => ({ id: start + i + 1 }));
      scanned += rows.length;
      return { rows, hasMore: true, nextCursor: String(start + rows.length) };
    }
  });
  const engine = new Engine({
    namespaces: new Map<string, NamespaceConfig>([['app', { registry }]]),
    datasets,
    edges: new MemoryEdgesStore({ now: () => new Date() }),
    subscriptions: { snapshotLimit: 2 }
  });
  const frames: WsResponseFrame[] = [];
  await engine.subscribe({
    id: 's1',
    frame: { 'app/Thing': { fields: { id: true } } },
    ctx: { identity: null },
    onFrame: (f) => {
      frames.push(f);
    }
  });

  expect(frames[0]?.errors?.[0]?.code).toBe('snapshot_too_large');
  expect(scanned).toBeLessThanOrEqual(30);
});

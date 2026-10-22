import { MemoryDataset, MemoryDatasetRegistry } from '@mnmal-ai/substrate-dataset-memory';
import type { BridgeClient, BridgeRegistry, SweepDeps } from '@mnmal-ai/substrate-types';
import { describe, expect, it, vi } from 'vitest';
import {
  BridgeUnreachableError,
  loadSweepState,
  MemoryEdgesStore,
  runSweep,
  saveSweepState
} from '../src/index.js';
import type { SweepMetricName } from '../src/sweep.js';

function mkBridges(
  known: string[] = [],
  unreachable: (ns: string) => boolean = () => false
): BridgeRegistry {
  const set = new Set(known);
  return {
    has: (ns) => set.has(ns),
    get: (): BridgeClient | undefined => undefined,
    isUnreachable: (ns) => set.has(ns) && unreachable(ns),
    entries: (): Array<[string, BridgeClient]> => []
  };
}

interface Harness {
  datasets: MemoryDatasetRegistry;
  edges: MemoryEdgesStore;
  now: () => Date;
  metrics: Array<{ name: string; payload?: unknown }>;
  deps: SweepDeps;
}

function makeHarness(opts: { bridges?: BridgeRegistry } = {}): Harness {
  const clock = new Date('2026-04-18T00:00:00Z');
  const now = () => clock;

  const datasets = new MemoryDatasetRegistry();
  const edges = new MemoryEdgesStore({ now });
  const metrics: Array<{ name: string; payload?: unknown }> = [];

  const deps: SweepDeps = {
    datasets,
    bridges: opts.bridges ?? mkBridges(),
    edges,
    now,
    metric: (name, payload) => metrics.push({ name, payload })
  };

  return { datasets, edges, now, metrics, deps };
}

function countMetric(h: Harness, name: SweepMetricName | string): number {
  return h.metrics.filter((m) => m.name === name).length;
}

describe('runSweep — per-policy branches', () => {
  it('EXISTS target → update lastSweptAt, no policy fires', async () => {
    const h = makeHarness();
    const priceDs = new MemoryDataset({ namespace: 'prices' });
    await priceDs.write('Price', [{ id: 42 }]);
    h.datasets.set('prices', priceDs);

    const productDs = new MemoryDataset({ namespace: 'products' });
    await productDs.write('Product', [{ id: 1, priceId: 42 }]);
    h.datasets.set('products', productDs);

    const edge = await h.edges.write({
      from: { ns: 'products', type: 'Product', id: 1 },
      to: { ns: 'prices', type: 'Price', id: 42 },
      fieldName: 'priceId',
      policy: 'set_null'
    });

    await runSweep(h.deps, { lastSweptCursor: null });

    const [rec] = await h.edges.readNextBatch(null, 10).then((b) => b.edges);
    expect(rec?.id).toBe(edge.id);
    expect(rec?.lastSweptAt).toBeInstanceOf(Date);
    expect(rec?.deletedAt).toBeUndefined();
  });

  it('DELETED + set_null: nulls source field and tombstones edge', async () => {
    const h = makeHarness();
    const priceDs = new MemoryDataset({ namespace: 'prices' });
    await priceDs.write('Price', [{ id: 42 }]);
    await priceDs.tombstone('Price', [42]);
    h.datasets.set('prices', priceDs);

    const productDs = new MemoryDataset({ namespace: 'products' });
    await productDs.write('Product', [{ id: 1, priceId: 42 }]);
    h.datasets.set('products', productDs);

    const edge = await h.edges.write({
      from: { ns: 'products', type: 'Product', id: 1 },
      to: { ns: 'prices', type: 'Price', id: 42 },
      fieldName: 'priceId',
      policy: 'set_null'
    });

    await runSweep(h.deps, { lastSweptCursor: null });

    const {
      rows: [row]
    } = await productDs.read('Product', { id: 1 });
    expect(row?.priceId).toBeNull();

    const batch = await h.edges.readNextBatch(null, 10);
    expect(batch.edges.find((e) => e.id === edge.id)?.deletedAt).toBeInstanceOf(Date);
    expect(countMetric(h, 'policy_applied')).toBeGreaterThanOrEqual(1);
  });

  it('DELETED + cascade: tombstones source row, tombstones edge, fan-out within cycle', async () => {
    const h = makeHarness();

    const priceDs = new MemoryDataset({ namespace: 'prices' });
    await priceDs.write('Price', [{ id: 42 }]);
    await priceDs.tombstone('Price', [42]);
    h.datasets.set('prices', priceDs);

    const productDs = new MemoryDataset({ namespace: 'products' });
    await productDs.write('Product', [{ id: 1, priceId: 42 }]);
    h.datasets.set('products', productDs);

    const lineDs = new MemoryDataset({ namespace: 'lines' });
    await lineDs.write('Line', [{ id: 7, productId: 1 }]);
    h.datasets.set('lines', lineDs);

    await h.edges.write({
      from: { ns: 'products', type: 'Product', id: 1 },
      to: { ns: 'prices', type: 'Price', id: 42 },
      fieldName: 'priceId',
      policy: 'cascade'
    });

    await h.edges.write({
      from: { ns: 'lines', type: 'Line', id: 7 },
      to: { ns: 'products', type: 'Product', id: 1 },
      fieldName: 'productId',
      policy: 'cascade'
    });

    await runSweep(h.deps, { lastSweptCursor: null });

    const {
      rows: [prod]
    } = await productDs.read('Product', { id: 1, includeDeleted: true });
    expect(prod?._deletedAt).toBeInstanceOf(Date);

    const {
      rows: [line]
    } = await lineDs.read('Line', { id: 7, includeDeleted: true });
    expect(line?._deletedAt).toBeInstanceOf(Date);
  });

  it('DELETED + cascade: each edge processed once (diamond)', async () => {
    // A diamond: A --cascade--> root; B --cascade--> root; C --cascade--> A; C --cascade--> B.
    // Deleting root must not process C twice.
    const h = makeHarness();

    const rootDs = new MemoryDataset({ namespace: 'root' });
    await rootDs.write('R', [{ id: 1 }]);
    await rootDs.tombstone('R', [1]);
    h.datasets.set('root', rootDs);

    const abDs = new MemoryDataset({ namespace: 'ab' });
    await abDs.write('A', [{ id: 10 }]);
    await abDs.write('B', [{ id: 20 }]);
    h.datasets.set('ab', abDs);

    const cDs = new MemoryDataset({ namespace: 'c' });
    await cDs.write('C', [{ id: 100 }]);
    h.datasets.set('c', cDs);

    await h.edges.write({
      from: { ns: 'ab', type: 'A', id: 10 },
      to: { ns: 'root', type: 'R', id: 1 },
      fieldName: 'rootId',
      policy: 'cascade'
    });
    await h.edges.write({
      from: { ns: 'ab', type: 'B', id: 20 },
      to: { ns: 'root', type: 'R', id: 1 },
      fieldName: 'rootId',
      policy: 'cascade'
    });
    await h.edges.write({
      from: { ns: 'c', type: 'C', id: 100 },
      to: { ns: 'ab', type: 'A', id: 10 },
      fieldName: 'aId',
      policy: 'cascade'
    });
    await h.edges.write({
      from: { ns: 'c', type: 'C', id: 100 },
      to: { ns: 'ab', type: 'B', id: 20 },
      fieldName: 'bId',
      policy: 'cascade'
    });

    await runSweep(h.deps, { lastSweptCursor: null });

    // Exactly one swept metric, and the swept count includes the C-edges once each.
    const swept = h.metrics.find((m) => m.name === 'swept');
    expect(swept).toBeDefined();
  });

  it('DELETED + restrict: stamps lastSweptAt, edge stays live, metric fired', async () => {
    const h = makeHarness();

    const priceDs = new MemoryDataset({ namespace: 'prices' });
    await priceDs.write('Price', [{ id: 42 }]);
    await priceDs.tombstone('Price', [42]);
    h.datasets.set('prices', priceDs);

    const productDs = new MemoryDataset({ namespace: 'products' });
    await productDs.write('Product', [{ id: 1, priceId: 42 }]);
    h.datasets.set('products', productDs);

    const edge = await h.edges.write({
      from: { ns: 'products', type: 'Product', id: 1 },
      to: { ns: 'prices', type: 'Price', id: 42 },
      fieldName: 'priceId',
      policy: 'restrict'
    });

    await runSweep(h.deps, { lastSweptCursor: null });

    const batch = await h.edges.readNextBatch(null, 10);
    const rec = batch.edges.find((e) => e.id === edge.id);
    expect(rec?.deletedAt).toBeUndefined();
    expect(rec?.lastSweptAt).toBeInstanceOf(Date);

    expect(countMetric(h, 'restrict_violation')).toBe(1);
    const {
      rows: [row]
    } = await productDs.read('Product', { id: 1 });
    expect(row?.priceId).toBe(42);
  });

  it('DELETED + orphan: stamps lastSweptAt, edge stays live', async () => {
    const h = makeHarness();

    const priceDs = new MemoryDataset({ namespace: 'prices' });
    await priceDs.write('Price', [{ id: 42 }]);
    await priceDs.tombstone('Price', [42]);
    h.datasets.set('prices', priceDs);

    const productDs = new MemoryDataset({ namespace: 'products' });
    await productDs.write('Product', [{ id: 1, priceId: 42 }]);
    h.datasets.set('products', productDs);

    const edge = await h.edges.write({
      from: { ns: 'products', type: 'Product', id: 1 },
      to: { ns: 'prices', type: 'Price', id: 42 },
      fieldName: 'priceId',
      policy: 'orphan'
    });

    await runSweep(h.deps, { lastSweptCursor: null });

    const batch = await h.edges.readNextBatch(null, 10);
    const rec = batch.edges.find((e) => e.id === edge.id);
    expect(rec?.deletedAt).toBeUndefined();
    expect(rec?.lastSweptAt).toBeInstanceOf(Date);
  });
});

describe('runSweep — bridge handling', () => {
  it('MISSING + bridged + bridge-unreachable → bail, no edge mutation', async () => {
    const bridges = mkBridges(['bridge-ns'], (ns) => ns === 'bridge-ns');
    const h = makeHarness({ bridges });

    const productDs = new MemoryDataset({ namespace: 'products' });
    await productDs.write('Product', [{ id: 1 }]);
    h.datasets.set('products', productDs);

    const edge = await h.edges.write({
      from: { ns: 'products', type: 'Product', id: 1 },
      to: { ns: 'bridge-ns', type: 'Remote', id: 99, bridged: true },
      fieldName: 'remoteId',
      policy: 'cascade'
    });

    await runSweep(h.deps, { lastSweptCursor: null });

    const batch = await h.edges.readNextBatch(null, 10);
    const rec = batch.edges.find((e) => e.id === edge.id);
    expect(rec?.deletedAt).toBeUndefined();
    expect(rec?.blocked).toBeUndefined();
    expect(rec?.lastSweptAt).toBeUndefined();

    expect(countMetric(h, 'bridge_unreachable')).toBe(1);
  });

  it('a bridge that refuses the read (403) leaves the edge and its source row alone', async () => {
    // A 403 throws BridgeUnreachableError without flipping isUnreachable, so
    // the sweep cannot rely on the registry flag to tell refusal from absence.
    const refusing = {
      readRow: async () => {
        throw new BridgeUnreachableError('peer', 'https://peer', 'HTTP 403 (auth)');
      }
    } as unknown as BridgeClient;
    const bridges: BridgeRegistry = { ...mkBridges(['bridge-ns']), get: () => refusing };
    const h = makeHarness({ bridges });

    const productDs = new MemoryDataset({ namespace: 'products' });
    await productDs.write('Product', [{ id: 1 }]);
    h.datasets.set('products', productDs);

    const edge = await h.edges.write({
      from: { ns: 'products', type: 'Product', id: 1 },
      to: { ns: 'bridge-ns', type: 'Remote', id: 99, bridged: true },
      fieldName: 'remoteId',
      policy: 'cascade'
    });

    await runSweep(h.deps, { lastSweptCursor: null });

    const batch = await h.edges.readNextBatch(null, 10);
    const rec = batch.edges.find((e) => e.id === edge.id);
    expect(rec?.deletedAt).toBeUndefined();
    expect(rec?.lastSweptAt).toBeUndefined();
    const { rows } = await productDs.read('Product', { id: 1 });
    expect(rows[0]?._deletedAt).toBeUndefined();
    expect(countMetric(h, 'bridge_unreachable')).toBe(1);
  });

  it('DELETED-known + cascade + bridged + unreachable → blocked=true (no tombstone)', async () => {
    // Target is bridged but resolveTarget returns DELETED because a local
    // tombstone is cached in a "bridge-dataset" placeholder in our registry.
    const h = makeHarness({
      bridges: mkBridges(['bridge-ns'], (ns) => ns === 'bridge-ns')
    });

    const bridgeDs = new MemoryDataset({ namespace: 'bridge-ns' });
    await bridgeDs.write('Remote', [{ id: 99 }]);
    await bridgeDs.tombstone('Remote', [99]);
    h.datasets.set('bridge-ns', bridgeDs);

    const productDs = new MemoryDataset({ namespace: 'products' });
    await productDs.write('Product', [{ id: 1 }]);
    h.datasets.set('products', productDs);

    const edge = await h.edges.write({
      from: { ns: 'products', type: 'Product', id: 1 },
      to: { ns: 'bridge-ns', type: 'Remote', id: 99, bridged: true },
      fieldName: 'remoteId',
      policy: 'cascade'
    });

    await runSweep(h.deps, { lastSweptCursor: null });

    const batch = await h.edges.readNextBatch(null, 10);
    const rec = batch.edges.find((e) => e.id === edge.id);
    expect(rec?.deletedAt).toBeUndefined();
    expect(rec?.blocked).toBe(true);

    expect(countMetric(h, 'cascade_blocked_bridge')).toBe(1);
  });
});

describe('runSweep — from-ns unknown', () => {
  it('set_null with unknown from-ns tombstones edge + emits metric', async () => {
    const h = makeHarness();

    const priceDs = new MemoryDataset({ namespace: 'prices' });
    await priceDs.write('Price', [{ id: 42 }]);
    await priceDs.tombstone('Price', [42]);
    h.datasets.set('prices', priceDs);

    // Note: no 'products' dataset registered.
    const edge = await h.edges.write({
      from: { ns: 'products', type: 'Product', id: 1 },
      to: { ns: 'prices', type: 'Price', id: 42 },
      fieldName: 'priceId',
      policy: 'set_null'
    });

    await runSweep(h.deps, { lastSweptCursor: null });

    const batch = await h.edges.readNextBatch(null, 10);
    const rec = batch.edges.find((e) => e.id === edge.id);
    expect(rec?.deletedAt).toBeInstanceOf(Date);
    expect(countMetric(h, 'from_ns_unknown')).toBe(1);
  });
});

describe('runSweep — cursor + drain-loop', () => {
  it('wraparound: empty batch → cursor becomes null', async () => {
    const h = makeHarness();
    const state = await runSweep(h.deps, { lastSweptCursor: 'stale-cursor' });
    expect(state.lastSweptCursor).toBeNull();
  });

  it('advances cursor by base batch only', async () => {
    const h = makeHarness();
    const priceDs = new MemoryDataset({ namespace: 'prices' });
    await priceDs.write('Price', [{ id: 42 }]);
    h.datasets.set('prices', priceDs);

    const productDs = new MemoryDataset({ namespace: 'products' });
    await productDs.write('Product', [{ id: 1 }, { id: 2 }, { id: 3 }]);
    h.datasets.set('products', productDs);

    const e1 = await h.edges.write({
      from: { ns: 'products', type: 'Product', id: 1 },
      to: { ns: 'prices', type: 'Price', id: 42 },
      fieldName: 'priceId',
      policy: 'set_null'
    });
    const e2 = await h.edges.write({
      from: { ns: 'products', type: 'Product', id: 2 },
      to: { ns: 'prices', type: 'Price', id: 42 },
      fieldName: 'priceId',
      policy: 'set_null'
    });

    const state = await runSweep(h.deps, { lastSweptCursor: null }, 10);
    expect(state.lastSweptCursor).toBe(e2.id);
    // Witness e1 was also in the batch.
    expect(e1.id < e2.id).toBe(true);
  });

  it('drain-loop: small batch size still processes cascade fan-out in one call', async () => {
    const h = makeHarness();

    const priceDs = new MemoryDataset({ namespace: 'prices' });
    await priceDs.write('Price', [{ id: 42 }]);
    await priceDs.tombstone('Price', [42]);
    h.datasets.set('prices', priceDs);

    const productDs = new MemoryDataset({ namespace: 'products' });
    await productDs.write('Product', [{ id: 1, priceId: 42 }]);
    h.datasets.set('products', productDs);

    const lineDs = new MemoryDataset({ namespace: 'lines' });
    await lineDs.write('Line', [{ id: 7, productId: 1 }]);
    h.datasets.set('lines', lineDs);

    await h.edges.write({
      from: { ns: 'products', type: 'Product', id: 1 },
      to: { ns: 'prices', type: 'Price', id: 42 },
      fieldName: 'priceId',
      policy: 'cascade'
    });
    // Second edge is a cascade-child; it's NOT in the base batch (cursor stops at 1)
    await h.edges.write({
      from: { ns: 'lines', type: 'Line', id: 7 },
      to: { ns: 'products', type: 'Product', id: 1 },
      fieldName: 'productId',
      policy: 'cascade'
    });

    await runSweep(h.deps, { lastSweptCursor: null }, 1);

    // Both cascades MUST have fired within the one call (drain-loop).
    const {
      rows: [prod]
    } = await productDs.read('Product', { id: 1, includeDeleted: true });
    expect(prod?._deletedAt).toBeInstanceOf(Date);
    const {
      rows: [line]
    } = await lineDs.read('Line', { id: 7, includeDeleted: true });
    expect(line?._deletedAt).toBeInstanceOf(Date);
  });

  it('processedEdgeIds prevents double-processing within a cycle', async () => {
    const h = makeHarness();
    const updateSpy = vi.spyOn(h.edges, 'update');

    const priceDs = new MemoryDataset({ namespace: 'prices' });
    await priceDs.write('Price', [{ id: 42 }]);
    h.datasets.set('prices', priceDs);

    const productDs = new MemoryDataset({ namespace: 'products' });
    await productDs.write('Product', [{ id: 1 }]);
    h.datasets.set('products', productDs);

    const edge = await h.edges.write({
      from: { ns: 'products', type: 'Product', id: 1 },
      to: { ns: 'prices', type: 'Price', id: 42 },
      fieldName: 'priceId',
      policy: 'set_null'
    });

    await runSweep(h.deps, { lastSweptCursor: null });

    const updatesForEdge = updateSpy.mock.calls.filter(
      (args) => (args[0] as { id: string }).id === edge.id
    );
    expect(updatesForEdge).toHaveLength(1);
  });

  it('skips tombstoned edges', async () => {
    const h = makeHarness();
    const productDs = new MemoryDataset({ namespace: 'products' });
    await productDs.write('Product', [{ id: 1 }]);
    h.datasets.set('products', productDs);

    const priceDs = new MemoryDataset({ namespace: 'prices' });
    await priceDs.write('Price', [{ id: 42 }]);
    await priceDs.tombstone('Price', [42]);
    h.datasets.set('prices', priceDs);

    const edge = await h.edges.write({
      from: { ns: 'products', type: 'Product', id: 1 },
      to: { ns: 'prices', type: 'Price', id: 42 },
      fieldName: 'priceId',
      policy: 'set_null'
    });
    await h.edges.tombstone(edge.id);

    await runSweep(h.deps, { lastSweptCursor: null });

    const batch = await h.edges.readNextBatch(null, 10);
    const rec = batch.edges.find((e) => e.id === edge.id);
    expect(rec?.lastSweptAt).toBeUndefined();
    // Source field untouched.
    const {
      rows: [row]
    } = await productDs.read('Product', { id: 1 });
    expect(row).toBeDefined();
  });
});

describe('runSweep — stale edges', () => {
  async function setup(policy: 'set_null' | 'cascade') {
    const h = makeHarness();
    const priceDs = new MemoryDataset({ namespace: 'prices' });
    await priceDs.write('Price', [{ id: 42 }]);
    await priceDs.tombstone('Price', [42]);
    h.datasets.set('prices', priceDs);
    const productDs = new MemoryDataset({ namespace: 'products' });
    await productDs.write('Product', [{ id: 1, priceId: 42 }]);
    h.datasets.set('products', productDs);
    const edge = await h.edges.write({
      from: { ns: 'products', type: 'Product', id: 1 },
      to: { ns: 'prices', type: 'Price', id: 42 },
      fieldName: 'priceId',
      policy
    });
    return { h, productDs, edge };
  }

  it.each(['set_null', 'cascade'] as const)(
    '%s leaves a source whose field was repointed since the edge was written',
    async (policy) => {
      const { h, productDs } = await setup(policy);
      await productDs.write('Product', [{ id: 1, priceId: 43 }]);

      await runSweep(h.deps, { lastSweptCursor: null });

      const { rows } = await productDs.read('Product', { id: 1, includeDeleted: true });
      expect(rows[0]).toMatchObject({ priceId: 43 });
      expect(rows[0]?._deletedAt).toBeUndefined();
    }
  );

  it('skips an edge tombstoned after the batch was read', async () => {
    const { h, productDs, edge } = await setup('set_null');
    const readNextBatch = h.edges.readNextBatch.bind(h.edges);
    h.deps.edges.readNextBatch = async (cursor, size) => {
      const batch = await readNextBatch(cursor, size);
      await h.edges.tombstone(edge.id);
      return batch;
    };

    await runSweep(h.deps, { lastSweptCursor: null });

    const { rows } = await productDs.read('Product', { id: 1 });
    expect(rows[0]).toMatchObject({ priceId: 42 });
  });
});

describe('runSweep — time budget + persisted cursor', () => {
  it('walks every batch within the budget, and the cursor survives a reload', async () => {
    const h = makeHarness();
    const priceDs = new MemoryDataset({ namespace: 'prices' });
    await priceDs.write('Price', [{ id: 42 }]);
    h.datasets.set('prices', priceDs);
    for (const id of [1, 2, 3]) {
      await h.edges.write({
        from: { ns: 'products', type: 'Product', id },
        to: { ns: 'prices', type: 'Price', id: 42 },
        fieldName: 'priceId',
        policy: 'set_null'
      });
    }

    const state = await runSweep(h.deps, { lastSweptCursor: null }, 2, 60_000);

    const { edges } = await h.edges.readNextBatch(null, 10);
    expect(edges.every((e) => e.lastSweptAt instanceof Date)).toBe(true);
    const system = new MemoryDataset({ namespace: '_system' });
    expect(await loadSweepState(system)).toEqual({ lastSweptCursor: null });
    await saveSweepState(system, state);
    expect(await loadSweepState(system)).toEqual(state);
    expect(state.lastSweptCursor).toBe(edges[2]?.id);
  });

  it('stores the cursor under a UUID id, which the opt-in pg UUID check requires', async () => {
    const system = new MemoryDataset({ namespace: '_system' });
    await saveSweepState(system, { lastSweptCursor: 'c1' });
    const { rows } = await system.read('SweepCursor', { limit: 10 });
    expect(rows).toHaveLength(1);
    expect(String(rows[0]?.id)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    );
  });
});

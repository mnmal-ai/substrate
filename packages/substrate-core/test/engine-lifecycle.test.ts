/**
 * §6.4 — engine lifecycle wiring. The engine subscribes to
 * `DatasetRegistry.onNamespaceLost` in its constructor; a dispose on the
 * registry must trigger `applyLostNamespace` against every inbound edge and
 * surface failures via `namespace_lost_error` without crashing the engine.
 */

import { MemoryDataset, MemoryDatasetRegistry } from '@mnmal-ai/substrate-dataset-memory';
import type { Dataset, DatasetRegistry } from '@mnmal-ai/substrate-types';
import { describe, expect, it, vi } from 'vitest';
import { Engine, MemoryEdgesStore, type NamespaceConfig, Registry } from '../src/index.js';

function makeEdges(): MemoryEdgesStore {
  return new MemoryEdgesStore({ now: () => new Date('2026-04-18T00:00:00Z') });
}

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 500): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await flushMicrotasks();
  }
}

describe('Engine — §6.4 lifecycle', () => {
  it('dispose on registry triggers set_null on inbound edges', async () => {
    const priceDs = new MemoryDataset({ namespace: 'prices' });
    await priceDs.write('Price', [{ id: 42 }]);
    const productDs = new MemoryDataset({ namespace: 'products' });
    await productDs.write('Product', [{ id: 1, priceId: 42 }]);

    const datasets = new MemoryDatasetRegistry();
    datasets.set('prices', priceDs);
    datasets.set('products', productDs);

    const edges = makeEdges();
    await edges.write({
      from: { ns: 'products', type: 'Product', id: 1 },
      to: { ns: 'prices', type: 'Price', id: 42 },
      fieldName: 'priceId',
      policy: 'set_null'
    });

    const metrics: Array<{ name: string; payload?: unknown }> = [];
    const namespaces = new Map<string, NamespaceConfig>([
      ['prices', { registry: new Registry() }],
      ['products', { registry: new Registry() }]
    ]);
    new Engine({
      namespaces,
      datasets,
      edges,
      metric: (name, payload) => metrics.push({ name, payload })
    });

    datasets.dispose('prices');

    await waitFor(
      () => metrics.some((m) => m.name === 'namespace_lost_applied'),
      'namespace_lost_applied metric'
    );

    const {
      rows: [row]
    } = await productDs.read('Product', { id: 1 });
    expect(row?.priceId).toBeNull();

    const applied = metrics.find((m) => m.name === 'namespace_lost_applied');
    expect(applied?.payload).toEqual({ ns: 'prices', affectedEdges: 1 });
  });

  it('cascade policy fan-out fires from a disposed namespace', async () => {
    const priceDs = new MemoryDataset({ namespace: 'prices' });
    await priceDs.write('Price', [{ id: 42 }]);
    const productDs = new MemoryDataset({ namespace: 'products' });
    await productDs.write('Product', [{ id: 1, priceId: 42 }]);
    const lineDs = new MemoryDataset({ namespace: 'lines' });
    await lineDs.write('Line', [{ id: 7, productId: 1 }]);

    const datasets = new MemoryDatasetRegistry();
    datasets.set('prices', priceDs);
    datasets.set('products', productDs);
    datasets.set('lines', lineDs);

    const edges = makeEdges();
    await edges.write({
      from: { ns: 'products', type: 'Product', id: 1 },
      to: { ns: 'prices', type: 'Price', id: 42 },
      fieldName: 'priceId',
      policy: 'cascade'
    });
    await edges.write({
      from: { ns: 'lines', type: 'Line', id: 7 },
      to: { ns: 'products', type: 'Product', id: 1 },
      fieldName: 'productId',
      policy: 'cascade'
    });

    const metrics: Array<{ name: string; payload?: unknown }> = [];
    const namespaces = new Map<string, NamespaceConfig>();
    new Engine({
      namespaces,
      datasets,
      edges,
      metric: (name, payload) => metrics.push({ name, payload })
    });

    datasets.dispose('prices');

    await waitFor(
      () => metrics.some((m) => m.name === 'namespace_lost_applied'),
      'namespace_lost_applied metric'
    );

    const {
      rows: [prod]
    } = await productDs.read('Product', { id: 1, includeDeleted: true });
    expect(prod?._deletedAt).toBeInstanceOf(Date);
    const {
      rows: [line]
    } = await lineDs.read('Line', { id: 7, includeDeleted: true });
    // The line edge points at products, not prices — it gets cascaded through
    // the fan-out from the first edge's cascade.
    expect(line?._deletedAt).toBeInstanceOf(Date);
  });

  it('metric listener error does not kill the engine', async () => {
    const datasets = new MemoryDatasetRegistry();
    datasets.set('prices', new MemoryDataset({ namespace: 'prices' }));

    const edges = makeEdges();
    let metricCalls = 0;
    // A throwing metric hook simulates a misbehaving user metric sink.
    const engine = new Engine({
      namespaces: new Map(),
      datasets,
      edges,
      metric: (): void => {
        metricCalls++;
        throw new Error('metric sink is down');
      }
    });

    // Even with the throwing metric, dispose completes and no promise
    // rejection escapes. The engine reference stays usable.
    datasets.dispose('prices');
    await flushMicrotasks();
    await flushMicrotasks();

    expect(engine).toBeDefined();
    expect(metricCalls).toBeGreaterThan(0);
  });

  it('engine.dispose() unsubscribes — later registry dispose is a no-op on the engine', async () => {
    const priceDs = new MemoryDataset({ namespace: 'prices' });
    await priceDs.write('Price', [{ id: 42 }]);
    const productDs = new MemoryDataset({ namespace: 'products' });
    await productDs.write('Product', [{ id: 1, priceId: 42 }]);

    const datasets = new MemoryDatasetRegistry();
    datasets.set('prices', priceDs);
    datasets.set('products', productDs);

    const edges = makeEdges();
    await edges.write({
      from: { ns: 'products', type: 'Product', id: 1 },
      to: { ns: 'prices', type: 'Price', id: 42 },
      fieldName: 'priceId',
      policy: 'set_null'
    });

    const metrics: Array<{ name: string; payload?: unknown }> = [];
    const engine = new Engine({
      namespaces: new Map(),
      datasets,
      edges,
      metric: (name, payload) => metrics.push({ name, payload })
    });

    engine.dispose();
    datasets.dispose('prices');
    await flushMicrotasks();
    await flushMicrotasks();

    expect(metrics.find((m) => m.name === 'namespace_lost_applied')).toBeUndefined();
    const {
      rows: [row]
    } = await productDs.read('Product', { id: 1 });
    // Edge still points at the now-gone price; without the lifecycle hook the
    // field is NOT nulled until the next sweep cycle.
    expect(row?.priceId).toBe(42);
  });

  it('engine.dispose() is safe to call repeatedly', () => {
    const datasets = new MemoryDatasetRegistry();
    const engine = new Engine({
      namespaces: new Map(),
      datasets,
      edges: makeEdges()
    });
    engine.dispose();
    engine.dispose();
    expect(engine).toBeDefined();
  });

  it('engine built on a registry without onNamespaceLost is a safe no-op on dispose', () => {
    // A persistent-substrate registry omits the lifecycle surface entirely.
    // The engine must feature-detect and skip subscription.
    const pgLikeRegistry: DatasetRegistry = {
      get: (): Dataset | undefined => undefined,
      has: (): boolean => false,
      set: (): void => {}
    };
    const engine = new Engine({
      namespaces: new Map(),
      datasets: pgLikeRegistry,
      edges: makeEdges()
    });
    // dispose is still safe — it's a no-op in this branch.
    expect(() => engine.dispose()).not.toThrow();
  });

  it('subscription is engine-scoped — multiple engines over one registry each reconcile', async () => {
    // Two engines share a registry; each subscribes independently. Disposing
    // the registry's namespace fires both listeners. Our metric counts the
    // reconciliation twice — once per engine — which is the intended shape:
    // each engine owns its own reconcile pass.
    const priceDs = new MemoryDataset({ namespace: 'prices' });
    const productDs = new MemoryDataset({ namespace: 'products' });
    await productDs.write('Product', [{ id: 1, priceId: 42 }]);

    const datasets = new MemoryDatasetRegistry();
    datasets.set('prices', priceDs);
    datasets.set('products', productDs);

    const edges = makeEdges();
    await edges.write({
      from: { ns: 'products', type: 'Product', id: 1 },
      to: { ns: 'prices', type: 'Price', id: 42 },
      fieldName: 'priceId',
      policy: 'set_null'
    });

    const metricSpy = vi.fn();
    new Engine({
      namespaces: new Map(),
      datasets,
      edges,
      metric: metricSpy
    });
    new Engine({
      namespaces: new Map(),
      datasets,
      edges,
      metric: metricSpy
    });

    datasets.dispose('prices');
    await waitFor(
      () => metricSpy.mock.calls.filter((c) => c[0] === 'namespace_lost_applied').length >= 2,
      'two reconcile passes'
    );
  });
});

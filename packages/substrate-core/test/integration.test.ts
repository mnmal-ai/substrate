import { MemoryDataset, MemoryDatasetRegistry } from '@mnmal-ai/substrate-dataset-memory';
import type { BridgeClient, BridgeRegistry, SweepDeps } from '@mnmal-ai/substrate-types';
import { describe, expect, it } from 'vitest';
import { MemoryEdgesStore, runSweep } from '../src/index.js';

// `deleteRow` lives in @mnmal-ai/substrate-sdk, but importing it here would
// create a circular workspace devDep cycle (substrate-sdk → substrate-core for tests).
// The test data has no restrict edges, so we directly tombstone the row —
// equivalent to what deleteRow does after the gate check.
async function tombstoneNoRestrict(
  dataset: MemoryDataset,
  ref: { type: string; id: string | number }
): Promise<{ ok: true }> {
  await dataset.tombstone(ref.type, [ref.id]);
  return { ok: true };
}

const noBridges: BridgeRegistry = {
  has: () => false,
  get: (): BridgeClient | undefined => undefined,
  isUnreachable: () => false,
  entries: (): Array<[string, BridgeClient]> => []
};

describe('integration: tombstone → sweep → cascade', () => {
  it('full round-trip across three namespaces', async () => {
    const clock = new Date('2026-04-18T00:00:00Z');
    const now = () => clock;

    const datasets = new MemoryDatasetRegistry();
    const prices = new MemoryDataset({ namespace: 'prices' });
    const products = new MemoryDataset({ namespace: 'products' });
    const lines = new MemoryDataset({ namespace: 'lines' });
    datasets.set('prices', prices);
    datasets.set('products', products);
    datasets.set('lines', lines);

    await prices.write('Price', [{ id: 42, value: 9.99 }]);
    await products.write('Product', [{ id: 1, priceId: 42 }]);
    await lines.write('Line', [{ id: 7, productId: 1 }]);

    const edges = new MemoryEdgesStore({ now });
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

    // Outer delete — Phase 0 gate passes (no restrict), Phase 1 tombstones target.
    const del = await tombstoneNoRestrict(prices, { type: 'Price', id: 42 });
    expect(del.ok).toBe(true);

    const metrics: Array<{ name: string; payload?: unknown }> = [];
    const deps: SweepDeps = {
      datasets,
      bridges: noBridges,
      edges,
      now,
      metric: (name, payload) => metrics.push({ name, payload })
    };

    // One cycle is enough: drain-loop pulls cascade fan-out in.
    await runSweep(deps, { lastSweptCursor: null });

    const {
      rows: [priceRow]
    } = await prices.read('Price', { id: 42, includeDeleted: true });
    expect(priceRow?._deletedAt).toBeInstanceOf(Date);

    const {
      rows: [productRow]
    } = await products.read('Product', { id: 1, includeDeleted: true });
    expect(productRow?._deletedAt).toBeInstanceOf(Date);

    const {
      rows: [lineRow]
    } = await lines.read('Line', { id: 7, includeDeleted: true });
    expect(lineRow?._deletedAt).toBeInstanceOf(Date);

    // Both edges tombstoned.
    const toPrice = await edges.findEdgesTo({ ns: 'prices', type: 'Price', id: 42 });
    expect(toPrice).toEqual([]);
    const toProduct = await edges.findEdgesTo({ ns: 'products', type: 'Product', id: 1 });
    expect(toProduct).toEqual([]);

    expect(
      metrics.filter((m) => m.name === 'policy_applied' && m.payload === 'cascade')
    ).toHaveLength(2);
  });

  it('set_null propagation leaves source row live with nulled field', async () => {
    const now = () => new Date('2026-04-18T00:00:00Z');

    const datasets = new MemoryDatasetRegistry();
    const prices = new MemoryDataset({ namespace: 'prices' });
    const products = new MemoryDataset({ namespace: 'products' });
    datasets.set('prices', prices);
    datasets.set('products', products);

    await prices.write('Price', [{ id: 42, value: 9.99 }]);
    await products.write('Product', [{ id: 1, priceId: 42, name: 'keep' }]);

    const edges = new MemoryEdgesStore({ now });
    await edges.write({
      from: { ns: 'products', type: 'Product', id: 1 },
      to: { ns: 'prices', type: 'Price', id: 42 },
      fieldName: 'priceId',
      policy: 'set_null'
    });

    await tombstoneNoRestrict(prices, { type: 'Price', id: 42 });

    const deps: SweepDeps = {
      datasets,
      bridges: noBridges,
      edges,
      now,
      metric: () => {}
    };
    await runSweep(deps, { lastSweptCursor: null });

    const {
      rows: [product]
    } = await products.read('Product', { id: 1 });
    expect(product?.priceId).toBeNull();
    expect(product?.name).toBe('keep');
    expect(product?._deletedAt).toBeUndefined();
  });
});

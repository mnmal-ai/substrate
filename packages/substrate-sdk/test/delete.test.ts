import { MemoryEdgesStore } from '@mnmal-ai/substrate-core';
import { MemoryDataset } from '@mnmal-ai/substrate-dataset-memory';
import { RestrictViolation } from '@mnmal-ai/substrate-types';
import { beforeEach, describe, expect, it } from 'vitest';
import { deleteRow } from '../src/delete.js';

describe('deleteRow (outer two-phase delete)', () => {
  let now: Date;
  let ds: MemoryDataset;
  let edges: MemoryEdgesStore;

  beforeEach(() => {
    now = new Date('2026-04-18T00:00:00Z');
    ds = new MemoryDataset({ namespace: 'prices' });
    edges = new MemoryEdgesStore({ now: () => now });
  });

  it('Phase 0 gate: proceeds when no restrict edges exist', async () => {
    await ds.write('Price', [{ id: 42, value: 9.99 }]);

    const res = await deleteRow({
      dataset: ds,
      edges,
      ref: { ns: 'prices', type: 'Price', id: 42 },
      now: () => now
    });

    expect(res.ok).toBe(true);
    const {
      rows: [row]
    } = await ds.read('Price', { id: 42, includeDeleted: true });
    expect(row?._deletedAt).toBeInstanceOf(Date);
  });

  it('Phase 0 gate: rejects when a live restrict edge points at target', async () => {
    await ds.write('Price', [{ id: 42, value: 9.99 }]);
    const restrict = await edges.write({
      from: { ns: 'products', type: 'Product', id: 1 },
      to: { ns: 'prices', type: 'Price', id: 42 },
      fieldName: 'priceId',
      policy: 'restrict'
    });

    await expect(
      deleteRow({
        dataset: ds,
        edges,
        ref: { ns: 'prices', type: 'Price', id: 42 },
        now: () => now
      })
    ).rejects.toBeInstanceOf(RestrictViolation);

    // Target row must NOT be tombstoned.
    const {
      rows: [row]
    } = await ds.read('Price', { id: 42 });
    expect(row?._deletedAt).toBeUndefined();

    // Restrict edge is still live.
    expect(restrict.deletedAt).toBeUndefined();
  });

  it('Phase 0 gate: proceeds when existing restrict edge is tombstoned', async () => {
    await ds.write('Price', [{ id: 42, value: 9.99 }]);
    const restrict = await edges.write({
      from: { ns: 'products', type: 'Product', id: 1 },
      to: { ns: 'prices', type: 'Price', id: 42 },
      fieldName: 'priceId',
      policy: 'restrict'
    });
    await edges.tombstone(restrict.id);

    const res = await deleteRow({
      dataset: ds,
      edges,
      ref: { ns: 'prices', type: 'Price', id: 42 },
      now: () => now
    });
    expect(res.ok).toBe(true);
  });

  it('does NOT tombstone incoming edges itself (sweep does that)', async () => {
    await ds.write('Price', [{ id: 42, value: 9.99 }]);
    const setNull = await edges.write({
      from: { ns: 'products', type: 'Product', id: 1 },
      to: { ns: 'prices', type: 'Price', id: 42 },
      fieldName: 'priceId',
      policy: 'set_null'
    });

    await deleteRow({
      dataset: ds,
      edges,
      ref: { ns: 'prices', type: 'Price', id: 42 },
      now: () => now
    });

    // Edge is still live — the sweep will propagate.
    const live = await edges.findEdgesTo({ ns: 'prices', type: 'Price', id: 42 });
    expect(live.map((e) => e.id)).toEqual([setNull.id]);
  });
});

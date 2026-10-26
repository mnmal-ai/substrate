/**
 * The index advisor's read observation: shape keys keep field names and
 * operators only, the recorder reports a p95 per shape and stays bounded, and
 * the engine records each read with its effective order.
 */

import { MemoryDataset, MemoryDatasetRegistry } from '@mnmal-ai/substrate-dataset-memory';
import type { FieldDef, ReadParams, ReadResult } from '@mnmal-ai/substrate-types';
import { describe, expect, it } from 'vitest';
import {
  Engine,
  MemoryEdgesStore,
  type NamespaceConfig,
  type ReadShape,
  Registry,
  ShapeRecorder,
  shapeKey
} from '../src/index.js';

const shape = (over: Partial<ReadShape> = {}): ReadShape => ({
  namespace: 'shop',
  type: 'Item',
  filters: [],
  orderBy: [['createdAt', 'desc']],
  ...over
});

describe('shapeKey', () => {
  it('ignores operand values and filter order', () => {
    const a = shape({
      filters: [
        { field: 'kid', op: 'eq' },
        { field: 'rating', op: 'gt' }
      ]
    });
    const b = shape({
      filters: [
        { field: 'rating', op: 'gt' },
        { field: 'kid', op: 'eq' }
      ]
    });
    expect(shapeKey(a)).toBe(shapeKey(b));
    expect(shapeKey(a)).not.toBe(shapeKey(shape({ filters: [{ field: 'kid', op: 'eq' }] })));
    expect(shapeKey(a)).not.toBe(shapeKey({ ...a, orderBy: [['createdAt', 'asc']] }));
  });
});

describe('ShapeRecorder', () => {
  it('drain returns the p95 per shape and resets', () => {
    const r = new ShapeRecorder();
    const slow = shape({ filters: [{ field: 'kid', op: 'eq' }] });
    for (let i = 1; i <= 100; i++) r.observe(slow, i);
    r.observe(shape(), 2);
    const out = r.drain();
    expect(out).toHaveLength(2);
    const s = out.find((o) => shapeKey(o.shape) === shapeKey(slow));
    expect(s?.count).toBe(100);
    // Bucketed: within one sqrt(2) bucket of the true p95 (95).
    expect(s?.p95Ms).toBeGreaterThanOrEqual(95);
    expect(s?.p95Ms).toBeLessThan(95 * Math.SQRT2);
    expect(r.drain()).toEqual([]);
  });

  it('holds at most 1024 shapes, dropping the least recently seen', () => {
    const r = new ShapeRecorder();
    const nth = (i: number) => shape({ filters: [{ field: `f${i}`, op: 'eq' }] });
    for (let i = 0; i < 1024; i++) r.observe(nth(i), 1);
    r.observe(nth(0), 1); // seen again: now the most recent
    r.observe(nth(1024), 1);
    const keys = new Set(r.drain().map((o) => shapeKey(o.shape)));
    expect(keys.size).toBe(1024);
    expect(keys.has(shapeKey(nth(0)))).toBe(true);
    expect(keys.has(shapeKey(nth(1)))).toBe(false);
    expect(keys.has(shapeKey(nth(1024)))).toBe(true);
  });
});

describe('engine read recording', () => {
  const FIELDS: Record<string, FieldDef> = {
    kid: { kind: 'crossRef', ns: 'shop', type: 'Kid', onDelete: 'set_null' },
    rating: { kind: 'scalar', type: 'number' },
    addr: { kind: 'struct', fields: { city: { kind: 'scalar', type: 'string' } } }
  };

  function engineWith(recorder: ShapeRecorder): Engine {
    const ds = new MemoryDataset({ namespace: 'shop' });
    const registry = new Registry();
    registry.register('Item', {
      fields: FIELDS,
      orderedBy: { rating: 'desc' },
      resolver: async (_ctx, args): Promise<ReadResult> =>
        ds.read('Item', (args.params ?? {}) as ReadParams)
    });
    const datasets = new MemoryDatasetRegistry();
    datasets.set('shop', ds);
    return new Engine({
      namespaces: new Map<string, NamespaceConfig>([['shop', { registry }]]),
      datasets,
      edges: new MemoryEdgesStore({ now: () => new Date() }),
      shapeRecorder: recorder
    });
  }

  it('records the where shape and the injected natural order, never operands', async () => {
    const recorder = new ShapeRecorder();
    const engine = engineWith(recorder);
    const env = await engine.query({
      frame: {
        'shop/Item': {
          params: {
            where: {
              AND: [
                { kid: { eq: 'secret-kid' } },
                { OR: [{ rating: { gte: 3, lt: 9 } }, { addr: { city: { eq: 'Paris' } } }] }
              ]
            }
          },
          fields: { id: true }
        }
      },
      ctx: { identity: null }
    });
    expect(env.errors).toBeUndefined();
    const [obs] = recorder.drain();
    expect(obs?.count).toBe(1);
    expect(obs?.shape.orderBy).toEqual([['rating', 'desc']]);
    expect([...(obs?.shape.filters ?? [])].map((f) => `${f.field} ${f.op}`).sort()).toEqual([
      'addr.city eq',
      'kid eq',
      'rating gte',
      'rating lt'
    ]);
    expect(JSON.stringify(obs)).not.toMatch(/secret-kid|Paris/);
  });

  it('records an explicit orderBy as given', async () => {
    const recorder = new ShapeRecorder();
    const engine = engineWith(recorder);
    await engine.query({
      frame: { 'shop/Item': { params: { orderBy: [{ rating: 'asc' }] }, fields: { id: true } } },
      ctx: { identity: null }
    });
    expect(recorder.drain()[0]?.shape.orderBy).toEqual([['rating', 'asc']]);
  });
});

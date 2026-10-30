/**
 * The index advisor's read observation: shape keys keep field names and
 * operators only, the recorder reports a p95 per shape and stays bounded, and
 * the engine records each read with its effective order.
 */

import { MemoryDataset, MemoryDatasetRegistry } from '@mnmal-ai/substrate-dataset-memory';
import type { FieldDef, ReadParams, ReadResult } from '@mnmal-ai/substrate-types';
import { describe, expect, it } from 'vitest';
import { walkShapesOf } from '../src/advisor/shape-recorder.js';
import { walkSites } from '../src/advisor/walk-service.js';
import {
  Engine,
  MemoryEdgesStore,
  type NamespaceConfig,
  type ReadShape,
  Registry,
  readShapeOf,
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

  function engineWith(recorder: ShapeRecorder, fail?: Error): Engine {
    const ds = new MemoryDataset({ namespace: 'shop' });
    const registry = new Registry();
    registry.register('Item', {
      fields: FIELDS,
      orderedBy: { rating: 'desc' },
      resolver: async (_ctx, args): Promise<ReadResult> => {
        if (fail !== undefined) throw fail;
        return ds.read('Item', (args.params ?? {}) as ReadParams);
      }
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

  it('records a read that throws, such as a statement timeout', async () => {
    const recorder = new ShapeRecorder();
    const engine = engineWith(recorder, new Error('canceling statement due to statement timeout'));
    await engine
      .query({
        frame: {
          'shop/Item': { params: { where: { kid: { eq: 'k' } } }, fields: { id: true } }
        },
        ctx: { identity: null }
      })
      .catch(() => {});
    const [obs] = recorder.drain();
    expect(obs?.count).toBe(1);
    expect(obs?.shape.filters).toEqual([{ field: 'kid', op: 'eq' }]);
    expect(obs?.shape.orderBy).toEqual([['rating', 'desc']]);
  });
});

describe('readShapeOf: conjunction and literals', () => {
  const fields: Record<string, FieldDef> = {
    status: { kind: 'scalar', type: 'string' },
    archived: { kind: 'scalar', type: 'boolean' }
  };
  const of = (where: unknown) => readShapeOf('shop', 'Item', fields, where, []);

  it('marks a shape with an OR or a NOT anywhere as disjunctive, and keys it apart', () => {
    const and = of({ AND: [{ status: { eq: 'a' } }, { archived: { eq: false } }] });
    expect(and.disjunctive).toBeUndefined();
    const or = of({ OR: [{ status: { eq: 'a' } }, { archived: { eq: false } }] });
    expect(or.disjunctive).toBe(true);
    expect(of({ NOT: { status: { eq: 'a' } } }).disjunctive).toBe(true);
    expect(of({ AND: [{ OR: [{ status: { eq: 'a' } }] }] }).disjunctive).toBe(true);
    const { disjunctive: _, ...plain } = or;
    expect(shapeKey(or)).not.toBe(shapeKey(plain));
  });

  it('keeps only conjunctive boolean or null eq operands, never other values', () => {
    const s = of({ status: { eq: 'secret' }, archived: { eq: false } });
    expect(s.literals).toEqual({ archived: false });
    expect(JSON.stringify(s)).not.toContain('secret');
    expect(of({ OR: [{ archived: { eq: true } }] }).literals).toBeUndefined();
    expect(shapeKey(of({ archived: { eq: true } }))).not.toBe(
      shapeKey(of({ archived: { eq: false } }))
    );
  });
});

describe('ShapeRecorder.since', () => {
  it('is the start of what the next drain returns', () => {
    let t = 1000;
    const r = new ShapeRecorder(() => t);
    expect(r.since).toBe(1000);
    t = 5000;
    r.drain();
    expect(r.since).toBe(5000);
  });
});

describe('walk shapes', () => {
  const fields: Record<string, FieldDef> = {
    grade: { kind: 'scalar', type: 'number' },
    cert: { kind: 'crossRef', ns: 'cards', type: 'Cert', onDelete: 'set_null' },
    observedAt: { kind: 'scalar', type: 'date' }
  };
  const where = {
    AND: [
      { grade: { eq: 9 } },
      { _walk: { in: 'cards/Observation.cert', where: { observedAt: { gte: 'x' } } } },
      { _agg: { in: 'cards/Observation.cert', count: true }, gte: { $ref: '$.grade' } }
    ]
  };

  it('readShapeOf records no walk grammar as fields', () => {
    expect(readShapeOf('cards', 'Cert', fields, where, []).filters).toEqual([
      { field: 'grade', op: 'eq' }
    ]);
  });

  it('shape recorder emits a far-type shape per walk', () => {
    const sites = walkSites(
      {
        params: { where },
        fields: {
          obs: {
            _walk: { in: 'cards/Observation.cert' },
            orderBy: [{ observedAt: 'desc' }]
          },
          up: { _walk: { out: 'cert' } }
        }
      },
      'Cert',
      (node) => (node.in !== undefined ? 'Observation' : 'Cert')
    );
    const shapes = walkShapesOf('cards', sites, () => fields);
    expect(shapes).toEqual([
      {
        namespace: 'cards',
        type: 'Observation',
        filters: [
          { field: 'cert', op: 'eq' },
          { field: 'observedAt', op: 'gte' }
        ],
        orderBy: []
      },
      {
        namespace: 'cards',
        type: 'Observation',
        filters: [{ field: 'cert', op: 'eq' }],
        orderBy: []
      },
      {
        namespace: 'cards',
        type: 'Observation',
        filters: [{ field: 'cert', op: 'eq' }],
        orderBy: [['observedAt', 'desc']]
      }
    ]);
  });
});

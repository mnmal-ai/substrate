/**
 * Index service of walk reads (typed edge walks goal 7, §2): every clause is
 * marked served or unserved, an unserved one names the index that would
 * serve it, nothing is refused, and the engine reports it as
 * `_diagnostics[key].plan` only for walk-grammar frames on a store with an
 * index plan.
 */

import { MemoryDataset, MemoryDatasetRegistry } from '@mnmal-ai/substrate-dataset-memory';
import type {
  FieldDef,
  IndexPlan,
  PlanClause,
  ReadParams,
  ReadResult
} from '@mnmal-ai/substrate-types';
import { describe, expect, it } from 'vitest';
import { classifyWalkService } from '../src/advisor/walk-service.js';
import {
  Engine,
  MemoryEdgesStore,
  type NamespaceConfig,
  Registry,
  ShapeRecorder,
  shapeKey
} from '../src/index.js';
import { hopResolver } from '../src/walk-types.js';

const crossRef = (type: string): FieldDef => ({
  kind: 'crossRef',
  ns: 'cards',
  type,
  onDelete: 'set_null'
});
const TYPES: Record<string, Record<string, FieldDef>> = {
  Cert: { grade: { kind: 'scalar', type: 'number' } },
  Observation: {
    cert: crossRef('Cert'),
    observedAt: { kind: 'scalar', type: 'date' },
    price: { kind: 'scalar', type: 'number' }
  },
  Listing: { cert: crossRef('Cert'), price: { kind: 'scalar', type: 'number' } },
  Note: { cert: { ...crossRef('Cert'), indexed: false } as FieldDef }
};

type Indexes = IndexPlan['indexes'];
const idx = (name: string, ...keys: Array<[string, 'asc' | 'desc']>) => ({
  name,
  keys,
  unique: false
});
/** `desiredIndexKeys`' derived crossRef index: the field, then the natural order (createdAt desc). */
const eager = (ref: string) => idx(`${ref}_eager`, [ref, 'asc'], ['createdAt', 'desc']);
const INDEXES: Record<string, Indexes> = {
  Cert: [idx('grade', ['grade', 'asc'], ['id', 'asc'])],
  Observation: [eager('cert'), idx('cert_observed', ['cert', 'asc'], ['observedAt', 'desc'])],
  Listing: [eager('cert')],
  // `indexed: false`: no derived index.
  Note: []
};

const schemaOf = (t: string) => (Object.hasOwn(TYPES, t) ? { fields: TYPES[t] ?? {} } : undefined);
const classify = (entry: Record<string, unknown>, seed = 'Cert'): PlanClause[] =>
  classifyWalkService(
    { entry, seed, resolve: hopResolver('cards', schemaOf), fieldsOf: (t) => schemaOf(t)?.fields },
    (t) => INDEXES[t] ?? []
  );
const where = (w: unknown) => ({ params: { where: w }, fields: { id: true } });
const at = (plan: PlanClause[], ...path: string[]) =>
  plan.find((c) => JSON.stringify(c.path) === JSON.stringify(path));

describe('classifyWalkService', () => {
  it('every hop is served by the eager crossRef index', () => {
    const plan = classify({
      params: {
        where: { _walk: { in: 'cards/Observation.cert', where: { _walk: { out: 'cert' } } } }
      },
      fields: {
        id: true,
        _agg: { n: { in: 'cards/Listing.cert', count: true } },
        obs: { _walk: { in: 'cards/Observation.cert' }, fields: { id: true } }
      }
    });
    const hops = plan.filter((c) => c.kind === 'hop');
    expect(hops.map((c) => c.path)).toEqual([
      ['where', '_walk'],
      ['where', '_walk', 'where', '_walk'],
      ['fields', '_agg', 'n'],
      ['fields', 'obs', '_walk']
    ]);
    expect(hops.every((c) => c.served && c.recommend === undefined)).toBe(true);
    expect(at(plan, 'fields', '_agg', 'n', 'count')).toEqual({
      path: ['fields', '_agg', 'n', 'count'],
      kind: 'agg',
      served: true
    });
  });

  it('a hop over a crossRef with no eager index is unserved and recommends (crossRef)', () => {
    expect(at(classify(where({ _walk: { in: 'cards/Note.cert' } })), 'where', '_walk')).toEqual({
      path: ['where', '_walk'],
      kind: 'hop',
      served: false,
      recommend: { fields: ['cert'] }
    });
  });

  it('a far filter served by (cert, observedAt) is served', () => {
    const plan = classify(
      where({ _walk: { in: 'cards/Observation.cert', where: { observedAt: { gte: 'x' } } } })
    );
    expect(at(plan, 'where', '_walk', 'where', 'observedAt')).toEqual({
      path: ['where', '_walk', 'where', 'observedAt'],
      kind: 'filter',
      served: true
    });
  });

  it('an unserved far filter recommends (crossRef, field)', () => {
    const plan = classify(
      where({ _walk: { in: 'cards/Listing.cert', where: { price: { gte: 5 } } } })
    );
    expect(at(plan, 'where', '_walk', 'where', 'price')).toEqual({
      path: ['where', '_walk', 'where', 'price'],
      kind: 'filter',
      served: false,
      recommend: { fields: ['cert', 'price'] }
    });
  });

  it('orders: the eager index serves natural order, a declared one its field, else recommend', () => {
    const plan = classify({
      params: {},
      fields: {
        id: true,
        a: { _walk: { in: 'cards/Observation.cert' }, orderBy: [{ createdAt: 'desc' }] },
        b: { _walk: { in: 'cards/Observation.cert' }, orderBy: [{ observedAt: 'desc' }] },
        c: { _walk: { in: 'cards/Listing.cert' }, orderBy: [{ price: 'asc' }] },
        d: { _walk: { in: 'cards/Observation.cert' }, orderBy: [{ observedAt: 'asc' }] },
        _agg: {
          last: { in: 'cards/Listing.cert', latest: { by: 'price', value: 'price' } },
          first: { in: 'cards/Observation.cert', min: 'observedAt' }
        }
      }
    });
    // A list's LIMIT needs the index in its own direction: (cert, observedAt DESC) read
    // backward is nulls first, so it does not serve observedAt ascending.
    expect(at(plan, 'fields', 'd', 'orderBy')).toMatchObject({
      served: false,
      recommend: { fields: ['cert', { field: 'observedAt', dir: 'asc' }] }
    });
    // shortcut pinned: an orderBy that spells out its `id` tie-break is reported unserved,
    // though the index plus an incremental sort on id serves it. Conservative, so honest.
    const spelled = classify({
      params: {},
      fields: {
        id: true,
        e: {
          _walk: { in: 'cards/Observation.cert' },
          orderBy: [{ observedAt: 'desc' }, { id: 'asc' }]
        }
      }
    });
    expect(at(spelled, 'fields', 'e', 'orderBy')?.served).toBe(false);
    // A pick or min/max is a min/max probe, which either direction serves.
    expect(at(plan, 'fields', '_agg', 'first', 'min')?.served).toBe(true);
    expect(at(plan, 'fields', 'a', 'orderBy')?.served).toBe(true);
    expect(at(plan, 'fields', 'b', 'orderBy')?.served).toBe(true);
    expect(at(plan, 'fields', 'c', 'orderBy')).toMatchObject({
      kind: 'order',
      served: false,
      recommend: { fields: ['cert', { field: 'price', dir: 'asc' }] }
    });
    expect(at(plan, 'fields', '_agg', 'last', 'latest')).toMatchObject({
      kind: 'agg',
      served: false,
      recommend: { fields: ['cert', { field: 'price', dir: 'desc' }] }
    });
  });

  it('$ref is always served', () => {
    const plan = classify(
      where({
        AND: [
          { _walk: { as: 'L', in: 'cards/Listing.cert' } },
          {
            _walk: {
              in: 'cards/Observation.cert',
              where: { price: { gte: { $ref: 'L.price', times: 1.25 } } }
            }
          }
        ]
      })
    );
    expect(at(plan, 'where', 'AND', '1', '_walk', 'where', 'price')).toEqual({
      path: ['where', 'AND', '1', '_walk', 'where', 'price'],
      kind: 'ref',
      served: true
    });
  });

  it('a select ordering is unserved unless a served clause bounds the result', () => {
    const frame = (w?: unknown) => ({
      params: {
        ...(w !== undefined ? { where: w } : {}),
        select: { m: { sub: ['grade', '_agg.n'] } },
        orderBy: [{ m: 'desc' }]
      },
      fields: { id: true, _agg: { n: { in: 'cards/Listing.cert', count: true } } }
    });
    expect(at(classify(frame()), 'orderBy', '0')).toEqual({
      path: ['orderBy', '0'],
      kind: 'select',
      served: false
    });
    expect(at(classify(frame({ grade: { eq: 9 } })), 'orderBy', '0')?.served).toBe(true);
    // A seed filter no index serves bounds nothing.
    const unbounded = classify({
      ...frame(),
      params: { ...frame().params, where: { id: { neq: 'x' } } }
    });
    expect(at(unbounded, 'orderBy', '0')?.served).toBe(false);
    // Served, yet bounding nothing: under NOT or OR, or only `neq`.
    for (const w of [
      { NOT: { grade: { eq: 9 } } },
      { OR: [{ grade: { eq: 9 } }, { grade: { eq: 10 } }] },
      { grade: { neq: 9 } }
    ]) {
      const plan = classify(frame(w));
      expect(plan.find((c) => c.kind === 'filter')?.served, JSON.stringify(w)).toBe(true);
      expect(at(plan, 'orderBy', '0')?.served, JSON.stringify(w)).toBe(false);
    }
    expect(at(classify(frame({ AND: [{ grade: { gte: 9 } }] })), 'orderBy', '0')?.served).toBe(
      true
    );
  });

  it("a date-truncating group key is served by its field's index, and recommends one otherwise", () => {
    const b = (field: string) =>
      at(
        classify(
          { params: { groupBy: { bucket: { dateTrunc: [{ lit: 'day' }, field] } } } },
          'Observation'
        ),
        'groupBy',
        'bucket'
      );
    expect(b('cert')?.served).toBe(true);
    expect(b('observedAt')).toEqual({
      path: ['groupBy', 'bucket'],
      kind: 'group',
      served: false,
      recommend: { fields: ['observedAt'] }
    });
  });
});

describe('engine: plan and walk shapes', () => {
  const metrics: string[] = [];
  function build(withPlan: boolean | 'throws', recorder?: ShapeRecorder) {
    const ds = new MemoryDataset({ namespace: 'cards', walkReference: true });
    if (withPlan !== false) {
      Object.assign(ds, {
        indexPlan: async (type: string) => {
          if (withPlan === 'throws') throw new Error('catalog gone');
          return { indexes: INDEXES[type] ?? [] };
        }
      });
    }
    const registry = new Registry();
    for (const [name, fields] of Object.entries(TYPES)) {
      registry.register(name, {
        fields,
        policy: () => ({ allow: true }),
        resolver: async (_ctx, args): Promise<ReadResult> =>
          ds.read(name, (args.params ?? {}) as ReadParams)
      });
    }
    const datasets = new MemoryDatasetRegistry();
    datasets.set('cards', ds);
    return new Engine({
      namespaces: new Map<string, NamespaceConfig>([['cards', { registry }]]),
      datasets,
      edges: new MemoryEdgesStore({ now: () => new Date() }),
      metric: (name) => metrics.push(name),
      ...(recorder !== undefined ? { shapeRecorder: recorder } : {})
    });
  }
  const ctx = { identity: null };
  const walkFrame = {
    'cards/Cert': where({ _walk: { in: 'cards/Listing.cert', where: { price: { gte: 5 } } } })
  };

  it('a walk read carries its plan, and runs although a clause is unserved', async () => {
    const env = await build(true).query({ frame: walkFrame, ctx });
    expect(env.errors).toBeUndefined();
    expect(env.data['cards/Cert']).toEqual([]);
    expect(env._diagnostics?.['cards/Cert']?.plan).toEqual([
      { path: ['where', '_walk'], kind: 'hop', served: true },
      {
        path: ['where', '_walk', 'where', 'price'],
        kind: 'filter',
        served: false,
        recommend: { fields: ['cert', 'price'] }
      }
    ]);
  });

  it('an ordinary read, or a store with no index plan, carries no plan', async () => {
    const plain = await build(true).query({
      frame: { 'cards/Cert': where({ grade: { eq: 9 } }) },
      ctx
    });
    expect(plain._diagnostics).toBeUndefined();
    const memory = await build(false).query({ frame: walkFrame, ctx });
    expect(memory.errors).toBeUndefined();
    expect(memory._diagnostics).toBeUndefined();
  });

  it('a failing index plan is a metric and no plan, never a failed read', async () => {
    metrics.length = 0;
    const env = await build('throws').query({ frame: walkFrame, ctx });
    expect(env.errors).toBeUndefined();
    expect(env._diagnostics).toBeUndefined();
    expect(metrics).toContain('engine_walk_plan_failed');
  });

  it('records the seed shape without walk keys, and one far-type shape per walk', async () => {
    const recorder = new ShapeRecorder();
    await build(false, recorder).query({ frame: walkFrame, ctx });
    const shapes = recorder.drain().map((o) => o.shape);
    expect(shapes.map((s) => shapeKey(s)).sort()).toEqual(
      [
        { namespace: 'cards', type: 'Cert', filters: [], orderBy: [['createdAt', 'desc']] },
        {
          namespace: 'cards',
          type: 'Listing',
          filters: [
            { field: 'cert', op: 'eq' },
            { field: 'price', op: 'gte' }
          ],
          orderBy: []
        }
      ]
        .map((s) => shapeKey(s as Parameters<typeof shapeKey>[0]))
        .sort()
    );
  });
});

describe('walk forms (#1815) and a nested list in natural order (#1821)', () => {
  const OBS = 'cards/Observation.cert';
  // Windows need an index leading with the window's field.
  const indexes = (t: string): Indexes =>
    t === 'Observation'
      ? [...(INDEXES.Observation ?? []), idx('observed', ['observedAt', 'desc'], ['id', 'asc'])]
      : (INDEXES[t] ?? []);
  const run = (entry: Record<string, unknown>, seed = 'Cert') =>
    classifyWalkService(
      {
        entry,
        seed,
        resolve: hopResolver('cards', schemaOf),
        fieldsOf: (t) => schemaOf(t)?.fields,
        naturalOrder: () => ({ createdAt: 'desc' })
      },
      indexes
    );
  const w = { observedAt: { gte: '2026-10-01T00:00:00Z' } };
  const windowFrame = (params: Record<string, unknown>, aggWhere: unknown = w) => ({
    params: { where: { _walk: { in: OBS, where: w } }, ...params },
    fields: {
      id: true,
      _agg: {
        n: { in: OBS, where: aggWhere, count: true },
        hi: { in: OBS, where: aggWhere, max: 'price' },
        last: { in: OBS, where: aggWhere, max: 'observedAt' }
      }
    }
  });

  it("a frame _agg over the seeds' own indexed window is group-by when every seed is read", () => {
    const plan = run(windowFrame({ limit: 5000 }));
    expect(at(plan, 'fields', '_agg', 'n')?.form).toBe('group-by');
    expect(at(plan, 'fields', '_agg', 'hi')?.form).toBe('group-by');
    // A date max is a top-1 probe per seed.
    expect(at(plan, 'fields', '_agg', 'last')?.form).toBe('per-seed');
    // A page of 20 seeds is 20 probes; aggregating the whole window would cost more.
    expect(at(run(windowFrame({ limit: 20 })), 'fields', '_agg', 'n')?.form).toBe('per-seed');
    // Another window than the seeds', or a $ref to the seed: per seed.
    const other = run(windowFrame({}, { observedAt: { gte: '2026-10-02T00:00:00Z' } }));
    expect(at(other, 'fields', '_agg', 'n')?.form).toBe('per-seed');
    const ref = run(windowFrame({}, { ...w, price: { gte: { $ref: '$.grade' } } }));
    expect(at(ref, 'fields', '_agg', 'n')?.form).toBe('per-seed');
    // A range on an unindexed field is no index range.
    const unindexed = { price: { gte: 5 } };
    const frame = windowFrame({}, unindexed);
    (frame.params.where._walk as Record<string, unknown>).where = unindexed;
    expect(at(run(frame), 'fields', '_agg', 'n')?.form).toBe('per-seed');
  });

  it('a pick reached through an outbound hop is per-hub on a count, per-seed on a page', () => {
    const where = {
      _walk: {
        out: 'cert',
        where: {
          _walk: {
            in: 'cards/Listing.cert',
            pick: { max: 'price' },
            where: { price: { gte: { $ref: '$.price' } } }
          }
        }
      }
    };
    const path = ['where', '_walk', 'where', '_walk'];
    expect(at(run({ params: { count: true, where } }, 'Observation'), ...path)?.form).toBe(
      'per-hub'
    );
    expect(at(run({ params: { limit: 20, where } }, 'Observation'), ...path)?.form).toBe(
      'per-seed'
    );
    // A whole-result aggregate keeps the per-seed form.
    const aggregate = { n: { count: true } };
    expect(at(run({ params: { aggregate, where } }, 'Observation'), ...path)?.form).toBe(
      'per-seed'
    );
    // Under OR the hub walk is not a conjunct of the seed's where.
    expect(
      at(
        run({ params: { count: true, where: { OR: [where] } } }, 'Observation'),
        'where',
        'OR',
        '0',
        '_walk',
        'where',
        '_walk'
      )?.form
    ).toBe('per-seed');
  });

  it("a nested list without orderBy is planned in the far type's natural order", () => {
    const plan = run({
      params: {},
      fields: { id: true, recent: { _walk: { in: OBS }, fields: { id: true } } }
    });
    // The eager (cert, createdAt DESC) index serves it.
    expect(at(plan, 'fields', 'recent', 'orderBy')).toEqual({
      path: ['fields', 'recent', 'orderBy'],
      kind: 'order',
      served: true
    });
    const notes = run({
      params: {},
      fields: { id: true, notes: { _walk: { in: 'cards/Note.cert' }, fields: { id: true } } }
    });
    expect(at(notes, 'fields', 'notes', 'orderBy')).toMatchObject({
      served: false,
      recommend: { fields: ['cert', { field: 'createdAt', dir: 'desc' }] }
    });
  });

  it("an engine read lists a nested walk in the far type's natural order, ties by id (#1821)", async () => {
    const ds = new MemoryDataset({ namespace: 'cards', walkReference: true });
    Object.assign(ds, { indexPlan: async (type: string) => ({ indexes: INDEXES[type] ?? [] }) });
    const registry = new Registry();
    for (const [name, fields] of Object.entries(TYPES)) {
      registry.register(name, {
        fields,
        ...(name === 'Listing' ? { orderedBy: { price: 'asc' as const } } : {}),
        policy: () => ({ allow: true }),
        // As the autocrud list resolver: nested selections ride out of `fields` as `nested`.
        resolver: async (_ctx, args): Promise<ReadResult> => {
          const nested = Object.fromEntries(
            Object.entries(args.fields ?? {}).filter(
              ([, v]) => typeof v === 'object' && v !== null && '_walk' in v
            )
          );
          return ds.read(name, { ...(args.params ?? {}), nested } as ReadParams);
        }
      });
    }
    const datasets = new MemoryDatasetRegistry();
    datasets.set('cards', ds);
    const engine = new Engine({
      namespaces: new Map<string, NamespaceConfig>([['cards', { registry }]]),
      datasets,
      edges: new MemoryEdgesStore({ now: () => new Date() })
    });
    await ds.write('Cert', [{ id: 'c1', grade: 9 }]);
    // Natural order is price ascending: l2 and l3 tie, so id breaks it; id order alone is l1 first.
    await ds.write('Listing', [
      { id: 'l1', cert: 'c1', price: 5 },
      { id: 'l2', cert: 'c1', price: 3 },
      { id: 'l3', cert: 'c1', price: 3 },
      { id: 'l4', cert: 'c1', price: 9 }
    ]);
    const list = (extra: Record<string, unknown>) =>
      engine.query({
        frame: {
          'cards/Cert': {
            params: {},
            fields: {
              id: true,
              ls: { _walk: { in: 'cards/Listing.cert' }, fields: { price: true }, ...extra }
            }
          }
        },
        ctx: { identity: null }
      });
    const env = await list({ limit: 2 });
    expect(env.errors).toBeUndefined();
    const [row] = env.data['cards/Cert'] as Array<Record<string, unknown>>;
    expect(row?.ls).toEqual([
      { id: 'l2', price: 3 },
      { id: 'l3', price: 3 }
    ]);
    expect(row?._truncated).toEqual({ ls: true });
    // The plan reports the implicit order the list was read in.
    expect(
      env._diagnostics?.['cards/Cert']?.plan?.find((c) => c.path.join('.') === 'fields.ls.orderBy')
    ).toMatchObject({ kind: 'order', served: false });
    // An explicit orderBy is kept.
    const desc = await list({ orderBy: [{ price: 'desc' }] });
    const [d] = desc.data['cards/Cert'] as Array<Record<string, unknown>>;
    expect(((d?.ls ?? []) as Array<{ id: string }>).map((l) => l.id)).toEqual([
      'l4',
      'l1',
      'l2',
      'l3'
    ]);
  });
});

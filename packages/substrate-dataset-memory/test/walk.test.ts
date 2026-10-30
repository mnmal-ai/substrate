/**
 * Typed edge walks over the memory dataset (spec 2026-10-24-typed-edge-walks
 * §1, §5). The memory dataset is the reference the pg compiler must match.
 */

import type { FieldDef, ReadParams, WhereClause } from '@mnmal-ai/substrate-types';
import { describe, expect, it } from 'vitest';
import { MemoryDataset } from '../src/index.js';

const num: FieldDef = { kind: 'scalar', type: 'number' };
const str: FieldDef = { kind: 'scalar', type: 'string' };
const date: FieldDef = { kind: 'scalar', type: 'date' };
const ref = (type: string): FieldDef => ({
  kind: 'crossRef',
  ns: 'cards',
  type,
  onDelete: 'set_null'
});

const SCHEMA: Record<string, Record<string, FieldDef>> = {
  Cert: { grade: num, ask: num, minObs: num },
  Listing: { cert: ref('Cert'), seller: ref('Seller'), price: num, firstSeen: date },
  Observation: { cert: ref('Cert'), price: num, observedAt: date, status: str },
  Seller: { rating: num }
};
const fieldDefLookup = (type: string, field: string): FieldDef | undefined =>
  Object.hasOwn(SCHEMA, type) && Object.hasOwn(SCHEMA[type] ?? {}, field)
    ? SCHEMA[type]?.[field]
    : undefined;

type Rows = Record<string, Array<Record<string, unknown>>>;

async function dataset(rows: Rows, walkBudget?: number): Promise<MemoryDataset> {
  const ds = new MemoryDataset({
    namespace: 'cards',
    fieldDefLookup,
    walkReference: true,
    ...(walkBudget !== undefined ? { walkBudget } : {})
  });
  for (const [type, list] of Object.entries(rows)) await ds.write(type, list as never);
  return ds;
}

async function ids(ds: MemoryDataset, type: string, where: WhereClause): Promise<string[]> {
  const res = await ds.read(type, { where });
  return res.rows.map((r) => String(r.id)).sort();
}

const RECENT = '2026-10-22T00:00:00Z';
const obs = (where?: WhereClause, extra: Record<string, unknown> = {}): WhereClause =>
  ({
    _walk: { in: 'cards/Observation.cert', ...(where ? { where } : {}), ...extra }
  }) as WhereClause;

describe('memory edge walks', () => {
  it('yardstick count on a 3-cert fixture', async () => {
    const ds = await dataset({
      Cert: [
        { id: 'c1', grade: 9 },
        { id: 'c2', grade: 9 },
        { id: 'c3', grade: 8 }
      ],
      Listing: [
        { id: 'l1', cert: 'c1', price: 100, firstSeen: '2026-10-23T00:00:00Z' },
        // c2: the recent listing is too dear, the cheap one is old.
        { id: 'l2a', cert: 'c2', price: 100, firstSeen: '2026-10-23T00:00:00Z' },
        { id: 'l2b', cert: 'c2', price: 50, firstSeen: '2026-10-01T00:00:00Z' },
        { id: 'l3', cert: 'c3', price: 100, firstSeen: '2026-10-23T00:00:00Z' }
      ],
      Observation: [
        { id: 'o1', cert: 'c1', price: 130 },
        { id: 'o2', cert: 'c2', price: 70 },
        { id: 'o3', cert: 'c3', price: 130 }
      ]
    });
    const where = {
      AND: [
        { grade: { eq: 9 } },
        {
          _walk: { as: 'L', in: 'cards/Listing.cert', where: { firstSeen: { gte: RECENT } } }
        },
        {
          _walk: {
            as: 'O',
            in: 'cards/Observation.cert',
            where: { price: { gte: { $ref: 'L.price', times: 1.25 } } }
          }
        }
      ]
    } as WhereClause;
    expect(await ids(ds, 'Cert', where)).toEqual(['c1']);
    // The bindings in one AND group are joint: c2 has a listing satisfying
    // each half, but no single listing satisfying both.
    const independent = {
      AND: [
        { grade: { eq: 9 } },
        { _walk: { in: 'cards/Listing.cert', where: { firstSeen: { gte: RECENT } } } },
        {
          _walk: {
            as: 'L',
            in: 'cards/Listing.cert'
          }
        },
        {
          _walk: {
            in: 'cards/Observation.cert',
            where: { price: { gte: { $ref: 'L.price', times: 1.25 } } }
          }
        }
      ]
    } as WhereClause;
    expect(await ids(ds, 'Cert', independent)).toEqual(['c1', 'c2']);
  });

  it('a binding walk may reference a later sibling binding', async () => {
    const ds = await dataset({
      Cert: [{ id: 'c1' }, { id: 'c2' }],
      Listing: [
        { id: 'l1', cert: 'c1', price: 200 },
        { id: 'l2', cert: 'c2', price: 100 }
      ],
      Observation: [
        { id: 'o1', cert: 'c1', price: 150 },
        { id: 'o2', cert: 'c2', price: 150 }
      ]
    });
    const where = {
      AND: [
        {
          _walk: {
            as: 'L',
            in: 'cards/Listing.cert',
            where: { price: { gt: { $ref: 'O.price' } } }
          }
        },
        { _walk: { as: 'O', in: 'cards/Observation.cert' } }
      ]
    } as WhereClause;
    expect(await ids(ds, 'Cert', where)).toEqual(['c1']);
  });

  it('none and all', async () => {
    const ds = await dataset({
      Cert: [{ id: 'c1' }, { id: 'c2' }],
      Observation: [
        { id: 'o1', cert: 'c1', price: 100 },
        { id: 'o2', cert: 'c1', price: 150 },
        { id: 'o3', cert: 'c2', price: 50 },
        { id: 'o4', cert: 'c2', price: 250 }
      ]
    });
    expect(await ids(ds, 'Cert', obs({ price: { gt: 200 } }, { quantifier: 'none' }))).toEqual([
      'c1'
    ]);
    expect(await ids(ds, 'Cert', obs({ price: { gte: 100 } }, { quantifier: 'all' }))).toEqual([
      'c1'
    ]);
    expect(await ids(ds, 'Cert', obs({ price: { gt: 200 } }, { quantifier: 'any' }))).toEqual([
      'c2'
    ]);
    // A null value fails the predicate, so `all` over it is false.
    await ds.write('Observation', [{ id: 'o5', cert: 'c1', price: null }]);
    expect(await ids(ds, 'Cert', obs({ price: { gte: 100 } }, { quantifier: 'all' }))).toEqual([]);
  });

  it('empty neighbourhood semantics', async () => {
    const ds = await dataset({ Cert: [{ id: 'c1' }], Observation: [] });
    const p = { price: { gt: 0 } };
    expect(await ids(ds, 'Cert', obs(p))).toEqual([]);
    expect(await ids(ds, 'Cert', obs(p, { quantifier: 'none' }))).toEqual(['c1']);
    expect(await ids(ds, 'Cert', obs(p, { quantifier: 'all' }))).toEqual(['c1']);
    expect(await ids(ds, 'Cert', obs(p, { pick: { max: 'price' } }))).toEqual([]);
    // No predicate at all: still no neighbour to pick or find.
    expect(await ids(ds, 'Cert', obs(undefined, { pick: { latest: 'observedAt' } }))).toEqual([]);
    expect(await ids(ds, 'Cert', obs())).toEqual([]);
  });

  it('pick latest/max/min applies the predicate to the one neighbour', async () => {
    const ds = await dataset({
      Cert: [{ id: 'c1' }],
      Observation: [
        { id: 'o1', cert: 'c1', price: 100, observedAt: '2026-10-20T00:00:00Z' },
        // Latest, though it sorts first as text: 12:00+02:00 is 10:00Z.
        { id: 'o2', cert: 'c1', price: 300, observedAt: '2026-10-21T12:00:00+02:00' },
        { id: 'o3', cert: 'c1', price: 200, observedAt: '2026-10-21T09:00:00Z' },
        // A null pick field sorts last in both directions.
        { id: 'o4', cert: 'c1', price: null, observedAt: null }
      ]
    });
    const pick = (p: Record<string, string>, price: number) =>
      ids(ds, 'Cert', obs({ price: { eq: price } }, { pick: p }));
    expect(await pick({ latest: 'observedAt' }, 300)).toEqual(['c1']);
    expect(await pick({ latest: 'observedAt' }, 200)).toEqual([]);
    expect(await pick({ max: 'price' }, 300)).toEqual(['c1']);
    expect(await pick({ max: 'price' }, 200)).toEqual([]);
    expect(await pick({ min: 'price' }, 100)).toEqual(['c1']);
    expect(await pick({ min: 'observedAt' }, 100)).toEqual(['c1']);
    // A null pick field is picked only when every neighbour's is null.
    const nulls = await dataset({
      Cert: [{ id: 'c1' }],
      Observation: [{ id: 'o1', cert: 'c1', price: 5, observedAt: null }]
    });
    expect(
      await ids(nulls, 'Cert', obs({ price: { eq: 5 } }, { pick: { latest: 'observedAt' } }))
    ).toEqual(['c1']);
  });

  it('pick ties break by id ascending', async () => {
    const at = '2026-10-21T00:00:00Z';
    const ds = await dataset({
      Cert: [{ id: 'c1' }],
      Observation: [
        { id: 'o2', cert: 'c1', price: 2, observedAt: at },
        { id: 'o1', cert: 'c1', price: 1, observedAt: at },
        { id: 'o3', cert: 'c1', price: 3, observedAt: at }
      ]
    });
    expect(
      await ids(ds, 'Cert', obs({ price: { eq: 1 } }, { pick: { latest: 'observedAt' } }))
    ).toEqual(['c1']);
    expect(
      await ids(ds, 'Cert', obs({ price: { eq: 1 } }, { pick: { min: 'observedAt' } }))
    ).toEqual(['c1']);
    expect(
      await ids(ds, 'Cert', obs({ price: { eq: 2 } }, { pick: { latest: 'observedAt' } }))
    ).toEqual([]);
  });

  it('null ref operand is never true, under any and none', async () => {
    const ds = await dataset({
      Cert: [{ id: 'c1', ask: null }, { id: 'c2' }],
      Listing: [{ id: 'l1', cert: 'c1', price: null }],
      Observation: [
        { id: 'o1', cert: 'c1', price: 100 },
        { id: 'o2', cert: 'c2', price: 100 }
      ]
    });
    for (const op of ['eq', 'neq', 'gt', 'gte', 'lt', 'lte']) {
      const p = { price: { [op]: { $ref: '$.ask' } } } as WhereClause;
      // The comparison is never true, so no neighbour matches: `any` is
      // false and `none` true, for every operator, eq and neq included.
      expect(await ids(ds, 'Cert', obs(p)), `any ${op}`).toEqual([]);
      expect(await ids(ds, 'Cert', obs(p, { quantifier: 'none' })), `none ${op}`).toEqual([
        'c1',
        'c2'
      ]);
      // `all` counts the failing comparison as a failing neighbour.
      expect(await ids(ds, 'Cert', obs(p, { quantifier: 'all' })), `all ${op}`).toEqual([]);
      // The same through a binding whose field is null.
      const bound = {
        AND: [
          { _walk: { as: 'L', in: 'cards/Listing.cert' } },
          obs({ price: { [op]: { $ref: 'L.price' } } } as WhereClause)
        ]
      } as WhereClause;
      expect(await ids(ds, 'Cert', bound), `bound ${op}`).toEqual([]);
    }
    // A literal `eq: null` keeps its is-null meaning.
    expect(await ids(ds, 'Cert', { ask: { eq: null } })).toEqual(['c1', 'c2']);
  });

  it('$ref times and plus', async () => {
    const ds = await dataset({
      Cert: [
        { id: 'c1', ask: 100 },
        { id: 'c2', ask: 100 },
        { id: 'c3', ask: 'not a number' }
      ],
      Listing: [
        { id: 'l1', cert: 'c1', price: 100, firstSeen: '2026-10-20T00:00:00.000001Z' },
        { id: 'l2', cert: 'c2', price: 100, firstSeen: '2026-10-20T00:00:00Z' }
      ],
      Observation: [
        { id: 'o1', cert: 'c1', price: 130, observedAt: '2026-10-21T00:00:00Z' },
        { id: 'o2', cert: 'c2', price: 129, observedAt: '2026-10-21T00:00:00Z' },
        { id: 'o3', cert: 'c3', price: 1000 }
      ]
    });
    // price >= ask * 1.25 + 5
    expect(
      await ids(ds, 'Cert', obs({ price: { gte: { $ref: '$.ask', times: 1.25, plus: 5 } } }))
    ).toEqual(['c1']);
    expect(await ids(ds, 'Cert', obs({ price: { gt: { $ref: '$.ask', plus: 29 } } }))).toEqual([
      'c1'
    ]);
    // Dates shift by `plus` milliseconds, compared as instants to the microsecond.
    const day = 86_400_000;
    const within = {
      AND: [
        { _walk: { as: 'L', in: 'cards/Listing.cert' } },
        obs({ observedAt: { gte: { $ref: 'L.firstSeen', plus: day } } })
      ]
    } as WhereClause;
    expect(await ids(ds, 'Cert', within)).toEqual(['c2']);
    // Same-row field vs field.
    expect(await ids(ds, 'Listing', { price: { eq: { $ref: '$.price' } } } as WhereClause)).toEqual(
      ['l1', 'l2']
    );
  });

  it('outbound walk follows the body crossRef', async () => {
    const ds = await dataset({
      Cert: [
        { id: 'c1', grade: 9 },
        { id: 'c2', grade: 8 },
        { id: 'c3', grade: 9 }
      ],
      Observation: [
        { id: 'o1', cert: 'c1' },
        { id: 'o2', cert: 'c2' },
        { id: 'o3', cert: 'missing' },
        { id: 'o4', cert: 'c3' },
        { id: 'o5' }
      ]
    });
    await ds.tombstone('Cert', ['c3']);
    const out = (q?: string) =>
      ({
        _walk: { out: 'cert', where: { grade: { eq: 9 } }, ...(q ? { quantifier: q } : {}) }
      }) as WhereClause;
    expect(await ids(ds, 'Observation', out())).toEqual(['o1']);
    expect(await ids(ds, 'Observation', out('none'))).toEqual(['o2', 'o3', 'o4', 'o5']);
    expect(await ids(ds, 'Observation', out('all'))).toEqual(['o1', 'o3', 'o4', 'o5']);
  });

  it('tombstoned neighbours are never walked', async () => {
    const ds = await dataset({
      Cert: [{ id: 'c1' }],
      Observation: [
        { id: 'o1', cert: 'c1', price: 100 },
        { id: 'o2', cert: 'c1', price: 5, observedAt: '2026-10-25T00:00:00Z' }
      ]
    });
    await ds.tombstone('Observation', ['o2']);
    expect(await ids(ds, 'Cert', obs({ price: { lt: 10 } }))).toEqual([]);
    expect(await ids(ds, 'Cert', obs({ price: { gte: 100 } }, { quantifier: 'all' }))).toEqual([
      'c1'
    ]);
    expect(
      await ids(ds, 'Cert', obs({ price: { eq: 100 } }, { pick: { latest: 'observedAt' } }))
    ).toEqual(['c1']);
    // The tombstoned row's own walks still run when it is the seed.
    const res = await ds.read('Observation', {
      includeDeleted: true,
      where: { _walk: { out: 'cert' } } as WhereClause
    });
    expect(res.rows.map((r) => r.id).sort()).toEqual(['o1', 'o2']);
  });

  it('three hops', async () => {
    const ds = await dataset({
      Seller: [
        { id: 's1', rating: 5 },
        { id: 's2', rating: 2 }
      ],
      Cert: [{ id: 'c1' }, { id: 'c2' }],
      Listing: [
        { id: 'l1', cert: 'c1', seller: 's1' },
        { id: 'l2', cert: 'c2', seller: 's2' }
      ],
      Observation: [
        { id: 'o1', cert: 'c1' },
        { id: 'o2', cert: 'c2' }
      ]
    });
    const where = {
      _walk: {
        out: 'cert',
        where: {
          _walk: {
            in: 'cards/Listing.cert',
            where: { _walk: { out: 'seller', where: { rating: { gte: 4 } } } }
          }
        }
      }
    } as WhereClause;
    expect(await ids(ds, 'Observation', where)).toEqual(['o1']);
  });

  it('OR and NOT around walks', async () => {
    const ds = await dataset({
      Cert: [{ id: 'c1' }, { id: 'c2' }, { id: 'c3' }],
      Observation: [
        { id: 'o1', cert: 'c1', price: 100 },
        { id: 'o2', cert: 'c2', price: 5 }
      ]
    });
    const cheap = obs({ price: { lt: 10 } });
    expect(await ids(ds, 'Cert', { NOT: cheap } as WhereClause)).toEqual(['c1', 'c3']);
    expect(
      await ids(ds, 'Cert', { OR: [cheap, obs({ price: { gt: 50 } })] } as WhereClause)
    ).toEqual(['c1', 'c2']);
    // A binding under OR is quantified within its own branch.
    const branch = {
      OR: [
        { AND: [{ _walk: { as: 'O', in: 'cards/Observation.cert' } }, { id: { eq: 'c2' } }] },
        { id: { eq: 'c3' } }
      ]
    } as WhereClause;
    expect(await ids(ds, 'Cert', branch)).toEqual(['c2', 'c3']);
  });

  it('$ref arithmetic is float64', async () => {
    // Ruling: IEEE double defines $ref arithmetic (pg casts both sides to
    // float8), so 0.1 * 3 is 0.30000000000000004, not 0.3.
    const ds = await dataset({
      Cert: [{ id: 'c1', ask: 0.1 }],
      Observation: [{ id: 'o1', cert: 'c1', price: 0.3 }]
    });
    const cmp = (op: string) =>
      ids(ds, 'Cert', obs({ price: { [op]: { $ref: '$.ask', times: 3 } } } as WhereClause));
    expect(await cmp('eq')).toEqual([]);
    expect(await cmp('gte')).toEqual([]);
    expect(await cmp('lt')).toEqual(['c1']);
  });

  it('a $ref to an _agg throws rather than reading as false', async () => {
    const ds = await dataset({
      Cert: [{ id: 'c1' }],
      Observation: [{ id: 'o1', cert: 'c1', price: 1, observedAt: '2026-10-21T00:00:00Z' }]
    });
    const p = { price: { gte: { $ref: '_agg.x' } } } as WhereClause;
    for (const extra of [{}, { quantifier: 'none' }, { pick: { latest: 'observedAt' } }]) {
      await expect(ids(ds, 'Cert', obs(p, extra))).rejects.toThrow(/_agg/);
    }
  });

  it('joint quantification stops at the per-read budget', async () => {
    const n = 1100;
    const listings = Array.from({ length: n }, (_, i) => ({ id: `l${i}`, cert: 'c1', price: 1 }));
    const observations = Array.from({ length: n }, (_, i) => ({
      id: `o${i}`,
      cert: 'c1',
      price: 1
    }));
    // No pair satisfies, so every one of n * n assignments is tried.
    const where = {
      AND: [
        { _walk: { as: 'L', in: 'cards/Listing.cert' } },
        {
          _walk: {
            as: 'O',
            in: 'cards/Observation.cert',
            where: { price: { gt: { $ref: 'L.price' } } }
          }
        }
      ]
    } as WhereClause;
    const rows = { Cert: [{ id: 'c1' }], Listing: listings, Observation: observations };
    const capped = await dataset(rows, 100_000);
    await expect(capped.read('Cert', { where })).rejects.toMatchObject({
      code: 'walk_budget_exceeded'
    });
    // Under the budget the same walk answers.
    const roomy = await dataset(rows, 2 * n * n);
    expect((await roomy.read('Cert', { where })).rows).toEqual([]);
  });
});

const OBS = 'cards/Observation.cert';

describe('memory walk aggregates, count, buckets and derive', () => {
  it('declares walks only as the test reference', () => {
    expect(new MemoryDataset({ namespace: 'cards' }).capabilities.walks).toBe(false);
    const ref = new MemoryDataset({ namespace: 'cards', walkReference: true });
    expect(ref.capabilities.walks).toBe(true);
    expect(ref.forNamespace('other').capabilities.walks).toBe(true);
  });

  it('feature row: latest, 7-day avg, count', async () => {
    const ds = await dataset({
      Cert: [
        { id: 'c1', grade: 9 },
        { id: 'c2', grade: 8 }
      ],
      Observation: [
        { id: 'o1', cert: 'c1', price: 100, observedAt: '2026-10-10T00:00:00Z' },
        { id: 'o2', cert: 'c1', price: 120, observedAt: '2026-10-20T00:00:00Z' },
        { id: 'o3', cert: 'c1', price: 140, observedAt: '2026-10-23T00:00:00Z' },
        { id: 'o4', cert: 'c1', price: 1, observedAt: null }
      ]
    });
    const res = await ds.read('Cert', {
      orderBy: [{ id: 'asc' }],
      agg: {
        offers7d: { in: OBS, where: { observedAt: { gte: '2026-10-17T00:00:00Z' } }, avg: 'price' },
        obsCount: { in: OBS, count: true },
        latestOffer: { in: OBS, latest: { by: 'observedAt', value: 'price' } }
      }
    });
    expect(res.rows.map((r) => [r.id, r.grade, r._agg])).toEqual([
      ['c1', 9, { offers7d: 130, obsCount: 4, latestOffer: 140 }],
      ['c2', 8, { offers7d: null, obsCount: 0, latestOffer: null }]
    ]);
    // The stored rows are not decorated.
    expect((await ds.read('Cert', { id: 'c1' })).rows[0]?._agg).toBeUndefined();
  });

  it('avg/sum/min/max ignore nulls; count of none is 0, others null', async () => {
    const ds = await dataset({
      Cert: [{ id: 'c1' }, { id: 'c2' }],
      Observation: [
        { id: 'o1', cert: 'c1', price: 10 },
        { id: 'o2', cert: 'c1', price: null },
        { id: 'o3', cert: 'c1', price: 'n/a' },
        { id: 'o4', cert: 'c1', price: 30 },
        { id: 'o5', cert: 'c1' }
      ]
    });
    const agg = {
      avg: { in: OBS, avg: 'price' },
      sum: { in: OBS, sum: 'price' },
      min: { in: OBS, min: 'price' },
      max: { in: OBS, max: 'price' },
      n: { in: OBS, count: true }
    } as ReadParams['agg'];
    const res = await ds.read('Cert', { orderBy: [{ id: 'asc' }], ...(agg ? { agg } : {}) });
    expect(res.rows.map((r) => r._agg)).toEqual([
      { avg: 20, sum: 40, min: 10, max: 30, n: 5 },
      { avg: null, sum: null, min: null, max: null, n: 0 }
    ]);
  });

  it('_agg in where filters', async () => {
    const ds = await dataset({
      Cert: [
        { id: 'c1', ask: 50 },
        { id: 'c2', ask: 50 },
        { id: 'c3', ask: 50 }
      ],
      Observation: [
        { id: 'o1', cert: 'c1', price: 60 },
        { id: 'o2', cert: 'c1', price: 70 },
        { id: 'o3', cert: 'c1', price: 80 },
        { id: 'o4', cert: 'c2', price: 10 }
      ]
    });
    const atLeast3 = { _agg: { in: OBS, count: true }, gte: 3 } as WhereClause;
    expect(await ids(ds, 'Cert', atLeast3)).toEqual(['c1']);
    // A null aggregate matches nothing, neq included.
    const avgNeq = { _agg: { in: OBS, avg: 'price' }, neq: 10 } as WhereClause;
    expect(await ids(ds, 'Cert', avgNeq)).toEqual(['c1']);
    // A `$ref` to a frame `_agg` reads that seed's value.
    const res = await ds.read('Cert', {
      where: obs({ price: { gt: { $ref: '_agg.avgPrice' } } }),
      agg: { avgPrice: { in: OBS, avg: 'price' } }
    });
    expect(res.rows.map((r) => [r.id, r._agg])).toEqual([['c1', { avgPrice: 70 }]]);
  });

  it('nested list honours its where, orderBy, limit and marks _truncated', async () => {
    const ds = await dataset({
      Seller: [{ id: 's1', rating: 5 }],
      Cert: [{ id: 'c1' }, { id: 'c2' }],
      Listing: [
        { id: 'l1', cert: 'c1', seller: 's1', price: 30, firstSeen: '2026-10-01T00:00:00Z' },
        { id: 'l2', cert: 'c1', seller: 's1', price: 10, firstSeen: '2026-10-03T00:00:00Z' },
        { id: 'l3', cert: 'c1', seller: 's1', price: 20, firstSeen: '2026-10-02T00:00:00Z' },
        { id: 'l4', cert: 'c1', price: 99, firstSeen: '2026-10-04T00:00:00Z' },
        { id: 'l5', cert: 'c2', seller: 's1', price: 5, firstSeen: '2026-10-04T00:00:00Z' }
      ],
      Observation: [{ id: 'o1', cert: 'c1', price: 7 }]
    });
    const listings = {
      _walk: { in: 'cards/Listing.cert', where: { price: { lt: 50 } } },
      where: { seller: { eq: 's1' } },
      fields: {
        price: true,
        seller: { _walk: { out: 'seller' }, fields: { rating: true } },
        // A nested aggregate hops from the listing back to its cert.
        _agg: { cheaperObs: { out: 'cert', count: true } }
      },
      orderBy: [{ firstSeen: 'desc' }],
      limit: 2
    };
    const res = await ds.read('Cert', {
      orderBy: [{ id: 'asc' }],
      nested: { listings } as NonNullable<ReadParams['nested']>
    });
    const [c1, c2] = res.rows;
    expect(c1?.listings).toEqual([
      { id: 'l2', price: 10, seller: [{ id: 's1', rating: 5 }], _agg: { cheaperObs: 1 } },
      { id: 'l3', price: 20, seller: [{ id: 's1', rating: 5 }], _agg: { cheaperObs: 1 } }
    ]);
    expect(c1?._truncated).toEqual({ listings: true });
    expect(c2?.listings).toEqual([
      { id: 'l5', price: 5, seller: [{ id: 's1', rating: 5 }], _agg: { cheaperObs: 1 } }
    ]);
    expect(c2?._truncated).toBeUndefined();
  });

  it('count returns the number and no rows', async () => {
    const ds = await dataset({
      Cert: [
        { id: 'c1', grade: 9 },
        { id: 'c2', grade: 9 },
        { id: 'c3', grade: 8 }
      ],
      Observation: [{ id: 'o1', cert: 'c1' }]
    });
    // The page limit does not cap a count.
    expect(await ds.read('Cert', { where: { grade: { eq: 9 } }, count: true, limit: 1 })).toEqual({
      rows: [],
      hasMore: false,
      count: 2
    });
    expect((await ds.read('Cert', { where: obs(), count: true })).count).toBe(1);
  });

  it('aggregate over the whole result', async () => {
    const ds = await dataset({
      Observation: [
        { id: 'o1', price: 10 },
        { id: 'o2', price: 30 },
        { id: 'o3', price: null },
        { id: 'o4', price: 100 }
      ]
    });
    const res = await ds.read('Observation', {
      where: { price: { neq: 100 } },
      aggregate: { n: { count: true }, avgOffer: { avg: 'price' }, top: { max: 'price' } }
    });
    expect(res).toEqual({
      rows: [],
      hasMore: false,
      groups: [{ n: 3, avgOffer: 20, top: 30 }]
    });
    // Over no rows: one group, count 0, the rest null.
    const none = await ds.read('Observation', {
      where: { price: { gt: 1000 } },
      aggregate: { n: { count: true }, s: { sum: 'price' } }
    });
    expect(none.groups).toEqual([{ n: 0, s: null }]);
  });

  it('bucket by day in UTC across a midnight boundary', async () => {
    const ds = await dataset({
      Observation: [
        // 23:30 at -02:00 is 01:30 the next day in UTC.
        { id: 'o1', price: 10, observedAt: '2026-10-24T23:30:00-02:00' },
        { id: 'o2', price: 20, observedAt: '2026-10-24T23:59:59.999Z' },
        { id: 'o3', price: 30, observedAt: '2026-10-25T00:00:00Z' },
        // Null and non-date bucket values fall in no bucket.
        { id: 'o4', price: 40, observedAt: null },
        { id: 'o5', price: 50, observedAt: 'yesterday' }
      ]
    });
    const res = await ds.read('Observation', {
      aggregate: { n: { count: true }, avgOffer: { avg: 'price' } },
      bucket: { field: 'observedAt', by: 'day' }
    });
    expect(res.groups).toEqual([
      { bucket: '2026-10-24', n: 1, avgOffer: 20 },
      { bucket: '2026-10-25', n: 2, avgOffer: 20 }
    ]);
    expect(res.rows).toEqual([]);
    expect(res.truncated).toBeUndefined();
  });

  it('bucket by hour', async () => {
    const ds = await dataset({
      Observation: [
        { id: 'o1', observedAt: '2026-10-24T10:59:59Z' },
        { id: 'o2', observedAt: '2026-10-24T09:00:00Z' },
        { id: 'o3', observedAt: '2026-10-24T10:00:00Z' }
      ]
    });
    const res = await ds.read('Observation', {
      aggregate: { n: { count: true } },
      bucket: { field: 'observedAt', by: 'hour' }
    });
    expect(res.groups).toEqual([
      { bucket: '2026-10-24T09', n: 1 },
      { bucket: '2026-10-24T10', n: 2 }
    ]);
  });

  it('groups beyond the page max set truncated', async () => {
    const ds = await dataset({
      Observation: ['01', '02', '03'].map((d) => ({
        id: `o${d}`,
        observedAt: `2026-10-${d}T00:00:00Z`
      }))
    });
    const res = await ds.read('Observation', {
      aggregate: { n: { count: true } },
      bucket: { field: 'observedAt', by: 'day' },
      limit: 2
    });
    expect(res).toEqual({
      rows: [],
      hasMore: false,
      groups: [
        { bucket: '2026-10-01', n: 1 },
        { bucket: '2026-10-02', n: 1 }
      ],
      truncated: true
    });
  });

  it('derive diff orders desc and pages with a stable cursor', async () => {
    const ds = await dataset({
      Cert: [
        { id: 'c1', grade: 10, ask: 4 }, // 6
        { id: 'c2', grade: 10, ask: 1 }, // 9
        { id: 'c3', grade: 10, ask: 7 }, // 3
        { id: 'c4', grade: 9, ask: 3 }, // 6, ties c1: id ascending
        { id: 'c5', grade: 10, ask: 2 } // 8
      ]
    });
    const params: ReadParams = {
      derive: { margin: { diff: ['$.grade', '$.ask'] } },
      orderBy: [{ $margin: 'desc' }],
      limit: 2
    };
    const pages: string[][] = [];
    let cursor: string | undefined;
    do {
      const res = await ds.read('Cert', { ...params, ...(cursor ? { cursor } : {}) });
      pages.push(res.rows.map((r) => String(r.id)));
      // Derived values order the page; they are not added to the rows.
      for (const r of res.rows) expect(Object.hasOwn(r, '$margin')).toBe(false);
      cursor = res.nextCursor;
    } while (cursor !== undefined);
    expect(pages).toEqual([['c2', 'c5'], ['c1', 'c4'], ['c3']]);
    // The cursor is issued for the `$margin` order and refused under another.
    const first = await ds.read('Cert', params);
    await expect(
      ds.read('Cert', { ...params, orderBy: [{ $margin: 'asc' }], cursor: first.nextCursor ?? '' })
    ).rejects.toMatchObject({ code: 'invalid_cursor' });
  });

  it('derive null and zero divisor sort last', async () => {
    const ds = await dataset({
      Cert: [
        { id: 'c1', grade: 10, ask: 0 }, // zero divisor
        { id: 'c2', grade: 10, ask: 5 }, // 2
        { id: 'c3', ask: 5 }, // null operand
        { id: 'c4', grade: 10, ask: 2 } // 5
      ],
      Observation: [
        { id: 'o1', cert: 'c2', price: 6 },
        { id: 'o2', cert: 'c4', price: 1 }
      ]
    });
    const read = async (dir: 'asc' | 'desc') =>
      (
        await ds.read('Cert', {
          derive: { r: { ratio: ['$.grade', '$.ask'] } },
          orderBy: [{ $r: dir }]
        })
      ).rows.map((r) => r.id);
    expect(await read('desc')).toEqual(['c4', 'c2', 'c1', 'c3']);
    expect(await read('asc')).toEqual(['c2', 'c4', 'c1', 'c3']);
    // An `_agg` operand: c1 and c3 have no observations, so a null latest.
    const byAgg = await ds.read('Cert', {
      agg: { last: { in: OBS, latest: { by: 'observedAt', value: 'price' } } },
      derive: { d: { diff: ['_agg.last', '$.ask'] } },
      orderBy: [{ $d: 'asc' }]
    });
    expect(byAgg.rows.map((r) => [r.id, r._agg])).toEqual([
      ['c4', { last: 1 }],
      ['c2', { last: 6 }],
      ['c1', { last: null }],
      ['c3', { last: null }]
    ]);
  });
});

describe('walk budget covers all walk work', () => {
  const many = (n: number, f: (i: number) => Record<string, unknown>) =>
    Array.from({ length: n }, (_, i) => f(i));
  const rows: Rows = {
    Cert: [{ id: 'c1' }],
    Listing: many(50, (i) => ({ id: `l${i}`, cert: 'c1', price: 1 })),
    Observation: many(50, (i) => ({ id: `o${i}`, cert: 'c1', price: 1 }))
  };
  const budgetError = { code: 'walk_budget_exceeded' };

  it('an unbound 3-hop walk', async () => {
    // 50 listings, each one cert, each 50 observations: 2,600 far rows, none matching.
    const where = {
      _walk: {
        in: 'cards/Listing.cert',
        where: { _walk: { out: 'cert', where: obs({ price: { gt: 1000 } }) } }
      }
    } as WhereClause;
    await expect((await dataset(rows, 1000)).read('Cert', { where })).rejects.toMatchObject(
      budgetError
    );
    expect((await (await dataset(rows, 10_000)).read('Cert', { where })).rows).toEqual([]);
  });

  it('an _agg', async () => {
    const agg = { n: { in: OBS, count: true } } as ReadParams['agg'];
    const params = { ...(agg ? { agg } : {}) };
    await expect((await dataset(rows, 10)).read('Cert', params)).rejects.toMatchObject(budgetError);
    expect((await (await dataset(rows, 100)).read('Cert', params)).rows[0]?._agg).toEqual({
      n: 50
    });
  });

  it('a nested selection', async () => {
    const nested = {
      obs: { _walk: { in: OBS }, fields: { price: true }, limit: 1 }
    } as ReadParams['nested'];
    const params = { ...(nested ? { nested } : {}) };
    await expect((await dataset(rows, 10)).read('Cert', params)).rejects.toMatchObject(budgetError);
    expect((await (await dataset(rows, 100)).read('Cert', params)).rows[0]?._truncated).toEqual({
      obs: true
    });
  });
});

describe('task 8 review fixes', () => {
  it('a nested walk back to the seed computes its own _agg, not the frame one', async () => {
    const ds = await dataset({
      Cert: [{ id: 'c1' }],
      Listing: [{ id: 'l1', cert: 'c1', price: 1 }],
      Observation: [
        { id: 'o1', cert: 'c1', price: 10 },
        { id: 'o2', cert: 'c1', price: 30 }
      ]
    });
    const res = await ds.read('Cert', {
      // A frame `_agg` with the same name `b` but another aggregate.
      agg: { b: { in: OBS, sum: 'price' } },
      nested: {
        listings: {
          _walk: { in: 'cards/Listing.cert' },
          fields: {
            cert: {
              _walk: { out: 'cert' },
              fields: { _agg: { b: { in: OBS, count: true }, c: { in: OBS, max: 'price' } } }
            }
          }
        }
      } as NonNullable<ReadParams['nested']>
    });
    expect(res.rows[0]?._agg).toEqual({ b: 40 });
    expect(res.rows[0]?.listings).toEqual([
      { id: 'l1', cert: [{ id: 'c1', _agg: { b: 2, c: 30 } }] }
    ]);
  });

  it('a $ref beside _agg resolves', async () => {
    const ds = await dataset({
      Cert: [{ id: 'c1', minObs: 2 }, { id: 'c2', minObs: 3 }, { id: 'c3' }],
      Observation: [
        { id: 'o1', cert: 'c1' },
        { id: 'o2', cert: 'c1' },
        { id: 'o3', cert: 'c2' },
        { id: 'o4', cert: 'c3' }
      ]
    });
    const where = { _agg: { in: OBS, count: true }, gte: { $ref: '$.minObs' } } as WhereClause;
    // c3's null minObs matches nothing.
    expect(await ids(ds, 'Cert', where)).toEqual(['c1']);
    const scaled = {
      _agg: { in: OBS, count: true },
      gte: { $ref: '$.minObs', times: 0.5 }
    } as WhereClause;
    expect(await ids(ds, 'Cert', scaled)).toEqual(['c1']);
  });

  it('max over a date projects the latest stored date', async () => {
    const ds = await dataset({
      Cert: [{ id: 'c1' }, { id: 'c2' }],
      Observation: [
        { id: 'o1', cert: 'c1', observedAt: '2026-10-09T23:30:00Z' },
        // Later as text, earlier as an instant (2026-10-09T23:00Z).
        { id: 'o2', cert: 'c1', observedAt: '2026-10-10T01:00:00+02:00' },
        { id: 'o3', cert: 'c1', observedAt: '2026-09-30T00:00:00Z' },
        { id: 'o4', cert: 'c1', observedAt: null },
        { id: 'o5', cert: 'c2', observedAt: 'never' }
      ]
    });
    const res = await ds.read('Cert', {
      orderBy: [{ id: 'asc' }],
      agg: {
        last: { in: OBS, max: 'observedAt' },
        first: { in: OBS, min: 'observedAt' }
      }
    });
    expect(res.rows.map((r) => r._agg)).toEqual([
      { last: '2026-10-09T23:30:00Z', first: '2026-09-30T00:00:00Z' },
      { last: null, first: null }
    ]);
    // The frame aggregate reads dates the same way.
    const whole = await ds.read('Observation', { aggregate: { last: { max: 'observedAt' } } });
    expect(whole.groups).toEqual([{ last: '2026-10-09T23:30:00Z' }]);
    // Instants: 2026-10-10T01:00+02:00 is 2026-10-09T23:00Z, after 2026-10-09T00:00Z.
    const ds2 = await dataset({
      Cert: [{ id: 'c1' }],
      Observation: [
        { id: 'o1', cert: 'c1', observedAt: '2026-10-09T00:00:00Z' },
        { id: 'o2', cert: 'c1', observedAt: '2026-10-10T01:00:00+02:00' }
      ]
    });
    const r2 = await ds2.read('Cert', { agg: { last: { in: OBS, max: 'observedAt' } } });
    expect(r2.rows[0]?._agg).toEqual({ last: '2026-10-10T01:00:00+02:00' });
  });

  it('a where-side latest string value and a date-max predicate match by kind', async () => {
    const ds = await dataset({
      Cert: [{ id: 'c1' }, { id: 'c2' }],
      Observation: [
        { id: 'o1', cert: 'c1', status: 'listed', observedAt: '2026-10-01T00:00:00Z' },
        { id: 'o2', cert: 'c1', status: 'sold', observedAt: '2026-10-20T00:00:00Z' },
        { id: 'o3', cert: 'c2', status: 'sold', observedAt: '2026-10-01T00:00:00Z' },
        { id: 'o4', cert: 'c2', status: 'listed', observedAt: '2026-10-05T00:00:00+00:00' }
      ]
    });
    const sold = {
      _agg: { in: OBS, latest: { by: 'observedAt', value: 'status' } },
      eq: 'sold'
    } as unknown as WhereClause;
    expect(await ids(ds, 'Cert', sold)).toEqual(['c1']);
    // As instants: '2026-10-05T00:00:00+00:00' >= '2026-10-05T00:00:00Z', though as text it sorts before.
    const recent = {
      _agg: { in: OBS, max: 'observedAt' },
      gte: '2026-10-05T00:00:00Z'
    } as unknown as WhereClause;
    expect(await ids(ds, 'Cert', recent)).toEqual(['c1', 'c2']);
  });

  it('$ and _agg.x inside a nested selection where resolve against the seed; absent fields are null', async () => {
    const ds = await dataset({
      Cert: [
        { id: 'c1', ask: 15 },
        { id: 'c2', ask: 100 }
      ],
      Listing: [
        { id: 'l1', cert: 'c1', price: 10 },
        { id: 'l2', cert: 'c1', price: 20 },
        { id: 'l3', cert: 'c1', price: 30 },
        { id: 'l4', cert: 'c1' },
        { id: 'l5', cert: 'c2', price: 50 }
      ]
    });
    const res = await ds.read('Cert', {
      orderBy: [{ id: 'asc' }],
      // c1: avg 20; c2: avg 50.
      agg: { avg: { in: 'cards/Listing.cert', avg: 'price' } },
      nested: {
        above: {
          _walk: { in: 'cards/Listing.cert' },
          where: { price: { gt: { $ref: '$.ask' }, lte: { $ref: '_agg.avg' } } },
          fields: { price: true, firstSeen: true },
          orderBy: [{ price: 'asc' }]
        },
        all: {
          _walk: { in: 'cards/Listing.cert' },
          fields: { price: true },
          orderBy: [{ id: 'asc' }]
        }
      } as NonNullable<ReadParams['nested']>
    });
    expect(res.rows[0]?.above).toEqual([{ id: 'l2', price: 20, firstSeen: null }]);
    expect(res.rows[1]?.above).toEqual([]);
    expect(res.rows[0]?.all).toContainEqual({ id: 'l4', price: null });
  });
});

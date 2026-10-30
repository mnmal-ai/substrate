/**
 * Typed edge walks over the memory dataset (spec 2026-10-24-typed-edge-walks
 * §1, §5). The memory dataset is the reference the pg compiler must match.
 */

import type { FieldDef, WhereClause } from '@mnmal-ai/substrate-types';
import { describe, expect, it } from 'vitest';
import { MemoryDataset } from '../src/index.js';

const num: FieldDef = { kind: 'scalar', type: 'number' };
const date: FieldDef = { kind: 'scalar', type: 'date' };
const ref = (type: string): FieldDef => ({
  kind: 'crossRef',
  ns: 'cards',
  type,
  onDelete: 'set_null'
});

const SCHEMA: Record<string, Record<string, FieldDef>> = {
  Cert: { grade: num, ask: num },
  Listing: { cert: ref('Cert'), seller: ref('Seller'), price: num, firstSeen: date },
  Observation: { cert: ref('Cert'), price: num, observedAt: date },
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
    // Small enough for a slow CI runner; the cap below is far under n * n.
    const n = 300;
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
    const capped = await dataset(rows, 10_000);
    await expect(capped.read('Cert', { where })).rejects.toMatchObject({
      code: 'walk_budget_exceeded'
    });
    // Under the budget the same walk answers.
    const roomy = await dataset(rows, 2 * n * n);
    expect((await roomy.read('Cert', { where })).rows).toEqual([]);
  });
});

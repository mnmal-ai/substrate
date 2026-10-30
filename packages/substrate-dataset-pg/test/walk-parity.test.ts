/**
 * Cross-dataset walk parity (spec 2026-10-24-typed-edge-walks §4): every case
 * reads the two named fixtures through pg and the memory reference, expects
 * the same answer from both, and checks that answer. Walks need the
 * partitioned layout, so the legacy pass only proves the refusal.
 */

import { createHash, randomBytes } from 'node:crypto';
import { MemoryDataset } from '@mnmal-ai/substrate-dataset-memory';
import {
  type FieldDef,
  type ReadParams,
  type Row,
  WALK_BUDGET_EXCEEDED,
  WALKS_NEED_PARTITIONED,
  type WhereClause
} from '@mnmal-ai/substrate-types';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PgDataset } from '../src/index.js';
import { walkComparers } from './_walk-helpers.js';
import {
  CARDS,
  RECENT,
  REF_FIELDS,
  RUNS,
  TOMBSTONED,
  walkSchema
} from './fixtures/walk-fixtures.js';

const POSTGRES_URL = process.env.POSTGRES_URL;
const PARTITIONED = process.env.SUBSTRATE_TEST_LAYOUT === 'partitioned';
const NS = `wpar_${randomBytes(4).toString('hex')}`;
const SCHEMA = walkSchema(NS);
const fieldDefLookup = (type: string, field: string): FieldDef | undefined =>
  Object.hasOwn(SCHEMA, type) && Object.hasOwn(SCHEMA[type] ?? {}, field)
    ? SCHEMA[type]?.[field]
    : undefined;
const typeDefLookup = (type: string) =>
  Object.hasOwn(SCHEMA, type) ? { fields: SCHEMA[type] ?? {} } : undefined;

/** A stable uuid per fixture name, since pg ids must be uuids. */
const names = new Map<string, string>();
function u(name: string): string {
  const h = createHash('sha1').update(name).digest('hex');
  const id = `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
  names.set(id, name);
  return id;
}
const name = (r: Row) => names.get(String(r.id)) ?? String(r.id);
const fx = (rows: ReadonlyArray<Record<string, unknown>>) =>
  rows.map((r) =>
    Object.fromEntries(
      Object.entries(r).map(([k, v]) => [k, REF_FIELDS.has(k) && typeof v === 'string' ? u(v) : v])
    )
  );

let sql: Sql;
let pg: PgDataset;
let mem: MemoryDataset;
const { same, sameResult } = walkComparers(
  () => ({ pg, mem }),
  (id) => names.get(id) ?? id
);

/** A memory reference holding both fixtures. */
async function memory(walkBudget?: number): Promise<MemoryDataset> {
  const ds = new MemoryDataset({
    namespace: NS,
    fieldDefLookup,
    walkReference: true,
    ...(walkBudget === undefined ? {} : { walkBudget })
  });
  for (const [type, rows] of Object.entries({ ...CARDS, ...RUNS })) {
    await ds.write(type, fx(rows) as never);
  }
  for (const [type, ids] of Object.entries(TOMBSTONED)) await ds.tombstone(type, ids.map(u));
  return ds;
}

const walk = (target: string) => `${NS}/${target}`;
const OBS = walk('Observation.cert');
const LISTING = walk('Listing.cert');
const obs = (where?: WhereClause, extra: Record<string, unknown> = {}) =>
  ({ _walk: { in: OBS, ...(where ? { where } : {}), ...extra } }) as WhereClause;
const agg = (a: Record<string, unknown>) => a as unknown as NonNullable<ReadParams['agg']>;
const aggregate = (a: Record<string, unknown>) =>
  a as unknown as NonNullable<ReadParams['aggregate']>;

/** Spec §1: PSA 9 certs with a recent listing and an observation >= 1.25x THAT listing's price. */
const CARD_YARDSTICK = {
  AND: [
    { grade: { eq: 9 } },
    { _walk: { as: 'L', in: LISTING, where: { firstSeen: { gte: RECENT } } } },
    { _walk: { as: 'O', in: OBS, where: { price: { gte: { $ref: 'L.price', times: 1.25 } } } } }
  ]
} as WhereClause;

/** Pg-gated tests with a recent local run >= 1.25x a recent CI run, skipped runs excluded. */
const recentRun = (extra: WhereClause[] = []) =>
  ({ AND: [{ at: { gte: RECENT } }, { status: { neq: 'skipped' } }, ...extra] }) as WhereClause;
const RUN_YARDSTICK = {
  AND: [
    { pgGated: { eq: true } },
    { _walk: { as: 'C', in: walk('CiRun.test'), where: recentRun() } },
    {
      _walk: {
        as: 'L',
        in: walk('LocalRun.test'),
        where: recentRun([{ durationMs: { gte: { $ref: 'C.durationMs', times: 1.25 } } }])
      }
    }
  ]
} as WhereClause;

/**
 * [name, type, params, expected]. A row read expects fixture names (in order
 * under an orderBy, else sorted) or partial rows by name; a count or
 * aggregate expects a partial result.
 */
type Expected = string[] | Record<string, unknown>;
const mustAgree: Array<[string, string, ReadParams, Expected]> = [
  ['any', 'Cert', { where: obs({ price: { gt: 120 } }) }, ['c1', 'c5', 'c6']],
  [
    'none',
    'Cert',
    { where: obs({ price: { gt: 120 } }, { quantifier: 'none' }) },
    ['c2', 'c3', 'c4', 'c7']
  ],
  [
    'all, vacuous over a tombstoned-only cert',
    'Cert',
    { where: obs({ price: { gte: 90 } }, { quantifier: 'all' }) },
    ['c1', 'c3', 'c5', 'c6', 'c7']
  ],
  [
    'pick latest',
    'Cert',
    { where: obs({ status: { eq: 'listed' } }, { pick: { latest: 'observedAt' } }) },
    ['c2', 'c4', 'c5']
  ],
  [
    'pick max',
    'Cert',
    { where: obs({ price: { gte: 500 } }, { pick: { max: 'price' } }) },
    ['c5', 'c6']
  ],
  ['pick min', 'Cert', { where: obs({ price: { lt: 80 } }, { pick: { min: 'price' } }) }, ['c2']],
  [
    '$ref to the seed, times',
    'Cert',
    { where: obs({ price: { gte: { $ref: '$.ask', times: 1.25 } } }) },
    ['c1', 'c3', 'c5', 'c6']
  ],
  [
    '$ref to the seed, plus',
    'Cert',
    { where: obs({ price: { gt: { $ref: '$.ask', plus: 400 } } }) },
    ['c6']
  ],
  [
    'date $ref to a binding, plus an hour',
    'Cert',
    {
      where: {
        AND: [
          { _walk: { as: 'L', in: LISTING } },
          obs({ observedAt: { gte: { $ref: 'L.firstSeen', plus: 3_600_000 } } })
        ]
      } as WhereClause
    },
    ['c1', 'c2', 'c3', 'c6']
  ],
  [
    'OR around a walk',
    'Cert',
    { where: { OR: [obs({ price: { gt: 600 } }), { grade: { eq: 8 } }] } as WhereClause },
    ['c3', 'c6']
  ],
  [
    'NOT around a walk',
    'Cert',
    { where: { NOT: obs({ status: { eq: 'sold' } }) } as WhereClause },
    ['c2', 'c4', 'c7']
  ],
  [
    'NOT around a bound group',
    'Cert',
    { where: { AND: [{ grade: { eq: 9 } }, { NOT: CARD_YARDSTICK }] } as WhereClause },
    ['c2', 'c4', 'c5', 'c6', 'c7']
  ],
  [
    'outbound then inbound, two hops',
    'Observation',
    {
      where: {
        _walk: {
          out: 'cert',
          where: { _walk: { in: LISTING, where: { firstSeen: { lt: RECENT } } } }
        }
      } as WhereClause
    },
    ['o2']
  ],
  [
    'outbound walk',
    'Observation',
    { where: { _walk: { out: 'cert', where: { grade: { eq: 8 } } } } as WhereClause },
    ['o3']
  ],
  [
    '_agg count filter',
    'Cert',
    { where: { _agg: { in: OBS, count: true }, gte: 2 } as unknown as WhereClause },
    ['c1', 'c5']
  ],
  [
    '_agg avg filter',
    'Cert',
    { where: { _agg: { in: OBS, avg: 'price' }, gt: 400 } as unknown as WhereClause },
    ['c5', 'c6']
  ],
  [
    '_agg count of 0 skips tombstones',
    'Cert',
    { where: { _agg: { in: OBS, count: true }, eq: 0 } as unknown as WhereClause },
    ['c7']
  ],
  [
    'null ref operand is never true, under any',
    'Cert',
    {
      where: {
        AND: [{ _walk: { as: 'L', in: LISTING } }, obs({ price: { gte: { $ref: 'L.price' } } })]
      } as WhereClause
    },
    ['c1', 'c2', 'c3']
  ],
  [
    'null ref operand is never true, under none',
    'Cert',
    {
      where: {
        AND: [
          { _walk: { as: 'L', in: LISTING } },
          obs({ price: { gte: { $ref: 'L.price', times: 1.25 } } }, { quantifier: 'none' })
        ]
      } as WhereClause
    },
    ['c2', 'c4', 'c6', 'c7']
  ],
  ['card yardstick rows', 'Cert', { where: CARD_YARDSTICK }, ['c1']],
  ['card yardstick count', 'Cert', { where: CARD_YARDSTICK, count: true }, { count: 1 }],
  ['run yardstick rows', 'Test', { where: RUN_YARDSTICK }, ['t1']],
  ['run yardstick count', 'Test', { where: RUN_YARDSTICK, count: true }, { count: 1 }],
  ['count over a type never written', 'Empty', { count: true }, { rows: [], count: 0 }],
  [
    'aggregate over a type never written',
    'Empty',
    { aggregate: aggregate({ n: { count: true } }) },
    { rows: [], groups: [{ n: 0 }] }
  ],
  [
    '_agg fields, a feature row per cert',
    'Cert',
    {
      where: { grade: { eq: 9 } },
      agg: agg({
        n: { in: OBS, count: true },
        avg: { in: OBS, avg: 'price' },
        hi: { in: OBS, max: 'price' },
        last: { in: OBS, latest: { by: 'observedAt', value: 'price' } },
        recent: { in: OBS, where: { observedAt: { gte: RECENT } }, count: true }
      })
    },
    {
      c1: { _agg: { n: 2, avg: 110, hi: 130, last: 130, recent: 1 } },
      c4: { _agg: { n: 1, avg: null, hi: null, last: null, recent: 1 } },
      c7: { _agg: { n: 0, avg: null, hi: null, last: null, recent: 0 } }
    }
  ],
  [
    '_agg fields over runs',
    'Test',
    {
      agg: agg({
        local: { in: walk('LocalRun.test'), count: true },
        ciAvg: { in: walk('CiRun.test'), avg: 'durationMs' }
      })
    },
    { t2: { _agg: { local: 2, ciAvg: 100 } }, t4: { _agg: { local: 1, ciAvg: 125 } } }
  ],
  [
    'nested lists, cut and whole',
    'Cert',
    {
      where: { grade: { eq: 9 } },
      nested: {
        latest: {
          _walk: { in: OBS },
          fields: { price: true, status: true },
          orderBy: [{ observedAt: 'desc' }],
          limit: 1
        }
      } as unknown as NonNullable<ReadParams['nested']>
    },
    {
      c1: { latest: [{ price: 130, status: 'sold' }], _truncated: { latest: true } },
      c2: { latest: [{ price: 70, status: 'listed' }] },
      c7: { latest: [] }
    }
  ],
  [
    'count with a walk',
    'Cert',
    { where: obs({ status: { eq: 'sold' } }), count: true },
    { count: 4 }
  ],
  [
    'aggregate over a window',
    'Observation',
    {
      where: { observedAt: { gte: RECENT } },
      aggregate: aggregate({ n: { count: true }, avg: { avg: 'price' }, hi: { max: 'price' } })
    },
    { groups: [{ n: 6, avg: 350, hi: 1000 }] }
  ],
  [
    'bucket by day, with a walk in where',
    'Observation',
    {
      where: { _walk: { out: 'cert', where: { grade: { eq: 9 } } } } as WhereClause,
      aggregate: aggregate({ n: { count: true } }),
      bucket: { field: 'observedAt', by: 'day' }
    },
    {
      groups: [
        { bucket: '2026-10-25', n: 1 },
        { bucket: '2026-10-27', n: 1 },
        { bucket: '2026-10-29', n: 5 }
      ]
    }
  ],
  [
    'bucket local runs by hour',
    'LocalRun',
    {
      where: { status: { neq: 'skipped' } },
      aggregate: aggregate({ n: { count: true }, avg: { avg: 'durationMs' } }),
      bucket: { field: 'at', by: 'hour' }
    },
    {
      groups: [
        { bucket: '2026-10-20T02', n: 1, avg: 300 },
        { bucket: '2026-10-29T02', n: 5, avg: 306 }
      ]
    }
  ]
];

/** [name, where it is raised, type, params, code]: only codes a dataset raises. */
const mustRefuse: Array<[string, 'legacy pg' | 'memory budget', string, ReadParams, string]> = [
  [
    'a walk on a legacy store',
    'legacy pg',
    'Cert',
    { where: CARD_YARDSTICK },
    WALKS_NEED_PARTITIONED
  ],
  [
    'the card yardstick over a lowered budget',
    'memory budget',
    'Cert',
    { where: CARD_YARDSTICK },
    WALK_BUDGET_EXCEEDED
  ],
  [
    'an _agg feature row over a lowered budget',
    'memory budget',
    'Test',
    { agg: agg({ n: { in: walk('LocalRun.test'), count: true } }) },
    WALK_BUDGET_EXCEEDED
  ]
];

beforeAll(async () => {
  if (!POSTGRES_URL) return;
  sql = postgres(POSTGRES_URL, { onnotice: () => {} });
  pg = new PgDataset({ namespace: NS, sql, fieldDefLookup, typeDefLookup });
  if (!PARTITIONED) return;
  for (const type of Object.keys(SCHEMA)) await pg.ensureTypeStorage(type);
  for (const [type, rows] of Object.entries({ ...CARDS, ...RUNS })) {
    await pg.write(type, fx(rows) as never);
  }
  for (const [type, ids] of Object.entries(TOMBSTONED)) await pg.tombstone(type, ids.map(u));
  mem = await memory();
});

afterAll(async () => {
  if (!POSTGRES_URL) return;
  await sql`DELETE FROM rows WHERE namespace = ${NS}`;
  await sql.end({ timeout: 5 });
});

describe.skipIf(!POSTGRES_URL || PARTITIONED)('walk parity, legacy pass (pg)', () => {
  it.each(mustRefuse.filter((c) => c[1] === 'legacy pg'))('%s refuses', async (...c) => {
    const [, , type, params, code] = c;
    await expect(pg.read(type, params)).rejects.toMatchObject({ code });
  });
});

describe.skipIf(!POSTGRES_URL || !PARTITIONED)('walk parity across memory and pg', () => {
  it.each(mustAgree)('%s', async (_name, type, params, expected) => {
    if (params.count === true || params.aggregate !== undefined) {
      expect(await sameResult(type, params)).toMatchObject(expected);
      return;
    }
    const rows = await same(type, params);
    if (!Array.isArray(expected)) {
      expect(Object.fromEntries(rows.map((r) => [name(r), r]))).toMatchObject(expected);
      return;
    }
    const got = rows.map(name);
    expect(params.orderBy === undefined ? got.sort() : got).toEqual(expected);
  });

  it.each(mustRefuse.filter((c) => c[1] === 'memory budget'))('%s refuses', async (...c) => {
    const [, , type, params, code] = c;
    const tight = await memory(3);
    await expect(tight.read(type, params)).rejects.toMatchObject({ code });
    // pg carries no evaluation budget: it answers as the unbounded reference does.
    await same(type, params);
  });

  it('derive pages agree, value and cursor, across both datasets', async () => {
    const derives = [
      { m: { diff: ['_agg.last', '$.ask'] } },
      { m: { ratio: ['_agg.last', '$.ask'] } }
    ] as Array<NonNullable<ReadParams['derive']>>;
    const pages = async (ds: PgDataset | MemoryDataset, params: ReadParams) => {
      const out: string[][] = [];
      let cursor: string | undefined;
      do {
        const res = await ds.read('Cert', { ...params, ...(cursor ? { cursor } : {}) });
        out.push(res.rows.map(name));
        cursor = res.nextCursor;
      } while (cursor !== undefined && out.length < 20);
      return out;
    };
    for (const derive of derives) {
      for (const dir of ['asc', 'desc'] as const) {
        const base: ReadParams = {
          agg: agg({ last: { in: OBS, latest: { by: 'observedAt', value: 'price' } } }),
          derive,
          orderBy: [{ $m: dir }]
        };
        const full = (await same('Cert', base)).map(name);
        // c1 130-100, c2 70-80, c3 100-20, c5 450-300, c6 1000-10; c4 and c7 have no latest price.
        expect(full.slice(-2).sort(), JSON.stringify(base)).toEqual(['c4', 'c7']);
        const paged = await pages(pg, { ...base, limit: 2 });
        expect(paged, JSON.stringify(base)).toEqual(await pages(mem, { ...base, limit: 2 }));
        expect(paged.flat()).toEqual(full);
      }
    }
  });
});

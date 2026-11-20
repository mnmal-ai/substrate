/**
 * Walk parity across namespaces: each case reads the two-namespace fixture
 * (`crossSchema`) through pg and the memory reference, both holding the same
 * rows in two namespaces of one store, expects the same answer from both, and
 * checks that answer. A case names the namespace it seeds from.
 */

import { createHash, randomBytes } from 'node:crypto';
import { MemoryDataset } from '@mnmal-ai/substrate-dataset-memory';
import type { ReadParams, Row, WhereClause } from '@mnmal-ai/substrate-types';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PgDataset } from '../src/index.js';
import { dropNamespace, relationOf } from './_layout.js';
import { strip, walkComparers } from './_walk-helpers.js';
import {
  CROSS_FAR,
  CROSS_NEAR,
  CROSS_TOMBSTONED,
  crossSchema,
  REF_FIELDS
} from './fixtures/walk-fixtures.js';

const POSTGRES_URL = process.env.POSTGRES_URL;
const tag = randomBytes(4).toString('hex');
const A = `xpa_${tag}`;
const B = `xpb_${tag}`;
const SCHEMA = crossSchema(A, B);
const fieldDefLookupFor = (ns: string) => (type: string, field: string) =>
  Object.hasOwn(SCHEMA[ns]?.[type] ?? {}, field) ? SCHEMA[ns]?.[type]?.[field] : undefined;
const typeDefLookup = (type: string, ns: string) => {
  const fields = SCHEMA[ns]?.[type];
  return fields === undefined ? undefined : { fields };
};

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

type Seed = 'A' | 'B';
let sql: Sql;
let traced: Sql;
let sent: string[] = [];
let pg: Record<Seed, PgDataset>;
let mem: Record<Seed, MemoryDataset>;
const label = (id: string) => names.get(id) ?? id;
/** A row without its null scalars, which memory keeps and pg omits (so a null ref compares equal). */
const dropNulls = (r: Row): Row =>
  Object.fromEntries(Object.entries(strip(r)).filter(([, v]) => v !== null)) as Row;
const cmp = {
  A: walkComparers(() => ({ pg: pg.A, mem: mem.A }), label),
  B: walkComparers(() => ({ pg: pg.B, mem: mem.B }), label)
};

const loads = [
  [A, CROSS_NEAR],
  [B, CROSS_FAR]
] as const;

const OBS = `${B}/Observation.cert`;
const LST = `${B}/Listing.cert`;
const TK = `${A}/Ticket.cert`;
const NEVER = `${B}/Never.cert`;
const w = (x: unknown) => x as WhereClause;
const walk = (node: Record<string, unknown>) => w({ _walk: node });
const agg = (a: Record<string, unknown>) => a as unknown as NonNullable<ReadParams['agg']>;
const nested = (n: Record<string, unknown>) => n as unknown as NonNullable<ReadParams['nested']>;
/** A range on the indexed `price`, the window an `_agg` can group in one pass. */
const WINDOW = { price: { gte: 100 } };
const grade9 = { grade: { eq: 9 } };
/** The crossing `Listing` pick of a cert, judged on a price. */
const lastListing = (extra: Record<string, unknown> = {}) => ({
  in: LST,
  pick: { latest: 'firstSeen' },
  where: { price: { gte: 100 } },
  ...extra
});

/**
 * [name, seed namespace, type, params, expected]. A row read expects fixture
 * names (in order under an orderBy, else sorted) or partial rows by name; a
 * count expects a partial result.
 */
type Expected = string[] | Record<string, unknown>;
const mustAgree: Array<[string, Seed, string, ReadParams, Expected]> = [
  // Inbound: near certs, far observations.
  [
    'in any',
    'A',
    'Cert',
    { where: walk({ in: OBS, where: { price: { gt: 120 } } }) },
    ['c1', 'c5', 'c6']
  ],
  [
    'in none',
    'A',
    'Cert',
    { where: walk({ in: OBS, where: { price: { gt: 120 } }, quantifier: 'none' }) },
    ['c2', 'c3', 'c4', 'c7']
  ],
  [
    'in all, vacuous over a tombstoned-only cert',
    'A',
    'Cert',
    { where: walk({ in: OBS, where: { price: { gte: 90 } }, quantifier: 'all' }) },
    ['c1', 'c3', 'c5', 'c6', 'c7']
  ],
  [
    'in pick latest',
    'A',
    'Cert',
    {
      where: walk({ in: OBS, where: { status: { eq: 'listed' } }, pick: { latest: 'observedAt' } })
    },
    ['c2', 'c4', 'c5']
  ],
  [
    'in pick max',
    'A',
    'Cert',
    { where: walk({ in: OBS, where: { price: { gte: 500 } }, pick: { max: 'price' } }) },
    ['c5', 'c6']
  ],
  [
    'in pick min',
    'A',
    'Cert',
    { where: walk({ in: OBS, where: { price: { lt: 80 } }, pick: { min: 'price' } }) },
    ['c2']
  ],
  [
    'in pick latest among the unsold',
    'A',
    'Cert',
    {
      where: walk({
        in: OBS,
        where: { price: { lt: 100 } },
        pick: { latest: 'observedAt' },
        among: { NOT: { status: { eq: 'sold' } } }
      })
    },
    ['c1', 'c2']
  ],
  [
    'in pick max among a seed-relative window',
    'A',
    'Cert',
    {
      where: walk({
        in: OBS,
        pick: { max: 'price' },
        among: { price: { lte: { $ref: '$.ask', times: 1.25 } } }
      })
    },
    ['c1', 'c2']
  ],
  [
    'in pick over a type never written',
    'A',
    'Cert',
    { where: walk({ in: NEVER, pick: { max: 'n' } }) },
    []
  ],
  // Outbound: tickets to far observations, far observations to near certs.
  [
    'out any',
    'A',
    'Ticket',
    { where: walk({ out: 'obs', where: { price: { gt: 120 } } }) },
    ['tk1', 'tk4']
  ],
  [
    'out none',
    'A',
    'Ticket',
    { where: walk({ out: 'obs', where: { price: { gt: 120 } }, quantifier: 'none' }) },
    ['tk2', 'tk3', 'tk5', 'tk6']
  ],
  [
    'out all, vacuous over a null or tombstoned target',
    'A',
    'Ticket',
    { where: walk({ out: 'obs', where: { price: { gte: 100 } }, quantifier: 'all' }) },
    ['tk1', 'tk3', 'tk4', 'tk5', 'tk6']
  ],
  [
    'out pick latest',
    'B',
    'Observation',
    { where: walk({ out: 'cert', where: grade9, pick: { latest: 'ask' } }) },
    ['o1a', 'o1b', 'o2', 'o4', 'o5', 'o5b', 'o6']
  ],
  [
    'out pick max',
    'B',
    'Observation',
    { where: walk({ out: 'cert', where: { ask: { gte: 100 } }, pick: { max: 'ask' } }) },
    ['o1a', 'o1b', 'o5', 'o5b']
  ],
  [
    'out pick min',
    'B',
    'Observation',
    { where: walk({ out: 'cert', where: { ask: { lt: 50 } }, pick: { min: 'ask' } }) },
    ['o3', 'o6']
  ],
  [
    'out pick on a ticket, among a far window',
    'A',
    'Ticket',
    {
      where: walk({
        out: 'obs',
        pick: { max: 'price' },
        among: { status: { eq: 'listed' } },
        where: { price: { gte: 100 } }
      })
    },
    ['tk4']
  ],
  // as bindings across namespaces.
  [
    'as binding a far row, read by another far walk',
    'A',
    'Cert',
    {
      where: w({
        AND: [
          { _walk: { as: 'L', in: LST, where: { firstSeen: { gte: '2026-10-28T00:00:00Z' } } } },
          { _walk: { in: OBS, where: { price: { gte: { $ref: 'L.price', times: 1.25 } } } } }
        ]
      })
    },
    ['c1', 'c3']
  ],
  [
    'as binding a near row from a far seed, read inside a walk back to the far namespace',
    'B',
    'Observation',
    {
      where: w({
        AND: [
          { _walk: { as: 'C', out: 'cert' } },
          {
            _walk: {
              out: 'cert',
              where: { _walk: { in: LST, where: { price: { gte: { $ref: 'C.ask' } } } } }
            }
          }
        ]
      })
    },
    ['o1a', 'o1b', 'o2', 'o4']
  ],
  // _agg in where.
  [
    '_agg count in where',
    'A',
    'Cert',
    { where: w({ _agg: { in: OBS, count: true }, gte: 2 }) },
    ['c1', 'c5']
  ],
  [
    '_agg avg in where',
    'A',
    'Cert',
    { where: w({ _agg: { in: OBS, avg: 'price' }, gt: 400 }) },
    ['c5', 'c6']
  ],
  [
    '_agg count of 0 skips tombstones',
    'A',
    'Cert',
    { where: w({ _agg: { in: OBS, count: true }, eq: 0 }) },
    ['c7']
  ],
  [
    '_agg over an out hop in where',
    'A',
    'Ticket',
    { where: w({ _agg: { out: 'obs', max: 'price' }, gt: 100 }) },
    ['tk1', 'tk4']
  ],
  // _agg in fields, with picks.
  [
    '_agg fields with latest, date min and max, number min and max',
    'A',
    'Cert',
    {
      where: { grade: { eq: 9 } },
      agg: agg({
        n: { in: OBS, count: true },
        last: { in: OBS, latest: { by: 'observedAt', value: 'price' } },
        newest: { in: OBS, max: 'observedAt' },
        oldest: { in: OBS, min: 'observedAt' },
        hi: { in: OBS, max: 'price' },
        lo: { in: OBS, min: 'price' },
        listed: {
          in: LST,
          where: { price: { gte: 100 } },
          latest: { by: 'firstSeen', value: 'price' }
        }
      })
    },
    {
      c1: { _agg: { n: 2, last: 130, hi: 130, lo: 90, listed: 100 } },
      c5: { _agg: { n: 2, last: 450, hi: 500, lo: 450, listed: null } },
      c7: { _agg: { n: 0, last: null, newest: null, oldest: null, hi: null, lo: null } }
    }
  ],
  [
    '_agg fields over an out hop',
    'A',
    'Ticket',
    {
      agg: agg({
        price: { out: 'obs', max: 'price' },
        at: { out: 'obs', latest: { by: 'observedAt', value: 'status' } }
      })
    },
    {
      tk1: { _agg: { price: 130, at: 'sold' } },
      tk5: { _agg: { price: null, at: null } },
      tk6: { _agg: { price: null, at: null } }
    }
  ],
  [
    '_agg fields over a type never written',
    'A',
    'Cert',
    { agg: agg({ n: { in: NEVER, count: true }, hi: { in: NEVER, max: 'n' } }) },
    { c1: { _agg: { n: 0, hi: null } } }
  ],
  // Nested selections, with order and limit.
  [
    'nested inbound list, cut and whole',
    'A',
    'Cert',
    {
      where: { grade: { eq: 9 } },
      nested: nested({
        latest: {
          _walk: { in: OBS },
          fields: { price: true, status: true },
          orderBy: [{ observedAt: 'desc' }],
          limit: 1
        }
      })
    },
    {
      c1: { latest: [{ price: 130, status: 'sold' }], _truncated: { latest: true } },
      c2: { latest: [{ price: 70, status: 'listed' }] },
      c7: { latest: [] }
    }
  ],
  [
    'nested outbound list',
    'A',
    'Ticket',
    { nested: nested({ o: { _walk: { out: 'obs' }, fields: { price: true } } }) },
    { tk1: { o: [{ price: 130 }] }, tk5: { o: [] }, tk6: { o: [] } }
  ],
  [
    'nested far list whose where walks back and picks',
    'A',
    'Cert',
    {
      where: { grade: { eq: 9 } },
      nested: nested({
        o: {
          _walk: { in: OBS },
          where: { _walk: { out: 'cert', where: walk(lastListing()) } },
          fields: { price: true },
          orderBy: [{ price: 'asc' }]
        }
      })
    },
    { c1: { o: [{ price: 90 }, { price: 130 }] }, c5: { o: [] } }
  ],
  [
    'nested far list ordered and cut',
    'A',
    'Cert',
    {
      where: { grade: { eq: 9 } },
      nested: nested({
        o: { _walk: { in: OBS }, fields: { price: true }, orderBy: [{ price: 'asc' }], limit: 1 }
      })
    },
    { c1: { o: [{ price: 90 }] }, c5: { o: [{ price: 450 }] } }
  ],
  // A walk inside a walk.
  [
    'in then out, back to the near namespace',
    'A',
    'Cert',
    { where: walk({ in: OBS, where: walk({ out: 'cert', where: { ask: { gte: 100 } } }) }) },
    ['c1', 'c5']
  ],
  [
    'out then out, near to far to near',
    'A',
    'Ticket',
    { where: walk({ out: 'obs', where: walk({ out: 'cert', where: grade9 }) }) },
    ['tk1', 'tk2', 'tk4']
  ],
  [
    'in then in inside the far namespace',
    'A',
    'Cert',
    { where: walk({ in: TK, where: walk({ out: 'obs', where: { status: { eq: 'sold' } } }) }) },
    ['c1', 'c3']
  ],
  // A crossing walk beside a single-namespace walk.
  [
    'a crossing walk and a single-namespace walk in one where',
    'A',
    'Cert',
    {
      where: w({
        AND: [
          { _walk: { in: TK, where: { label: { neq: 'a' } } } },
          { _walk: { in: OBS, where: { price: { gt: 120 } } } }
        ]
      })
    },
    ['c5']
  ],
  [
    'a crossing _agg and a single-namespace _agg in one where',
    'A',
    'Cert',
    {
      where: w({
        AND: [
          { _agg: { in: TK, count: true }, gte: 1 },
          { _agg: { in: OBS, count: true }, gte: 2 }
        ]
      })
    },
    ['c1', 'c5']
  ],
  [
    'a single-namespace out walk and a crossing in walk',
    'A',
    'Ticket',
    {
      where: w({
        AND: [
          { _walk: { out: 'cert', where: grade9 } },
          { _walk: { out: 'obs', where: { status: { eq: 'listed' } } } }
        ]
      })
    },
    ['tk2', 'tk4']
  ],
  // Same-named types.
  [
    'a same-named far type is not the near one',
    'B',
    'Observation',
    { where: walk({ out: 'cert', where: { grade: { eq: 1 } } }) },
    []
  ],
  [
    'a same-named type seeds on its own rows',
    'B',
    'Cert',
    { where: { grade: { eq: 1 } } },
    ['c1', 'c2']
  ],
  [
    'near cert grades, read through the far hop',
    'B',
    'Observation',
    { where: walk({ out: 'cert', where: { grade: { eq: 8 } } }) },
    ['o3']
  ],
  // Shared and per-seed pick forms with crossing hops.
  [
    'a shared pick through an out hop, counted',
    'B',
    'Observation',
    { where: walk({ out: 'cert', where: walk(lastListing()) }), count: true },
    { count: 4 }
  ],
  [
    'a shared pick through an out hop, a page of every seed',
    'B',
    'Observation',
    { where: walk({ out: 'cert', where: walk(lastListing()) }) },
    ['o1a', 'o1b', 'o2', 'o4']
  ],
  [
    'a shared pick with a far-only among',
    'B',
    'Observation',
    {
      where: walk({
        out: 'cert',
        where: walk(lastListing({ among: { price: { gt: 50 } }, pick: { max: 'price' } }))
      })
    },
    ['o1a', 'o1b', 'o2', 'o4']
  ],
  [
    'a shared min pick through a crossing out hop',
    'B',
    'Observation',
    {
      where: walk({
        out: 'cert',
        where: walk(lastListing({ pick: { min: 'price' }, where: { price: { lt: 50 } } }))
      }),
      count: true
    },
    { count: 2 }
  ],
  [
    'a shared pick from a near seed, local out hop and far pick',
    'A',
    'Ticket',
    { where: walk({ out: 'cert', where: walk(lastListing()) }), count: true },
    { count: 3 }
  ],
  // Window and shared forms: Observation.price and .observedAt are indexed, Listing is not.
  [
    'in pick latest, counted',
    'A',
    'Cert',
    {
      where: walk({ in: OBS, where: { status: { eq: 'listed' } }, pick: { latest: 'observedAt' } }),
      count: true
    },
    { count: 3 }
  ],
  [
    'in pick max, counted',
    'A',
    'Cert',
    {
      where: walk({ in: OBS, where: { price: { gte: 500 } }, pick: { max: 'price' } }),
      count: true
    },
    { count: 2 }
  ],
  [
    'in pick min, counted',
    'A',
    'Cert',
    { where: walk({ in: OBS, where: { price: { lt: 80 } }, pick: { min: 'price' } }), count: true },
    { count: 1 }
  ],
  [
    'a windowed _agg beside a pick _agg, a page of every seed',
    'A',
    'Cert',
    {
      where: walk({ in: OBS, where: WINDOW }),
      agg: agg({
        n: { in: OBS, where: WINDOW, count: true },
        tot: { in: OBS, where: WINDOW, sum: 'price' },
        last: { in: OBS, latest: { by: 'observedAt', value: 'price' } }
      })
    },
    {
      c1: { _agg: { n: 1, tot: 130, last: 130 } },
      c3: { _agg: { n: 1, tot: 100, last: 100 } },
      c5: { _agg: { n: 2, tot: 950, last: 450 } },
      c6: { _agg: { n: 1, tot: 1000, last: 1000 } }
    }
  ],
  [
    'the same windowed _agg on a short page',
    'A',
    'Cert',
    {
      where: walk({ in: OBS, where: WINDOW }),
      limit: 10,
      agg: agg({
        n: { in: OBS, where: WINDOW, count: true },
        tot: { in: OBS, where: WINDOW, sum: 'price' }
      })
    },
    { c1: { _agg: { n: 1, tot: 130 } }, c5: { _agg: { n: 2, tot: 950 } } }
  ],
  // Picks and out-hop aggregates beyond latest.
  [
    'nested far list whose where walks back and picks the max',
    'A',
    'Cert',
    {
      where: { grade: { eq: 9 } },
      nested: nested({
        o: {
          _walk: { in: OBS },
          where: { _walk: { out: 'cert', where: walk(lastListing({ pick: { max: 'price' } })) } },
          fields: { price: true },
          orderBy: [{ price: 'asc' }]
        }
      })
    },
    { c1: { o: [{ price: 90 }, { price: 130 }] }, c5: { o: [] } }
  ],
  [
    'nested far list whose where walks back and picks the min',
    'A',
    'Cert',
    {
      where: { grade: { eq: 9 } },
      nested: nested({
        o: {
          _walk: { in: OBS },
          where: {
            _walk: {
              out: 'cert',
              where: walk(lastListing({ pick: { min: 'price' }, where: { price: { lt: 50 } } }))
            }
          },
          fields: { price: true },
          orderBy: [{ price: 'asc' }]
        }
      })
    },
    { c1: { o: [] }, c2: { o: [{ price: 70 }] } }
  ],
  [
    '_agg min and max over an out hop, number and date',
    'A',
    'Ticket',
    {
      agg: agg({
        lo: { out: 'obs', min: 'price' },
        hi: { out: 'obs', max: 'price' },
        first: { out: 'obs', min: 'observedAt' },
        last: { out: 'obs', max: 'observedAt' }
      })
    },
    {
      tk1: {
        _agg: {
          lo: 130,
          hi: 130,
          first: '2026-10-29T10:00:00Z',
          last: '2026-10-29T10:00:00Z'
        }
      },
      tk6: { _agg: { lo: null, hi: null, first: null, last: null } }
    }
  ],
  // Types and namespaces with no rows.
  ['in any over a type never written', 'A', 'Cert', { where: walk({ in: NEVER }) }, []],
  [
    'in none over a type never written',
    'A',
    'Cert',
    { where: walk({ in: NEVER, quantifier: 'none' }) },
    ['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7']
  ],
  [
    'in all over a type never written',
    'A',
    'Cert',
    { where: walk({ in: NEVER, quantifier: 'all', where: { n: { gt: 1 } } }) },
    ['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7']
  ],
  [
    '_agg count over a type never written, in where',
    'A',
    'Cert',
    { where: w({ _agg: { in: NEVER, count: true }, eq: 0 }), count: true },
    { count: 7 }
  ],
  [
    'nested over a type never written',
    'A',
    'Cert',
    {
      where: { grade: { eq: 8 } },
      nested: nested({ n: { _walk: { in: NEVER }, fields: { n: true } } })
    },
    { c3: { n: [] } }
  ],
  // Counts and aggregates.
  [
    'count with a crossing walk',
    'A',
    'Cert',
    { where: walk({ in: OBS, where: { status: { eq: 'sold' } } }), count: true },
    { count: 4 }
  ]
];

beforeAll(async () => {
  if (!POSTGRES_URL) return;
  sql = postgres(POSTGRES_URL, { onnotice: () => {} });
  traced = postgres(POSTGRES_URL, {
    onnotice: () => {},
    debug: (_c, query) => {
      sent.push(query);
    }
  });
  const root = new PgDataset({
    namespace: A,
    sql: traced,
    fieldDefLookup: fieldDefLookupFor(A),
    fieldDefLookupFor,
    typeDefLookup
  });
  pg = { A: root, B: root.forNamespace(B) as PgDataset };
  const memRoot = new MemoryDataset({
    namespace: A,
    walkReference: true,
    fieldDefLookup: fieldDefLookupFor(A),
    fieldDefLookupFor
  });
  mem = { A: memRoot, B: memRoot.forNamespace(B) as MemoryDataset };
  for (const [ns, rows] of loads) {
    const seed: Seed = ns === A ? 'A' : 'B';
    for (const [type, data] of Object.entries(rows)) {
      await pg[seed].ensureTypeStorage(type);
      await pg[seed].write(type, fx(data) as never);
      await mem[seed].write(type, fx(data) as never);
    }
  }
  for (const [type, ids] of Object.entries(CROSS_TOMBSTONED)) {
    await pg.B.tombstone(type, ids.map(u));
    await mem.B.tombstone(type, ids.map(u));
  }
}, 60_000);

afterAll(async () => {
  if (!POSTGRES_URL) return;
  await dropNamespace(sql, A);
  await dropNamespace(sql, B);
  await traced.end({ timeout: 5 });
  await sql.end({ timeout: 5 });
});

describe.skipIf(!POSTGRES_URL)('walk parity across namespaces, memory and pg', () => {
  it.each(mustAgree)('%s', async (_name, seed, type, params, expected) => {
    if (params.count === true) {
      expect(await cmp[seed].sameResult(type, params)).toMatchObject(expected);
      return;
    }
    const read = async (ds: PgDataset | MemoryDataset) =>
      (await ds.read(type, params)).rows.map(dropNulls);
    const rows = await read(mem[seed]);
    expect(await read(pg[seed]), JSON.stringify(params)).toEqual(rows);
    if (!Array.isArray(expected)) {
      expect(Object.fromEntries(rows.map((r) => [name(r), r]))).toMatchObject(expected);
      return;
    }
    const got = rows.map(name);
    expect(params.orderBy === undefined ? got.sort() : got).toEqual(expected);
  });

  it('a windowed _agg across namespaces groups the far window in one pass (group-by form)', async () => {
    const frame = (limit?: number): ReadParams => ({
      where: walk({ in: OBS, where: WINDOW }),
      ...(limit === undefined ? {} : { limit }),
      agg: agg({ n: { in: OBS, where: WINDOW, count: true } })
    });
    const far = await relationOf(sql, B, 'Observation');
    const statement = () =>
      sent.find((q) => q.includes(far) && /GROUP BY/i.test(q) && /count\(/i.test(q));
    sent = [];
    await pg.A.read('Cert', frame());
    expect(statement()).toBeDefined();
    sent = [];
    await pg.A.read('Cert', frame(10));
    expect(statement()).toBeUndefined();
  });
});

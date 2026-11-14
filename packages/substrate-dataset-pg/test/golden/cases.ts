/**
 * The golden-eval set (Decision #627, Todo #1859): synthetic rows and the
 * reads run over them. Each read's answer on Postgres is recorded in
 * `expected.json`, and `golden.test.ts` checks pg (and memory, where it can)
 * against it value for value. Seeded from the memory-vs-pg parity suites
 * (backend-filter, cursor-orderby, grouped, select-expr, null-absent,
 * tables-dataset misfits, walk-parity), which named each rule first.
 *
 * Ids are fixture names; the suite maps them, and every crossRef value, to
 * stable uuids and back, so `expected.json` reads in names.
 */

import { field } from '@mnmal-ai/substrate-sdk';
import type { FieldDef, ReadParams } from '@mnmal-ai/substrate-types';
import { CARDS, RECENT, RUNS, TOMBSTONED, walkSchema } from '../fixtures/walk-fixtures.js';

export const NS = 'golden_evals';

export const SCHEMA: Record<string, Record<string, FieldDef>> = {
  ...walkSchema(NS),
  Item: {
    title: field.string(),
    n: field.number({ nullable: true }),
    big: field.int64({ nullable: true }),
    status: field.enum(['open', 'closed'], { nullable: true }),
    at: field.date({ nullable: true }),
    region: field.number({ nullable: true }),
    phrase: field.string({ nullable: true }),
    meta: field.json(),
    tags: field.list(field.string()),
    addr: field.struct({ city: field.string() }),
    ref: field.crossRef(NS, 'Item')
  }
};

/** Fields holding fixture names that become uuids: ids and crossRefs. */
export const REF_FIELDS = new Set(['id', 'cert', 'test', 'ref']);

const MAX = '9223372036854775807';
const meta = (i: number) => ({
  createdAt: `2026-01-01T00:00:${String(i).padStart(2, '0')}.000Z`,
  updatedAt: `2026-01-01T00:00:${String(i).padStart(2, '0')}.000Z`,
  createdBy: { kind: 'agent', id: 'golden' },
  updatedBy: { kind: 'agent', id: 'golden' }
});

/**
 * i3 holds explicit nulls, i4 lacks every optional field, i5 holds misfits
 * (a string in a number field, an enum value out of vocabulary), i9/i10 tie
 * on `n`, and i11 is tombstoned. Each row's createdAt is distinct, so natural
 * order is defined.
 */
const ITEMS: Array<Record<string, unknown>> = [
  {
    id: 'i1',
    title: 'alpha',
    n: 1,
    big: '9007199254740993',
    status: 'open',
    at: '2024-01-01T00:00:00.123456Z',
    region: 1,
    phrase: 'foo',
    meta: { region: 'eu', tier: { name: 'gold' }, year: 1995 },
    tags: ['a', 'b'],
    addr: { city: 'Leeds' }
  },
  {
    id: 'i2',
    title: 'beta',
    n: 2.5,
    big: 7,
    status: 'closed',
    at: '2024-03-05T10:20:30.123999Z',
    region: 1,
    phrase: 'foobar',
    meta: { region: 'us', year: '1995' },
    tags: ['b'],
    addr: { city: 'York' },
    ref: 'i1'
  },
  {
    id: 'i3',
    title: 'Gamma',
    n: null,
    big: -3,
    status: null,
    at: null,
    region: 2,
    phrase: '',
    meta: null,
    tags: [],
    ref: 'i1'
  },
  { id: 'i4', title: 'delta', region: 2 },
  { id: 'i5', title: 'epsilon', n: '5', status: 'zzz', region: 3, phrase: 'bar' },
  {
    id: 'i6',
    title: 'zeta',
    n: 10,
    big: MAX,
    status: 'closed',
    at: '2023-12-31T23:59:59.999999Z',
    region: 3,
    phrase: 'aaab',
    tags: ['c', 'a'],
    ref: 'i2'
  },
  { id: 'i7', title: 'eta', n: 0, big: 0, status: 'open', region: 1, phrase: null },
  { id: 'i8', title: 'theta', n: -1.25, region: null, phrase: 'foo', meta: { year: 2001 } },
  { id: 'i9', title: 'a%b', n: 3, region: 2 },
  { id: 'i10', title: 'axb', n: 3, region: 2 },
  { id: 'i11', title: 'iota', n: 99, region: 1 }
].map((r, i) => ({ ...r, _metadata: meta(i + 1) }));

/** Rows by type, written in this order. */
export const SEED: Record<string, Array<Record<string, unknown>>> = {
  ...CARDS,
  ...RUNS,
  Item: ITEMS
};
export const SEED_TOMBSTONED: Record<string, string[]> = { ...TOMBSTONED, Item: ['i11'] };

export interface GoldenCase {
  name: string;
  type: string;
  params: ReadParams;
  /** Follow `nextCursor` to the end and record every page. */
  pages?: true;
  /**
   * Why the memory store cannot answer this case as pg does. Set, the fast
   * local mode skips it; pg still checks it.
   */
  memory?: string;
}

const W = (target: string) => `${NS}/${target}`;
const OBS = W('Observation.cert');
const LISTING = W('Listing.cert');
const obs = (where?: unknown, extra: Record<string, unknown> = {}) => ({
  _walk: { in: OBS, ...(where ? { where } : {}), ...extra }
});
const p = (params: Record<string, unknown>) => params as ReadParams;
const byTitle = [{ title: 'asc' }];
const natural = [{ createdAt: 'desc' }];

export const CASES: GoldenCase[] = [
  // ── filters ───────────────────────────────────────────────────────────
  { name: 'filter eq string', type: 'Item', params: p({ where: { title: { eq: 'beta' } } }) },
  {
    name: 'filter in, nin and neq',
    type: 'Item',
    params: p({
      where: { title: { in: ['alpha', 'beta', 'zeta'] }, n: { nin: [10] }, phrase: { neq: 'x' } }
    })
  },
  {
    name: 'filter in [] matches nothing',
    type: 'Item',
    params: p({ where: { title: { in: [] } } })
  },
  {
    name: 'filter nin [] excludes nothing',
    type: 'Item',
    params: p({ where: { title: { nin: [] } } })
  },
  {
    name: 'filter contains, startsWith, endsWith',
    type: 'Item',
    params: p({
      where: {
        OR: [
          { title: { contains: 'et' } },
          { title: { startsWith: 'al' } },
          { title: { endsWith: 'mma' } }
        ]
      }
    })
  },
  {
    name: 'filter like and notLike are case-sensitive, % is literal under contains',
    type: 'Item',
    params: p({
      where: { OR: [{ title: { like: 'a_b' } }, { title: { contains: '%' } }] }
    })
  },
  { name: 'filter notLike', type: 'Item', params: p({ where: { title: { notLike: '%a' } } }) },
  {
    name: 'filter gt/lte on a number',
    type: 'Item',
    params: p({ where: { n: { gt: 0, lte: 3 } } })
  },
  {
    name: 'filter between on a string',
    type: 'Item',
    params: p({ where: { title: { between: ['b', 'e'] } } })
  },
  {
    name: 'filter on a date with microseconds',
    type: 'Item',
    params: p({ where: { at: { gt: '2024-01-01T00:00:00.123455Z' } } })
  },
  {
    name: 'filter int64 past 2^53',
    type: 'Item',
    params: p({ where: { big: { gt: '9007199254740992' } } })
  },
  {
    name: 'filter AND, OR and NOT',
    type: 'Item',
    params: p({
      where: {
        AND: [
          { OR: [{ region: { eq: 1 } }, { region: { eq: 3 } }] },
          { NOT: { status: { eq: 'open' } } }
        ]
      }
    })
  },
  {
    name: 'filter on a struct sub-field',
    type: 'Item',
    params: p({ where: { addr: { city: { eq: 'York' } } } })
  },
  {
    name: 'filter on a json path is type-strict',
    type: 'Item',
    params: p({ where: { meta: { path: ['year'], eq: 1995 } } })
  },
  {
    name: 'filter on a nested json path',
    type: 'Item',
    params: p({ where: { meta: { path: ['tier', 'name'], eq: 'gold' } } })
  },
  { name: 'filter list has', type: 'Item', params: p({ where: { tags: { has: 'a' } } }) },
  { name: 'filter crossRef eq', type: 'Item', params: p({ where: { ref: { eq: 'i1' } } }) },
  { name: 'filter id in', type: 'Item', params: p({ where: { id: { in: ['i2', 'i4', 'i11'] } } }) },
  {
    name: 'filter $expr on a computed condition',
    type: 'Item',
    params: p({ where: { $expr: { gt: [{ length: ['title'] }, 4] } } })
  },
  {
    name: 'filter NOT $expr is a complement: a null result is false, so NOT keeps the row',
    type: 'Item',
    params: p({ where: { NOT: { $expr: { gt: ['n', 2] } } } })
  },
  {
    name: 'tombstoned rows are hidden',
    type: 'Item',
    params: p({ where: { title: { eq: 'iota' } } })
  },
  {
    name: 'includeDeleted shows tombstoned rows',
    type: 'Item',
    params: p({ where: { title: { eq: 'iota' } }, includeDeleted: true })
  },

  // ── null and absent ───────────────────────────────────────────────────
  {
    name: 'eq null matches null and absent',
    type: 'Item',
    params: p({ where: { n: { eq: null } } })
  },
  { name: 'neq null', type: 'Item', params: p({ where: { phrase: { neq: null } } }) },
  { name: 'in with null', type: 'Item', params: p({ where: { region: { in: [null, 3] } } }) },
  { name: 'nin with null', type: 'Item', params: p({ where: { region: { nin: [null, 1] } } }) },
  {
    name: 'an explicit null on a column field reads absent; json and list keep null',
    type: 'Item',
    params: p({ id: 'i3' })
  },
  { name: 'a row lacking every optional field', type: 'Item', params: p({ id: 'i4' }) },
  { name: 'empty string is not null', type: 'Item', params: p({ where: { phrase: { eq: '' } } }) },

  // ── misfits ───────────────────────────────────────────────────────────
  {
    name: 'misfit: a string in a number field reads back as written',
    type: 'Item',
    params: p({ id: 'i5' })
  },
  {
    name: "misfit: eq '5' finds the string",
    type: 'Item',
    params: p({ where: { n: { eq: '5' } } })
  },
  { name: 'misfit: in mixes kinds', type: 'Item', params: p({ where: { n: { in: ['5', 10] } } }) },
  { name: 'misfit: gt skips the string', type: 'Item', params: p({ where: { n: { gt: 1 } } }) },
  {
    name: 'misfit: eq null does not match the string',
    type: 'Item',
    params: p({ where: { n: { eq: null }, region: { eq: 3 } } })
  },
  {
    name: 'misfit: out-of-vocab enum eq',
    type: 'Item',
    params: p({ where: { status: { eq: 'zzz' } } })
  },
  {
    name: 'misfit: out-of-vocab enum neq',
    type: 'Item',
    params: p({ where: { status: { neq: 'zzz' } } })
  },
  {
    name: 'misfit: nin with the misfit and null',
    type: 'Item',
    params: p({ where: { status: { nin: ['zzz', null] } } })
  },

  // ── sorts ─────────────────────────────────────────────────────────────
  {
    name: 'natural order is createdAt desc',
    type: 'Item',
    // The engine reads in natural order by handing the dataset this orderBy
    // (substrate-core engine/internals.ts); a dataset read without one has no defined order.
    params: p({ orderBy: natural, limit: 100 })
  },
  { name: 'sort string asc', type: 'Item', params: p({ orderBy: byTitle }) },
  {
    name: 'sort number desc, nulls last, id breaks ties',
    type: 'Item',
    params: p({ orderBy: [{ n: 'desc' }] })
  },
  {
    name: 'sort number asc then title desc',
    type: 'Item',
    params: p({ orderBy: [{ n: 'asc' }, { title: 'desc' }] })
  },
  { name: 'sort int64', type: 'Item', params: p({ orderBy: [{ big: 'desc' }] }) },
  { name: 'sort date asc', type: 'Item', params: p({ orderBy: [{ at: 'asc' }] }) },
  { name: 'sort by createdAt asc', type: 'Item', params: p({ orderBy: [{ createdAt: 'asc' }] }) },
  { name: 'limit cuts and says hasMore', type: 'Item', params: p({ orderBy: byTitle, limit: 3 }) },
  {
    name: 'count with a filter',
    type: 'Item',
    params: p({ where: { region: { eq: 2 } }, count: true })
  },

  // ── cursors and paging ────────────────────────────────────────────────
  { name: 'pages by title', type: 'Item', params: p({ orderBy: byTitle, limit: 3 }), pages: true },
  {
    name: 'pages by a nullable number with ties',
    type: 'Item',
    params: p({ orderBy: [{ n: 'desc' }], limit: 2 }),
    pages: true
  },
  {
    name: 'pages by a date, filtered',
    type: 'Item',
    params: p({ where: { region: { neq: 3 } }, orderBy: [{ at: 'desc' }], limit: 2 }),
    pages: true
  },
  {
    name: 'pages in natural order',
    type: 'Item',
    params: p({ orderBy: natural, limit: 4 }),
    pages: true
  },
  {
    name: 'pages by a select key',
    type: 'Item',
    params: p({ select: { l: { length: ['title'] } }, orderBy: [{ l: 'desc' }], limit: 3 }),
    pages: true
  },

  // ── select ────────────────────────────────────────────────────────────
  {
    name: 'select computed number, string and boolean keys',
    type: 'Item',
    params: p({
      select: {
        l: { length: ['title'] },
        n1: { add: ['n', 1] },
        up: { upper: ['title'] },
        wide: { gt: ['n', 2] }
      },
      orderBy: byTitle
    })
  },
  {
    name: 'select int64 and date truncation',
    type: 'Item',
    params: p({
      where: { big: { lt: MAX } },
      select: { b2: { add: ['big', 1] }, day: { dateTrunc: [{ lit: 'day' }, 'at'] } },
      orderBy: byTitle
    })
  },

  // ── aggregates and groupBy ────────────────────────────────────────────
  {
    name: 'ungrouped aggregate',
    type: 'Item',
    params: p({
      aggregate: {
        c: { count: true },
        cn: { count: 'n' },
        s: { sum: 'n' },
        a: { avg: 'n' },
        mn: { min: 'n' },
        mx: { max: 'n' },
        d: { countDistinct: 'region' }
      }
    })
  },
  {
    name: 'ungrouped aggregate over no rows is one group',
    type: 'Item',
    params: p({
      where: { region: { eq: -1 } },
      aggregate: { c: { count: true }, s: { sum: 'big' }, d: { countDistinct: 'phrase' } }
    })
  },
  {
    name: 'group by a field, default key order',
    type: 'Item',
    params: p({ groupBy: { region: 'region' }, aggregate: { c: { count: true }, s: { sum: 'n' } } })
  },
  {
    name: 'group ordered by an aggregate, with having',
    type: 'Item',
    params: p({
      groupBy: { region: 'region' },
      aggregate: { c: { count: true } },
      having: { gt: ['c', 1] },
      orderBy: [{ c: 'desc' }, { region: 'asc' }]
    })
  },
  {
    name: 'group by an int64 with min and max',
    type: 'Item',
    params: p({
      where: { big: { neq: null } },
      groupBy: { status: 'status' },
      aggregate: { mn: { min: 'big' }, mx: { max: 'big' } }
    })
  },
  // Arithmetic overflow raises (docs/upgrading-to-warehouse-grammar.md §6).
  {
    name: 'int64 sum overflow raises',
    type: 'Item',
    params: p({ aggregate: { s: { sum: 'big' } } })
  },
  {
    name: 'int64 select overflow raises',
    type: 'Item',
    params: p({ where: { id: { eq: 'i6' } }, select: { b2: { add: ['big', 1] } } })
  },
  {
    name: 'group offset and limit say truncated',
    type: 'Item',
    params: p({
      groupBy: { region: 'region' },
      aggregate: { c: { count: true } },
      offset: 1,
      limit: 2
    })
  },
  {
    name: 'group by an expression key',
    type: 'Item',
    params: p({
      groupBy: { k: { regexpReplace: ['phrase', { lit: '^(f)o+.*$' }, { lit: '\\1' }] } },
      aggregate: { c: { count: true }, l: { avg: { length: ['title'] } } }
    })
  },
  {
    name: 'group by day',
    type: 'Item',
    params: p({
      where: { at: { neq: null } },
      groupBy: { day: { dateTrunc: [{ lit: 'day' }, 'at'] } },
      aggregate: { c: { count: true }, mx: { max: 'at' } }
    })
  },

  // ── walks ─────────────────────────────────────────────────────────────
  { name: 'walk any', type: 'Cert', params: p({ where: obs({ price: { gt: 120 } }) }) },
  {
    name: 'walk none',
    type: 'Cert',
    params: p({ where: obs({ price: { gt: 120 } }, { quantifier: 'none' }) })
  },
  {
    name: 'walk all, vacuous over a tombstoned-only cert',
    type: 'Cert',
    params: p({ where: obs({ price: { gte: 90 } }, { quantifier: 'all' }) })
  },
  {
    name: 'walk pick latest',
    type: 'Cert',
    params: p({ where: obs({ status: { eq: 'listed' } }, { pick: { latest: 'observedAt' } }) })
  },
  {
    name: 'walk pick max',
    type: 'Cert',
    params: p({ where: obs({ price: { gte: 500 } }, { pick: { max: 'price' } }) })
  },
  {
    name: 'walk pick latest among the unsold',
    type: 'Cert',
    params: p({
      where: obs(
        { price: { lt: 100 } },
        { pick: { latest: 'observedAt' }, among: { NOT: { status: { eq: 'sold' } } } }
      )
    })
  },
  {
    name: 'walk pick max among a seed-relative window',
    type: 'Cert',
    params: p({
      where: obs(undefined, {
        pick: { max: 'price' },
        among: { price: { lte: { $ref: '$.ask', times: 1.25 } } }
      })
    })
  },
  {
    name: 'walk $ref to a binding',
    type: 'Cert',
    params: p({
      where: {
        AND: [
          { grade: { eq: 9 } },
          { _walk: { as: 'L', in: LISTING, where: { firstSeen: { gte: RECENT } } } },
          obs({ price: { gte: { $ref: 'L.price', times: 1.25 } } })
        ]
      }
    })
  },
  {
    name: 'walk outbound then inbound',
    type: 'Observation',
    params: p({
      where: {
        _walk: {
          out: 'cert',
          where: { _walk: { in: LISTING, where: { firstSeen: { lt: RECENT } } } }
        }
      }
    })
  },
  {
    name: 'walk _agg filter skips tombstones',
    type: 'Cert',
    params: p({ where: { _agg: { in: OBS, count: true }, eq: 0 } })
  },
  {
    name: 'walk _agg feature fields',
    type: 'Cert',
    params: p({
      where: { grade: { eq: 9 } },
      agg: {
        n: { in: OBS, count: true },
        avg: { in: OBS, avg: 'price' },
        last: { in: OBS, latest: { by: 'observedAt', value: 'price' } },
        recent: { in: OBS, where: { observedAt: { gte: RECENT } }, count: true }
      }
    })
  },
  {
    name: 'walk nested list, cut',
    type: 'Cert',
    params: p({
      where: { grade: { eq: 9 } },
      nested: {
        latest: {
          _walk: { in: OBS },
          fields: { price: true, status: true },
          orderBy: [{ observedAt: 'desc' }],
          limit: 1
        }
      }
    })
  },
  {
    name: 'walk count',
    type: 'Cert',
    params: p({ where: obs({ status: { eq: 'sold' } }), count: true })
  },
  {
    name: 'walk in a grouped read',
    type: 'Observation',
    params: p({
      where: { _walk: { out: 'cert', where: { grade: { eq: 9 } } } },
      aggregate: { n: { count: true }, avg: { avg: 'price' } },
      groupBy: { bucket: { dateTrunc: [{ lit: 'day' }, 'observedAt'] } }
    })
  },
  {
    name: 'walk select over an _agg, paged',
    type: 'Cert',
    params: p({
      agg: { last: { in: OBS, latest: { by: 'observedAt', value: 'price' } } },
      select: { m: { sub: ['_agg.last', 'ask'] } },
      orderBy: [{ m: 'desc' }],
      limit: 3
    }),
    pages: true
  },
  {
    name: 'walk run yardstick',
    type: 'Test',
    params: p({
      where: {
        AND: [
          { pgGated: { eq: true } },
          { _walk: { as: 'C', in: W('CiRun.test'), where: { status: { neq: 'skipped' } } } },
          {
            _walk: {
              in: W('LocalRun.test'),
              where: {
                status: { neq: 'skipped' },
                durationMs: { gte: { $ref: 'C.durationMs', times: 1.25 } }
              }
            }
          }
        ]
      }
    })
  },
  { name: 'count over a type never written', type: 'Empty', params: p({ count: true }) }
];

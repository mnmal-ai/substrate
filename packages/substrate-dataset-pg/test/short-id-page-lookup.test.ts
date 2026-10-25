/**
 * `read()` resolves `short_id` for the returned page only, unless the where
 * tree or orderBy references `shortId`, which needs it per candidate row.
 *
 * The plan cases run the statement `read()` sends. Under
 * `force_generic_plan` a join on `short_ids` below the LIMIT has nothing
 * bounding `row_id` and reads the type from its start up to the cursor. Under
 * zero parallel costs the page query must still be able to run in parallel.
 * A cursor on a nullable leading key bounds that key in the index scan and
 * reads the null tail only when the bounded page falls short.
 */

import { randomBytes } from 'node:crypto';
import { encodeCursor } from '@mnmal-ai/substrate-filter';
import type { FieldDef, IndexDecl, ReadParams } from '@mnmal-ai/substrate-types';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PgDataset } from '../src/index.js';

const POSTGRES_URL = process.env.POSTGRES_URL;
const TYPE = 'Paged';
/** Every row has a `d`. */
const FULL = 'PagedFull';
const FULL_ROWS = 6000;
const ROWS = 20_000;
const PAGE = 1000;
const ns = `spl_${randomBytes(4).toString('hex')}`;
const rid = (i: number): string => `r${String(i).padStart(5, '0')}`;
/** Every 7th row has no short id; the rest have short id i + 1. */
const bound = (i: number): boolean => i % 7 !== 0;
const iso = (i: number): string =>
  new Date(Date.UTC(2020, 0, 1) + (i % 997) * 3_600_000).toISOString();
/**
 * Every 19th row (about 5%) has no `d`; the rest repeat 997 distinct dates, so
 * ties fall to the later keys. 19 leaves the null boundary mid-page.
 */
const dateOf = (i: number): string | undefined => (i % 19 === 0 ? undefined : iso(i));
/** A second sort key: three values, and none on every 11th row. */
const gOf = (i: number): string | undefined => (i % 11 === 0 ? undefined : `g${i % 3}`);
const fields: Record<string, FieldDef> = { d: { kind: 'scalar', type: 'date' } };
const D_IDX = `rows_spl_d_${randomBytes(4).toString('hex')}`;
const D_ASC_IDX = `rows_spl_d_asc_${randomBytes(4).toString('hex')}`;
const indexes: IndexDecl[] = [
  { fields: [{ field: 'd', dir: 'desc' }], name: D_IDX },
  { fields: ['d'], name: D_ASC_IDX }
];

let sql: Sql;
/** A second client whose `debug` hook records each statement it sends. */
let traced: Sql;
let sent: Array<{ query: string; parameters: unknown[]; types: number[] }> = [];
let ds: PgDataset;

beforeAll(async () => {
  if (!POSTGRES_URL) return;
  sql = postgres(POSTGRES_URL, { onnotice: () => {} });
  traced = postgres(POSTGRES_URL, {
    onnotice: () => {},
    debug: (_conn, query, parameters, types) => {
      sent.push({ query, parameters: parameters as unknown[], types: types as number[] });
    }
  });
  ds = new PgDataset({
    namespace: ns,
    sql: traced,
    fieldDefLookup: (_type, field) => fields[field],
    typeDefLookup: (type) =>
      type === TYPE
        ? { fields, indexes }
        : { fields, indexes: [{ fields: [{ field: 'd', dir: 'desc' }] }] }
  });
  await ds.ensureTypeStorage(TYPE);
  await ds.ensureTypeStorage(FULL);
  for (let start = 0; start < ROWS; start += 2000) {
    await ds.write(
      TYPE,
      Array.from({ length: 2000 }, (_, k) => {
        const i = start + k;
        const d = dateOf(i);
        const g = gOf(i);
        return {
          id: rid(i),
          n: i,
          ...(d === undefined ? {} : { d }),
          ...(g === undefined ? {} : { g })
        };
      })
    );
  }
  await ds.write(
    FULL,
    Array.from({ length: FULL_ROWS }, (_, i) => ({ id: rid(i), n: i, d: iso(i) }))
  );
  await sql`
    INSERT INTO short_ids (namespace, type, short_id, row_id)
    SELECT ${ns}, ${TYPE}, i + 1, 'r' || lpad(i::text, 5, '0')
    FROM generate_series(0, ${ROWS - 1}) i
    WHERE i % 7 <> 0`;
  await sql`ANALYZE rows`;
  await sql`ANALYZE short_ids`;
}, 120_000);

afterAll(async () => {
  if (!POSTGRES_URL) return;
  await sql`DELETE FROM rows WHERE namespace = ${ns}`;
  await traced.end({ timeout: 5 });
  await sql.end({ timeout: 5 });
});

type PlanNode = {
  'Node Type': string;
  'Parent Relationship'?: string;
  'Relation Name'?: string;
  'Index Name'?: string;
  'Index Cond'?: string;
  'Rows Removed by Filter'?: number;
  'Actual Rows': number;
  'Actual Loops': number;
  Plans?: PlanNode[];
};

const touchesShortIds = (n: PlanNode): boolean =>
  n['Relation Name'] === 'short_ids' || (n['Index Name'] ?? '').startsWith('short_ids');

function nodes(node: PlanNode, out: PlanNode[] = []): PlanNode[] {
  out.push(node);
  for (const child of node.Plans ?? []) nodes(child, out);
  return out;
}

/** The SELECTs `read()` sends for `params`. */
async function selectsOf(params: ReadParams, type = TYPE): Promise<typeof sent> {
  sent = [];
  await ds.read(type, params);
  return sent.filter((s) => /FROM rows r/.test(s.query));
}

/** The plan of the first statement `read()` sends for `params`, executed after `settings`. */
async function planOf(params: ReadParams, settings: string[], analyze: boolean): Promise<PlanNode> {
  const q = (await selectsOf(params))[0];
  if (q === undefined) throw new Error('read sent no SELECT');
  const conn = await sql.reserve();
  try {
    const names = await conn<Array<{ t: string }>>`
      SELECT format_type(oid, NULL) AS t FROM unnest(${q.types}::oid[]) WITH ORDINALITY u(oid, k)
      ORDER BY k`;
    const literals = q.parameters
      .map((p) => (p === null ? 'NULL' : `'${String(p).replace(/'/g, "''")}'`))
      .join(', ');
    // A statement the client already prepared reports its types as 0 ('-'),
    // which PREPARE takes as `unknown`, inferred from context as the client's were.
    const typeList = names.map((n) => (n.t === '-' ? 'unknown' : n.t)).join(', ');
    await conn.unsafe(`PREPARE spl_stmt(${typeList}) AS ${q.query}`);
    for (const s of settings) await conn.unsafe(`SET ${s}`);
    const rows = await conn.unsafe(
      `EXPLAIN (${analyze ? 'ANALYZE, ' : ''}FORMAT JSON) EXECUTE spl_stmt(${literals})`
    );
    return ((rows[0]?.['QUERY PLAN'] ?? []) as Array<{ Plan: PlanNode }>)[0]?.Plan as PlanNode;
  } finally {
    await conn.unsafe('DEALLOCATE ALL');
    await conn.unsafe('RESET ALL');
    conn.release();
  }
}

/** The analysed generic plan of the statement `read()` sends for a deep id-ordered page. */
const genericPlan = (): Promise<PlanNode> =>
  planOf(
    { limit: PAGE, cursor: encodeCursor({ orderByValues: [], id: rid(15_000) }) },
    ['plan_cache_mode = force_generic_plan'],
    true
  );

describe.skipIf(!POSTGRES_URL)('read: short id lookup for the returned page only', () => {
  it('a deep id-ordered page never reads short_ids beyond the page (generic plan)', async () => {
    const all = nodes(await genericPlan());
    const joins = all.filter(
      (n) => /^(Merge|Hash) Join$/.test(n['Node Type']) && nodes(n).some(touchesShortIds)
    );
    expect(joins.map((n) => n['Node Type'])).toEqual([]);
    // The only short_ids access is the inner side of a Nested Loop over the page's Limit.
    const loops = all.filter((n) => n['Node Type'] === 'Nested Loop');
    expect(loops).toHaveLength(1);
    const [outer, inner] = (loops[0] as PlanNode).Plans ?? [];
    const pageTop = outer?.['Node Type'] === 'Subquery Scan' ? outer.Plans?.[0] : outer;
    expect(pageTop?.['Node Type']).toBe('Limit');
    expect(nodes(outer as PlanNode).some(touchesShortIds)).toBe(false);
    const lookups = nodes(inner as PlanNode).filter(touchesShortIds);
    expect(lookups.length).toBeGreaterThan(0);
    expect(all.filter(touchesShortIds)).toEqual(lookups);
    for (const n of lookups) {
      expect(n['Actual Loops'], n['Node Type']).toBeLessThanOrEqual(PAGE + 1);
      expect(n['Actual Rows'], n['Node Type']).toBeLessThanOrEqual(1);
    }
  });

  it('the page query of a filtered read can run in parallel', async () => {
    const plan = await planOf(
      { where: { n: { gte: 100 } }, orderBy: [{ d: 'desc' }], limit: 50 },
      [
        'parallel_setup_cost = 0',
        'parallel_tuple_cost = 0',
        'min_parallel_table_scan_size = 0',
        'min_parallel_index_scan_size = 0'
      ],
      false
    );
    // Pre-order, so the page's Limit comes before the lookup's LIMIT 1.
    const page = nodes(plan).find((n) => n['Node Type'] === 'Limit');
    expect(page).toBeDefined();
    const below = nodes(page as PlanNode);
    expect(below.some((n) => /^Gather( Merge)?$/.test(n['Node Type']))).toBe(true);
    // A SubPlan computed above the Gather still forces its node out of the workers.
    expect(below.filter((n) => n['Parent Relationship'] === 'SubPlan')).toEqual([]);
  });

  it('a full id-ordered paged walk returns every row once with its short id or none', async () => {
    const seen: Array<{ id: unknown; shortId: unknown }> = [];
    let cursor: string | undefined;
    for (;;) {
      const page = await ds.read(TYPE, { limit: PAGE, ...(cursor ? { cursor } : {}) });
      for (const r of page.rows) seen.push({ id: r.id, shortId: r.shortId });
      if (!page.hasMore) break;
      cursor = page.nextCursor;
    }
    expect(seen).toEqual(
      Array.from({ length: ROWS }, (_, i) => ({
        id: rid(i),
        shortId: bound(i) ? i + 1 : undefined
      }))
    );
  }, 60_000);

  // A deep page: about half the dated rows sort before the cursor.
  const deepDateCursor = encodeCursor({ orderByValues: [iso(500)], id: rid(500) });

  for (const [dir, index, bound] of [
    ['desc', () => D_IDX, /<=/],
    ['asc', () => D_ASC_IDX, />=/]
  ] as const)
    for (const mode of ['force_custom_plan', 'force_generic_plan']) {
      it(`a deep page by a nullable date ${dir} bounds the date in the index scan (${mode})`, async () => {
        const params: ReadParams = { orderBy: [{ d: dir }], limit: PAGE, cursor: deepDateCursor };
        const all = nodes(await planOf(params, [`plan_cache_mode = ${mode}`], true));
        const scan = all.find((n) => n['Index Name'] === index());
        expect(
          scan,
          all.map((n) => `${n['Node Type']} ${n['Index Name'] ?? ''}`).join(', ')
        ).toBeDefined();
        expect(scan?.['Index Cond']).toMatch(bound);
        const removed = all.reduce((sum, n) => sum + (n['Rows Removed by Filter'] ?? 0), 0);
        expect(removed).toBeLessThanOrEqual(PAGE);
        // A full page never reads the null tail.
        expect(await selectsOf(params)).toHaveLength(1);
      });
    }

  it('a cursor already in the null tail bounds it in the index scan', async () => {
    const tailCursor = encodeCursor({ orderByValues: [null], id: rid(19 * 500) });
    const params: ReadParams = { orderBy: [{ d: 'desc' }], limit: 100, cursor: tailCursor };
    for (const mode of ['force_custom_plan', 'force_generic_plan']) {
      const all = nodes(await planOf(params, [`plan_cache_mode = ${mode}`], true));
      const scan = all.find((n) => n['Index Name'] === D_IDX);
      expect(scan?.['Index Cond'], mode).toMatch(/IS NULL/);
      expect(scan?.['Index Cond'], mode).toMatch(/id >/);
    }
    expect(await selectsOf(params)).toHaveLength(1);
  });

  type Key = (i: number) => string | undefined;
  /** The expected order: each key under NULLS LAST, then id ascending. */
  const sortedBy =
    (keys: Array<[Key, 'asc' | 'desc']>) =>
    (a: number, b: number): number => {
      for (const [key, dir] of keys) {
        const ka = key(a);
        const kb = key(b);
        if (ka === kb) continue;
        if (ka === undefined) return 1;
        if (kb === undefined) return -1;
        return ka < kb === (dir === 'asc') ? -1 : 1;
      }
      return a - b;
    };

  const walks: Array<{
    name: string;
    type?: string;
    params: ReadParams;
    keep?: (i: number) => boolean;
    keys: Array<[Key, 'asc' | 'desc']>;
    straddles: boolean;
  }> = [
    {
      name: 'date DESC',
      params: { orderBy: [{ d: 'desc' }, { id: 'asc' }] },
      keys: [[dateOf, 'desc']],
      straddles: true
    },
    {
      name: 'date ASC',
      params: { orderBy: [{ d: 'asc' }] },
      keys: [[dateOf, 'asc']],
      straddles: true
    },
    {
      name: 'date DESC, g ASC',
      params: { orderBy: [{ d: 'desc' }, { g: 'asc' }] },
      keys: [
        [dateOf, 'desc'],
        [gOf, 'asc']
      ],
      straddles: true
    },
    {
      name: 'date DESC where date >= X',
      params: { where: { d: { gte: iso(300) } }, orderBy: [{ d: 'desc' }] },
      keep: (i) => (dateOf(i) ?? '') >= iso(300),
      keys: [[dateOf, 'desc']],
      straddles: false
    },
    {
      name: 'date DESC through the shortId join',
      // gte 3 rather than 1 leaves the null boundary mid-page at page 7.
      params: { where: { shortId: { gte: 3 } }, orderBy: [{ d: 'desc' }] },
      keep: (i) => bound(i) && i + 1 >= 3,
      keys: [[dateOf, 'desc']],
      straddles: true
    },
    {
      name: 'date DESC with no nulls',
      type: FULL,
      params: { orderBy: [{ d: 'desc' }] },
      keys: [[iso, 'desc']],
      straddles: false
    }
  ];

  for (const w of walks) {
    for (const size of [7, 100]) {
      it(`a paged walk by ${w.name}, page ${size}, returns every row once, in order`, async () => {
        const type = w.type ?? TYPE;
        // A slice of the fixture keeps the page count down. Both sizes leave
        // the null boundary mid-page.
        const total = size === 7 ? 2000 : 6000;
        const slice = { n: { lt: total } };
        const where = w.params.where === undefined ? slice : { AND: [w.params.where, slice] };
        const seen: Array<{ id: unknown; shortId: unknown }> = [];
        let straddled = false;
        let cursor: string | undefined;
        for (;;) {
          const page = await ds.read(type, {
            ...w.params,
            where,
            limit: size,
            ...(cursor ? { cursor } : {})
          });
          const dated = page.rows.filter((r) => r.d !== undefined).length;
          if (dated > 0 && dated < page.rows.length) straddled = true;
          for (const r of page.rows) seen.push({ id: r.id, shortId: r.shortId });
          if (!page.hasMore) break;
          cursor = page.nextCursor;
        }
        const expected = Array.from({ length: total }, (_, i) => i)
          .filter(w.keep ?? (() => true))
          .sort(sortedBy(w.keys));
        expect(seen).toEqual(
          expected.map((i) => ({
            id: rid(i),
            shortId: type === TYPE && bound(i) ? i + 1 : undefined
          }))
        );
        expect(straddled).toBe(w.straddles);
      }, 60_000);
    }
  }

  it('an unlimited read from a non-null cursor returns the rest, null tail included', async () => {
    const params: ReadParams = { where: { n: { lt: 2000 } }, orderBy: [{ d: 'desc' }] };
    const first = await ds.read(TYPE, { ...params, limit: 100 });
    expect(first.nextCursor).toBeDefined();
    const rest = await ds.read(TYPE, { ...params, cursor: first.nextCursor ?? '' });
    expect(rest.hasMore).toBe(false);
    const expected = Array.from({ length: 2000 }, (_, i) => i)
      .sort(sortedBy([[dateOf, 'desc']]))
      .map(rid);
    expect([...first.rows, ...rest.rows].map((r) => r.id)).toEqual(expected);
  });

  it('a row whose lead turns null between the two queries is not returned twice', async () => {
    const RACE = 'Race';
    await ds.ensureTypeStorage(RACE);
    await ds.write(
      RACE,
      Array.from({ length: 10 }, (_, i) => ({ id: rid(i), ...(i < 5 ? { d: iso(i) } : {}) }))
    );
    // A client that clears r00001's date just before the second page query
    // (the null tail) is sent; the first has already returned r00001.
    let pageQueries = 0;
    const racing = new Proxy(traced, {
      apply(target, thisArg, args: unknown[]) {
        const strings = args[0];
        const isPage = Array.isArray(strings) && String(strings[0]).includes('SELECT p.*');
        if (isPage && ++pageQueries === 2) {
          return sql`
            UPDATE rows SET body = body - 'd'
            WHERE namespace = ${ns} AND type = ${RACE} AND id = ${rid(1)}`.then(() =>
            Reflect.apply(target, thisArg, args)
          );
        }
        return Reflect.apply(target, thisArg, args);
      }
    });
    const raceDs = new PgDataset({
      namespace: ns,
      sql: racing,
      fieldDefLookup: (_type, field) => fields[field]
    });
    const page = await raceDs.read(RACE, {
      orderBy: [{ d: 'desc' }],
      limit: 100,
      cursor: encodeCursor({ orderByValues: [iso(4)], id: rid(4) })
    });
    expect(pageQueries).toBe(2);
    const ids = page.rows.map((r) => r.id);
    expect(ids).toEqual([rid(3), rid(2), rid(1), rid(0), rid(5), rid(6), rid(7), rid(8), rid(9)]);
    expect(page.hasMore).toBe(false);
  });

  it('a shortId reference nested under OR/NOT keeps the join', async () => {
    const { rows } = await ds.read(TYPE, {
      where: { OR: [{ shortId: { eq: 2 } }, { NOT: { shortId: { gte: 4 } } }] },
      orderBy: [{ shortId: 'desc' }]
    });
    expect(rows.map((r) => [r.id, r.shortId])).toEqual([
      [rid(2), 3],
      [rid(1), 2]
    ]);
  });

  it('a where-only shortId reference nested in AND/OR keeps the join', async () => {
    sent = [];
    const { rows } = await ds.read(TYPE, {
      where: { AND: [{ n: { lt: 10 } }, { OR: [{ shortId: { eq: 2 } }, { shortId: { eq: 5 } }] }] }
    });
    expect(rows.map((r) => [r.id, r.shortId])).toEqual([
      [rid(1), 2],
      [rid(4), 5]
    ]);
    expect(
      sent.some((s) => /LEFT JOIN short_ids s\s+ON s\.namespace = r\.namespace/.test(s.query))
    ).toBe(true);
  });
});

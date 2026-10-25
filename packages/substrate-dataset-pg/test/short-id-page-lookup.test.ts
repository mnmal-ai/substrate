/**
 * `read()` resolves `short_id` for the returned page only, unless the where
 * tree or orderBy references `shortId`, which needs it per candidate row.
 *
 * The plan cases run the statement `read()` sends. Under
 * `force_generic_plan` a join on `short_ids` below the LIMIT has nothing
 * bounding `row_id` and reads the type from its start up to the cursor. Under
 * zero parallel costs the page query must still be able to run in parallel.
 */

import { randomBytes } from 'node:crypto';
import { encodeCursor } from '@mnmal-ai/substrate-filter';
import type { FieldDef, ReadParams } from '@mnmal-ai/substrate-types';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PgDataset } from '../src/index.js';

const POSTGRES_URL = process.env.POSTGRES_URL;
const TYPE = 'Paged';
const ROWS = 20_000;
const PAGE = 1000;
const ns = `spl_${randomBytes(4).toString('hex')}`;
const rid = (i: number): string => `r${String(i).padStart(5, '0')}`;
/** Every 7th row has no short id; the rest have short id i + 1. */
const bound = (i: number): boolean => i % 7 !== 0;
/** Every 5th row has no `d`; the rest repeat 997 distinct dates, so ties fall to id. */
const dateOf = (i: number): string | undefined =>
  i % 5 === 0 ? undefined : new Date(Date.UTC(2020, 0, 1) + (i % 997) * 3_600_000).toISOString();
const dIsDate = (_type: string, field: string): FieldDef | undefined =>
  field === 'd' ? { kind: 'scalar', type: 'date' } : undefined;

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
  ds = new PgDataset({ namespace: ns, sql: traced, fieldDefLookup: dIsDate });
  await ds.ensureTypeStorage(TYPE);
  for (let start = 0; start < ROWS; start += 2000) {
    await ds.write(
      TYPE,
      Array.from({ length: 2000 }, (_, k) => {
        const d = dateOf(start + k);
        return { id: rid(start + k), n: start + k, ...(d === undefined ? {} : { d }) };
      })
    );
  }
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

/** The plan of the statement `read()` sends for `params`, executed after `settings`. */
async function planOf(params: ReadParams, settings: string[], analyze: boolean): Promise<PlanNode> {
  sent = [];
  await ds.read(TYPE, params);
  const q = sent.find((s) => /FROM rows r/.test(s.query));
  if (q === undefined) throw new Error('read sent no SELECT');
  const conn = await sql.reserve();
  try {
    const names = await conn<Array<{ t: string }>>`
      SELECT format_type(oid, NULL) AS t FROM unnest(${q.types}::oid[]) WITH ORDINALITY u(oid, k)
      ORDER BY k`;
    const literals = q.parameters
      .map((p) => (p === null ? 'NULL' : `'${String(p).replace(/'/g, "''")}'`))
      .join(', ');
    await conn.unsafe(`PREPARE spl_stmt(${names.map((n) => n.t).join(', ')}) AS ${q.query}`);
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

  it('a paged walk by a nullable date DESC returns every row once, in order', async () => {
    const seen: Array<{ id: unknown; shortId: unknown }> = [];
    let cursor: string | undefined;
    for (;;) {
      const page = await ds.read(TYPE, {
        orderBy: [{ d: 'desc' }, { id: 'asc' }],
        limit: PAGE,
        ...(cursor ? { cursor } : {})
      });
      for (const r of page.rows) seen.push({ id: r.id, shortId: r.shortId });
      if (!page.hasMore) break;
      cursor = page.nextCursor;
    }
    const expected = Array.from({ length: ROWS }, (_, i) => i).sort((a, b) => {
      const da = dateOf(a);
      const db = dateOf(b);
      if (da !== db) {
        if (da === undefined) return 1;
        if (db === undefined) return -1;
        return da < db ? 1 : -1;
      }
      return a - b;
    });
    expect(seen).toEqual(
      expected.map((i) => ({ id: rid(i), shortId: bound(i) ? i + 1 : undefined }))
    );
  }, 60_000);

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

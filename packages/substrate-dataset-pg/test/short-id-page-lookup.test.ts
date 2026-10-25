/**
 * `read()` resolves `short_id` for the returned page only, unless the where
 * tree or orderBy references `shortId`, which needs it per candidate row.
 *
 * The plan case runs the statement `read()` sends under
 * `force_generic_plan`, where a join on `short_ids` has nothing bounding
 * `row_id` and reads the type from its start up to the cursor.
 */

import { randomBytes } from 'node:crypto';
import { encodeCursor } from '@mnmal-ai/substrate-filter';
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
  ds = new PgDataset({ namespace: ns, sql: traced });
  await ds.ensureTypeStorage(TYPE);
  for (let start = 0; start < ROWS; start += 2000) {
    await ds.write(
      TYPE,
      Array.from({ length: 2000 }, (_, k) => ({ id: rid(start + k), n: start + k }))
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

/** The analysed generic plan of the statement `read()` sends for a deep id-ordered page. */
async function genericPlan(): Promise<PlanNode> {
  const cursor = encodeCursor({ orderByValues: [], id: rid(15_000) });
  sent = [];
  await ds.read(TYPE, { limit: PAGE, cursor });
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
    await conn.unsafe('SET plan_cache_mode = force_generic_plan');
    const rows = await conn.unsafe(`EXPLAIN (ANALYZE, FORMAT JSON) EXECUTE spl_stmt(${literals})`);
    return ((rows[0]?.['QUERY PLAN'] ?? []) as Array<{ Plan: PlanNode }>)[0]?.Plan as PlanNode;
  } finally {
    await conn.unsafe('DEALLOCATE ALL');
    await conn.unsafe('RESET plan_cache_mode');
    conn.release();
  }
}

describe.skipIf(!POSTGRES_URL)('read: short id lookup for the returned page only', () => {
  it('a deep id-ordered page never reads short_ids beyond the page (generic plan)', async () => {
    const all = nodes(await genericPlan());
    const joins = all.filter(
      (n) => /^(Merge|Hash) Join$/.test(n['Node Type']) && nodes(n).some(touchesShortIds)
    );
    expect(joins.map((n) => n['Node Type'])).toEqual([]);
    const lookups = all.filter(touchesShortIds);
    expect(lookups.length).toBeGreaterThan(0);
    for (const n of lookups) {
      expect(n['Actual Loops'], n['Node Type']).toBeLessThanOrEqual(PAGE + 1);
      expect(n['Actual Rows'], n['Node Type']).toBeLessThanOrEqual(1);
    }
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
});

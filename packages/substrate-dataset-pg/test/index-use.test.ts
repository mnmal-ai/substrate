/**
 * The planner serves every operator a field kind allows from the index the
 * reconciler built on the type's partition. A mismatch between the index
 * expression and the compiled filter is a silent scan, so each case explains
 * the statement `read()` actually sends, twice: with its parameters (a custom
 * plan), and as a prepared statement under `force_generic_plan`.
 */

import { randomBytes } from 'node:crypto';
import type { FieldDef, IndexDecl, ReadParams } from '@mnmal-ai/substrate-types';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PgDataset } from '../src/index.js';
import { generatedIdentifier } from '../src/migrate.js';

const POSTGRES_URL = process.env.POSTGRES_URL;
const LAYOUT = process.env.SUBSTRATE_STORAGE_LAYOUT ?? 'legacy';
const TYPE = 'Obs';
const ROWS = 5000;
const COMPOSITE = `rows_iu_${randomBytes(4).toString('hex')}`;

const fields: Record<string, FieldDef> = {
  title: { kind: 'scalar', type: 'string', indexed: true },
  n: { kind: 'scalar', type: 'number', indexed: true },
  at: { kind: 'scalar', type: 'date', indexed: true },
  owner: { kind: 'crossRef', ns: 'x', type: 'Owner', onDelete: 'set_null', indexed: true },
  tags: { kind: 'list', of: { kind: 'scalar', type: 'string' }, indexed: true },
  cert: { kind: 'scalar', type: 'string' },
  observedAt: { kind: 'scalar', type: 'date' }
};
const indexes: IndexDecl[] = [
  { fields: ['cert', { field: 'observedAt', dir: 'desc' }], name: COMPOSITE }
];

const ns = `iu_${randomBytes(4).toString('hex')}`;
const iso = (i: number): string => new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString();

let sql: Sql;
/** A second client whose `debug` hook records each statement it sends. */
let traced: Sql;
let sent: Array<{ query: string; parameters: unknown[]; types: number[] }> = [];
let ds: PgDataset;

beforeAll(async () => {
  if (!POSTGRES_URL || LAYOUT !== 'partitioned') return;
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
    fieldDefLookup: (type, field) => (type === TYPE ? fields[field] : undefined),
    typeDefLookup: (type) => (type === TYPE ? { fields, indexes } : undefined)
  });
  await ds.ensureTypeStorage(TYPE);
  for (let start = 0; start < ROWS; start += 1000) {
    await ds.write(
      TYPE,
      Array.from({ length: 1000 }, (_, k) => {
        const i = start + k;
        return {
          id: `r${i}`,
          title: `t${String(i).padStart(5, '0')}`,
          n: i,
          at: iso(i),
          owner: `o${i % 500}`,
          tags: [`g${i % 100}`],
          cert: `c${i % 50}`,
          observedAt: iso(i)
        };
      })
    );
  }
  await sql`ANALYZE rows`;
}, 120_000);

afterAll(async () => {
  await traced?.end({ timeout: 5 });
  await sql?.end({ timeout: 5 });
});

/** The statement `read()` sends for `params`, with its bound values. */
async function compiled(
  params: ReadParams
): Promise<{ query: string; parameters: unknown[]; types: number[] }> {
  sent = [];
  await ds.read(TYPE, params);
  const q = sent.find((s) => /FROM rows r/.test(s.query));
  if (q === undefined) throw new Error('read sent no SELECT');
  return q;
}

type PlanNode = { 'Node Type': string; 'Index Name'?: string; Plans?: PlanNode[] };

/** `<node type> on <index>` for every index scan in the plan. */
function indexesUsed(node: PlanNode, out: string[] = []): string[] {
  if (/Index/.test(node['Node Type']) && node['Index Name'] !== undefined) {
    out.push(`${node['Node Type']} on ${node['Index Name']}`);
  }
  for (const child of node.Plans ?? []) indexesUsed(child, out);
  return out;
}

const planOf = (rows: Array<Record<string, unknown>>): PlanNode =>
  ((rows[0]?.['QUERY PLAN'] ?? []) as Array<{ Plan: PlanNode }>)[0]?.Plan as PlanNode;

/**
 * Index names in the plan of the prepared statement, under a forced custom
 * plan and then a forced generic one. The parameter types are the ones the
 * client declared, so both plans see the statement `read()` sent.
 */
async function plans(params: ReadParams): Promise<{ custom: string[]; generic: string[] }> {
  const { query, parameters, types } = await compiled(params);
  const conn = await sql.reserve();
  try {
    const names = await conn<Array<{ t: string }>>`
      SELECT format_type(oid, NULL) AS t FROM unnest(${types}::oid[]) WITH ORDINALITY u(oid, k)
      ORDER BY k`;
    // The values as the client serialised them, as literals: EXPLAIN takes no bind parameters.
    const literals = parameters
      .map((p) => (p === null ? 'NULL' : `'${String(p).replace(/'/g, "''")}'`))
      .join(', ');
    await conn.unsafe(`PREPARE iu_stmt(${names.map((n) => n.t).join(', ')}) AS ${query}`);
    const explain = async (mode: string): Promise<string[]> => {
      await conn.unsafe(`SET plan_cache_mode = ${mode}`);
      const rows = await conn.unsafe(`EXPLAIN (FORMAT JSON) EXECUTE iu_stmt(${literals})`);
      return indexesUsed(planOf(rows));
    };
    return {
      custom: await explain('force_custom_plan'),
      generic: await explain('force_generic_plan')
    };
  } finally {
    await conn.unsafe('DEALLOCATE ALL');
    await conn.unsafe('RESET plan_cache_mode');
    conn.release();
  }
}

const idx = (field: string, suffix = 'idx') => generatedIdentifier(ns, TYPE, field, suffix);

const cases: Array<[string, ReadParams, () => string]> = [
  ['text eq', { where: { title: { eq: 't00042' } } }, () => idx('title')],
  ['text in', { where: { title: { in: ['t00001', 't00002'] } } }, () => idx('title')],
  [
    'text gt',
    { where: { title: { gt: 't04990' } }, orderBy: [{ title: 'asc' }], limit: 10 },
    () => idx('title')
  ],
  ['text between', { where: { title: { between: ['t00010', 't00020'] } } }, () => idx('title')],
  ['text orderBy', { orderBy: [{ title: 'asc' }], limit: 10 }, () => idx('title')],
  ['number eq', { where: { n: { eq: 42 } } }, () => idx('n')],
  ['number gt', { where: { n: { gt: 4990 } }, orderBy: [{ n: 'asc' }], limit: 10 }, () => idx('n')],
  ['number between', { where: { n: { between: [10, 20] } } }, () => idx('n')],
  ['number orderBy', { orderBy: [{ n: 'asc' }], limit: 10 }, () => idx('n')],
  [
    'date gte',
    { where: { at: { gte: iso(4990) } }, orderBy: [{ at: 'asc' }], limit: 10 },
    () => idx('at')
  ],
  ['date orderBy', { orderBy: [{ at: 'asc' }], limit: 10 }, () => idx('at')],
  ['crossRef eq', { where: { owner: { eq: 'o7' } } }, () => idx('owner')],
  ['crossRef in', { where: { owner: { in: ['o7', 'o8'] } } }, () => idx('owner')],
  ['list has', { where: { tags: { has: 'g7' } } }, () => idx('tags', 'gin')],
  [
    'composite eq + orderBy desc',
    { where: { cert: { eq: 'c7' } }, orderBy: [{ observedAt: 'desc' }], limit: 10 },
    () => COMPOSITE
  ]
];

describe.skipIf(!POSTGRES_URL || LAYOUT !== 'partitioned')('index use (partitioned)', () => {
  for (const [name, params, expected] of cases) {
    it(name, async () => {
      const { custom, generic } = await plans(params);
      if (process.env.INDEX_USE_LOG)
        console.log(`${name}\n  custom: ${custom}\n  generic: ${generic}`);
      const on = (scans: string[]) => scans.some((s) => s.endsWith(` on ${expected()}`));
      expect(on(custom), `custom plan: ${custom}`).toBe(true);
      expect(on(generic), `generic plan: ${generic}`).toBe(true);
    });
  }
});

/**
 * On `tables`, a filter on a declared column field is served by the index the
 * reconciler built on that column of the type table: the statement `read()`
 * sends is explained with seq scans off, under a custom and a generic plan.
 * The fields exist at the table's CREATE, so they are `column` state; a
 * `promoting` field reads through `extraWins`, which no column index serves.
 */

import { randomBytes } from 'node:crypto';
import type { FieldDef, IndexDecl, ReadParams } from '@mnmal-ai/substrate-types';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PgDataset } from '../src/index.js';
import { generatedIdentifier } from '../src/migrate.js';
import { loadTypeTable } from '../src/type-table.js';
import { dropNamespace, TABLES } from './_layout.js';

const POSTGRES_URL = process.env.POSTGRES_URL;
const NS = `tiu_${randomBytes(4).toString('hex')}`;
const TYPE = 'Obs';
const COMPOSITE = `rows_tiu_${randomBytes(4).toString('hex')}`;

const fields: Record<string, FieldDef> = {
  title: { kind: 'scalar', type: 'string', indexed: true },
  n: { kind: 'scalar', type: 'number', indexed: true },
  owner: { kind: 'crossRef', ns: 'x', type: 'Owner', onDelete: 'set_null' },
  cert: { kind: 'scalar', type: 'string' },
  observedAt: { kind: 'scalar', type: 'date' }
};
const indexes: IndexDecl[] = [
  { fields: ['cert', { field: 'observedAt', dir: 'desc' }], name: COMPOSITE }
];

let sql: Sql;
let traced: Sql;
let sent: Array<{ query: string; parameters: unknown[] }> = [];
let ds: PgDataset;
let from: string;

type PlanNode = { 'Node Type': string; 'Index Name'?: string; Plans?: PlanNode[] };

function indexesUsed(node: PlanNode, out: string[] = []): string[] {
  if (node['Index Name'] !== undefined) out.push(node['Index Name']);
  for (const child of node.Plans ?? []) indexesUsed(child, out);
  return out;
}

describe.skipIf(!POSTGRES_URL || !TABLES)('index use on a type table', () => {
  beforeAll(async () => {
    sql = postgres(POSTGRES_URL as string, { onnotice: () => {} });
    traced = postgres(POSTGRES_URL as string, {
      onnotice: () => {},
      debug: (_conn, query, parameters) => {
        sent.push({ query, parameters: parameters as unknown[] });
      }
    });
    ds = new PgDataset({
      namespace: NS,
      sql: traced,
      fieldDefLookup: (type, f) => (type === TYPE ? fields[f] : undefined),
      typeDefLookup: (type) => (type === TYPE ? { fields, indexes } : undefined)
    });
    await ds.ensureTypeStorage(TYPE);
    from = (await loadTypeTable(sql, NS, TYPE))?.from as string;
    await ds.write(
      TYPE,
      Array.from({ length: 2000 }, (_, i) => ({
        id: `r${i}`,
        title: `t${String(i).padStart(5, '0')}`,
        n: i,
        owner: `o${i % 100}`,
        cert: `c${i % 50}`,
        observedAt: new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString()
      }))
    );
    await sql.unsafe(`ANALYZE ${from}`);
  }, 120_000);

  afterAll(async () => {
    await dropNamespace(sql, NS);
    await traced?.end({ timeout: 5 });
    await sql?.end({ timeout: 5 });
  });

  /** The indexes the plan of `read(params)`'s SELECT scans, custom and generic, seq scans off. */
  async function plans(params: ReadParams): Promise<{ custom: string[]; generic: string[] }> {
    sent = [];
    await ds.read(TYPE, params);
    const q = sent.find((s) => s.query.includes(`FROM ${from} r`));
    if (q === undefined) throw new Error('read sent no SELECT on the type table');
    const conn = await sql.reserve();
    try {
      await conn.unsafe('SET enable_seqscan = off');
      const literals = q.parameters.map((p) =>
        p === null ? 'NULL' : `'${String(p).replace(/'/g, "''")}'`
      );
      const args = literals.length === 0 ? '' : `(${literals.join(', ')})`;
      await conn.unsafe(`PREPARE tiu_stmt AS ${q.query}`);
      const explain = async (mode: string) => {
        await conn.unsafe(`SET plan_cache_mode = ${mode}`);
        const rows = await conn.unsafe(`EXPLAIN (FORMAT JSON) EXECUTE tiu_stmt${args}`);
        const plan = ((rows[0]?.['QUERY PLAN'] ?? []) as Array<{ Plan: PlanNode }>)[0]?.Plan;
        return indexesUsed(plan as PlanNode);
      };
      return {
        custom: await explain('force_custom_plan'),
        generic: await explain('force_generic_plan')
      };
    } finally {
      await conn.unsafe('DEALLOCATE ALL');
      await conn.unsafe('RESET plan_cache_mode');
      await conn.unsafe('RESET enable_seqscan');
      conn.release();
    }
  }

  const idx = (field: string) => generatedIdentifier(NS, TYPE, field, 'idx');
  const cases: Array<[string, ReadParams, () => string]> = [
    ['text eq', { where: { title: { eq: 't00042' } } }, () => idx('title')],
    ['number eq', { where: { n: { eq: 42 } } }, () => idx('n')],
    ['crossRef eq', { where: { owner: { eq: 'o7' } } }, () => idx('owner')],
    [
      'declared composite eq + orderBy desc',
      { where: { cert: { eq: 'c7' } }, orderBy: [{ observedAt: 'desc' }], limit: 10 },
      () => COMPOSITE
    ]
  ];

  for (const [name, params, expected] of cases) {
    it(`EXPLAIN of ${name} on an indexed column uses the index`, async () => {
      const { custom, generic } = await plans(params);
      expect(custom, 'custom plan').toContain(expected());
      expect(generic, 'generic plan').toContain(expected());
    });
  }
});

/**
 * The row codec through a real type table: INSERT what `encodeRow` gives,
 * SELECT it back, and `decodeRow` returns the written row. `tables` only.
 */

import { randomBytes } from 'node:crypto';
import { field } from '@mnmal-ai/substrate-sdk';
import type { FieldDef } from '@mnmal-ai/substrate-types';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decodeRow, encodeRow, RAW_KEY } from '../src/row-codec.js';
import { ensureTypeTable, loadTypeTable, type TypeTable } from '../src/type-table.js';

const POSTGRES_URL = process.env.POSTGRES_URL;
const TABLES = process.env.SUBSTRATE_TEST_LAYOUT === 'tables';
const NS = `rc_${randomBytes(4).toString('hex')}`;

const BASE: Record<string, FieldDef> = {
  title: field.string(),
  status: field.enum(['open', 'closed']),
  count: field.number(),
  due: field.date(),
  done: field.boolean(),
  owner: field.crossRef(NS, 'Other')
};

const ROWS: Record<string, unknown>[] = [
  { title: 'plain', status: 'open', count: 3, due: '2026-10-26T10:00:00.000Z', done: true },
  { title: 'day', due: '2026-10-26' },
  { title: 'offset', due: '2026-10-26T10:00:00+02:00' },
  { title: 'nanos', due: '2026-10-26T10:00:00.123456789Z' },
  { title: 'misfits', count: '5', status: 'archived', owner: 42, done: 'yes' },
  { title: null, status: null, later: null, moving: null },
  { note: 'undeclared', blob: null, list: [1, 'a'], obj: { a: 1 } },
  { title: 'pending', later: 'soon' },
  { title: 'promoting', moving: 'm' },
  { title: 'orphaned', gone: 'g' }
];

/** `row` without the explicit nulls a declared column field reads back as absent. */
const expected = (table: TypeTable, row: Record<string, unknown>) =>
  Object.fromEntries(
    Object.entries(row).filter(([k, v]) => {
      if (v !== null) return true;
      const c = table.column(k);
      return !(table.pending.includes(k) || (c !== undefined && c.state !== 'orphaned'));
    })
  );

describe.skipIf(!POSTGRES_URL || !TABLES)('row codec through a type table', () => {
  let sql: Sql;
  let table: TypeTable;
  let tableName: string;

  beforeAll(async () => {
    sql = postgres(POSTGRES_URL as string, { onnotice: () => {} });
    const ensure = (fields: Record<string, FieldDef>, newFields: 'column' | 'pending') =>
      ensureTypeTable(sql, {
        namespace: NS,
        type: 'T',
        fields,
        newFields,
        enforceUuidCheck: false
      });
    // moving: column → orphaned → promoting; gone: column → orphaned; later: pending.
    await ensure({ ...BASE, moving: field.string(), gone: field.string() }, 'column');
    await ensure(BASE, 'column');
    await ensure({ ...BASE, moving: field.string(), later: field.string() }, 'pending');
    const loaded = await loadTypeTable(sql, NS, 'T');
    if (loaded === undefined) throw new Error('no type table');
    table = loaded;
    const [row] = await sql<Array<{ table_name: string }>>`
      SELECT table_name FROM substrate_type_tables WHERE namespace = ${NS} AND type = 'T'`;
    tableName = row?.table_name as string;
  });

  afterAll(async () => {
    await sql.end({ timeout: 5 });
  });

  async function write(id: string, row: Record<string, unknown>): Promise<void> {
    const { columns, extra, raw } = encodeRow(table, row);
    const stored = Object.keys(raw).length === 0 ? extra : { ...extra, [RAW_KEY]: raw };
    await sql`INSERT INTO ${sql(tableName)} ${sql({ id, extra: sql.json(stored as Parameters<typeof sql.json>[0]), ...columns })}`;
  }

  it('the catalog gives the states the rows exercise', () => {
    expect(table.column('moving')?.state).toBe('promoting');
    expect(table.column('gone')?.state).toBe('orphaned');
    expect(table.pending).toEqual(['later']);
  });

  it('rows round-trip through INSERT and SELECT', async () => {
    for (const [i, row] of ROWS.entries()) await write(`r${i}`, row);
    const records = await sql<Array<Record<string, unknown>>>`
      SELECT * FROM ${sql(tableName)} ORDER BY id`;
    expect(records.map((r) => decodeRow(table, r))).toEqual(ROWS.map((r) => expected(table, r)));
  });

  it('the columns hold the canonical values and extra holds no column field', async () => {
    const [day] = await sql<Array<Record<string, boolean>>>`
      SELECT f_due = '2026-10-26T00:00:00Z'::timestamptz AS due,
        NOT (extra ? 'title') AS no_title,
        extra -> ${RAW_KEY} ->> 'due' = '2026-10-26' AS raw_due
      FROM ${sql(tableName)} WHERE id = 'r1'`;
    expect(day).toEqual({ due: true, no_title: true, raw_due: true });
    const [offset] = await sql<Array<{ due: Date }>>`
      SELECT f_due AS due FROM ${sql(tableName)} WHERE id = 'r2'`;
    expect(offset?.due.toISOString()).toBe('2026-10-26T08:00:00.000Z');
    const [misfit] = await sql<Array<Record<string, unknown>>>`
      SELECT f_count AS count, f_status AS status, f_owner AS owner,
        extra -> ${RAW_KEY} AS raw, NOT (extra ? 'title') AS no_title
      FROM ${sql(tableName)} WHERE id = 'r4'`;
    expect(misfit).toEqual({
      count: null,
      status: null,
      owner: '42',
      raw: { count: '5', status: 'archived', owner: 42, done: 'yes' },
      no_title: true
    });
    const [pending] = await sql<Array<{ later: string }>>`
      SELECT extra ->> 'later' AS later FROM ${sql(tableName)} WHERE id = 'r7'`;
    expect(pending?.later).toBe('soon');
  });
});

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

  /** INSERTs `row`, binding dates and `extra` as text so postgres.js never routes them through a JS Date. */
  async function write(id: string, row: Record<string, unknown>): Promise<void> {
    const { columns, extra, raw } = encodeRow(table, row);
    const stored = Object.keys(raw).length === 0 ? extra : { ...extra, [RAW_KEY]: raw };
    const dates = new Set(table.columns().flatMap((c) => (c.kind === 'date' ? [c.column] : [])));
    const names = ['id', 'extra', ...Object.keys(columns)];
    const casts = names.map((n, i) =>
      n === 'extra'
        ? `$${i + 1}::text::jsonb`
        : dates.has(n)
          ? `$${i + 1}::text::timestamptz`
          : `$${i + 1}`
    );
    await sql.unsafe(
      `INSERT INTO ${table.from} (${names.map((n) => `"${n}"`).join(', ')}) VALUES (${casts.join(', ')})`,
      [id, JSON.stringify(stored), ...Object.values(columns)]
    );
  }

  it('the catalog gives the states the rows exercise', () => {
    expect(table.column('moving')?.state).toBe('promoting');
    expect(table.column('gone')?.state).toBe('orphaned');
    expect(table.pending).toEqual(['later']);
  });

  it('rows round-trip through INSERT and SELECT', async () => {
    for (const [i, row] of ROWS.entries()) await write(`r${i}`, row);
    const records = await sql<Array<Record<string, unknown>>>`
      SELECT * FROM ${sql(tableName)} WHERE id LIKE 'r%' ORDER BY id`;
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

  it('dates keep the shared grammar instant at microseconds, whatever the process TZ', async () => {
    const DATES = [
      '2026-10-26T10:00:00.123456Z',
      '2026-10-26T10:00:00',
      '2026-02-30',
      '0099-06-01',
      '0099-06-01T00:00:00.000Z'
    ];
    const tz = process.env.TZ;
    process.env.TZ = 'America/New_York';
    try {
      // Offset-less text would read as local time through `new Date`.
      expect(new Date('2026-10-26T10:00:00').toISOString()).toBe('2026-10-26T14:00:00.000Z');
      for (const [i, due] of DATES.entries()) await write(`d${i}`, { due });
      const rows = await sql<Array<Record<string, unknown>>>`
        SELECT *,
          f_due = '2026-10-26T10:00:00.123456Z'::timestamptz AS micros,
          f_due = '2026-10-26T10:00:00Z'::timestamptz AS utc,
          f_due IS NULL AS null_due,
          f_due = '0099-06-01T00:00:00Z'::timestamptz AS y99
        FROM ${sql(tableName)} WHERE id LIKE 'd%' ORDER BY id`;
      const checks = rows.map(({ micros, utc, null_due, y99 }) => ({ micros, utc, null_due, y99 }));
      const only = (k: string) => ({
        micros: k === 'micros',
        utc: k === 'utc',
        null_due: k === 'null_due',
        y99: k === 'y99'
      });
      expect(checks).toEqual([
        only('micros'),
        only('utc'),
        { micros: null, utc: null, null_due: true, y99: null },
        only('y99'),
        only('y99')
      ]);
      expect(rows.map((r) => decodeRow(table, r))).toEqual(DATES.map((due) => ({ due })));
    } finally {
      if (tz === undefined) delete process.env.TZ;
      else process.env.TZ = tz;
    }
  });
});

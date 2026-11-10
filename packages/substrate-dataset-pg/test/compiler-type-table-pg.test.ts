/**
 * The compiler's type-table SQL run against a real type table. A `promoting`
 * or `orphaned` field may hold anything in `extra` (an orphaned one is
 * undeclared), so reading it never raises: a value its kind cannot read is
 * NULL and matches nothing. A promoting number stays exact (numeric) through
 * `sum`. `tables` only.
 */

import { randomBytes } from 'node:crypto';
import { field } from '@mnmal-ai/substrate-sdk';
import type { FieldDef, WhereClause } from '@mnmal-ai/substrate-types';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildGroupedRead } from '../src/pg-sql/grouped.js';
import { buildOrderBy } from '../src/pg-sql/sorting.js';
import { tableLookup, walkScope } from '../src/pg-sql/walk.js';
import { buildWhere } from '../src/pg-sql/where.js';
import { ensureTypeTable, loadTypeTable, type TypeTable } from '../src/type-table.js';

const POSTGRES_URL = process.env.POSTGRES_URL;
const NS = `ct_${randomBytes(4).toString('hex')}`;

const PROMOTING: Record<string, FieldDef> = {
  flag: field.boolean(),
  qty: field.number(),
  seen: field.date()
};
const ORPHANED: Record<string, FieldDef> = {
  oflag: field.boolean(),
  oqty: field.number(),
  oseen: field.date()
};

describe.skipIf(!POSTGRES_URL)('type-table SQL against a type table', () => {
  let sql: Sql;
  let table: TypeTable;

  beforeAll(async () => {
    sql = postgres(POSTGRES_URL as string, { onnotice: () => {} });
    const ensure = (fields: Record<string, FieldDef>) =>
      ensureTypeTable(sql, {
        namespace: NS,
        type: 'T',
        fields,
        newFields: 'column',
        enforceUuidCheck: false
      });
    // Every field gets a column, all are orphaned, then PROMOTING is declared again.
    await ensure({ ...PROMOTING, ...ORPHANED });
    await ensure({});
    await ensure(PROMOTING);
    const loaded = await loadTypeTable(sql, NS, 'T');
    if (loaded === undefined) throw new Error('no type table');
    table = loaded;
    const col = (f: string) => table.column(f)?.column as string;
    const insert = (id: string, extra: string, cols: Record<string, unknown> = {}) =>
      sql.unsafe(
        `INSERT INTO ${table.from} (id, extra${Object.keys(cols)
          .map((f) => `, ${col(f)}`)
          .join('')})
         VALUES ($1, $2::text::jsonb${Object.keys(cols)
           .map((_, i) => `, $${i + 3}`)
           .join('')})`,
        [id, extra, ...(Object.values(cols) as string[])]
      );
    await insert(
      'good',
      JSON.stringify({
        flag: true,
        qty: 2,
        seen: '2026-01-02T00:00:00Z',
        oflag: true,
        oqty: 2,
        oseen: '2026-01-02'
      })
    );
    // Values the kinds cannot read; 1e400 is a JSON number past float8's range.
    await insert(
      'junk',
      '{"flag":"maybe","qty":1e400,"seen":"garbage","oflag":"maybe","oqty":1e400,"oseen":"garbage"}'
    );
    // No extra keys: the columns answer.
    await insert('col', '{}', {
      flag: true,
      qty: 3,
      seen: '2026-03-01T00:00:00Z',
      oflag: true,
      oqty: 3,
      oseen: '2026-03-01T00:00:00Z'
    });
    await insert('s1', '{"qty":1.00000000000000000001}');
    await insert('s2', '{"qty":-1}');
  });

  afterAll(async () => {
    // Drop this run's type table and catalog rows so repeated runs leave nothing behind.
    if (table !== undefined) await sql.unsafe(`DROP TABLE IF EXISTS ${table.from}`);
    await sql`DELETE FROM substrate_type_fields WHERE namespace = ${NS}`;
    await sql`DELETE FROM substrate_type_tables WHERE namespace = ${NS}`;
    await sql.end({ timeout: 5 });
  });

  const ids = async (where: WhereClause, order: string) => {
    const frag = buildWhere(sql, where, () => null, table) ?? sql`TRUE`;
    const orderBy = buildOrderBy(
      sql,
      [
        [order, 'asc'],
        ['id', 'asc']
      ],
      () => null,
      table
    );
    const rows = await sql<Array<{ id: string }>>`
      SELECT id FROM ${sql.unsafe(table.from)} WHERE ${frag} ${orderBy}`;
    return rows.map((r) => r.id).sort();
  };

  it('the catalog gives the states the rows exercise', () => {
    expect(table.column('flag')?.state).toBe('promoting');
    expect(table.column('oflag')?.state).toBe('orphaned');
  });

  for (const [promoting, orphaned] of [
    ['flag', 'oflag'],
    ['qty', 'oqty'],
    ['seen', 'oseen']
  ] as const) {
    const kind = PROMOTING[promoting] as FieldDef & { type: string };
    const predicate =
      kind.type === 'boolean'
        ? { eq: true }
        : kind.type === 'number'
          ? { gt: 1 }
          : { gte: '2026-01-01' };
    // 1e400 is a number, so it passes `gt: 1`; "maybe" and "garbage" read NULL and match nothing.
    const want = kind.type === 'number' ? ['col', 'good', 'junk'] : ['col', 'good'];
    for (const f of [promoting, orphaned]) {
      it(`a ${kind.type} field (${f}) holding junk filters and sorts without raising`, async () => {
        // s1's 1.00000000000000000001 (for the sum below) is > 1 too.
        expect(await ids({ [f]: predicate } as WhereClause, f)).toEqual(
          f === 'qty' ? [...want, 's1'] : want
        );
      });
    }
  }

  it('sum over a promoting number is exact, in numeric (Todo #1809)', async () => {
    const g = buildGroupedRead(
      sql,
      { aggregate: { s: { sum: 'qty' } } },
      sql`r.id IN ('s1', 's2')`,
      sql``,
      table,
      () => ({ kind: 'scalar', type: 'number' }) as FieldDef
    );
    const [row] = await sql<Array<Record<string, unknown>>>`${g.statement}`;
    // 1.00000000000000000001 is 1 as a float8, which would sum to 0.
    expect(row === undefined ? undefined : g.decode(row)).toEqual({ s: 1e-20 });
  });
});

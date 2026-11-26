/**
 * Row ids order and compare by code point on pg, as on memory, whatever the
 * database collation: a type table's `id` column is `COLLATE "C"`, and the
 * migration converts tables created before that.
 *
 * Skipped when POSTGRES_URL is absent.
 */

import { MemoryDataset } from '@mnmal-ai/substrate-dataset-memory';
import { field } from '@mnmal-ai/substrate-sdk';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureTypeTable, loadTypeTable, PgDataset, runMigrations } from '../src/index.js';
import { TX_STATEMENTS as ID_COLLATION_TX } from '../src/migrations/0010t_id_collation.js';
import { dropNamespacesLike } from './_layout.js';

const POSTGRES_URL = process.env.POSTGRES_URL;
const PREFIX = 'idcoll';
const IDS = ['a', 'B', '_x', 'b-2', 'b2', 'Z'];
const meta = { identity: { kind: 'agent' as const, id: 't' }, now: new Date() };

describe.skipIf(!POSTGRES_URL)('row id order on pg matches memory', () => {
  let sql: Sql;
  let seq = 0;
  const run = Date.now().toString(36);
  const fresh = () => `${PREFIX}_${run}_${++seq}`;

  beforeAll(async () => {
    sql = postgres(POSTGRES_URL as string, { onnotice: () => {} });
    await runMigrations(sql);
  });
  afterAll(async () => {
    await dropNamespacesLike(sql, PREFIX);
    await sql.end();
  });

  async function both() {
    const ns = fresh();
    const pg = new PgDataset({ namespace: ns, sql });
    const mem = new MemoryDataset({ namespace: ns });
    for (const ds of [pg, mem])
      await ds.write(
        'T',
        IDS.map((id) => ({ id })),
        meta
      );
    return { ns, pg, mem };
  }

  const ids = async (ds: PgDataset | MemoryDataset, params: Record<string, unknown>) =>
    (await ds.read('T', params)).rows.map((r) => String(r.id));

  it('orders by id the same on both', async () => {
    const { pg, mem } = await both();
    const params = { orderBy: [['id', 'asc']] };
    expect(await ids(pg, params)).toEqual(await ids(mem, params));
  });

  it('range-filters on id the same on both', async () => {
    const { pg, mem } = await both();
    const params = { where: { id: { gt: 'Z' } }, orderBy: [['id', 'asc']] };
    expect(await ids(pg, params)).toEqual(await ids(mem, params));
  });

  it('the shared tables hold row ids in "C"', async () => {
    const rows = await sql<Array<{ col: string; coll: string }>>`
      SELECT c.relname || '.' || a.attname AS col, a.attcollation::regcollation::text AS coll
      FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
      WHERE c.relnamespace = current_schema()::regnamespace
        AND (c.relname, a.attname) IN (
          ('row_ids', 'id'), ('short_ids', 'row_id'), ('edges', 'from_id'), ('edges', 'to_id'))
      ORDER BY 1`;
    expect(rows).toEqual(
      ['edges.from_id', 'edges.to_id', 'row_ids.id', 'short_ids.row_id'].map((col) => ({
        col,
        coll: '"C"'
      }))
    );
  });

  it('the migration converts id and crossRef columns left on the default collation', async () => {
    const ns = fresh();
    await ensureTypeTable(sql, {
      namespace: ns,
      type: 'T',
      fields: { ref: field.crossRef(ns, 'T') },
      newFields: 'column',
      enforceUuidCheck: false
    });
    const pg = new PgDataset({ namespace: ns, sql });
    await pg.write(
      'T',
      IDS.map((id) => ({ id })),
      meta
    );
    const table = await loadTypeTable(sql, ns, 'T');
    if (table === undefined) throw new Error('no table');
    const refColumn = table.column('ref')?.column;
    if (refColumn === undefined) throw new Error('no ref column');
    await sql.unsafe(
      `ALTER TABLE ${table.from} ALTER COLUMN id TYPE text COLLATE "default", ALTER COLUMN "${refColumn}" TYPE text COLLATE "default"`
    );
    for (const stmt of ID_COLLATION_TX) await sql.unsafe(stmt);
    for (const stmt of ID_COLLATION_TX) await sql.unsafe(stmt);
    const rows = await sql<Array<{ name: string; coll: string }>>`
      SELECT a.attname AS name, a.attcollation::regcollation::text AS coll
      FROM pg_attribute a
      WHERE a.attrelid = ${table.from}::regclass AND a.attname IN ('id', ${refColumn})
      ORDER BY a.attname`;
    expect(rows.map((r) => r.coll)).toEqual(['"C"', '"C"']);
    expect(await ids(pg, { orderBy: [['id', 'asc']] })).toEqual([...IDS].sort());
  });
});

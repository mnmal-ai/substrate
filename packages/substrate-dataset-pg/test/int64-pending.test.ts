/**
 * An int64 written while its field is `pending` (no column yet) is held in
 * `extra` as an exact JSON number, filters exactly, and the promotion sweep
 * moves it into the bigint column.
 */

import { randomBytes } from 'node:crypto';
import { field } from '@mnmal-ai/substrate-sdk';
import type { FieldDef } from '@mnmal-ai/substrate-types';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PgDataset } from '../src/index.js';
import { loadTypeTable } from '../src/type-table.js';
import { dropNamespace } from './_layout.js';

const POSTGRES_URL = process.env.POSTGRES_URL;
const BEYOND_SAFE = 9007199254740993n;
const MAX = 2n ** 63n - 1n;

describe.skipIf(!POSTGRES_URL)('int64 in a pending field', () => {
  let sql: Sql;
  const ns = `i64p_${randomBytes(4).toString('hex')}`;
  const defs: Record<string, { fields: Record<string, FieldDef> }> = {
    Note: { fields: { title: field.string() } }
  };
  let pg: PgDataset;

  beforeAll(() => {
    sql = postgres(POSTGRES_URL as string, { onnotice: () => {} });
    pg = new PgDataset({
      namespace: ns,
      sql,
      typeDefLookup: (t) => defs[t],
      fieldDefLookup: (t, f) => defs[t]?.fields[f]
    });
  });

  afterAll(async () => {
    await dropNamespace(sql, ns);
    await sql.end({ timeout: 5 });
  });

  it('is written to extra exactly, filters exactly, and promotes into the column', async () => {
    await pg.write('Note', [{ id: 'n0', title: 'seed' }]);
    defs.Note = { fields: { title: field.string(), big: field.int64() } };
    expect(await pg.ensureTypeStorage('Note', { newFields: 'pending' })).toEqual({
      pending: ['big']
    });

    await pg.write('Note', [
      { id: 'n1', title: 'a', big: BEYOND_SAFE },
      { id: 'n2', title: 'b', big: MAX }
    ]);
    const t = await loadTypeTable(sql, ns, 'Note');
    const held = await sql.unsafe(`SELECT id, extra ->> 'big' AS big FROM ${t?.from} ORDER BY id`);
    expect(held.map((r) => [r.id, r.big])).toEqual([
      ['n0', null],
      ['n1', '9007199254740993'],
      ['n2', '9223372036854775807']
    ]);

    const ids = async (where: Record<string, unknown>) =>
      (await pg.read('Note', { where })).rows.map((r) => r.id).sort();
    expect(await ids({ big: { eq: '9007199254740993' } })).toEqual(['n1']);
    expect(await ids({ big: { gt: '9007199254740993' } })).toEqual(['n2']);

    const events = await pg.promotePendingFields({
      lockTimeoutMs: 2000,
      batchRows: 100,
      namespace: ns
    });
    expect(events.map((e) => e.kind)).toEqual(['promoted']);
    const col = (await loadTypeTable(sql, ns, 'Note'))?.column('big')?.column as string;
    const stored = await sql.unsafe(
      `SELECT id, ${col}::text AS c, extra ? 'big' AS inx, extra ? '$raw' AS raw FROM ${t?.from} ORDER BY id`
    );
    expect(stored.map((r) => [r.id, r.c, r.inx, r.raw])).toEqual([
      ['n0', null, false, false],
      ['n1', '9007199254740993', false, false],
      ['n2', '9223372036854775807', false, false]
    ]);
    const read = (await pg.read('Note', { orderBy: [{ big: 'asc' }] })).rows;
    expect(read.slice(0, 2).map((r) => r.big)).toEqual([BEYOND_SAFE, MAX]);
  });

  it('the sweep keeps an out-of-range integer and a fraction under $raw and promotes the rest', async () => {
    const ns2 = `i64q_${randomBytes(4).toString('hex')}`;
    const d: Record<string, { fields: Record<string, FieldDef> }> = {
      Note: { fields: { title: field.string() } }
    };
    const ds = new PgDataset({
      namespace: ns2,
      sql,
      typeDefLookup: (t) => d[t],
      fieldDefLookup: (t, f) => d[t]?.fields[f]
    });
    try {
      // Written before the field is declared int64, so they sit in extra as written.
      await ds.write('Note', [
        { id: 'big', title: 'a', score: 99999999999999999999n },
        { id: 'frac', title: 'b', score: 1.5 },
        { id: 'ok', title: 'c', score: 42 }
      ]);
      d.Note = { fields: { title: field.string(), score: field.int64() } };
      await ds.ensureTypeStorage('Note', { newFields: 'pending' });
      const events = await ds.promotePendingFields({
        lockTimeoutMs: 2000,
        batchRows: 100,
        namespace: ns2
      });
      expect(events.map((e) => e.kind)).toEqual(['promoted']);
      const t = await loadTypeTable(sql, ns2, 'Note');
      const col = t?.column('score')?.column as string;
      const rows = await sql.unsafe(
        `SELECT id, ${col}::text AS c, extra -> '$raw' ->> 'score' AS raw FROM ${t?.from} ORDER BY id`
      );
      expect(rows.map((r) => [r.id, r.c, r.raw])).toEqual([
        ['big', null, '99999999999999999999'],
        ['frac', null, '1.5'],
        ['ok', '42', null]
      ]);
    } finally {
      await dropNamespace(sql, ns2);
    }
  });
});

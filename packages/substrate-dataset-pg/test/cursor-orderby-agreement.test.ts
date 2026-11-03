/**
 * Keyset pagination must return the same rows as an unpaginated read: the
 * cursor carries a sort key at full precision, and a derived key sorts,
 * projects into the cursor and compares through one expression.
 */

import { MemoryDataset } from '@mnmal-ai/substrate-dataset-memory';
import type { FieldDef, Row } from '@mnmal-ai/substrate-types';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PgDataset, runMigrations } from '../src/index.js';
import { relationOf, truncateRows } from './_layout.js';

const POSTGRES_URL = process.env.POSTGRES_URL;

describe.skipIf(!POSTGRES_URL)('keyset pagination over sub-millisecond timestamps', () => {
  let sql: Sql;
  // The cursor used to carry the sort key as a JS Date, which keeps
  // milliseconds only, so `.123456` came back as `.123` and the next page
  // started at (and re-served) the cursor row itself.
  const dueAtIsDate = (_type: string, field: string): FieldDef | undefined =>
    field === 'dueAt' ? { kind: 'scalar', type: 'date' } : undefined;

  beforeAll(async () => {
    sql = postgres(POSTGRES_URL as string);
    await runMigrations(sql);
  });
  afterAll(async () => {
    await sql.end();
  });

  for (const dir of ['asc', 'desc'] as const) {
    it(`pages a microsecond-precision date field without repeats (${dir})`, async () => {
      await truncateRows(sql);
      const ds = new PgDataset({ namespace: 'cursor_usec', sql, fieldDefLookup: dueAtIsDate });
      await ds.write('Memo', [
        { id: 'a', dueAt: '2026-10-21T10:00:00.123456Z' },
        { id: 'b', dueAt: '2026-10-21T10:00:00.123789Z' },
        { id: 'c', dueAt: '2026-10-21T10:00:00.124001Z' }
      ] as Row[]);

      const seen: string[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 10; page++) {
        const res = await ds.read('Memo', {
          orderBy: [{ dueAt: dir }],
          limit: 1,
          ...(cursor === undefined ? {} : { cursor })
        });
        seen.push(...res.rows.map((r) => String(r.id)));
        const next = (res as { nextCursor?: string | null }).nextCursor;
        if (next === undefined || next === null || res.rows.length === 0) break;
        cursor = next;
      }
      expect(seen).toEqual(dir === 'asc' ? ['a', 'b', 'c'] : ['c', 'b', 'a']);
    });
  }

  it('pages createdAt the same way when it carries microseconds', async () => {
    await truncateRows(sql);
    const ds = new PgDataset({ namespace: 'cursor_usec', sql });
    await ds.write('Memo', [{ id: 'a' }, { id: 'b' }, { id: 'c' }] as Row[]);
    // Writes through a path that stamps now() carry microseconds.
    await sql.unsafe(
      `UPDATE ${await relationOf(sql, 'cursor_usec', 'Memo')}
       SET created_at = '2026-10-21T10:00:00.123456Z'::timestamptz
         + (CASE id::text WHEN 'a' THEN 1 WHEN 'b' THEN 2 ELSE 3 END) * interval '1 microsecond'`
    );
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page++) {
      const res = await ds.read('Memo', {
        orderBy: [{ createdAt: 'asc' }],
        limit: 1,
        ...(cursor === undefined ? {} : { cursor })
      });
      seen.push(...res.rows.map((r) => String(r.id)));
      const next = (res as { nextCursor?: string | null }).nextCursor;
      if (next === undefined || next === null || res.rows.length === 0) break;
      cursor = next;
    }
    expect(seen).toEqual(['a', 'b', 'c']);
  });
});

// Derived keys are walk grammar.
describe.skipIf(!POSTGRES_URL)('keyset pagination over a derived key', () => {
  // A derived key is computed per row, so the same expression must sort,
  // project into the cursor and compare against it; its NULLs (a missing
  // operand, a zero divisor) sort last in both directions, as memory's do.
  let sql: Sql;
  const num: FieldDef = { kind: 'scalar', type: 'number' };
  const fieldDefLookup = (_type: string, field: string): FieldDef | undefined =>
    field === 'a' || field === 'b' ? num : undefined;
  const rows: Row[] = [
    { id: 'k1', a: 6, b: 3 },
    { id: 'k2', a: 1, b: 0 },
    { id: 'k3', a: 4, b: 2 },
    { id: 'k4', b: 5 },
    { id: 'k5', a: 9, b: 3 },
    { id: 'k6', a: -2, b: 4 },
    { id: 'k7', a: 2, b: 1 }
  ];

  beforeAll(async () => {
    sql = postgres(POSTGRES_URL as string);
    await runMigrations(sql);
  });
  afterAll(async () => {
    await sql.end();
  });

  for (const dir of ['asc', 'desc'] as const) {
    it(`pages a ratio like the memory backend, nulls last (${dir})`, async () => {
      await truncateRows(sql);
      const ds = new PgDataset({ namespace: 'cursor_derive', sql, fieldDefLookup });
      await ds.ensureTypeStorage('Memo');
      const mem = new MemoryDataset({ namespace: 'cursor_derive', fieldDefLookup });
      await ds.write('Memo', rows);
      await mem.write('Memo', rows);

      async function pageAll(dataset: { read: PgDataset['read'] }): Promise<string[]> {
        const seen: string[] = [];
        let cursor: string | undefined;
        for (let page = 0; page < 20; page++) {
          const res = await dataset.read('Memo', {
            derive: { r: { ratio: ['$.a', '$.b'] } },
            orderBy: [{ $r: dir }],
            limit: 2,
            ...(cursor === undefined ? {} : { cursor })
          });
          seen.push(...res.rows.map((r) => String(r.id)));
          if (res.nextCursor === undefined) break;
          cursor = res.nextCursor;
        }
        return seen;
      }

      const pgPages = await pageAll(ds);
      expect(pgPages).toEqual(await pageAll(mem as unknown as { read: PgDataset['read'] }));
      // k1, k3 and k7 tie at 2; k2 (zero divisor) and k4 (no a) are the null tail.
      expect(pgPages).toEqual(
        dir === 'asc'
          ? ['k6', 'k1', 'k3', 'k7', 'k5', 'k2', 'k4']
          : ['k5', 'k1', 'k3', 'k7', 'k6', 'k2', 'k4']
      );
    });
  }
});

/**
 * Filter / orderBy / cursor coverage for PgDataset. Spec §5.2.
 *
 * Skipped when POSTGRES_URL isn't set. Intentionally mirrors the shape of
 * the memory-dataset filter tests so divergence is loud.
 */

import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PgDataset, runMigrations } from '../src/index.js';

const POSTGRES_URL = process.env.POSTGRES_URL;

describe.skipIf(!POSTGRES_URL)('PgDataset — §5.2 filter', () => {
  let sql: Sql;
  let ds: PgDataset;

  beforeAll(async () => {
    sql = postgres(POSTGRES_URL as string);
    await runMigrations(sql);
  });

  afterAll(async () => {
    await sql.end();
  });

  beforeEach(async () => {
    await sql`TRUNCATE TABLE rows, short_ids`;
    ds = new PgDataset({ namespace: 'test_ns', sql });
  });

  describe('where-clause operators', () => {
    it('number: eq / neq / gt / gte / lt / lte / between', async () => {
      await ds.write('N', [
        { id: '1', v: 5 },
        { id: '2', v: 10 },
        { id: '3', v: 15 }
      ]);
      expect((await ds.read('N', { where: { v: { eq: 10 } } })).rows.map((r) => r.id)).toEqual([
        '2'
      ]);
      expect(
        (await ds.read('N', { where: { v: { neq: 10 } } })).rows.map((r) => r.id).sort()
      ).toEqual(['1', '3']);
      expect((await ds.read('N', { where: { v: { gt: 10 } } })).rows.map((r) => r.id)).toEqual([
        '3'
      ]);
      expect(
        (await ds.read('N', { where: { v: { gte: 10 } } })).rows.map((r) => r.id).sort()
      ).toEqual(['2', '3']);
      expect((await ds.read('N', { where: { v: { lt: 10 } } })).rows.map((r) => r.id)).toEqual([
        '1'
      ]);
      expect(
        (await ds.read('N', { where: { v: { lte: 10 } } })).rows.map((r) => r.id).sort()
      ).toEqual(['1', '2']);
      expect(
        (await ds.read('N', { where: { v: { between: [10, 15] } } })).rows.map((r) => r.id).sort()
      ).toEqual(['2', '3']);
    });

    it('number: in / nin', async () => {
      await ds.write('N', [
        { id: '1', v: 5 },
        { id: '2', v: 10 },
        { id: '3', v: 15 }
      ]);
      expect(
        (await ds.read('N', { where: { v: { in: [5, 15] } } })).rows.map((r) => r.id).sort()
      ).toEqual(['1', '3']);
      expect(
        (await ds.read('N', { where: { v: { nin: [5, 15] } } })).rows.map((r) => r.id)
      ).toEqual(['2']);
    });

    it('string: contains / startsWith / endsWith (case-insensitive)', async () => {
      await ds.write('S', [
        { id: '1', label: 'Hello World' },
        { id: '2', label: 'WORLD PEACE' },
        { id: '3', label: 'goodnight' }
      ]);
      expect(
        (await ds.read('S', { where: { label: { contains: 'world' } } })).rows
          .map((r) => r.id)
          .sort()
      ).toEqual(['1', '2']);
      expect(
        (await ds.read('S', { where: { label: { startsWith: 'hello' } } })).rows.map((r) => r.id)
      ).toEqual(['1']);
      expect(
        (await ds.read('S', { where: { label: { endsWith: 'PEACE' } } })).rows.map((r) => r.id)
      ).toEqual(['2']);
    });

    it('string: gt / lt / between (lexicographic — ASCII-safe: collation = code-unit for ASCII)', async () => {
      // pg compares by column collation; for ASCII-shaped keys collation order
      // matches UTF-16 code-unit order (the memory evaluator's contract) so both
      // datasets agree on these values.
      await ds.write('S', [
        { id: 'a1', title: 'apple' },
        { id: 'a2', title: 'mango' },
        { id: 'a3', title: 'zebra' }
      ]);
      // gt 'm' → rows strictly greater-than 'm': 'mango' > 'm' ✓, 'zebra' > 'm' ✓
      expect(
        (await ds.read('S', { where: { title: { gt: 'm' } } })).rows
          .map((r) => r.title as string)
          .sort()
      ).toEqual(['mango', 'zebra']);
      // between ['a', 'n'] inclusive: 'apple' and 'mango' (both <= 'n'); 'zebra' > 'n' ✗
      expect(
        (await ds.read('S', { where: { title: { between: ['a', 'n'] } } })).rows
          .map((r) => r.title as string)
          .sort()
      ).toEqual(['apple', 'mango']);
      // lt 'm' → only 'apple' (< 'm'); 'mango' starts with 'm' but is > 'm'; 'zebra' > 'm'
      expect(
        (await ds.read('S', { where: { title: { lt: 'm' } } })).rows.map((r) => r.title as string)
      ).toEqual(['apple']);
    });

    it('boolean: eq', async () => {
      await ds.write('B', [
        { id: '1', done: true },
        { id: '2', done: false }
      ]);
      expect((await ds.read('B', { where: { done: { eq: true } } })).rows.map((r) => r.id)).toEqual(
        ['1']
      );
      expect(
        (await ds.read('B', { where: { done: { eq: false } } })).rows.map((r) => r.id)
      ).toEqual(['2']);
    });

    // Uniform `where: { id }` across types that don't declare id in body.
    // Pg-side this routes to the native `id` column, not body extraction.
    // The test inserts rows where `body.id` would never match (autoCRUD-style:
    // no id stored in body) and asserts the PK column lookup wins.
    it('id: eq / neq / in / nin / contains / startsWith / endsWith route to PK column', async () => {
      // Bodies deliberately omit `id` to mimic autoCRUD-managed types where
      // the row PK isn't projected into body. If the predicate fell through
      // to `body ->> 'id'`, every row would be NULL on that path and these
      // assertions would fail. Note: leading/trailing prefix uses the PK
      // value directly so contains/startsWith/endsWith behave as expected.
      await ds.write('I', [
        { id: 'todo-alpha', label: 'A' },
        { id: 'todo-beta', label: 'B' },
        { id: 'task-gamma', label: 'C' }
      ]);
      expect(
        (await ds.read('I', { where: { id: { eq: 'todo-alpha' } } })).rows.map((r) => r.label)
      ).toEqual(['A']);
      expect(
        (await ds.read('I', { where: { id: { neq: 'todo-alpha' } } })).rows
          .map((r) => r.label)
          .sort()
      ).toEqual(['B', 'C']);
      expect(
        (await ds.read('I', { where: { id: { in: ['todo-alpha', 'task-gamma'] } } })).rows
          .map((r) => r.label)
          .sort()
      ).toEqual(['A', 'C']);
      expect(
        (await ds.read('I', { where: { id: { nin: ['todo-alpha', 'task-gamma'] } } })).rows.map(
          (r) => r.label
        )
      ).toEqual(['B']);
      expect(
        (await ds.read('I', { where: { id: { startsWith: 'todo-' } } })).rows
          .map((r) => r.label)
          .sort()
      ).toEqual(['A', 'B']);
      expect(
        (await ds.read('I', { where: { id: { contains: 'gamma' } } })).rows.map((r) => r.label)
      ).toEqual(['C']);
      expect(
        (await ds.read('I', { where: { id: { endsWith: '-beta' } } })).rows.map((r) => r.label)
      ).toEqual(['B']);
    });

    // Defensive: if a row happens to have a body.id that disagrees with the
    // PK (legacy migration shape, hand-crafted writes), the predicate must
    // still match against the PK column — never the body field.
    it('id: PK lookup wins even when body.id disagrees', async () => {
      await ds.write('I', [
        { id: 'real-pk', id_in_body: 'spoofed', body: { id: 'spoofed' } }
      ] as never);
      const got = await ds.read('I', { where: { id: { eq: 'real-pk' } } });
      expect(got.rows.map((r) => r.id)).toEqual(['real-pk']);
      const miss = await ds.read('I', { where: { id: { eq: 'spoofed' } } });
      expect(miss.rows).toEqual([]);
    });

    it('AND / OR / NOT', async () => {
      await ds.write('T', [
        { id: '1', a: 1, b: 'x' },
        { id: '2', a: 1, b: 'y' },
        { id: '3', a: 2, b: 'x' }
      ]);
      expect(
        (
          await ds.read('T', {
            where: { AND: [{ a: { eq: 1 } }, { b: { eq: 'x' } }] }
          })
        ).rows.map((r) => r.id)
      ).toEqual(['1']);
      expect(
        (
          await ds.read('T', {
            where: { OR: [{ a: { eq: 2 } }, { b: { eq: 'y' } }] }
          })
        ).rows
          .map((r) => r.id)
          .sort()
      ).toEqual(['2', '3']);
      expect(
        (
          await ds.read('T', {
            where: { NOT: { a: { eq: 1 } } }
          })
        ).rows.map((r) => r.id)
      ).toEqual(['3']);
    });

    // List element membership via JSONB `@>`. Byte-parity with the memory
    // suite (list fields stored as native JSONB arrays in body).
    it('list: has — string element membership', async () => {
      await ds.write('T', [
        { id: '1', tags: ['urgent', 'review'] },
        { id: '2', tags: ['done'] },
        { id: '3', tags: ['urgent', 'blocked'] },
        { id: '4', tags: [] }
      ]);
      expect(
        (await ds.read('T', { where: { tags: { has: 'urgent' } } })).rows.map((r) => r.id).sort()
      ).toEqual(['1', '3']);
      expect(
        (await ds.read('T', { where: { tags: { has: 'done' } } })).rows.map((r) => r.id)
      ).toEqual(['2']);
      expect((await ds.read('T', { where: { tags: { has: 'nope' } } })).rows).toEqual([]);
    });

    it('list: has — numeric element membership (native types, 10 ≠ "10")', async () => {
      await ds.write('T', [
        { id: '1', scores: [1, 2, 10] },
        { id: '2', scores: [3] }
      ]);
      expect(
        (await ds.read('T', { where: { scores: { has: 10 } } })).rows.map((r) => r.id)
      ).toEqual(['1']);
      expect((await ds.read('T', { where: { scores: { has: '10' } } })).rows).toEqual([]);
    });
  });

  describe('orderBy', () => {
    it('ascending / descending on a scalar field', async () => {
      await ds.write('T', [
        { id: '1', n: 30 },
        { id: '2', n: 10 },
        { id: '3', n: 20 }
      ]);
      // JSONB ->> returns text — sort is lexicographic. We use zero-padded
      // string ids so the id tie-break is stable. For numeric orderBy the
      // test uses 2-digit numbers so text-sort matches numeric-sort.
      await sql`TRUNCATE TABLE rows, short_ids`;
      await ds.write('T', [
        { id: '1', n: '30' },
        { id: '2', n: '10' },
        { id: '3', n: '20' }
      ]);
      expect((await ds.read('T', { orderBy: [{ n: 'asc' }] })).rows.map((r) => r.id)).toEqual([
        '2',
        '3',
        '1'
      ]);
      expect((await ds.read('T', { orderBy: [{ n: 'desc' }] })).rows.map((r) => r.id)).toEqual([
        '1',
        '3',
        '2'
      ]);
    });
  });

  describe('cursor pagination', () => {
    it('walks end-to-end without dupes or skips', async () => {
      // 20 rows with unique n from '01' through '20' so text sort equals numeric sort.
      const rows = Array.from({ length: 20 }, (_, i) => ({
        id: `t${String(i + 1).padStart(2, '0')}`,
        n: String(i + 1).padStart(2, '0')
      }));
      await ds.write('T', rows);

      const seen: string[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 5; page++) {
        const res = await ds.read('T', {
          orderBy: [{ n: 'asc' }],
          limit: 5,
          ...(cursor !== undefined ? { cursor } : {})
        });
        seen.push(...res.rows.map((r) => r.id as string));
        if (!res.hasMore) break;
        cursor = res.nextCursor;
      }
      expect(seen).toHaveLength(20);
      expect(new Set(seen).size).toBe(20);
      expect(seen).toEqual(rows.map((r) => r.id));
    });

    it('hasMore is false on the last page, nextCursor is undefined', async () => {
      await ds.write('T', [
        { id: '1', v: '01' },
        { id: '2', v: '02' },
        { id: '3', v: '03' }
      ]);
      const res = await ds.read('T', { orderBy: [{ v: 'asc' }], limit: 10 });
      expect(res.rows).toHaveLength(3);
      expect(res.hasMore).toBe(false);
      expect(res.nextCursor).toBeUndefined();
    });
  });
});

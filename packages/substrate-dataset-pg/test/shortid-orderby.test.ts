/**
 * PG dataset orderBy + cursor pagination on the shortId sidecar column.
 *
 * shortId lives on the LEFT-joined `short_ids.short_id` (alias `s`), not
 * in the JSONB body. If the orderBy / cursor builders fall through to
 * `body ->> field`, shortId is NULL on every row and NULLS LAST collapses the
 * result to insertion order regardless of direction.
 *
 * The shortIds chosen here are intentionally not in sorted lex order
 * (2, 11, 5, 22, 9): a correct numeric sort gives a different sequence than a
 * lexicographic sort (which would treat them as text via body->>). Both
 * brokenness modes (silent-drop and lex-as-numeric) fail the assertions.
 *
 * Skipped when POSTGRES_URL is absent.
 */

import postgres, { type Sql } from 'postgres';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PgDataset, runMigrations } from '../src/index.js';

const POSTGRES_URL = process.env.POSTGRES_URL;

describe.skipIf(!POSTGRES_URL)('PG dataset orderBy + cursor on shortId sidecar', () => {
  let sql: Sql;
  let ds: PgDataset;

  beforeEach(async () => {
    sql = postgres(POSTGRES_URL as string, { onnotice: () => {} });
    await sql`DROP TABLE IF EXISTS rows CASCADE`;
    await sql`DROP TABLE IF EXISTS short_ids CASCADE`;
    await runMigrations(sql, { force: true });
    ds = new PgDataset({ namespace: 'test', sql });

    const items: Array<{ id: string; shortId: number }> = [
      { id: 'r-a', shortId: 2 },
      { id: 'r-b', shortId: 11 },
      { id: 'r-c', shortId: 5 },
      { id: 'r-d', shortId: 22 },
      { id: 'r-e', shortId: 9 }
    ];
    for (const { id, shortId } of items) {
      await ds.write('Thing', [{ id, name: id }]);
      await ds.bindShortId('Thing', shortId, id);
    }
  });

  afterEach(async () => {
    await sql.end();
  });

  describe('orderBy on shortId', () => {
    it('orderBy shortId desc returns rows numerically descending (22, 11, 9, 5, 2)', async () => {
      const result = await ds.read('Thing', { orderBy: [{ shortId: 'desc' }] });
      expect(result.rows.map((r) => r.shortId)).toEqual([22, 11, 9, 5, 2]);
    });

    it('orderBy shortId asc returns rows numerically ascending (2, 5, 9, 11, 22)', async () => {
      const result = await ds.read('Thing', { orderBy: [{ shortId: 'asc' }] });
      expect(result.rows.map((r) => r.shortId)).toEqual([2, 5, 9, 11, 22]);
    });

    it('asc and desc produce inverse orderings (regression: silent-drop bug)', async () => {
      const asc = await ds.read('Thing', { orderBy: [{ shortId: 'asc' }] });
      const desc = await ds.read('Thing', { orderBy: [{ shortId: 'desc' }] });
      expect(asc.rows.map((r) => r.shortId)).toEqual(
        desc.rows
          .map((r) => r.shortId)
          .slice()
          .reverse()
      );
    });
  });

  describe('cursor pagination on shortId', () => {
    it('asc cursor pagination yields full numeric sequence with no overlap or gap', async () => {
      const pageSize = 2;
      const page1 = await ds.read('Thing', {
        orderBy: [{ shortId: 'asc' }],
        limit: pageSize
      });
      expect(page1.rows.map((r) => r.shortId)).toEqual([2, 5]);
      expect(page1.nextCursor).toBeDefined();

      const page2 = await ds.read('Thing', {
        orderBy: [{ shortId: 'asc' }],
        limit: pageSize,
        cursor: page1.nextCursor!
      });
      expect(page2.rows.map((r) => r.shortId)).toEqual([9, 11]);
      expect(page2.nextCursor).toBeDefined();

      const page3 = await ds.read('Thing', {
        orderBy: [{ shortId: 'asc' }],
        limit: pageSize,
        cursor: page2.nextCursor!
      });
      expect(page3.rows.map((r) => r.shortId)).toEqual([22]);
      expect(page3.nextCursor).toBeUndefined();
    });

    it('desc cursor pagination walks shortIds high-to-low', async () => {
      const pageSize = 2;
      const page1 = await ds.read('Thing', {
        orderBy: [{ shortId: 'desc' }],
        limit: pageSize
      });
      expect(page1.rows.map((r) => r.shortId)).toEqual([22, 11]);

      const page2 = await ds.read('Thing', {
        orderBy: [{ shortId: 'desc' }],
        limit: pageSize,
        cursor: page1.nextCursor!
      });
      expect(page2.rows.map((r) => r.shortId)).toEqual([9, 5]);
    });
  });
});

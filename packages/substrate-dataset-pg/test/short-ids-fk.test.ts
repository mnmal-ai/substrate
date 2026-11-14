/**
 * #1845: `DROP TABLE row_ids CASCADE` drops `short_ids_row_id_fkey`, and the
 * baseline only creates it with `short_ids`. 0008t restores it on re-run.
 */

import { randomBytes } from 'node:crypto';
import postgres, { type Sql } from 'postgres';
import { describe, expect, it } from 'vitest';
import { runMigrations } from '../src/index.js';

const POSTGRES_URL = process.env.POSTGRES_URL;

async function withFreshSchema(fn: (sql: Sql, notices: string[]) => Promise<void>): Promise<void> {
  const schema = `substrate_fk_${randomBytes(4).toString('hex')}`;
  const notices: string[] = [];
  const sql = postgres(POSTGRES_URL as string, {
    max: 1,
    onnotice: (n) => void notices.push(String(n.message))
  });
  try {
    await sql.unsafe(`CREATE SCHEMA ${schema}`);
    await sql.unsafe(`SET search_path TO ${schema}`);
    await fn(sql, notices);
  } finally {
    await sql.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await sql.end({ timeout: 5 });
  }
}

async function fk(sql: Sql): Promise<Array<{ validated: boolean }>> {
  return sql<Array<{ validated: boolean }>>`
    SELECT convalidated AS validated FROM pg_constraint
    WHERE conrelid = 'short_ids'::regclass AND conname = 'short_ids_row_id_fkey'`;
}

describe.skipIf(!POSTGRES_URL)('short_ids_row_id_fkey after DROP TABLE row_ids CASCADE', () => {
  it('re-running migrations restores the FK, validated, and it cascades again', async () => {
    await withFreshSchema(async (sql) => {
      await runMigrations(sql);
      expect(await fk(sql)).toEqual([{ validated: true }]);

      await sql`DROP TABLE row_ids CASCADE`;
      expect(await fk(sql)).toEqual([]);

      await runMigrations(sql, { force: true });
      expect(await fk(sql)).toEqual([{ validated: true }]);

      await sql`INSERT INTO row_ids (namespace, type, id) VALUES ('n', 'T', 'r1')`;
      await sql`INSERT INTO short_ids (namespace, type, short_id, row_id) VALUES ('n', 'T', 1, 'r1')`;
      await sql`DELETE FROM row_ids WHERE id = 'r1'`;
      expect(await sql`SELECT 1 FROM short_ids`).toHaveLength(0);
    });
  });

  it('keeps orphaned short ids, adds the FK NOT VALID and warns', async () => {
    await withFreshSchema(async (sql, notices) => {
      await runMigrations(sql);
      await sql`INSERT INTO row_ids (namespace, type, id) VALUES ('n', 'T', 'r1')`;
      await sql`INSERT INTO short_ids (namespace, type, short_id, row_id) VALUES ('n', 'T', 1, 'r1')`;
      await sql`DROP TABLE row_ids CASCADE`;

      await runMigrations(sql, { force: true });
      expect(await fk(sql)).toEqual([{ validated: false }]);
      expect(await sql`SELECT row_id FROM short_ids`).toEqual([{ row_id: 'r1' }]);
      expect(notices.some((n) => n.includes('short_ids_row_id_fkey left NOT VALID'))).toBe(true);
      // New writes are checked even so.
      await expect(
        sql`INSERT INTO short_ids (namespace, type, short_id, row_id) VALUES ('n', 'T', 2, 'nope')`
      ).rejects.toMatchObject({ code: '23503' });

      // Once repaired, a re-run validates it.
      await sql`INSERT INTO row_ids (namespace, type, id) VALUES ('n', 'T', 'r1')`;
      await runMigrations(sql, { force: true });
      expect(await fk(sql)).toEqual([{ validated: true }]);
    });
  });
});

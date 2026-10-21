/**
 * A failed `CREATE INDEX CONCURRENTLY` leaves an INVALID index; the re-run
 * must rebuild it rather than let `IF NOT EXISTS` accept it.
 */
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runDerivedMigrations, runMigrations } from '../src/index.js';

const POSTGRES_URL = process.env.POSTGRES_URL;

describe.skipIf(!POSTGRES_URL)('concurrent index over an invalid leftover', () => {
  let sql: Sql;

  beforeAll(async () => {
    sql = postgres(POSTGRES_URL as string, { onnotice: () => {} });
    await runMigrations(sql);
  });

  afterAll(async () => {
    await sql`DROP TABLE IF EXISTS invalid_idx_probe`;
    await sql`DELETE FROM migrations WHERE version = 'test:invalid-idx-probe'`;
    await sql.end();
  });

  it('drops the invalid index and builds a valid one', async () => {
    await sql`DROP TABLE IF EXISTS invalid_idx_probe`;
    await sql`DELETE FROM migrations WHERE version = 'test:invalid-idx-probe'`;
    await sql`CREATE TABLE invalid_idx_probe (a int)`;
    await sql`INSERT INTO invalid_idx_probe VALUES (1), (1)`;
    await expect(
      sql.unsafe('CREATE UNIQUE INDEX CONCURRENTLY invalid_idx_probe_a ON invalid_idx_probe (a)')
    ).rejects.toThrow();
    await sql`DELETE FROM invalid_idx_probe WHERE ctid = (SELECT min(ctid) FROM invalid_idx_probe)`;

    await runDerivedMigrations(sql, [
      {
        version: 'test:invalid-idx-probe',
        txStatements: [],
        concurrentStatements: [
          'CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS invalid_idx_probe_a ON invalid_idx_probe (a)'
        ]
      }
    ]);

    const rows = await sql<Array<{ valid: boolean }>>`
      SELECT indisvalid AS valid FROM pg_index
      WHERE indexrelid = to_regclass('invalid_idx_probe_a')
    `;
    expect(rows).toEqual([{ valid: true }]);
  });
});

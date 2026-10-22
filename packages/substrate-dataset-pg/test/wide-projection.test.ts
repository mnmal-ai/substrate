/**
 * A projection of more than 50 keys reads on pg. Each key is two arguments to
 * jsonb_build_object, and pg caps a call at 100.
 *
 * Skipped when POSTGRES_URL is absent.
 */

import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PgDataset, runMigrations } from '../src/index.js';

const POSTGRES_URL = process.env.POSTGRES_URL;
const KEYS = Array.from({ length: 120 }, (_, i) => `f${i}`);

describe.skipIf(!POSTGRES_URL)('wide projections', () => {
  let sql: Sql;
  let ds: PgDataset;

  beforeAll(async () => {
    sql = postgres(POSTGRES_URL as string, { onnotice: () => {} });
    await runMigrations(sql);
    await sql`DELETE FROM rows WHERE namespace = 'wide_projection'`;
    ds = new PgDataset({ namespace: 'wide_projection', sql });
    await ds.write('Wide', [{ id: 'w1', ...Object.fromEntries(KEYS.map((k, i) => [k, i])) }]);
  });
  afterAll(async () => {
    await sql`DELETE FROM rows WHERE namespace = 'wide_projection'`;
    await sql.end();
  });

  it('returns every projected key', async () => {
    const fields = Object.fromEntries(KEYS.map((k) => [k, true]));
    const { rows } = await ds.read('Wide', { fields });
    expect(rows[0]?.f0).toBe(0);
    expect(rows[0]?.f119).toBe(119);
    expect(Object.keys(rows[0] ?? {}).filter((k) => k.startsWith('f'))).toHaveLength(120);
  });
});

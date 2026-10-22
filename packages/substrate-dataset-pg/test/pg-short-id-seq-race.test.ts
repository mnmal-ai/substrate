/**
 * Two transactions creating the first rows of a new type both create its
 * shortId sequence. The second must wait for the first and reuse it, not fail
 * with a duplicate key on pg_class and roll back its create.
 *
 * Skipped when POSTGRES_URL is absent.
 */

import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PgShortIdStore, runMigrations } from '../src/index.js';
import { seqName } from '../src/pg-short-id-store.js';

const POSTGRES_URL = process.env.POSTGRES_URL;
const NS = 'seq_race';
const TYPE = 'Fresh';

describe.skipIf(!POSTGRES_URL)('lazy shortId sequence creation', () => {
  let sql: Sql;

  beforeAll(async () => {
    sql = postgres(POSTGRES_URL as string, { onnotice: () => {} });
    await runMigrations(sql);
    await sql.unsafe(`DROP SEQUENCE IF EXISTS "${seqName(NS, TYPE)}"`);
  });
  afterAll(async () => {
    await sql.unsafe(`DROP SEQUENCE IF EXISTS "${seqName(NS, TYPE)}"`);
    await sql.end();
  });

  it('lets two concurrent first allocations both commit', async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const first = sql.begin(async (tx) => {
      const id = await new PgShortIdStore(tx).allocateUnbound(NS, TYPE);
      await held;
      return id;
    });
    // Let the first transaction create the sequence before the second tries.
    await new Promise((r) => setTimeout(r, 100));
    const second = sql.begin((tx) => new PgShortIdStore(tx).allocateUnbound(NS, TYPE));
    await new Promise((r) => setTimeout(r, 100));
    release();
    const results = await Promise.allSettled([first, second]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
  });
});

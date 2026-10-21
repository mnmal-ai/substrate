/**
 * runMigrations under concurrent boots.
 *
 * Two processes booting against the same database simultaneously must not
 * race on the migration applier — the second's INSERT into
 * migrations would otherwise hit a primary-key conflict (best
 * case) or both could run conflicting CREATE INDEX statements (worse).
 * The `substrate-migrations` advisory lock serializes the body.
 *
 * Requires POSTGRES_URL — skips when absent.
 */

import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../src/index.js';

const POSTGRES_URL = process.env.POSTGRES_URL;

describe.skipIf(!POSTGRES_URL)('runMigrations advisory lock', () => {
  let sqlA: Sql;
  let sqlB: Sql;

  beforeAll(async () => {
    sqlA = postgres(POSTGRES_URL as string, { onnotice: () => {} });
    sqlB = postgres(POSTGRES_URL as string, { onnotice: () => {} });
  });

  afterAll(async () => {
    await sqlA.end();
    await sqlB.end();
  });

  it('two concurrent boots from independent connections both complete cleanly', async () => {
    // force=true on both, so each drops the tracking table and applies every
    // migration. The advisory lock serializes them: the second starts only
    // after the first completes, and re-applies over the finished schema.
    await Promise.all([runMigrations(sqlA, { force: true }), runMigrations(sqlB, { force: true })]);

    const rows = await sqlA<Array<{ version: string }>>`
      SELECT version FROM migrations ORDER BY version
    `;
    // Sanity: at least one migration applied; no duplicates.
    expect(rows.length).toBeGreaterThan(0);
    const versions = rows.map((r) => r.version);
    expect(new Set(versions).size).toBe(versions.length);
  });
});

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

  it("waits for the rows table's index-build lock before its concurrent phase", async () => {
    const holder = await sqlB.reserve();
    const key = `hashtext('substrate-index-build:' || current_schema() || '.' || $1::text)`;
    const [{ pid }] = (await holder.unsafe(
      `SELECT pg_advisory_lock(${key}), pg_backend_pid() AS pid`,
      ['rows']
    )) as unknown as [{ pid: number }];
    // A client of its own, so only its sessions are watched.
    const app = `n3_${process.pid}_${Date.now()}`;
    const migrator = postgres(POSTGRES_URL as string, {
      onnotice: () => {},
      connection: { application_name: app }
    });
    let settled = false;
    const run = runMigrations(migrator, { force: true }).finally(() => {
      settled = true;
    });
    try {
      // Another session asks for the lock the holder has: the migration is waiting on it.
      let polling = false;
      while (!polling && !settled) {
        const [row] = await sqlB`
          SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE application_name = ${app} AND pid <> ${pid}
            AND query LIKE '%pg_try_advisory_lock%substrate-index-build%'`;
        polling = (row?.n as number) > 0;
        if (!polling) await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(polling, 'the migration never asked for the rows table lock').toBe(true);
      // The first migration's concurrent phase has not run: its version is not recorded.
      const [recorded] = await sqlB`SELECT count(*)::int AS n FROM migrations`;
      expect(recorded?.n).toBe(0);
      expect(settled).toBe(false);
    } finally {
      await holder.unsafe(`SELECT pg_advisory_unlock(${key})`, ['rows']);
      holder.release();
    }
    await run;
    await migrator.end();
    const [after] = await sqlB`SELECT count(*)::int AS n FROM migrations`;
    expect(after?.n).toBeGreaterThan(0);
  });
});

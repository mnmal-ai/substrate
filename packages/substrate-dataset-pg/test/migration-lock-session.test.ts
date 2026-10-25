/**
 * The migration advisory lock must be released by the SESSION that took it.
 * Through a pooled handle, the unlock can land on a different connection,
 * fail with only a WARNING, and leave every later migrator polling forever.
 *
 * The body here issues concurrent queries on a multi-connection pool, which is
 * what makes the pooled form misroute its unlock. A second pool then stands in
 * for another process and must be able to take the lock.
 */

import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runDerivedMigrations, runMigrations, withMigrationLock } from '../src/migrate.js';

const POSTGRES_URL = process.env.POSTGRES_URL;

describe.skipIf(POSTGRES_URL === undefined)('withMigrationLock', () => {
  let sql: ReturnType<typeof postgres>;
  let other: ReturnType<typeof postgres>;

  beforeAll(() => {
    sql = postgres(POSTGRES_URL as string, { max: 4, onnotice: () => {} });
    other = postgres(POSTGRES_URL as string, { max: 1, onnotice: () => {} });
  });

  afterAll(async () => {
    await sql?.end({ timeout: 5 });
    await other?.end({ timeout: 5 });
  });

  async function otherProcessCanTakeIt(): Promise<boolean> {
    // Concurrent migrators in sibling packages may hold it briefly; poll.
    for (let i = 0; i < 40; i++) {
      const [row] = await other<Array<{ acquired: boolean }>>`
        SELECT pg_try_advisory_lock(hashtext('substrate-migrations:' || current_schema())) AS acquired
      `;
      if (row?.acquired === true) {
        await other`SELECT pg_advisory_unlock(hashtext('substrate-migrations:' || current_schema()))`;
        return true;
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    return false;
  }

  it('releases the lock even when the body spreads across pooled connections', async () => {
    await withMigrationLock(sql, async () => {
      await Promise.all([sql`SELECT pg_sleep(0.05)`, sql`SELECT 1`, sql`SELECT 1`, sql`SELECT 1`]);
    });
    expect(await otherProcessCanTakeIt()).toBe(true);
  });

  it('releases the lock when the body throws', async () => {
    await expect(
      withMigrationLock(sql, async () => {
        await Promise.all([sql`SELECT 1`, sql`SELECT 1`]);
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');
    expect(await otherProcessCanTakeIt()).toBe(true);
  });

  it('runs migrations on a pool of one connection', async () => {
    const single = postgres(POSTGRES_URL as string, { max: 1, onnotice: () => {} });
    try {
      const done = Promise.all([
        runMigrations(single),
        runDerivedMigrations(single, [
          { version: 'lock-test:noop', txStatements: ['SELECT 1'], concurrentStatements: [] }
        ])
      ]).then(() => 'done');
      const timeout = new Promise((r) => setTimeout(() => r('deadlocked'), 10_000));
      expect(await Promise.race([done, timeout])).toBe('done');
    } finally {
      await single`DELETE FROM migrations WHERE version = 'lock-test:noop'`;
      await single.end({ timeout: 5 });
    }
  }, 20_000);

  /** A pool of one whose session's current schema is `schema`. */
  async function poolIn(schema: string): Promise<ReturnType<typeof postgres>> {
    const pool = postgres(POSTGRES_URL as string, { max: 1, onnotice: () => {} });
    await pool.unsafe(`SET search_path TO "${schema}"`);
    return pool;
  }

  /** Whether `pool` takes the migration lock while `sql` holds it. */
  async function takenWhileHeld(pool: ReturnType<typeof postgres>): Promise<boolean> {
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let entered!: () => void;
    const holding = new Promise<void>((r) => (entered = r));
    const first = withMigrationLock(sql, async () => {
      entered();
      await held;
    });
    await holding;
    let ran = false;
    const second = withMigrationLock(pool, async () => {
      ran = true;
    });
    await new Promise((r) => setTimeout(r, 1_000));
    const taken = ran;
    release();
    await Promise.all([first, second]);
    return taken;
  }

  it('does not exclude a session in another schema', async () => {
    const schema = `lock_scope_${Date.now()}`;
    await sql.unsafe(`CREATE SCHEMA "${schema}"`);
    const pool = await poolIn(schema);
    try {
      expect(await takenWhileHeld(pool)).toBe(true);
    } finally {
      await pool.end({ timeout: 5 });
      await sql.unsafe(`DROP SCHEMA "${schema}"`);
    }
  });

  it('excludes a session in the same schema', async () => {
    const [{ schema }] = await sql<[{ schema: string }]>`SELECT current_schema()::text AS schema`;
    const pool = await poolIn(schema);
    try {
      expect(await takenWhileHeld(pool)).toBe(false);
    } finally {
      await pool.end({ timeout: 5 });
    }
  });
});

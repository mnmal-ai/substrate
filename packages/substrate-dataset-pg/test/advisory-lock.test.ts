/**
 * PgDataset.withAdvisoryLock: holders of one key serialise within a pool
 * and across pools (a second pool stands in for another process), and the
 * unlock really releases the session lock.
 */

import { randomUUID } from 'node:crypto';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PgDataset, tryWithPgAdvisoryLock } from '../src/index.js';

const POSTGRES_URL = process.env.POSTGRES_URL;

function gate(): { open: () => void; wait: Promise<void> } {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, wait };
}

const settle = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe.skipIf(POSTGRES_URL === undefined)('PgDataset.withAdvisoryLock', () => {
  let sql: Sql;
  let otherPool: Sql;
  let probe: Sql;

  beforeAll(() => {
    sql = postgres(POSTGRES_URL as string, { max: 4, onnotice: () => {} });
    otherPool = postgres(POSTGRES_URL as string, { max: 2, onnotice: () => {} });
    probe = postgres(POSTGRES_URL as string, { max: 1, onnotice: () => {} });
  });

  afterAll(async () => {
    await sql?.end({ timeout: 5 });
    await otherPool?.end({ timeout: 5 });
    await probe?.end({ timeout: 5 });
  });

  async function anotherSessionCanTake(key: string): Promise<boolean> {
    const [row] = await probe<Array<{ acquired: boolean }>>`
      SELECT pg_try_advisory_lock(hashtext(${key})) AS acquired
    `;
    if (row?.acquired === true) {
      await probe`SELECT pg_advisory_unlock(hashtext(${key}))`;
      return true;
    }
    return false;
  }

  it('serialises two holders of one key on the same pool', async () => {
    const ds = new PgDataset({ namespace: 'lock_a', sql });
    const key = `advisory-lock-test:${randomUUID()}`;
    const log: string[] = [];
    const g = gate();
    const first = ds.withAdvisoryLock(key, async () => {
      log.push('a:start');
      await g.wait;
      log.push('a:end');
    });
    await settle(50);
    const second = ds.withAdvisoryLock(key, async () => {
      log.push('b:start');
    });
    await settle(100);
    expect(log).toEqual(['a:start']);
    g.open();
    await Promise.all([first, second]);
    expect(log).toEqual(['a:start', 'a:end', 'b:start']);
  });

  it('excludes a holder on another pool until the first releases', async () => {
    const mine = new PgDataset({ namespace: 'lock_a', sql });
    const theirs = new PgDataset({ namespace: 'lock_b', sql: otherPool });
    const key = `advisory-lock-test:${randomUUID()}`;
    const g = gate();
    let theirsRan = false;
    const held = mine.withAdvisoryLock(key, () => g.wait);
    await settle(50);
    expect(await anotherSessionCanTake(key)).toBe(false);
    const waiting = theirs.withAdvisoryLock(key, async () => {
      theirsRan = true;
    });
    await settle(150);
    expect(theirsRan).toBe(false);
    g.open();
    await held;
    await waiting;
    expect(theirsRan).toBe(true);
  });

  it('releases the session lock after fn resolves and after fn throws', async () => {
    const ds = new PgDataset({ namespace: 'lock_a', sql });
    const key = `advisory-lock-test:${randomUUID()}`;
    await ds.withAdvisoryLock(key, async () => {
      await Promise.all([sql`SELECT 1`, sql`SELECT 1`, sql`SELECT 1`]);
    });
    expect(await anotherSessionCanTake(key)).toBe(true);

    await expect(
      ds.withAdvisoryLock(key, async () => {
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');
    expect(await anotherSessionCanTake(key)).toBe(true);
  });

  it('holds the lock on a tx-bound instance until the transaction ends', async () => {
    const ds = new PgDataset({ namespace: 'lock_a', sql });
    const key = `advisory-lock-test:${randomUUID()}`;
    const freeAfterFn = await ds.withTransaction(async (tx) => {
      const lock = tx.withAdvisoryLock;
      if (lock === undefined) throw new Error('withAdvisoryLock missing');
      await lock.call(tx, key, async () => 1);
      return anotherSessionCanTake(key);
    });
    expect(freeAfterFn).toBe(false);
    expect(await anotherSessionCanTake(key)).toBe(true);
  });

  it('tryWithPgAdvisoryLock skips fn while another pool holds the key', async () => {
    const mine = new PgDataset({ namespace: 'lock_a', sql });
    const key = `advisory-lock-test:${randomUUID()}`;
    const g = gate();
    const held = mine.withAdvisoryLock(key, () => g.wait);
    await settle(50);
    let ran = false;
    const skipped = await tryWithPgAdvisoryLock(otherPool, key, async () => {
      ran = true;
    });
    expect(skipped).toEqual({ acquired: false });
    expect(ran).toBe(false);
    g.open();
    await held;
    expect(await tryWithPgAdvisoryLock(otherPool, key, async () => 7)).toEqual({
      acquired: true,
      value: 7
    });
    expect(await anotherSessionCanTake(key)).toBe(true);
  });

  it('a failed unlock does not terminate another session that reuses its pid', async () => {
    const victim = postgres(POSTGRES_URL as string, { max: 1, onnotice: () => {} });
    const [{ pid }] = await victim<[{ pid: number }]>`SELECT pg_backend_pid() AS pid`;
    // The locking session ended and its pid went to `victim`, which started later.
    const conn = Object.assign(
      (strings: TemplateStringsArray) =>
        strings.join('?').includes('pg_try_advisory_lock')
          ? Promise.resolve([{ ok: true, pid, started: '2000-01-01 00:00:00+00' }])
          : Promise.reject(new Error('connection closed')),
      { release: () => {} }
    );
    const pool = Object.assign(
      (strings: TemplateStringsArray, ...values: unknown[]) =>
        otherPool(strings, ...(values as never[])),
      { reserve: () => Promise.resolve(conn), options: otherPool.options }
    ) as unknown as Sql;

    await tryWithPgAdvisoryLock(pool, `advisory-lock-test:${randomUUID()}`, async () => 1);

    const after = await victim<[{ pid: number }]>`SELECT pg_backend_pid() AS pid`.catch(() => []);
    await victim.end({ timeout: 5 });
    expect(after[0]?.pid).toBe(pid);
  });
});

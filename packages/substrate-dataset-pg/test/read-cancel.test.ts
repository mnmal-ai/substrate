/**
 * An aborted read cancels its pg statement. The read is held up on a lock
 * another connection owns, so it is slow without any test-only SQL function.
 */

import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../src/migrate.js';
import { PgDataset } from '../src/pg-dataset.js';

const POSTGRES_URL = process.env.POSTGRES_URL;
const NS = 'test_read_cancel';

describe.skipIf(!POSTGRES_URL)('read cancellation (pg)', () => {
  let sql: ReturnType<typeof postgres>;
  let reader: ReturnType<typeof postgres>;
  let locker: ReturnType<typeof postgres>;

  beforeAll(async () => {
    if (!POSTGRES_URL) return;
    sql = postgres(POSTGRES_URL, { onnotice: () => {} });
    await runMigrations(sql);
    // One connection each, so the reader's pid is known and the lock is held elsewhere.
    reader = postgres(POSTGRES_URL, { max: 1, onnotice: () => {} });
    locker = postgres(POSTGRES_URL, { max: 1, onnotice: () => {} });
  });

  afterAll(async () => {
    if (!POSTGRES_URL) return;
    await sql`DELETE FROM rows WHERE namespace = ${NS}`;
    await Promise.all([sql.end(), reader.end(), locker.end()]);
  });

  it('cancels the statement, rejects with AbortError and leaves the pool usable', async () => {
    const ds = new PgDataset({ namespace: NS, sql: reader });
    await ds.write('Item', [{ id: 'a' }]);
    const [me] = await reader<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
    const pid = me?.pid ?? -1;

    let release: () => void = () => {};
    const held = new Promise<void>((r) => (release = r));
    let locked: () => void = () => {};
    const gotLock = new Promise<void>((r) => (locked = r));
    const holder = locker.begin(async (tx) => {
      await tx`LOCK TABLE rows IN ACCESS EXCLUSIVE MODE`;
      locked();
      await held;
    });
    await gotLock;

    try {
      const controller = new AbortController();
      const started = Date.now();
      const pending = ds.read('Item', { signal: controller.signal });
      const outcome = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
      setTimeout(() => controller.abort(), 100);
      await outcome;
      expect(Date.now() - started).toBeLessThan(1000);
      const active = await sql`
        SELECT 1 FROM pg_stat_activity WHERE pid = ${pid} AND state = 'active'`;
      expect(active).toHaveLength(0);
    } finally {
      release();
      await holder;
    }

    expect((await ds.read('Item', {})).rows).toHaveLength(1);
    const early = new AbortController();
    early.abort();
    await expect(ds.read('Item', { signal: early.signal })).rejects.toMatchObject({
      name: 'AbortError'
    });
  });
});

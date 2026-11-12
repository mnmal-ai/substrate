/**
 * A request that waits past the pool's `queue_timeout` for a connection is
 * refused `store_busy`, on reads and on transactions, and `poolStats` counts
 * the pool as it stands.
 */

import { STORE_BUSY } from '@mnmal-ai/substrate-types';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../src/migrate.js';
import { PgDataset } from '../src/pg-dataset.js';
import { clearNamespace } from './_layout.js';

const POSTGRES_URL = process.env.POSTGRES_URL;
const NS = 'test_store_busy';

describe.skipIf(!POSTGRES_URL)('store_busy (pg)', () => {
  let sql: ReturnType<typeof postgres>;
  let one: ReturnType<typeof postgres>;

  beforeAll(async () => {
    if (!POSTGRES_URL) return;
    sql = postgres(POSTGRES_URL, { onnotice: () => {} });
    await runMigrations(sql);
    one = postgres(POSTGRES_URL, { max: 1, queue_timeout: 0.2, onnotice: () => {} });
  });

  afterAll(async () => {
    if (!POSTGRES_URL) return;
    await clearNamespace(sql, NS);
    await Promise.all([sql.end(), one.end()]);
  });

  it('refuses a read and a transaction that cannot get a connection, then recovers', async () => {
    const ds = new PgDataset({ namespace: NS, sql: one });
    await ds.write('Item', [{ id: 'a' }]);

    const held = await one.reserve();
    try {
      expect(ds.poolStats()).toMatchObject({ connections: 1, leased: 1, waiting: 0 });
      await expect(ds.read('Item', {})).rejects.toMatchObject({ code: STORE_BUSY });
      await expect(ds.withTransaction((tx) => tx.read('Item', {}))).rejects.toMatchObject({
        code: STORE_BUSY
      });
    } finally {
      held.release();
    }

    expect((await ds.read('Item', {})).rows).toHaveLength(1);
    expect(ds.poolStats()).toMatchObject({ leased: 0, waiting: 0 });
  });
});

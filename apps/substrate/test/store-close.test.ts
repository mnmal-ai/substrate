/**
 * A pg store's `close` is bounded: a query that never finishes, on a reserved
 * connection, holds it for `STORE_END_TIMEOUT_S` and then loses its
 * connection, so shutdown is not held by an index build that cannot be
 * cancelled.
 *
 * Skipped unless POSTGRES_URL is set.
 */

import { describe, expect, it } from 'vitest';
import { STORE_END_TIMEOUT_S, wireStore } from '../src/serve/wiring.js';

const POSTGRES_URL = process.env.POSTGRES_URL;

describe.skipIf(!POSTGRES_URL)('wireStore close (pg)', () => {
  it('drops a connection whose query is still running once the timeout passes', async () => {
    const store = await wireStore(POSTGRES_URL as string, () => () => undefined);
    const sql = store.sql;
    if (sql === null || store.close === null) throw new Error('a pg store has sql and close');
    const conn = await sql.reserve();
    const stuck = conn`SELECT pg_sleep(10)`.then(
      () => 'finished',
      () => 'dropped'
    );
    // Wait until the sleep is on the server, so close finds it in flight.
    for (let i = 0; i < 50; i++) {
      const [r] = await sql`
        SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE query = 'SELECT pg_sleep(10)' AND state = 'active'`;
      if ((r?.n as number) > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const started = Date.now();
    await store.close();
    expect(Date.now() - started).toBeLessThan(STORE_END_TIMEOUT_S * 1000 + 1500);
    expect(await stuck).toBe('dropped');
  }, 15_000);
});

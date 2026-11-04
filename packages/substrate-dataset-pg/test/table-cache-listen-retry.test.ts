/**
 * A failed catalog LISTEN is retried (Todo #1884): it warns, nothing is cached
 * meanwhile, and after the retry interval a later read listens again and
 * caches. Within the interval a broken server is not asked again.
 */

import { randomBytes } from 'node:crypto';
import postgres, { type Sql } from 'postgres';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { PgDataset } from '../src/index.js';
import { LISTEN_RETRY_MS, tableCacheFor } from '../src/type-table.js';
import { dropNamespace } from './_layout.js';

const POSTGRES_URL = process.env.POSTGRES_URL;

describe.skipIf(!POSTGRES_URL)('a failed catalog LISTEN (pg)', () => {
  let sql: Sql;
  const ns = `lr_${randomBytes(4).toString('hex')}`;

  beforeAll(() => {
    sql = postgres(POSTGRES_URL as string, { onnotice: () => {} });
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => {
    await dropNamespace(sql, ns);
    await sql.end({ timeout: 5 });
  });

  it('warns, caches nothing, and is retried after the interval', async () => {
    const listen = vi.spyOn(sql, 'listen').mockRejectedValueOnce(new Error('listen refused'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const ds = new PgDataset({ namespace: ns, sql });
    const key = `${ns}/T`;
    await ds.write('T', [{ id: 'a' }]);
    await ds.read('T', {});
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('listen refused'));
    expect(tableCacheFor(sql).tables.has(key)).toBe(false);

    await ds.read('T', {}); // within the interval: not asked again
    expect(listen).toHaveBeenCalledTimes(1);

    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + LISTEN_RETRY_MS + 1);
    await ds.read('T', {});
    expect(listen).toHaveBeenCalledTimes(2);
    expect(tableCacheFor(sql).tables.has(key)).toBe(true);
  });

  it('a LISTEN refused on a live listener connection: the retry reaches the server again', async () => {
    // Throwing from `debug` rejects the LISTEN on its (inherited) listener
    // connection, which stays open, as a server-side refusal leaves it.
    let refuse = true;
    const pool = postgres(POSTGRES_URL as string, {
      onnotice: () => {},
      debug: (_c, query) => {
        if (refuse && /^listen /i.test(query)) {
          refuse = false;
          throw new Error('listen refused');
        }
      }
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const ds = new PgDataset({ namespace: ns, sql: pool });
      const key = `${ns}/T`;
      await ds.write('T', [{ id: 'b' }]);
      await ds.read('T', {});
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('listen refused'));
      expect(tableCacheFor(pool).tables.has(key)).toBe(false);

      const now = Date.now();
      vi.spyOn(Date, 'now').mockReturnValue(now + LISTEN_RETRY_MS + 1);
      await ds.read('T', {});
      expect(tableCacheFor(pool).tables.has(key)).toBe(true);
      const channels = (
        pool.listen as unknown as { channels: Record<string, { listeners: unknown[] }> }
      ).channels;
      expect(channels.substrate_catalog?.listeners).toHaveLength(1);
    } finally {
      await pool.end({ timeout: 5 });
    }
  });
});

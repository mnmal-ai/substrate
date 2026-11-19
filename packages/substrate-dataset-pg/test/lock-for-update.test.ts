/**
 * `lockForUpdate` holds a row until the transaction that took it ends: a
 * second transaction's lock of the row waits, and its read after the lock
 * sees what the first committed.
 */

import { randomBytes } from 'node:crypto';
import { field } from '@mnmal-ai/substrate-sdk';
import type { FieldDef } from '@mnmal-ai/substrate-types';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PgDataset } from '../src/index.js';
import { dropNamespace } from './_layout.js';

const POSTGRES_URL = process.env.POSTGRES_URL;

describe.skipIf(!POSTGRES_URL)('lockForUpdate', () => {
  let sql: Sql;
  const ns = `lfu_${randomBytes(4).toString('hex')}`;
  const fields: Record<string, FieldDef> = { title: field.string() };

  beforeAll(() => {
    sql = postgres(POSTGRES_URL as string, { onnotice: () => {} });
  });
  afterAll(async () => {
    await dropNamespace(sql, ns);
    await sql.end({ timeout: 5 });
  });

  /** Resolves once a lock statement on this file's namespace is waiting. */
  async function lockWaits(): Promise<void> {
    const deadline = Date.now() + 10_000;
    for (;;) {
      const [w] = await sql<Array<{ n: number }>>`
        SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE wait_event_type = 'Lock' AND query LIKE '%FOR NO KEY UPDATE OF r%'
          AND query LIKE ${`%${ns}%`} AND pid <> pg_backend_pid()`;
      if ((w?.n ?? 0) > 0) return;
      if (Date.now() > deadline) throw new Error('the second lock never waited');
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  it('makes a second locker wait, then read what the first committed', async () => {
    const pg = new PgDataset({
      namespace: ns,
      sql,
      typeDefLookup: () => ({ fields }),
      fieldDefLookup: (_t, f) => fields[f]
    });
    await pg.write('Note', [{ id: 'k1', title: 'a' }]);
    let second: Promise<unknown> | undefined;
    await pg.withTransaction(async (tx) => {
      await tx.lockForUpdate?.('Note', ['k1']);
      second = pg.withTransaction(async (other) => {
        await other.lockForUpdate?.('Note', ['k1']);
        return (await other.read('Note', { id: 'k1' })).rows[0]?.title;
      });
      await lockWaits();
      await tx.write('Note', [{ id: 'k1', title: 'b' }]);
    });
    expect(await second).toBe('b');
  });
});

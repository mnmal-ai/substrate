/**
 * Two transactions that lock the same two rows in opposite orders deadlock.
 * Postgres aborts one, which is refused `write_conflict`; the other commits.
 */

import { BatchElementError, WRITE_CONFLICT } from '@mnmal-ai/substrate-types';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../src/migrate.js';
import { PgDataset } from '../src/pg-dataset.js';
import { clearNamespace } from './_layout.js';

const POSTGRES_URL = process.env.POSTGRES_URL;
const NS = 'test_write_conflict';

describe.skipIf(!POSTGRES_URL)('write_conflict (pg)', () => {
  let sql: ReturnType<typeof postgres>;

  beforeAll(async () => {
    if (!POSTGRES_URL) return;
    sql = postgres(POSTGRES_URL, { onnotice: () => {} });
    await runMigrations(sql);
  });

  afterAll(async () => {
    if (!POSTGRES_URL) return;
    await clearNamespace(sql, NS);
    await sql.end();
  });

  it.each([
    ['thrown as it is', false],
    ["thrown as a batch element's cause", true]
  ])('refuses the transaction Postgres aborts to break a deadlock, %s', async (_name, wrapped) => {
    const ds = new PgDataset({ namespace: NS, sql });
    const a = '00000000-0000-7000-8000-00000000000a';
    const b = '00000000-0000-7000-8000-00000000000b';
    await ds.write('Item', [{ id: a }, { id: b }]);

    // Each transaction locks its first row, then waits for the other to hold its own.
    let firstHeld = 0;
    let bothHold: () => void = () => {};
    const ready = new Promise<void>((resolve) => {
      bothHold = resolve;
    });
    const lockBoth = (first: string, second: string) =>
      ds.withTransaction(async (tx) => {
        await tx.lockForUpdate?.('Item', [first]);
        if (++firstHeld === 2) bothHold();
        await ready;
        try {
          await tx.lockForUpdate?.('Item', [second]);
        } catch (err) {
          throw wrapped ? new BatchElementError(0, err) : err;
        }
      });

    const outcomes = await Promise.allSettled([lockBoth(a, b), lockBoth(b, a)]);
    const refused = outcomes.filter((o) => o.status === 'rejected');

    expect(refused).toHaveLength(1);
    expect(refused[0]).toMatchObject({ reason: { code: WRITE_CONFLICT } });
  });
});

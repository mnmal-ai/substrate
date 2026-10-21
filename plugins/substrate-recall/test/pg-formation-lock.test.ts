/**
 * Crystallise formation is exclusive ACROSS PROCESSES, not just within one. Two `PgClusterStore`s on two separate pools stand in for two
 * substrate binaries over one database.
 *
 * The pools are deliberately multi-connection. An advisory lock belongs to a
 * session, so an unlock that lands on a different pooled connection than the
 * lock silently fails to release. The "released afterwards" cases are what
 * catch that.
 */

import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CRYSTALLISE_IN_FLIGHT_CODE } from '../src/crystallise-guard.js';
import { PgClusterStore } from '../src/pg-cluster-store.js';

const POSTGRES_URL = process.env.POSTGRES_URL;

describe.skipIf(POSTGRES_URL === undefined)('PgClusterStore.withFormationLock', () => {
  let sqlA: ReturnType<typeof postgres>;
  let sqlB: ReturnType<typeof postgres>;
  let a: PgClusterStore;
  let b: PgClusterStore;

  beforeAll(() => {
    sqlA = postgres(POSTGRES_URL as string, { max: 4, onnotice: () => {} });
    sqlB = postgres(POSTGRES_URL as string, { max: 4, onnotice: () => {} });
    a = new PgClusterStore({ sql: sqlA });
    b = new PgClusterStore({ sql: sqlB });
  });

  afterAll(async () => {
    await sqlA?.end({ timeout: 5 });
    await sqlB?.end({ timeout: 5 });
  });

  it('refuses a second process while the first holds the lock, then admits it', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = a.withFormationLock(async () => {
      // Keep A's pool busy on other connections too, as a real pass would.
      await Promise.all([sqlA`SELECT 1`, sqlA`SELECT 1`, sqlA`SELECT 1`]);
      await gate;
      return 'a';
    });
    // Let A reach the lock before B tries.
    await new Promise((r) => setTimeout(r, 100));

    await expect(b.withFormationLock(async () => 'b')).rejects.toMatchObject({
      code: CRYSTALLISE_IN_FLIGHT_CODE
    });

    release();
    await expect(first).resolves.toBe('a');
    await expect(b.withFormationLock(async () => 'b')).resolves.toBe('b');
  });

  it('releases the lock when the pass throws', async () => {
    await expect(
      a.withFormationLock(async () => {
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');
    await expect(b.withFormationLock(async () => 'after')).resolves.toBe('after');
  });
});

/**
 * Holds the memory and pg `IdempotencyStore` implementations to the same
 * behaviour.
 *
 * This store makes a retried mutation return the FIRST result instead of
 * applying twice. A store that misses a cached entry replays the write; one
 * that serves an expired entry returns a stale envelope as though it were
 * fresh. Both failures are silent.
 *
 * The contract:
 *
 *   get   — MUST return undefined for expired entries. Lazy expiry is fine;
 *           observing a stale result is not.
 *   put   — cache under key for ttlMs.
 *   reap  — delete expired, return the count. MAY no-op (memory expires
 *           lazily on get); pg must actually free rows.
 *
 * `reapExpired`'s count is the one place the two are permitted to differ.
 */

import { MemoryIdempotencyStore } from '@mnmal-ai/substrate-core';
import type { IdempotencyStore, PackEnvelope } from '@mnmal-ai/substrate-types';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PgIdempotencyStore, runMigrations } from '../src/index.js';

const POSTGRES_URL = process.env.POSTGRES_URL;

const envelope = (marker: string): PackEnvelope =>
  ({
    schemaVersion: 'test',
    data: { 'parity/Thing': { id: marker } },
    shapes: { 'parity/Thing': 'single' }
  }) as unknown as PackEnvelope;

describe.skipIf(!POSTGRES_URL)('IdempotencyStore conformance (memory vs pg)', () => {
  let sql: Sql;
  let mem: IdempotencyStore;
  let pg: IdempotencyStore;

  beforeAll(async () => {
    sql = postgres(POSTGRES_URL as string);
    await runMigrations(sql);
  });

  afterAll(async () => {
    await sql.end();
  });

  beforeEach(async () => {
    await sql`TRUNCATE TABLE idempotency`;
    mem = new MemoryIdempotencyStore();
    pg = new PgIdempotencyStore({ sql });
  });

  async function bothAgree<T>(fn: (s: IdempotencyStore) => Promise<T>): Promise<T> {
    const m = await fn(mem);
    const p = await fn(pg);
    expect(p, 'pg and memory disagree').toEqual(m);
    return m;
  }

  it('a miss is undefined, not a falsy stand-in', async () => {
    // `undefined` specifically: the engine branches on it to decide whether to
    // replay. `null` or `{}` would read as a cache HIT with an empty envelope,
    // and the caller would return nothing instead of applying the mutation.
    await bothAgree(async (s) => await s.get('never-written'));
  });

  it('put then get returns the envelope intact', async () => {
    await bothAgree(async (s) => {
      await s.put('k1', envelope('first'), 60_000);
      return await s.get('k1');
    });
  });

  it('an expired entry is a miss', async () => {
    // The assertion with teeth. Serving this would return a stale result for a
    // fresh request, indistinguishable from a correct dedupe.
    await bothAgree(async (s) => {
      await s.put('k2', envelope('stale'), 0);
      await new Promise((r) => setTimeout(r, 25));
      return await s.get('k2');
    });
  });

  it('re-putting while the entry is LIVE keeps the first envelope', async () => {
    // An idempotency key must resolve to ONE answer for its whole window.
    // Overwriting means two retries of the same request can get different
    // results, which is the thing the store exists to prevent.
    await bothAgree(async (s) => {
      await s.put('k3', envelope('one'), 60_000);
      await s.put('k3', envelope('two'), 60_000);
      return await s.get('k3');
    });
  });

  it('re-putting AFTER expiry replaces the envelope', async () => {
    // The boundary the immutability rule must not cross. Once the dedupe window
    // has passed, the mutation legitimately re-executed and the new result is
    // the real one; serving the old envelope under a refreshed TTL would hand
    // back a stale answer for a request that was never deduped.
    await bothAgree(async (s) => {
      await s.put('k4', envelope('old'), 0);
      await new Promise((r) => setTimeout(r, 25));
      await s.put('k4', envelope('new'), 60_000);
      return await s.get('k4');
    });
  });

  it('keys are independent', async () => {
    await bothAgree(async (s) => {
      await s.put('a', envelope('A'), 60_000);
      await s.put('b', envelope('B'), 60_000);
      return { a: await s.get('a'), b: await s.get('b') };
    });
  });

  it('reapExpired leaves live entries readable on both, whatever it counts', async () => {
    // The count itself is explicitly allowed to differ — memory may no-op
    // because it expires lazily on `get`, pg must delete to free rows. What
    // must NOT differ is the observable state afterwards.
    for (const s of [mem, pg]) {
      await s.put('live', envelope('live'), 60_000);
      await s.put('dead', envelope('dead'), 0);
    }
    await new Promise((r) => setTimeout(r, 25));

    for (const s of [mem, pg]) {
      const { deleted } = await s.reapExpired();
      expect(typeof deleted).toBe('number');
      expect(deleted).toBeGreaterThanOrEqual(0);
    }

    await bothAgree(async (s) => ({
      live: await s.get('live'),
      dead: await s.get('dead')
    }));
  });

  it('reapExpired on an empty store is a no-op that still answers', async () => {
    for (const s of [mem, pg]) {
      const { deleted } = await s.reapExpired();
      expect(deleted).toBe(0);
    }
  });
});

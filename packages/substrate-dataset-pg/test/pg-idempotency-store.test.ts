/**
 * §5.13 — PgIdempotencyStore integration tests. Mirrors the POSTGRES_URL skip
 * pattern the rest of the pg suite uses; no external DSN → the whole describe
 * block skips.
 */

import type { PackEnvelope } from '@mnmal-ai/substrate-types';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PgIdempotencyStore, runMigrations } from '../src/index.js';

const POSTGRES_URL = process.env.POSTGRES_URL;

function makeEnvelope(tag: string): PackEnvelope {
  return {
    schemaVersion: '1',
    data: { 'default/createTodo': { id: tag, title: `title-${tag}` } },
    shapes: { 'default/createTodo': 'single' }
  };
}

describe.skipIf(!POSTGRES_URL)('PgIdempotencyStore', () => {
  let sql: Sql;
  let store: PgIdempotencyStore;

  beforeAll(async () => {
    sql = postgres(POSTGRES_URL as string);
    await runMigrations(sql);
  });

  afterAll(async () => {
    await sql.end();
  });

  beforeEach(async () => {
    await sql`TRUNCATE TABLE idempotency`;
    store = new PgIdempotencyStore({ sql });
  });

  describe('runMigrations', () => {
    it('creates the idempotency table', async () => {
      const rows = await sql<Array<{ table_name: string }>>`
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = current_schema() AND table_name = 'idempotency'
      `;
      expect(rows).toHaveLength(1);
    });

    it('creates the idempotency_expires_at_idx index', async () => {
      const rows = await sql<Array<{ indexname: string }>>`
        SELECT indexname
        FROM pg_indexes
        WHERE schemaname = current_schema()
          AND indexname = 'idempotency_expires_at_idx'
      `;
      expect(rows).toHaveLength(1);
    });

    it('creates the short_ids table', async () => {
      const rows = await sql<Array<{ table_name: string }>>`
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = current_schema() AND table_name = 'short_ids'
      `;
      expect(rows).toHaveLength(1);
    });

    it('creates the short_ids_row_uniq_idx index', async () => {
      const rows = await sql<Array<{ indexname: string }>>`
        SELECT indexname
        FROM pg_indexes
        WHERE schemaname = current_schema()
          AND indexname = 'short_ids_row_uniq_idx'
      `;
      expect(rows).toHaveLength(1);
    });
  });

  describe('get + put', () => {
    it('round-trips an envelope under a key', async () => {
      const env = makeEnvelope('t1');
      await store.put('k1', env, 60_000);
      const got = await store.get('k1');
      expect(got).toEqual(env);
    });

    it('returns undefined for an unknown key', async () => {
      const got = await store.get('never-written');
      expect(got).toBeUndefined();
    });

    it('returns undefined for an expired key', async () => {
      const env = makeEnvelope('t-exp');
      // TTL 0 → expires_at = now(); the `expires_at > now()` predicate excludes.
      await store.put('k-exp', env, 0);
      // Force the row further into the past so we don't race the clock.
      await sql`
        UPDATE idempotency
        SET expires_at = now() - interval '1 second'
        WHERE key = 'k-exp'
      `;
      const got = await store.get('k-exp');
      expect(got).toBeUndefined();
    });
  });

  describe('put — first-write-wins on envelope, refresh on TTL', () => {
    it('second put with same key + different envelope leaves the envelope alone', async () => {
      const original = makeEnvelope('original');
      const replacement = makeEnvelope('replacement');
      await store.put('k-race', original, 60_000);
      await store.put('k-race', replacement, 60_000);
      const got = await store.get('k-race');
      expect(got).toEqual(original);
    });

    it('second put with a longer TTL extends expires_at to the new value', async () => {
      const env = makeEnvelope('refresh');
      await store.put('k-ttl', env, 60_000);
      const before = await sql<Array<{ expires_at: Date }>>`
        SELECT expires_at FROM idempotency WHERE key = 'k-ttl'
      `;
      expect(before).toHaveLength(1);
      const firstExpiry = (before[0] as { expires_at: Date }).expires_at;

      // Same key, much longer TTL. Envelope content does NOT matter for this
      // assertion — first-write-wins on content is covered above.
      await store.put('k-ttl', env, 3_600_000);
      const after = await sql<Array<{ expires_at: Date }>>`
        SELECT expires_at FROM idempotency WHERE key = 'k-ttl'
      `;
      expect(after).toHaveLength(1);
      const secondExpiry = (after[0] as { expires_at: Date }).expires_at;

      // The 1h TTL must land strictly later than the original 60s TTL.
      expect(secondExpiry.getTime()).toBeGreaterThan(firstExpiry.getTime());
      // And the refreshed expiry must sit within a sane window of the 1h
      // target — guard against the predicate quietly skipping the UPDATE.
      const targetMs = Date.now() + 3_600_000;
      const drift = Math.abs(secondExpiry.getTime() - targetMs);
      expect(drift).toBeLessThan(60_000);

      // Envelope is unchanged after the TTL-refresh path.
      const got = await store.get('k-ttl');
      expect(got).toEqual(env);
    });

    it('second put with a shorter TTL does NOT truncate expires_at', async () => {
      const env = makeEnvelope('shorter');
      await store.put('k-shorter', env, 3_600_000);
      const before = await sql<Array<{ expires_at: Date }>>`
        SELECT expires_at FROM idempotency WHERE key = 'k-shorter'
      `;
      const firstExpiry = (before[0] as { expires_at: Date }).expires_at;

      // 60s is much shorter than the stored 1h. The WHERE clause must skip
      // the UPDATE — otherwise we'd be giving callers LESS coverage than
      // they had before, which defeats the whole point of the refresh.
      await store.put('k-shorter', env, 60_000);
      const after = await sql<Array<{ expires_at: Date }>>`
        SELECT expires_at FROM idempotency WHERE key = 'k-shorter'
      `;
      const secondExpiry = (after[0] as { expires_at: Date }).expires_at;

      expect(secondExpiry.getTime()).toEqual(firstExpiry.getTime());
    });
  });

  describe('reapExpired', () => {
    it('deletes rows where expires_at < now, keeps live rows', async () => {
      // One fresh row with a 1h TTL.
      await store.put('k-fresh', makeEnvelope('fresh'), 3_600_000);
      // Two rows that bypassed TTL → raw SQL backdates expires_at so the
      // reaper's predicate picks them up deterministically without racing
      // the clock.
      await store.put('k-stale-60s', makeEnvelope('stale-60s'), 60_000);
      await sql`
        UPDATE idempotency
        SET expires_at = now() - interval '60 seconds'
        WHERE key = 'k-stale-60s'
      `;
      await store.put('k-stale-1h', makeEnvelope('stale-1h'), 60_000);
      await sql`
        UPDATE idempotency
        SET expires_at = now() - interval '1 hour'
        WHERE key = 'k-stale-1h'
      `;

      const result = await store.reapExpired();
      expect(result).toEqual({ deleted: 2 });

      const surviving = await sql<Array<{ key: string }>>`
        SELECT key FROM idempotency ORDER BY key
      `;
      expect(surviving.map((r) => r.key)).toEqual(['k-fresh']);
    });

    it('on an empty / all-live table returns { deleted: 0 }', async () => {
      const empty = await store.reapExpired();
      expect(empty).toEqual({ deleted: 0 });

      await store.put('k-live', makeEnvelope('live'), 3_600_000);
      const allLive = await store.reapExpired();
      expect(allLive).toEqual({ deleted: 0 });

      const rows = await sql<Array<{ key: string }>>`
        SELECT key FROM idempotency
      `;
      expect(rows).toHaveLength(1);
    });
  });
});

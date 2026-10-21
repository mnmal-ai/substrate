/**
 * PgIdempotencyStore — PostgreSQL-backed `IdempotencyStore`. Spec: §5.13.
 *
 * Rows live in `idempotency` keyed by the engine's frame-scoped dedup
 * key; envelopes are stored as JSONB.
 *
 * Semantics:
 *   - `get` returns `undefined` for unknown or expired keys. Expiry is lazy.
 *   - `put` is first-write-wins for the envelope; a conflicting put only
 *     extends `expires_at` (never shortens it).
 *   - SQL errors propagate: a swallowed put failure would let the next retry
 *     re-run the mutate.
 */

import type { IdempotencyStore, PackEnvelope } from '@mnmal-ai/substrate-types';
import type { Sql } from 'postgres';

export interface PgIdempotencyStoreOptions {
  sql: Sql;
}

interface IdempotencyRow {
  envelope: PackEnvelope;
}

export class PgIdempotencyStore implements IdempotencyStore {
  readonly #sql: Sql;

  constructor(options: PgIdempotencyStoreOptions) {
    this.#sql = options.sql;
  }

  async get(key: string): Promise<PackEnvelope | undefined> {
    const rows = await this.#sql<Array<IdempotencyRow>>`
      SELECT envelope
      FROM idempotency
      WHERE key = ${key}
        AND expires_at > now()
      LIMIT 1
    `;
    const row = rows[0];
    if (row === undefined) return undefined;
    return row.envelope;
  }

  async put(key: string, envelope: PackEnvelope, ttlMs: number): Promise<void> {
    const sql = this.#sql;
    await sql`
      INSERT INTO idempotency (key, envelope, expires_at)
      VALUES (
        ${key},
        ${sql.json(envelope as unknown as Parameters<typeof sql.json>[0])},
        now() + (${ttlMs}::bigint || ' milliseconds')::interval
      )
      ON CONFLICT (key) DO UPDATE SET
        -- The envelope is IMMUTABLE while the entry is live: an idempotency key
        -- must resolve to one stable answer for its whole window, or two
        -- retries of the same request can get different results, which is the
        -- thing the store exists to prevent.
        --
        -- Once it has EXPIRED that rule inverts. The dedupe window closed, the
        -- mutation legitimately re-executed, and the new envelope is the real
        -- result. Keeping the old one would hand back a stale answer wrapped in
        -- a fresh TTL, to a caller who was never deduped at all.
        envelope = CASE
          WHEN idempotency.expires_at <= now() THEN EXCLUDED.envelope
          ELSE idempotency.envelope
        END,
        -- GREATEST rather than a WHERE guard: extends a live window, never
        -- shortens it, and takes the new value outright when the old is past.
        expires_at = GREATEST(idempotency.expires_at, EXCLUDED.expires_at)
    `;
  }

  async reapExpired(): Promise<{ deleted: number }> {
    const result = await this.#sql`
      DELETE FROM idempotency
      WHERE expires_at <= now()
    `;
    return { deleted: result.count };
  }
}

/**
 * PgActResultStore: PostgreSQL-backed `ActResultStore`.
 *
 * Rows live in `act_results`; the whole record is JSONB, with `id`, `owner`,
 * `idempotency_key` and `expires_at` kept as indexed copies for the queries.
 * Expiry is lazy on reads; `reapExpired` deletes. SQL errors propagate.
 */

import {
  type ActResultRecord,
  type ActResultStore,
  stringifyJson
} from '@mnmal-ai/substrate-types';
import type { Sql } from 'postgres';

export interface PgActResultStoreOptions {
  sql: Sql;
}

export class PgActResultStore implements ActResultStore {
  readonly #sql: Sql;

  constructor(options: PgActResultStoreOptions) {
    this.#sql = options.sql;
  }

  async get(id: string, owner: string): Promise<ActResultRecord | undefined> {
    const rows = await this.#sql<Array<{ record: ActResultRecord }>>`
      SELECT record FROM act_results
      WHERE id = ${id} AND owner = ${owner} AND expires_at > now()
      LIMIT 1
    `;
    return rows[0]?.record;
  }

  async findByIdempotencyKey(owner: string, key: string): Promise<ActResultRecord | undefined> {
    const rows = await this.#sql<Array<{ record: ActResultRecord }>>`
      SELECT record FROM act_results
      WHERE owner = ${owner} AND idempotency_key = ${key} AND expires_at > now()
      LIMIT 1
    `;
    return rows[0]?.record;
  }

  async put(record: ActResultRecord, ttlMs: number): Promise<void> {
    const sql = this.#sql;
    const json = stringifyJson(record);
    const key = record.idempotencyKey ?? null;
    if (key === null) {
      await sql`
        INSERT INTO act_results (id, owner, idempotency_key, record, expires_at)
        VALUES (
          ${record.id}, ${record.owner}, NULL, ${json}::text::jsonb,
          now() + (${ttlMs}::bigint || ' milliseconds')::interval
        )
      `;
      return;
    }
    // First live write for (owner, key) wins; an expired one is replaced.
    await sql`
      INSERT INTO act_results (id, owner, idempotency_key, record, expires_at)
      VALUES (
        ${record.id}, ${record.owner}, ${key}, ${json}::text::jsonb,
        now() + (${ttlMs}::bigint || ' milliseconds')::interval
      )
      ON CONFLICT (owner, idempotency_key) WHERE idempotency_key IS NOT NULL DO UPDATE SET
        id = EXCLUDED.id,
        record = EXCLUDED.record,
        expires_at = EXCLUDED.expires_at
      WHERE act_results.expires_at <= now()
    `;
  }

  async reapExpired(): Promise<{ deleted: number }> {
    const result = await this.#sql`DELETE FROM act_results WHERE expires_at <= now()`;
    return { deleted: result.count };
  }
}

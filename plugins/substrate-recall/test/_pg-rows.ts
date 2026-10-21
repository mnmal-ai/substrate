/**
 * Creates the `rows` shape the recall stores join against: the body, which is
 * all they read. Idempotent, so every pg-gated suite can call it whatever
 * order the files run in.
 */

import type postgres from 'postgres';

export async function ensureRows(sql: ReturnType<typeof postgres>): Promise<void> {
  await sql`CREATE TABLE IF NOT EXISTS rows (
    namespace text NOT NULL, type text NOT NULL, id text NOT NULL,
    body jsonb NOT NULL, deleted_at timestamptz NULL, PRIMARY KEY (namespace, type, id))`;
}

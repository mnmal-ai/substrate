/**
 * Substrate identity for pg-backed stores: stores built on the same
 * `postgres.Sql` pool reference share a `txScopeId`, which lets the engine
 * run their mutations in one transaction.
 *
 * Keyed by `Sql` reference, not connection options: two pools on the same
 * database cannot share a transaction, so they are distinct substrates.
 * `TransactionSql` handles inherit their parent's id via constructor options.
 */

import { randomUUID } from 'node:crypto';
import type { Sql, TransactionSql } from 'postgres';

export type PgHandle = Sql | TransactionSql;

const SUBSTRATE_IDS = new WeakMap<PgHandle, string>();

export function txScopeIdFor(sql: PgHandle): string {
  const existing = SUBSTRATE_IDS.get(sql);
  if (existing !== undefined) return existing;
  const id = `pg:${randomUUID()}`;
  SUBSTRATE_IDS.set(sql, id);
  return id;
}

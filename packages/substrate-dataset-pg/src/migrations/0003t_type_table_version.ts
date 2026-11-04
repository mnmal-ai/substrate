/**
 * 0003t_type_table_version — each type table's catalog version. Every change
 * to a type's catalog rows bumps it in the transaction that notifies
 * `substrate_catalog`, and every write checks it against the version its
 * cached descriptor was loaded at (`guardCte`, write-rows.ts), so a write
 * through a stale descriptor is retried rather than silently misplaced.
 * A constant default: no table rewrite.
 */

export const TX_STATEMENTS: ReadonlyArray<string> = [
  'ALTER TABLE substrate_type_tables ADD COLUMN IF NOT EXISTS version bigint NOT NULL DEFAULT 0'
];

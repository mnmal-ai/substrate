/**
 * 0001t_tables_baseline — the engine's schema on the `tables` layout, where
 * each type has a table of its own (`ensureTypeTable`) and there is no `rows`.
 *
 * - `row_ids` registers every row's `(namespace, type, id)`; `short_ids`
 *   reference it. `edges` get no foreign key, since bridged and orphan edges
 *   point at rows that are not local.
 * - `edges`, `idempotency` and `visible_seqs` are as on the old layouts, and
 *   the safe casts are 0003's.
 * - `substrate_type_tables` and `substrate_type_fields` are the type catalog.
 *
 * `UUID_CHECK_STATEMENTS` follow `TX_STATEMENTS` when
 * `SUBSTRATE_ENFORCE_UUID_CHECK=true`, as 0002 does on the old layouts.
 */

import { UUID_REGEX } from '../uuid-check.js';
import { TX_STATEMENTS as SAFE_CASTS } from './0003_safe_casts.js';

export const TX_STATEMENTS: ReadonlyArray<string> = [
  `CREATE TABLE IF NOT EXISTS row_ids (
    namespace  text  NOT NULL,
    type       text  NOT NULL,
    id         text  NOT NULL,
    PRIMARY KEY (namespace, type, id)
  )`,

  `CREATE TABLE IF NOT EXISTS edges (
    id             uuid        PRIMARY KEY,
    from_ns        text        NOT NULL,
    from_type      text        NOT NULL,
    from_id        text        NOT NULL,
    from_bridged   boolean     NOT NULL DEFAULT false,
    to_ns          text        NOT NULL,
    to_type        text        NOT NULL,
    to_id          text        NOT NULL,
    to_bridged     boolean     NOT NULL DEFAULT false,
    field_name     text        NOT NULL,
    policy         text        NOT NULL,
    created_at     timestamptz NOT NULL,
    deleted_at     timestamptz NULL,
    last_swept_at  timestamptz NULL,
    blocked        boolean     NOT NULL DEFAULT false,
    CONSTRAINT edges_policy_check
      CHECK (policy IN ('set_null','cascade','restrict','orphan'))
  )`,

  `CREATE TABLE IF NOT EXISTS idempotency (
    key         text        PRIMARY KEY,
    envelope    jsonb       NOT NULL,
    expires_at  timestamptz NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now()
  )`,

  `CREATE TABLE IF NOT EXISTS short_ids (
    namespace  text   NOT NULL,
    type       text   NOT NULL,
    short_id   bigint NOT NULL,
    row_id     text   NOT NULL,
    PRIMARY KEY (namespace, type, short_id),
    CONSTRAINT short_ids_row_id_fkey FOREIGN KEY (namespace, type, row_id)
      REFERENCES row_ids (namespace, type, id) ON DELETE CASCADE
  )`,

  `CREATE TABLE IF NOT EXISTS visible_seqs (
    namespace  text   NOT NULL,
    type       text   NOT NULL,
    last_seq   bigint NOT NULL,
    PRIMARY KEY (namespace, type)
  )`,

  ...SAFE_CASTS,

  `CREATE TABLE IF NOT EXISTS substrate_type_tables (
    namespace   text  NOT NULL,
    type        text  NOT NULL,
    table_name  text  NOT NULL UNIQUE,
    PRIMARY KEY (namespace, type)
  )`,

  `CREATE TABLE IF NOT EXISTS substrate_type_fields (
    namespace    text    NOT NULL,
    type         text    NOT NULL,
    field        text    NOT NULL,
    column_name  text    NOT NULL,
    kind         text    NOT NULL,
    state        text    NOT NULL,
    vocab        text[]  NULL,
    attempts     int     NOT NULL DEFAULT 0,
    last_error   text    NULL,
    PRIMARY KEY (namespace, type, field),
    FOREIGN KEY (namespace, type) REFERENCES substrate_type_tables (namespace, type),
    CONSTRAINT substrate_type_fields_kind_check
      CHECK (kind IN ('text','enum','number','date','boolean','crossRef')),
    CONSTRAINT substrate_type_fields_state_check
      CHECK (state IN ('column','pending','promoting','orphaned'))
  )`
];

const uuidCheck = (table: string, column: string): string =>
  `DO $$ BEGIN
    ALTER TABLE ${table} ADD CONSTRAINT ${table}_${column}_uuid_format
      CHECK (${column} ~ '${UUID_REGEX}');
  EXCEPTION WHEN duplicate_object THEN NULL;
  END $$`;

export const UUID_CHECK_STATEMENTS: ReadonlyArray<string> = [
  uuidCheck('row_ids', 'id'),
  uuidCheck('short_ids', 'row_id'),
  uuidCheck('edges', 'from_id'),
  uuidCheck('edges', 'to_id')
];

export const CONCURRENT_STATEMENTS: ReadonlyArray<string> = [
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS edges_to_live_idx
    ON edges (to_ns, to_type, to_id) WHERE deleted_at IS NULL`,
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS edges_from_live_idx
    ON edges (from_ns, from_type, from_id) WHERE deleted_at IS NULL`,
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS edges_cursor_idx
    ON edges (id) WHERE deleted_at IS NULL`,
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS edges_tombstoned_idx
    ON edges (deleted_at) WHERE deleted_at IS NOT NULL`,
  `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS edges_logical_identity_unique_idx
    ON edges (from_ns, from_type, from_id, field_name, to_ns, to_type, to_id)
    WHERE deleted_at IS NULL`,
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS idempotency_expires_at_idx
    ON idempotency (expires_at)`,
  `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS short_ids_row_uniq_idx
    ON short_ids (namespace, type, row_id)`
];

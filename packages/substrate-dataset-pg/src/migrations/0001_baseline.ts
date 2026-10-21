/**
 * 0001_baseline — the engine's schema: rows, edges, the idempotency cache and
 * the short-id sidecar.
 *
 * Plugins own their tables and any columns they promote out of `rows.body`
 * (see `PgDatasetOptions.promotedColumns`), and add them in their own kernel
 * migrations. Idempotent, so re-running it changes nothing. `TX_STATEMENTS`
 * run in one transaction; `CONCURRENT_STATEMENTS` run one by one after it
 * commits, because Postgres refuses `CREATE INDEX CONCURRENTLY` in a
 * transaction.
 */

export const TX_STATEMENTS: ReadonlyArray<string> = [
  `CREATE TABLE IF NOT EXISTS rows (
    namespace        text        NOT NULL,
    type             text        NOT NULL,
    id               text        NOT NULL,
    body             jsonb       NOT NULL,
    deleted_at       timestamptz NULL,
    created_at       timestamptz NULL,
    updated_at       timestamptz NULL,
    created_by_kind  text        NULL,
    created_by_id    text        NULL,
    updated_by_kind  text        NULL,
    updated_by_id    text        NULL,
    PRIMARY KEY (namespace, type, id),
    CONSTRAINT rows_created_by_kind_check
      CHECK (created_by_kind IS NULL OR created_by_kind IN ('agent','user','system')),
    CONSTRAINT rows_updated_by_kind_check
      CHECK (updated_by_kind IS NULL OR updated_by_kind IN ('agent','user','system'))
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
      REFERENCES rows (namespace, type, id) ON DELETE CASCADE
  )`,

  // Two live keys for one kid would make verification ambiguous.
  `CREATE UNIQUE INDEX IF NOT EXISTS substrate_key_live_kid_uniq
     ON rows ((body ->> 'kid'))
   WHERE namespace = '_system'
     AND type = 'Key'
     AND deleted_at IS NULL
     AND (body ->> 'revokedAt') IS NULL`
];

export const CONCURRENT_STATEMENTS: ReadonlyArray<string> = [
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS rows_ns_type_created_at_idx
    ON rows (namespace, type, created_at DESC NULLS LAST) WHERE deleted_at IS NULL`,
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS rows_ns_type_updated_at_idx
    ON rows (namespace, type, updated_at DESC NULLS LAST) WHERE deleted_at IS NULL`,
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS rows_tombstoned_idx
    ON rows (deleted_at) WHERE deleted_at IS NOT NULL`,
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

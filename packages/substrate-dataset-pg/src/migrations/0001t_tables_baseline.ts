/**
 * 0001t_tables_baseline — the engine's schema on the `tables` layout, where
 * each type has a table of its own (`ensureTypeTable`) and there is no `rows`.
 *
 * - `row_ids` registers every row's `(namespace, type, id)`; `short_ids`
 *   reference it. `edges` get no foreign key, since bridged and orphan edges
 *   point at rows that are not local.
 * - `edges`, `idempotency` and `visible_seqs` are as on the old layouts, and
 *   the safe casts are below.
 * - `substrate_type_tables` and `substrate_type_fields` are the type catalog.
 *
 * The opt-in UUID CHECKs are `0002t_uuid_format_check`, gated by
 * `SUBSTRATE_ENFORCE_UUID_CHECK`.
 */

/**
 * IMMUTABLE jsonb → numeric / timestamptz casts that return NULL on a
 * wrong-shaped value instead of raising, so they can back index expressions
 * and filters over jsonb values (folded in from the old layouts' 0003, text
 * unchanged).
 *
 * substrate_ts reads the ISO grammar of substrate-types' `normalizeIsoTimestamp`
 * (same groups: date, HH:MM, seconds, first 6 fraction digits, offset). It is
 * IMMUTABLE because the text is rebuilt with an explicit offset before the
 * cast (TimeZone cannot matter) and is ISO (DateStyle cannot matter).
 */
const TS_SHAPE = String.raw`^([0-9]{4}-[0-9]{2}-[0-9]{2})(?:[T ]((?:[01][0-9]|2[0-3]):[0-5][0-9])(?::([0-5][0-9])(?:\.([0-9]{1,6})[0-9]{0,3})?)?)?(Z|[+-](?:0[0-9]|1[0-5])(?::?[0-5][0-9])?)?$`;

const SAFE_CASTS: ReadonlyArray<string> = [
  // Qualified names, no SET and no STRICT: inlinable, and immune to the caller's search_path.
  `CREATE OR REPLACE FUNCTION substrate_num(v jsonb) RETURNS pg_catalog.numeric
    LANGUAGE sql IMMUTABLE PARALLEL SAFE
    AS $$ SELECT CASE
      WHEN pg_catalog.jsonb_typeof(v) OPERATOR(pg_catalog.=) 'number'
      THEN (v OPERATOR(pg_catalog.#>>) '{}')::pg_catalog.numeric
    END $$`,

  // pg_input_is_valid rejects shape-valid but out-of-range values (month 13,
  // Feb 30) without raising. An EXCEPTION block would need a subtransaction,
  // which a parallel plan cannot start, so it would turn valid values to NULL.
  // Never inlined: timestamptz input and pg_input_is_valid are STABLE.
  `CREATE OR REPLACE FUNCTION substrate_ts(v jsonb) RETURNS pg_catalog.timestamptz
    LANGUAGE sql IMMUTABLE PARALLEL SAFE
    AS $$ SELECT CASE
      WHEN pg_catalog.pg_input_is_valid(t, 'pg_catalog.timestamptz') THEN t::pg_catalog.timestamptz
    END
    FROM (
      -- No offset is UTC; a date alone is its midnight UTC; fraction digits past 6 are dropped.
      SELECT m[1] OPERATOR(pg_catalog.||) 'T'
        OPERATOR(pg_catalog.||) COALESCE(m[2], '00:00') OPERATOR(pg_catalog.||) ':'
        OPERATOR(pg_catalog.||) COALESCE(m[3], '00')
        OPERATOR(pg_catalog.||) COALESCE('.' OPERATOR(pg_catalog.||) m[4], '')
        OPERATOR(pg_catalog.||) COALESCE(m[5], 'Z') AS t
      FROM pg_catalog.regexp_match(
        CASE WHEN pg_catalog.jsonb_typeof(v) OPERATOR(pg_catalog.=) 'string'
          THEN v OPERATOR(pg_catalog.#>>) '{}' END,
        '${TS_SHAPE}') AS m
    ) AS n $$`
];

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

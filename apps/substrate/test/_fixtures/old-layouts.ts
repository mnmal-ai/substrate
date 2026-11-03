/**
 * The old layouts' schema, frozen: the statements of `0001_baseline`,
 * `0001p_partitioned_baseline`, `0003_safe_casts` and `0004_visible_seq` as
 * they last shipped, byte for byte, so migrate-store's suites can build a
 * legacy or partitioned source after the engine stops carrying them (Task 16).
 * Each version's ledger row records the checksum the runner gave it
 * (`checksum` in migrate.ts: sha256 over the statements, each followed by a
 * space), so the ledger is the one a real store holds.
 *
 * Never edit a statement here: a real old store holds exactly this schema.
 */

import { createHash } from 'node:crypto';
import type { Sql } from 'postgres';

export interface FrozenMigration {
  version: string;
  tx: readonly string[];
  concurrent: readonly string[];
}

const LEGACY_CONCURRENT: readonly string[] = [
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

const EDGES = `CREATE TABLE IF NOT EXISTS edges (
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
  )`;

const IDEMPOTENCY = `CREATE TABLE IF NOT EXISTS idempotency (
    key         text        PRIMARY KEY,
    envelope    jsonb       NOT NULL,
    expires_at  timestamptz NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now()
  )`;

const SHORT_IDS = `CREATE TABLE IF NOT EXISTS short_ids (
    namespace  text   NOT NULL,
    type       text   NOT NULL,
    short_id   bigint NOT NULL,
    row_id     text   NOT NULL,
    PRIMARY KEY (namespace, type, short_id),
    CONSTRAINT short_ids_row_id_fkey FOREIGN KEY (namespace, type, row_id)
      REFERENCES rows (namespace, type, id) ON DELETE CASCADE
  )`;

const ROWS_COLUMNS = `
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
  `;

export const LEGACY_BASELINE: FrozenMigration = {
  version: '0001_baseline',
  tx: [
    `CREATE TABLE IF NOT EXISTS rows (${ROWS_COLUMNS})`,

    EDGES,

    IDEMPOTENCY,

    SHORT_IDS,

    // Two live keys for one kid would make verification ambiguous.
    `CREATE UNIQUE INDEX IF NOT EXISTS substrate_key_live_kid_uniq
     ON rows ((body ->> 'kid'))
   WHERE namespace = '_system'
     AND type = 'Key'
     AND deleted_at IS NULL
     AND (body ->> 'revokedAt') IS NULL`
  ],
  concurrent: LEGACY_CONCURRENT
};

const SYSTEM_PARTITION = 'rows___system';
const SYSTEM_KEY_PARTITION = 'rows___system__key_c3038cb3';

export const PARTITIONED_BASELINE: FrozenMigration = {
  version: '0001p_partitioned_baseline',
  tx: [
    `CREATE TABLE IF NOT EXISTS rows (${ROWS_COLUMNS}) PARTITION BY LIST (namespace)`,

    `CREATE TABLE IF NOT EXISTS rows__default PARTITION OF rows DEFAULT`,

    `CREATE TABLE IF NOT EXISTS ${SYSTEM_PARTITION} PARTITION OF rows
     FOR VALUES IN ('_system') PARTITION BY LIST (type)`,

    `CREATE TABLE IF NOT EXISTS ${SYSTEM_PARTITION}__default PARTITION OF ${SYSTEM_PARTITION} DEFAULT`,

    `CREATE TABLE IF NOT EXISTS ${SYSTEM_KEY_PARTITION} PARTITION OF ${SYSTEM_PARTITION}
     FOR VALUES IN ('Key')`,

    EDGES,

    IDEMPOTENCY,

    SHORT_IDS,

    // Two live keys for one kid would make verification ambiguous.
    `CREATE UNIQUE INDEX IF NOT EXISTS substrate_key_live_kid_uniq
     ON ${SYSTEM_KEY_PARTITION} ((body ->> 'kid'))
   WHERE deleted_at IS NULL
     AND (body ->> 'revokedAt') IS NULL`
  ],
  concurrent: LEGACY_CONCURRENT.filter((s) => !/\sON rows\s/.test(s))
};

const TS_SHAPE = String.raw`^([0-9]{4}-[0-9]{2}-[0-9]{2})(?:[T ]((?:[01][0-9]|2[0-3]):[0-5][0-9])(?::([0-5][0-9])(?:\.([0-9]{1,6})[0-9]{0,3})?)?)?(Z|[+-](?:0[0-9]|1[0-5])(?::?[0-5][0-9])?)?$`;

export const SAFE_CASTS: FrozenMigration = {
  version: '0003_safe_casts',
  tx: [
    // Qualified names, no SET and no STRICT: inlinable, and immune to the caller's search_path.
    `CREATE OR REPLACE FUNCTION substrate_num(v jsonb) RETURNS pg_catalog.numeric
    LANGUAGE sql IMMUTABLE PARALLEL SAFE
    AS $$ SELECT CASE
      WHEN pg_catalog.jsonb_typeof(v) OPERATOR(pg_catalog.=) 'number'
      THEN (v OPERATOR(pg_catalog.#>>) '{}')::pg_catalog.numeric
    END $$`,

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
  ],
  concurrent: []
};

export const VISIBLE_SEQ: FrozenMigration = {
  version: '0004_visible_seq',
  tx: [
    'ALTER TABLE rows ADD COLUMN IF NOT EXISTS seq bigint NULL',

    `CREATE TABLE IF NOT EXISTS visible_seqs (
    namespace  text   NOT NULL,
    type       text   NOT NULL,
    last_seq   bigint NOT NULL,
    PRIMARY KEY (namespace, type)
  )`
  ],
  concurrent: []
};

/** The checksum the migration runner records for `m`. */
export function frozenChecksum(m: FrozenMigration): string {
  const hasher = createHash('sha256');
  for (const s of [...m.tx, ...m.concurrent]) {
    hasher.update(s);
    hasher.update(' ');
  }
  return hasher.digest('hex');
}

/**
 * Builds an old-layout store in `sql`'s current schema, as the runner left
 * one: the baseline, then 0003 and 0004, each recorded in `migrations`
 * (beside an empty `migrations_audit`). `visibleSeq: false` stops before 0004,
 * for a store older than `seq`.
 */
export async function buildOldLayout(
  sql: Sql,
  layout: 'legacy' | 'partitioned',
  opts: { visibleSeq?: boolean } = {}
): Promise<void> {
  const baseline = layout === 'legacy' ? LEGACY_BASELINE : PARTITIONED_BASELINE;
  const list = [baseline, SAFE_CASTS, ...(opts.visibleSeq === false ? [] : [VISIBLE_SEQ])];
  await sql`
    CREATE TABLE IF NOT EXISTS migrations (
      version     text        PRIMARY KEY,
      applied_at  timestamptz NOT NULL DEFAULT now(),
      checksum    text        NOT NULL
    )`;
  await sql`
    CREATE TABLE IF NOT EXISTS migrations_audit (
      id                bigserial   PRIMARY KEY,
      version           text        NOT NULL,
      previous_checksum text        NOT NULL,
      new_checksum      text        NOT NULL,
      observed_at       timestamptz NOT NULL DEFAULT now(),
      reason            text        NOT NULL DEFAULT 'rehash',
      build_sha         text
    )`;
  for (const m of list) {
    await sql.begin(async (tx) => {
      for (const s of m.tx) await tx.unsafe(s);
    });
    for (const s of m.concurrent) await sql.unsafe(s);
    await sql`INSERT INTO migrations (version, checksum) VALUES (${m.version}, ${frozenChecksum(m)})`;
  }
}

/**
 * 0001p_partitioned_baseline — the engine's schema for a fresh database, with
 * `rows` partitioned LIST(namespace) then LIST(type). Same columns, keys and
 * side tables as `0001_baseline`.
 *
 * Partition names come from `partitionName`; a namespace partition carries a
 * DEFAULT sub-partition named `partitionName(ns) + '__default'`. `_system` is
 * built that way here, with its `Key` partition carrying the live-kid index.
 * `rows` gets no parent-level indexes beyond its primary key.
 */

import { CONCURRENT_STATEMENTS as BASELINE_CONCURRENT } from './0001_baseline.js';

/** `partitionName('_system')`; a test pins it to the function. */
export const SYSTEM_PARTITION = 'rows___system';
/** `partitionName('_system', 'Key')`; a test pins it to the function. */
export const SYSTEM_KEY_PARTITION = 'rows___system__key_c3038cb3';

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
  ) PARTITION BY LIST (namespace)`,

  `CREATE TABLE IF NOT EXISTS rows__default PARTITION OF rows DEFAULT`,

  `CREATE TABLE IF NOT EXISTS ${SYSTEM_PARTITION} PARTITION OF rows
     FOR VALUES IN ('_system') PARTITION BY LIST (type)`,

  `CREATE TABLE IF NOT EXISTS ${SYSTEM_PARTITION}__default PARTITION OF ${SYSTEM_PARTITION} DEFAULT`,

  `CREATE TABLE IF NOT EXISTS ${SYSTEM_KEY_PARTITION} PARTITION OF ${SYSTEM_PARTITION}
     FOR VALUES IN ('Key')`,

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
     ON ${SYSTEM_KEY_PARTITION} ((body ->> 'kid'))
   WHERE deleted_at IS NULL
     AND (body ->> 'revokedAt') IS NULL`
];

/** 0001's concurrent indexes, less those on `rows`. */
export const CONCURRENT_STATEMENTS: ReadonlyArray<string> = BASELINE_CONCURRENT.filter(
  (s) => !/\sON rows\s/.test(s)
);

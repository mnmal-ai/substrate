/**
 * 0002t_uuid_format_check — the `tables` layout's opt-in UUID-format CHECKs,
 * recorded under the same ledger version as 0002 (`UUID_CHECK_MIGRATION`) and
 * gated the same way, by `SUBSTRATE_ENFORCE_UUID_CHECK=true`. It covers
 * `row_ids.id`, `short_ids.row_id`, `edges.from_id`, `edges.to_id`, and the
 * `id` of every type table that exists when it runs; `ensureTypeTable` adds the
 * CHECK to tables it creates under the gate.
 */

import { UUID_REGEX } from '../uuid-check.js';

const uuidCheck = (table: string, column: string): string =>
  `DO $$ BEGIN
    ALTER TABLE ${table} ADD CONSTRAINT ${table}_${column}_uuid_format
      CHECK (${column} ~ '${UUID_REGEX}');
  EXCEPTION WHEN duplicate_object THEN NULL;
  END $$`;

export const TX_STATEMENTS: ReadonlyArray<string> = [
  uuidCheck('row_ids', 'id'),
  uuidCheck('short_ids', 'row_id'),
  uuidCheck('edges', 'from_id'),
  uuidCheck('edges', 'to_id'),
  `DO $$ DECLARE t text; BEGIN
    FOR t IN SELECT table_name FROM substrate_type_tables LOOP
      BEGIN
        EXECUTE format('ALTER TABLE %I ADD CONSTRAINT id_uuid_format CHECK (id ~ %L)',
          t, '${UUID_REGEX}');
      EXCEPTION WHEN duplicate_object THEN NULL;
      END;
    END LOOP;
  END $$`
];

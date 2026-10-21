/**
 * 0002_uuid_format_check — CHECK constraints enforcing UUID format on
 * `rows.id`, `short_ids.row_id`, `edges.from_id` and `edges.to_id`.
 * (`edges.id` is a native uuid.)
 *
 * OPT-IN via `SUBSTRATE_ENFORCE_UUID_CHECK=true`: the test corpus uses synthetic
 * non-UUID ids. Production enables it.
 *
 * The CHECK is the primary enforcement: a direct `dataset.write` bypasses
 * autoCRUD's `randomUUID()` and must supply a UUID-shape id itself.
 */
const UUID_REGEX = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

export const TX_STATEMENTS: ReadonlyArray<string> = [
  `DO $$ BEGIN
    ALTER TABLE rows ADD CONSTRAINT rows_id_uuid_format
      CHECK (id ~ '${UUID_REGEX}');
  EXCEPTION WHEN duplicate_object THEN NULL;
  END $$`,

  `DO $$ BEGIN
    ALTER TABLE short_ids ADD CONSTRAINT short_ids_row_id_uuid_format
      CHECK (row_id ~ '${UUID_REGEX}');
  EXCEPTION WHEN duplicate_object THEN NULL;
  END $$`,

  `DO $$ BEGIN
    ALTER TABLE edges ADD CONSTRAINT edges_from_id_uuid_format
      CHECK (from_id ~ '${UUID_REGEX}');
  EXCEPTION WHEN duplicate_object THEN NULL;
  END $$`,

  `DO $$ BEGIN
    ALTER TABLE edges ADD CONSTRAINT edges_to_id_uuid_format
      CHECK (to_id ~ '${UUID_REGEX}');
  EXCEPTION WHEN duplicate_object THEN NULL;
  END $$`
];

export const CONCURRENT_STATEMENTS: ReadonlyArray<string> = [];

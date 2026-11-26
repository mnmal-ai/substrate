/**
 * 0010t_id_collation — gives every column that holds a row id the "C"
 * collation, so row ids order and compare by code point, as on the memory
 * dataset, whatever the database collation. Text and enum columns and the
 * metadata sorts already use it.
 *
 * The columns are each type table's `id` and crossRef columns, `row_ids.id`,
 * `short_ids.row_id` and `edges.from_id` / `to_id`. They move together because
 * they are joined to each other: an index in the default collation cannot serve
 * a probe by a "C" value, so converting one side alone turns that join into a
 * sequential scan.
 *
 * Changing only the collation rewrites no rows, but every index on a converted
 * column is rebuilt under an exclusive lock on its table, so on a large store
 * this migration takes as long as rebuilding those indexes. Columns already in
 * "C", including every table created after this migration, are skipped, so a
 * re-run is a no-op.
 */

export const TX_STATEMENTS: ReadonlyArray<string> = [
  `DO $$
  DECLARE t record;
  BEGIN
    FOR t IN
      SELECT c.oid::regclass AS rel,
        string_agg(format('ALTER COLUMN %I TYPE text COLLATE "C"', a.attname), ', ' ORDER BY a.attnum) AS alters
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
      LEFT JOIN substrate_type_tables s ON s.table_name = c.relname
      WHERE c.relnamespace = current_schema()::regnamespace
        AND c.relkind = 'r'
        AND a.attcollation <> 'pg_catalog."C"'::regcollation
        AND (
          (c.relname, a.attname) IN (
            ('row_ids', 'id'), ('short_ids', 'row_id'), ('edges', 'from_id'), ('edges', 'to_id'))
          OR (s.table_name IS NOT NULL AND (a.attname = 'id' OR a.attname IN (
            SELECT f.column_name FROM substrate_type_fields f
            WHERE f.namespace = s.namespace AND f.type = s.type AND f.kind = 'crossRef'
          )))
        )
      GROUP BY c.oid, c.relname
      ORDER BY c.relname
    LOOP
      EXECUTE format('ALTER TABLE %s %s', t.rel, t.alters);
    END LOOP;
  END $$`
];

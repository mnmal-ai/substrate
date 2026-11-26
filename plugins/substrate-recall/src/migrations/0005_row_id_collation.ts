/**
 * Gives recall's row id columns (`embeddings.row_id`, `lexical.row_id`,
 * `recall_cluster_members.member_id`) the "C" collation, the collation the
 * dataset's own row id columns have. They are joined to those columns, and an
 * index in one collation cannot serve a probe by a value in the other.
 *
 * Changing only the collation rewrites no rows, but each table's indexes on
 * the column are rebuilt under an exclusive lock. Idempotent: a column already
 * in "C" is skipped, and so is a table that does not exist.
 */

import type { KernelMigration, KernelMigrationContext } from '@mnmal-ai/substrate-types';
import type postgres from 'postgres';

const COLUMNS = `('embeddings', 'row_id'), ('lexical', 'row_id'), ('recall_cluster_members', 'member_id')`;

const alter = (collation: string, skip: string): string => `DO $$
  DECLARE t record;
  BEGIN
    FOR t IN
      SELECT c.oid::regclass AS rel, a.attname AS col
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
      WHERE c.relnamespace = current_schema()::regnamespace
        AND c.relkind = 'r'
        AND (c.relname, a.attname) IN (${COLUMNS})
        AND a.attcollation ${skip} 'pg_catalog."C"'::regcollation
      ORDER BY c.relname
    LOOP
      EXECUTE format('ALTER TABLE %s ALTER COLUMN %I TYPE text COLLATE ${collation}', t.rel, t.col);
    END LOOP;
  END $$`;

export function rowIdCollationMigration(): KernelMigration {
  return {
    id: '0005_row_id_collation',
    apply: async ({ sql }: KernelMigrationContext): Promise<void> => {
      if (sql === null) return;
      await (sql as ReturnType<typeof postgres>).unsafe(alter('"C"', '<>'));
    },
    rollback: async ({ sql }: KernelMigrationContext): Promise<void> => {
      if (sql === null) return;
      await (sql as ReturnType<typeof postgres>).unsafe(alter('"default"', '='));
    }
  };
}

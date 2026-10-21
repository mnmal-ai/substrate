/**
 * The lexical arm's table: `lexical` + a GIN index over its tsvector.
 *
 * Separate from `embeddings` because the two indexes are independent:
 * a row can be lexically indexed with no embedder, and vice versa.
 *
 * `tsv` is a GENERATED column, so a backfilled row cannot disagree with a
 * written one; re-indexing rewrites `content` and postgres derives the rest.
 *
 * The text search configuration is baked into that generated expression
 * (`to_tsvector` is only immutable with a literal configuration), so CHANGING
 * IT IS A MIGRATION, not a config flip: drop and re-add the column.
 *
 * Idempotent: CREATE IF NOT EXISTS throughout.
 */

import type { KernelMigration, KernelMigrationContext } from '@mnmal-ai/substrate-types';
import type postgres from 'postgres';

export interface LexicalMigrationOptions {
  /**
   * Postgres text search configuration used to build the generated tsvector.
   * Defaults to `english`. Must name a configuration that exists on the
   * server; an unknown name fails the migration rather than degrading.
   */
  textSearchConfig?: string;
}

const DEFAULT_TS_CONFIG = 'english';

/**
 * Only identifier-safe configuration names are accepted. The value is
 * interpolated into DDL (a generated column expression cannot take a bind
 * parameter), so this is the boundary that keeps it from being a SQL
 * injection seam.
 */
function assertSafeConfigName(name: string): void {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) {
    throw new Error(
      `lexicalMigration: textSearchConfig must be a bare lowercase identifier (got '${name}')`
    );
  }
}

export function lexicalMigration(opts: LexicalMigrationOptions = {}): KernelMigration {
  const tsConfig = opts.textSearchConfig ?? DEFAULT_TS_CONFIG;
  assertSafeConfigName(tsConfig);

  return {
    id: '0003_lexical',
    apply: async ({ sql }: KernelMigrationContext): Promise<void> => {
      if (sql === null) return;
      const s = sql as ReturnType<typeof postgres>;
      await s.unsafe(`
        CREATE TABLE IF NOT EXISTS lexical (
          row_namespace text        NOT NULL,
          row_type      text        NOT NULL,
          row_id        text        NOT NULL,
          content       text        NOT NULL,
          tsv           tsvector    GENERATED ALWAYS AS (to_tsvector('${tsConfig}', content)) STORED,
          updated_at    timestamptz NOT NULL DEFAULT now(),
          PRIMARY KEY (row_namespace, row_type, row_id)
        )
      `);
      // GIN over the generated vector. The scope columns lead a separate
      // btree because every search narrows by (namespace, type) before it
      // ranks — a GIN alone would rank the whole corpus and then discard.
      await s`
        CREATE INDEX IF NOT EXISTS lexical_tsv
        ON lexical USING gin (tsv)
      `;
      await s`
        CREATE INDEX IF NOT EXISTS lexical_scope
        ON lexical (row_namespace, row_type)
      `;
    },
    rollback: async ({ sql }: KernelMigrationContext): Promise<void> => {
      if (sql === null) return;
      const s = sql as ReturnType<typeof postgres>;
      await s`DROP TABLE IF EXISTS lexical CASCADE`;
    }
  };
}

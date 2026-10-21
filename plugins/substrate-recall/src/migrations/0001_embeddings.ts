/**
 * substrate-recall's embeddings table, with salience, and its HNSW index.
 *
 * Vector dimension and HNSW params come from the factory and apply when the
 * table is created. Boot re-aligns an EMPTY table to the configured
 * embedder's dimension; a populated one keeps its dimension until its rows
 * are cleared and re-embedded.
 */

import type { KernelMigration, KernelMigrationContext } from '@mnmal-ai/substrate-types';
import type postgres from 'postgres';

export interface EmbeddingsMigrationOptions {
  /** Vector dimension. Defaults to 768. */
  dimension?: number;
  /** HNSW `m` build param. Defaults to pgvector default (16). */
  hnswM?: number;
  /** HNSW `ef_construction` build param. Defaults to pgvector default (64). */
  hnswEfConstruction?: number;
}

const DEFAULT_DIM = 768;
const DEFAULT_HNSW_M = 16;
const DEFAULT_HNSW_EF_CONSTRUCTION = 64;

function assertPositiveInt(name: string, value: number): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`embeddingsMigration: ${name} must be a positive integer (got ${value})`);
  }
}

export function embeddingsMigration(opts: EmbeddingsMigrationOptions = {}): KernelMigration {
  const dimension = opts.dimension ?? DEFAULT_DIM;
  const hnswM = opts.hnswM ?? DEFAULT_HNSW_M;
  const hnswEfConstruction = opts.hnswEfConstruction ?? DEFAULT_HNSW_EF_CONSTRUCTION;
  assertPositiveInt('dimension', dimension);
  assertPositiveInt('hnswM', hnswM);
  assertPositiveInt('hnswEfConstruction', hnswEfConstruction);

  return {
    id: '0001_embeddings',
    apply: async ({ sql }: KernelMigrationContext): Promise<void> => {
      if (sql === null) return;
      const s = sql as ReturnType<typeof postgres>;
      await s`CREATE EXTENSION IF NOT EXISTS vector`;
      await s.unsafe(`
        CREATE TABLE IF NOT EXISTS embeddings (
          row_namespace text             NOT NULL,
          row_type      text             NOT NULL,
          row_id        text             NOT NULL,
          embedding     vector(${dimension}) NOT NULL,
          model         text             NOT NULL,
          updated_at    timestamptz      NOT NULL DEFAULT now(),
          salience            float8      NOT NULL DEFAULT 0,
          salience_updated_at timestamptz NOT NULL DEFAULT now(),
          PRIMARY KEY (row_namespace, row_type, row_id)
        )
      `);
      await s.unsafe(`
        CREATE INDEX IF NOT EXISTS embeddings_hnsw
        ON embeddings USING hnsw (embedding vector_cosine_ops)
        WITH (m = ${hnswM}, ef_construction = ${hnswEfConstruction})
      `);
    },
    rollback: async ({ sql }: KernelMigrationContext): Promise<void> => {
      if (sql === null) return;
      const s = sql as ReturnType<typeof postgres>;
      // CASCADE so dependent objects cannot block rollback. The pgvector
      // extension is left in place: it is shared infrastructure.
      await s`DROP TABLE IF EXISTS embeddings CASCADE`;
    }
  };
}

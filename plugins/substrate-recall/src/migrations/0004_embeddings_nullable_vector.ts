/**
 * Lets `embeddings.embedding` hold NULL, for the marker a row with no
 * embeddable text keeps (model `'unindexable'`, NULL vector). The HNSW index
 * does not index NULL vectors, so it needs no change.
 *
 * Idempotent: dropping NOT NULL from a nullable column is a no-op, and a store
 * with no embeddings table is left alone.
 */

import type { KernelMigration, KernelMigrationContext } from '@mnmal-ai/substrate-types';
import type postgres from 'postgres';

export function embeddingsNullableVectorMigration(): KernelMigration {
  return {
    id: '0004_embeddings_nullable_vector',
    apply: async ({ sql }: KernelMigrationContext): Promise<void> => {
      if (sql === null) return;
      const s = sql as ReturnType<typeof postgres>;
      await s`ALTER TABLE IF EXISTS embeddings ALTER COLUMN embedding DROP NOT NULL`;
    },
    rollback: async ({ sql }: KernelMigrationContext): Promise<void> => {
      if (sql === null) return;
      const s = sql as ReturnType<typeof postgres>;
      const [found] = await s<Array<{ t: string | null }>>`SELECT to_regclass('embeddings') AS t`;
      if (found?.t == null) return;
      // The markers are derived; removing them is what lets NOT NULL hold again.
      await s`DELETE FROM embeddings WHERE embedding IS NULL`;
      await s`ALTER TABLE embeddings ALTER COLUMN embedding SET NOT NULL`;
    }
  };
}

/**
 * substrate-recall migration 0002: the crystallisation tables.
 *
 * Plugin-owned tables outside the engine's row/edge substrate, because a
 * substrate namespace is dataset-less: autoCRUD and crossRef edges are
 * unavailable to `recall/*`. FK cascade and indexes provide the equivalents.
 * `short_id` is a per-table IDENTITY, not an engine short-id.
 *
 * The member side has NO foreign key to the source row on purpose: deleting a
 * source row must leave the membership in place, marked `departed_at`.
 *
 * No unique index on the live member triple: one-cluster-per-row is enforced
 * in `crystallise-core`, so allowing overlap later needs no migration.
 */

import type { KernelMigration, KernelMigrationContext } from '@mnmal-ai/substrate-types';
import type postgres from 'postgres';

export interface RecallClustersMigrationOptions {
  /**
   * Centroid dimension. Must match `embeddings.embedding`: centroids
   * live in the ORIGINAL embedding space, never reduced space.
   */
  dimension?: number;
}

const DEFAULT_DIM = 768;

export function recallClustersMigration(
  opts: RecallClustersMigrationOptions = {}
): KernelMigration {
  const dimension = opts.dimension ?? DEFAULT_DIM;
  if (!Number.isInteger(dimension) || dimension <= 0) {
    throw new Error(
      `recallClustersMigration: dimension must be a positive integer (got ${dimension})`
    );
  }

  return {
    id: '0002_recall_clusters',
    apply: async ({ sql }: KernelMigrationContext): Promise<void> => {
      if (sql === null) return;
      const s = sql as ReturnType<typeof postgres>;
      await s`CREATE EXTENSION IF NOT EXISTS vector`;
      await s.unsafe(`
        CREATE TABLE IF NOT EXISTS recall_clusters (
          id               text        PRIMARY KEY,
          short_id         bigint      GENERATED ALWAYS AS IDENTITY,
          centroid         vector(${dimension}) NOT NULL,
          member_count     integer     NOT NULL DEFAULT 0,
          departed_count   integer     NOT NULL DEFAULT 0,
          cohesion         double precision NOT NULL,
          label            text        NOT NULL,
          labelled_by      text        NOT NULL,
          provenance       jsonb       NOT NULL,
          formed_at        timestamptz NOT NULL DEFAULT now(),
          last_accreted_at timestamptz,
          retired_at       timestamptz
        )
      `);
      // Accretion and the default query surface both filter on "live".
      await s.unsafe(`
        CREATE INDEX IF NOT EXISTS recall_clusters_live
        ON recall_clusters (retired_at)
      `);
      await s.unsafe(`
        CREATE TABLE IF NOT EXISTS recall_cluster_members (
          id          text        PRIMARY KEY,
          short_id    bigint      GENERATED ALWAYS AS IDENTITY,
          cluster_id  text        NOT NULL
                        REFERENCES recall_clusters(id) ON DELETE CASCADE,
          member_ns   text        NOT NULL,
          member_type text        NOT NULL,
          member_id   text        NOT NULL,
          origin      text        NOT NULL,
          similarity  double precision NOT NULL,
          attached_at timestamptz NOT NULL DEFAULT now(),
          departed_at timestamptz
        )
      `);
      // "Which members does this cluster have" — the findEdgesTo replacement.
      await s.unsafe(`
        CREATE UNIQUE INDEX IF NOT EXISTS recall_cluster_members_unique
        ON recall_cluster_members (cluster_id, member_ns, member_type, member_id)
      `);
      // "Which clusters claim this row" — the reverse walk.
      await s.unsafe(`
        CREATE INDEX IF NOT EXISTS recall_cluster_members_member
        ON recall_cluster_members (member_ns, member_type, member_id)
      `);
    },
    rollback: async ({ sql }: KernelMigrationContext): Promise<void> => {
      if (sql === null) return;
      const s = sql as ReturnType<typeof postgres>;
      // Members first, so the drop order states the FK dependency.
      await s`DROP TABLE IF EXISTS recall_cluster_members CASCADE`;
      await s`DROP TABLE IF EXISTS recall_clusters CASCADE`;
    }
  };
}

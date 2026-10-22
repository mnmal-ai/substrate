/**
 * PgClusterStore — postgres implementation of `ClusterStore`.
 *
 * Sibling of `PgEmbeddingsStore`: same handle type, same `txScopeIdFor`,
 * same pgvector text-literal wire convention.
 *
 * Counters are always RE-DERIVED from the membership rows inside the same
 * transaction as the write that touched them, never incremented in place:
 * `departedCount` and `memberCount` are changed by different code paths, and
 * an increment is only correct if every such path increments too.
 */

import { type PgHandle, txScopeIdFor } from '@mnmal-ai/substrate-dataset-pg';
import type { Sql } from 'postgres';
import type {
  ClusterMemberRecord,
  ClusterProvenance,
  ClusterRecord,
  ClusterStore,
  MemberRef,
  NewCluster,
  NewMember
} from './cluster-store.js';
import { memberKey } from './cluster-store.js';
import { inFlightError } from './crystallise-guard.js';
import { parseVectorText, vectorLiteral } from './pg-vector-text.js';

export interface PgClusterStoreOptions {
  sql: Sql;
}

interface ClusterRow {
  id: string;
  short_id: string | number;
  centroid: string;
  member_count: number;
  departed_count: number;
  cohesion: number;
  label: string;
  labelled_by: string;
  /** `jsonb` arrives as a JSON-encoded string, not a parsed object. */
  provenance: string;
  formed_at: Date;
  last_accreted_at: Date | null;
  retired_at: Date | null;
}

interface MemberRow {
  id: string;
  short_id: string | number;
  cluster_id: string;
  member_ns: string;
  member_type: string;
  member_id: string;
  origin: string;
  similarity: number;
  attached_at: Date;
  departed_at: Date | null;
}

function toCluster(r: ClusterRow): ClusterRecord {
  return {
    id: r.id,
    shortId: Number(r.short_id),
    centroid: parseVectorText(r.centroid),
    memberCount: r.member_count,
    departedCount: r.departed_count,
    cohesion: r.cohesion,
    label: r.label,
    labelledBy: r.labelled_by === 'agent' ? 'agent' : 'medoid',
    provenance: JSON.parse(r.provenance) as ClusterProvenance,
    formedAt: r.formed_at,
    lastAccretedAt: r.last_accreted_at,
    retiredAt: r.retired_at
  };
}

function toMember(r: MemberRow): ClusterMemberRecord {
  return {
    id: r.id,
    shortId: Number(r.short_id),
    clusterId: r.cluster_id,
    memberNs: r.member_ns,
    memberType: r.member_type,
    memberId: r.member_id,
    origin: r.origin === 'accretion' ? 'accretion' : 'formation',
    similarity: r.similarity,
    attachedAt: r.attached_at,
    departedAt: r.departed_at
  };
}

/** `centroid::text` — pgvector has no postgres.js codec, so it arrives as text. */
const CLUSTER_COLUMNS =
  'id, short_id, centroid::text AS centroid, member_count, departed_count, ' +
  'cohesion, label, labelled_by, provenance, formed_at, last_accreted_at, retired_at';

/**
 * Re-derive `member_count` / `departed_count` for `clusterIds` from the
 * membership rows, inside the caller's transaction, in one set-based UPDATE.
 *
 * `stamps` optionally sets a per-cluster `last_accreted_at`; a cluster with
 * no entry keeps its existing value.
 */
async function recountClusters(
  tx: Sql,
  clusterIds: readonly string[],
  stamps?: ReadonlyMap<string, Date>
): Promise<void> {
  if (clusterIds.length === 0) return;
  const stampTexts = clusterIds.map((id) => stamps?.get(id)?.toISOString() ?? null);
  await tx`
    UPDATE recall_clusters c SET
      member_count = counts.live,
      departed_count = counts.departed,
      last_accreted_at = COALESCE(want.stamp::timestamptz, c.last_accreted_at)
    FROM (
      SELECT cluster_id,
             count(*) FILTER (WHERE departed_at IS NULL) AS live,
             count(*) FILTER (WHERE departed_at IS NOT NULL) AS departed
      FROM recall_cluster_members
      WHERE cluster_id = ANY(${clusterIds}::text[])
      GROUP BY cluster_id
    ) counts
    JOIN unnest(${clusterIds}::text[], ${stampTexts}::text[]) AS want(cluster_id, stamp)
      ON want.cluster_id = counts.cluster_id
    WHERE c.id = counts.cluster_id
  `;
}

/** Distinct from the migrator's `substrate-migrations` key; hashed the same way. */
const FORMATION_LOCK_KEY = 'substrate-recall-crystallise';

export class PgClusterStore implements ClusterStore {
  readonly #sql: PgHandle;
  readonly txScopeId: string;

  constructor(opts: PgClusterStoreOptions) {
    this.#sql = opts.sql;
    this.txScopeId = txScopeIdFor(opts.sql);
  }

  /**
   * Runs `fn` holding a session advisory lock that excludes formation in every
   * process on this database; throws `crystallise_in_flight` if it is held.
   *
   * Lock and unlock share one reserved connection, since through the pool the
   * unlock can land on another session and fail to release.
   */
  async withFormationLock<T>(fn: () => Promise<T>): Promise<T> {
    const conn = await (this.#sql as Sql).reserve();
    try {
      const [row] = await conn<Array<{ acquired: boolean }>>`
        SELECT pg_try_advisory_lock(hashtext(${FORMATION_LOCK_KEY})) AS acquired
      `;
      if (row?.acquired !== true) throw inFlightError();
      try {
        return await fn();
      } finally {
        await conn`SELECT pg_advisory_unlock(hashtext(${FORMATION_LOCK_KEY}))`;
      }
    } finally {
      conn.release();
    }
  }

  async createCluster(input: NewCluster): Promise<ClusterRecord> {
    const sql = this.#sql as Sql;
    const rows = await sql.unsafe<ClusterRow[]>(
      `INSERT INTO recall_clusters
         (id, centroid, cohesion, label, labelled_by, provenance, formed_at)
       VALUES ($1, $2::vector, $3, $4, $5, $6, $7)
       RETURNING ${CLUSTER_COLUMNS}`,
      [
        input.id,
        vectorLiteral(input.centroid),
        input.cohesion,
        input.label,
        input.labelledBy,
        JSON.stringify(input.provenance),
        input.now ?? new Date()
      ]
    );
    const row = rows[0];
    if (row === undefined) {
      throw new Error(`PgClusterStore.createCluster: insert returned no row for '${input.id}'`);
    }
    return toCluster(row);
  }

  async attachMembers(inputs: readonly NewMember[]): Promise<void> {
    if (inputs.length === 0) return;
    const sql = this.#sql as Sql;
    const batchNow = new Date();
    await sql.begin(async (tx) => {
      // Per-cluster stamps, recorded only when a row was actually inserted:
      // clusters with differing `now` keep their own timestamps, and a
      // fully-duplicate batch leaves `lastAccretedAt` untouched.
      const stamps = new Map<string, Date>();
      for (const input of inputs) {
        const inserted = await tx`
          INSERT INTO recall_cluster_members
            (id, cluster_id, member_ns, member_type, member_id, origin, similarity, attached_at)
          VALUES (
            ${input.id}, ${input.clusterId}, ${input.ref.namespace}, ${input.ref.type},
            ${input.ref.id}, ${input.origin}, ${input.similarity}, ${input.now ?? batchNow}
          )
          ON CONFLICT (cluster_id, member_ns, member_type, member_id) DO NOTHING
          RETURNING id
        `;
        if (inserted.length > 0) stamps.set(input.clusterId, input.now ?? batchNow);
      }
      await recountClusters(tx as unknown as Sql, Array.from(stamps.keys()), stamps);
    });
  }

  async listClusters(opts: { includeRetired?: boolean } = {}): Promise<ClusterRecord[]> {
    const sql = this.#sql as Sql;
    const rows = await sql.unsafe<ClusterRow[]>(
      `SELECT ${CLUSTER_COLUMNS} FROM recall_clusters
       ${opts.includeRetired === true ? '' : 'WHERE retired_at IS NULL'}
       ORDER BY formed_at ASC, short_id ASC`
    );
    return rows.map(toCluster);
  }

  async getCluster(id: string): Promise<ClusterRecord | null> {
    const sql = this.#sql as Sql;
    const rows = await sql.unsafe<ClusterRow[]>(
      `SELECT ${CLUSTER_COLUMNS} FROM recall_clusters WHERE id = $1`,
      [id]
    );
    const row = rows[0];
    return row === undefined ? null : toCluster(row);
  }

  async listMembers(
    clusterId: string | readonly string[],
    opts: { includeDeparted?: boolean } = {}
  ): Promise<ClusterMemberRecord[]> {
    const sql = this.#sql as Sql;
    const ids = typeof clusterId === 'string' ? [clusterId] : [...clusterId];
    const rows = await sql<MemberRow[]>`
      SELECT * FROM recall_cluster_members
      WHERE cluster_id = ANY(${ids}::text[])
        ${opts.includeDeparted === true ? sql`` : sql`AND departed_at IS NULL`}
      ORDER BY short_id ASC
    `;
    return rows.map(toMember);
  }

  async listAllMembers(): Promise<ClusterMemberRecord[]> {
    const sql = this.#sql as Sql;
    const rows = await sql<MemberRow[]>`
      SELECT * FROM recall_cluster_members
      WHERE departed_at IS NULL
      ORDER BY short_id ASC
    `;
    return rows.map(toMember);
  }

  async findClustersForMember(ref: MemberRef): Promise<ClusterMemberRecord[]> {
    const sql = this.#sql as Sql;
    const rows = await sql<MemberRow[]>`
      SELECT * FROM recall_cluster_members
      WHERE member_ns = ${ref.namespace}
        AND member_type = ${ref.type}
        AND member_id = ${ref.id}
      ORDER BY short_id ASC
    `;
    return rows.map(toMember);
  }

  async claimedMembers(refs: readonly MemberRef[]): Promise<Set<string>> {
    if (refs.length === 0) return new Set();
    const sql = this.#sql as Sql;
    // One round-trip: unnest the three parallel arrays into a join key set.
    const namespaces = refs.map((r) => r.namespace);
    const types = refs.map((r) => r.type);
    const ids = refs.map((r) => r.id);
    const rows = await sql<Array<{ member_ns: string; member_type: string; member_id: string }>>`
      SELECT DISTINCT m.member_ns, m.member_type, m.member_id
      FROM recall_cluster_members m
      JOIN unnest(${namespaces}::text[], ${types}::text[], ${ids}::text[])
        AS want(ns, type, id)
        ON want.ns = m.member_ns AND want.type = m.member_type AND want.id = m.member_id
      WHERE m.departed_at IS NULL
    `;
    return new Set(
      rows.map((r) => memberKey({ namespace: r.member_ns, type: r.member_type, id: r.member_id }))
    );
  }

  async markDeparted(refs: readonly MemberRef[], now?: Date): Promise<number> {
    if (refs.length === 0) return 0;
    const sql = this.#sql as Sql;
    const stamp = now ?? new Date();
    const namespaces = refs.map((r) => r.namespace);
    const types = refs.map((r) => r.type);
    const ids = refs.map((r) => r.id);
    return sql.begin(async (tx) => {
      const updated = await tx<Array<{ cluster_id: string }>>`
        UPDATE recall_cluster_members m
        SET departed_at = ${stamp}
        FROM unnest(${namespaces}::text[], ${types}::text[], ${ids}::text[]) AS want(ns, type, id)
        WHERE want.ns = m.member_ns
          AND want.type = m.member_type
          AND want.id = m.member_id
          AND m.departed_at IS NULL
        RETURNING m.cluster_id
      `;
      if (updated.length === 0) return 0;
      const clusterIds = Array.from(new Set(updated.map((r) => r.cluster_id)));
      await recountClusters(tx as unknown as Sql, clusterIds);
      return updated.length;
    }) as unknown as Promise<number>;
  }

  async retire(clusterId: string, now?: Date): Promise<void> {
    const sql = this.#sql as Sql;
    // `retired_at IS NULL` makes this idempotent: a retired cluster keeps
    // the stamp recording when it actually fell below the floor.
    await sql`
      UPDATE recall_clusters
      SET retired_at = ${now ?? new Date()}
      WHERE id = ${clusterId} AND retired_at IS NULL
    `;
  }

  async relabel(clusterId: string, label: string): Promise<ClusterRecord | null> {
    const sql = this.#sql as Sql;
    const rows = await sql.unsafe<ClusterRow[]>(
      `UPDATE recall_clusters SET label = $2, labelled_by = 'agent'
       WHERE id = $1
       RETURNING ${CLUSTER_COLUMNS}`,
      [clusterId, label]
    );
    const row = rows[0];
    return row === undefined ? null : toCluster(row);
  }
}

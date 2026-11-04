/**
 * Keep every vector column substrate-recall owns at the configured embedder's
 * dimension: `embeddings.embedding` (+ its HNSW index) and
 * `recall_clusters.centroid`.
 *
 * This runs on every boot, not once: migrations are recorded by id, so a store
 * first booted with no embedder keeps the 768 default, and an embedder of
 * another dimension configured later would fail every write.
 *
 * An EMPTY column is re-typed, because vectors and centroids are derived and
 * there is nothing to reinterpret. A POPULATED column at another dimension is
 * left alone: re-typing it would reinterpret stored data. The caller decides
 * how to surface that.
 *
 * It runs in one transaction under an advisory lock scoped to the schema, so
 * replicas booting together do not race on the DDL, and the table is locked
 * before the emptiness check so a concurrent insert cannot land between check
 * and ALTER.
 */

import type postgres from 'postgres';

type Sql = ReturnType<typeof postgres>;

export type ColumnAlignment = 'absent' | 'match' | 'aligned' | 'populated';

export interface AlignmentReport {
  embeddings: ColumnAlignment;
  centroids: ColumnAlignment;
  /** The stored dimension of each column that was looked at. */
  found: { embeddings?: number; centroids?: number };
}

export interface AlignOptions {
  dimension: number;
  hnswM?: number;
  hnswEfConstruction?: number;
}

async function columnDim(s: Sql, table: string, column: string): Promise<number | null> {
  const reg = await s.unsafe(`SELECT to_regclass('${table}') AS t`);
  if ((reg[0] as { t: string | null } | undefined)?.t == null) return null;
  const rows = await s.unsafe(
    `SELECT (regexp_match(format_type(atttypid, atttypmod), '\\((\\d+)\\)'))[1]::int AS dim
     FROM pg_attribute WHERE attrelid = '${table}'::regclass AND attname = '${column}'`
  );
  return (rows[0] as { dim: number | null } | undefined)?.dim ?? null;
}

async function isEmpty(s: Sql, table: string): Promise<boolean> {
  const rows = await s.unsafe(`SELECT NOT EXISTS (SELECT 1 FROM ${table}) AS empty`);
  return (rows[0] as { empty: boolean } | undefined)?.empty === true;
}

async function alignColumn(
  s: Sql,
  table: string,
  column: string,
  dimension: number,
  after?: () => Promise<void>
): Promise<{ state: ColumnAlignment; found?: number }> {
  const found = await columnDim(s, table, column);
  if (found === null) return { state: 'absent' };
  if (found === dimension) return { state: 'match', found };
  await s.unsafe(`LOCK TABLE ${table} IN ACCESS EXCLUSIVE MODE`);
  if (!(await isEmpty(s, table))) return { state: 'populated', found };
  await s.unsafe(`ALTER TABLE ${table} ALTER COLUMN ${column} TYPE vector(${dimension})`);
  if (after !== undefined) await after();
  return { state: 'aligned', found };
}

export async function alignVectorDimensions(s: Sql, opts: AlignOptions): Promise<AlignmentReport> {
  const { dimension } = opts;
  if (!Number.isInteger(dimension) || dimension <= 0) {
    throw new Error(
      `alignVectorDimensions: dimension must be a positive integer (got ${dimension})`
    );
  }
  return (await s.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext('substrate-recall-align:' || current_schema()))`;
    return alignLocked(tx as unknown as Sql, opts);
  })) as AlignmentReport;
}

async function alignLocked(s: Sql, opts: AlignOptions): Promise<AlignmentReport> {
  const { dimension } = opts;
  const m = opts.hnswM ?? 16;
  const ef = opts.hnswEfConstruction ?? 64;
  const embeddings = await alignColumn(s, 'embeddings', 'embedding', dimension, async () => {
    // The HNSW index is typed by the column; rebuild it at the new dimension.
    await s.unsafe(`DROP INDEX IF EXISTS embeddings_hnsw`);
    await s.unsafe(`
      CREATE INDEX IF NOT EXISTS embeddings_hnsw
      ON embeddings USING hnsw (embedding vector_cosine_ops)
      WITH (m = ${m}, ef_construction = ${ef})
    `);
  });
  const centroids = await alignColumn(s, 'recall_clusters', 'centroid', dimension);
  return {
    embeddings: embeddings.state,
    centroids: centroids.state,
    found: {
      ...(embeddings.found !== undefined ? { embeddings: embeddings.found } : {}),
      ...(centroids.found !== undefined ? { centroids: centroids.found } : {})
    }
  };
}

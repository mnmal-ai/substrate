/**
 * PgEmbeddingsStore — PostgreSQL+pgvector implementation of `EmbeddingsStore`.
 *
 * One table (`embeddings`) keyed by (rowNamespace, rowType, rowId). The
 * model identifier is stored with the vector; knnSearch filters on it after
 * the vector scan.
 *
 * Vectors cross the wire as pgvector text literals (`[v1,...,vN]`), bound as
 * parameters and cast in SQL.
 *
 * The read path sets `hnsw.iterative_scan = 'strict_order'` and
 * `hnsw.ef_search` with SET LOCAL inside a transaction. Without iterative
 * scan, a WHERE on namespace/type makes the planner fall back to seqscan +
 * sort and bypass the HNSW index; model stays out of the WHERE for the same
 * reason.
 */

import { type PgHandle, txScopeIdFor } from '@mnmal-ai/substrate-dataset-pg';
import type { Sql } from 'postgres';
import type { Candidate, CandidateSelector } from './candidate-selection.js';
import type {
  EmbeddingsStore,
  EmbeddingsStoreDeleteInput,
  EmbeddingsStoreFetchResult,
  EmbeddingsStoreKnnInput,
  EmbeddingsStoreKnnResult,
  EmbeddingsStoreUpsertInput,
  SalienceTarget
} from './embeddings-store.js';
import { ROW_BODY_SQL, rowFilterSql } from './pg-row-filter.js';
import { parseVectorText, vectorLiteral } from './pg-vector-text.js';

export interface PgEmbeddingsStoreOptions {
  sql: Sql;
}

const DEFAULT_HNSW_EF_SEARCH = 200;

function clampK(k: number): number {
  if (!Number.isFinite(k) || k < 1) return 1;
  if (k > 100) return 100;
  return Math.floor(k);
}

export class PgEmbeddingsStore implements EmbeddingsStore {
  readonly #sql: PgHandle;
  readonly txScopeId: string;

  constructor(opts: PgEmbeddingsStoreOptions) {
    this.#sql = opts.sql;
    this.txScopeId = txScopeIdFor(opts.sql);
  }

  async upsert(input: EmbeddingsStoreUpsertInput): Promise<void> {
    const sql = this.#sql as Sql;
    const literal = vectorLiteral(input.vector);
    // ON CONFLICT omits salience + salience_updated_at so re-embedding a row
    // preserves its accumulated recall-attention signal.
    try {
      await sql`
        INSERT INTO embeddings (row_namespace, row_type, row_id, embedding, model, updated_at)
        VALUES (
          ${input.rowNamespace},
          ${input.rowType},
          ${input.rowId},
          ${literal}::vector,
          ${input.model},
          ${input.now ?? new Date()}
        )
        ON CONFLICT (row_namespace, row_type, row_id) DO UPDATE SET
          embedding  = EXCLUDED.embedding,
          model      = EXCLUDED.model,
          updated_at = EXCLUDED.updated_at
        WHERE embeddings.updated_at <= EXCLUDED.updated_at
      `;
    } catch (err) {
      // pgvector reports a dimension mismatch as "expected N dimensions, not
      // M"; rethrow it as an embedder-vs-table disagreement. Other errors
      // propagate unchanged.
      const msg = err instanceof Error ? err.message : String(err);
      if (/expected \d+ dimensions/i.test(msg)) {
        throw new Error(
          `PgEmbeddingsStore.upsert: embedding dimension mismatch for ` +
            `${input.rowNamespace}/${input.rowType}/${input.rowId} (${input.vector.length} dims) — ${msg}. ` +
            `The embedder's output dimension disagrees with the embeddings.embedding column; ` +
            `align the embedder config with the table, or re-embed via POST /substrate/v1/embed/reindex.`
        );
      }
      throw err;
    }
  }

  async delete(input: EmbeddingsStoreDeleteInput): Promise<void> {
    const sql = this.#sql as Sql;
    await sql`
      DELETE FROM embeddings
      WHERE row_namespace = ${input.rowNamespace}
        AND row_type      = ${input.rowType}
        AND row_id        = ${input.rowId}
    `;
  }

  async knnSearch(input: EmbeddingsStoreKnnInput): Promise<EmbeddingsStoreKnnResult[]> {
    const sql = this.#sql as Sql;
    const literal = vectorLiteral(input.vector);
    const k = clampK(input.k);
    const threshold = typeof input.threshold === 'number' ? input.threshold : 0;

    // SET LOCAL + SELECT in one transaction so the hnsw GUCs apply only here.
    const wantVector = input.returnVector === true;
    const halfLife = input.salienceHalfLifeHours;
    type KnnRow = {
      row: Record<string, unknown>;
      score: number;
      salience: number;
      /** pgvector text form, selected only when returnVector is requested. */
      embedding?: string;
    };
    const rows = await (sql.begin<Array<KnnRow>>(async (tx) => {
      await tx`SET LOCAL hnsw.iterative_scan = 'strict_order'`;
      // SET LOCAL refuses bound parameters, so the value is inlined via
      // tx.unsafe. Safe: it is a module constant, not user input.
      await tx.unsafe(`SET LOCAL hnsw.ef_search = ${DEFAULT_HNSW_EF_SEARCH}`);
      // The model and row filters are applied inside the iterative scan, so
      // vectors from another model of the same dimension (mid-reindex) do not
      // crowd out the top k. The scan stops after hnsw.max_scan_tuples: a very selective filter behind more nearer
      // non-matching tuples than that can still return fewer than k rows.
      //
      // The embedding is selected only when requested: serializing it to text
      // on every recall would tax the default path.
      return tx<Array<KnnRow>>`
        SELECT
          ${tx.unsafe(ROW_BODY_SQL)}              AS row,
          1 - (e.embedding <=> ${literal}::vector) AS score,
          e.salience ${
            halfLife !== undefined && halfLife > 0
              ? tx`* exp(-ln(2) * GREATEST(0, EXTRACT(EPOCH FROM (now() - e.salience_updated_at))) / ${halfLife * 3600})`
              : tx``
          } AS salience
          ${wantVector ? tx`, e.embedding::text AS embedding` : tx``}
        FROM embeddings e
        JOIN rows r
          ON r.namespace = e.row_namespace
         AND r.type      = e.row_type
         AND r.id        = e.row_id
        WHERE e.row_namespace = ${input.namespace}
          AND e.row_type      = ${input.type}
          AND e.model         = ${input.model}
          AND r.deleted_at IS NULL
          AND 1 - (e.embedding <=> ${literal}::vector) >= ${threshold}
          ${rowFilterSql(tx as unknown as Sql, input.rowFilter)}
        ORDER BY e.embedding <=> ${literal}::vector
        LIMIT ${k}
      `;
    }) as unknown as Promise<Array<KnnRow>>);

    return rows.map((r) => ({
      row: r.row,
      score: r.score,
      salience: r.salience,
      ...(wantVector && typeof r.embedding === 'string'
        ? { vector: Array.from(parseVectorText(r.embedding)) }
        : {})
    }));
  }

  async boostSalience(
    targets: ReadonlyArray<SalienceTarget>,
    halfLifeHours: number,
    bump = 1
  ): Promise<ReadonlyArray<SalienceTarget>> {
    if (targets.length === 0) return [];
    const sql = this.#sql as Sql;
    const halfLifeSeconds = halfLifeHours * 3600;
    // Decay-then-add as one set-based UPDATE driven by a VALUES join: one
    // round-trip regardless of target count. Targets without an embedding row
    // drop out of the join; RETURNING reports the ones that matched.
    const applied = await sql<Array<{ ns: string; ty: string; id: string }>>`
      UPDATE embeddings AS e
      SET salience = e.salience
                    * exp(
                        -ln(2) * GREATEST(0, EXTRACT(EPOCH FROM (now() - e.salience_updated_at)))
                        / ${halfLifeSeconds}
                      )
                    + ${bump},
          salience_updated_at = now()
      FROM (VALUES ${sql(targets.map((t) => [t.namespace, t.type, t.id]))}) AS t(ns, ty, id)
      WHERE e.row_namespace = t.ns
        AND e.row_type      = t.ty
        AND e.row_id        = t.id
      RETURNING e.row_namespace AS ns, e.row_type AS ty, e.row_id AS id
    `;
    return applied.map((r) => ({ namespace: r.ns, type: r.ty, id: r.id }));
  }

  async fetchEmbeddings(
    ids: ReadonlyArray<{ namespace: string; type: string; id: string }>,
    model: string
  ): Promise<ReadonlyArray<EmbeddingsStoreFetchResult>> {
    if (ids.length === 0) return [];
    const sql = this.#sql as Sql;

    type EmbeddingRow = {
      row_namespace: string;
      row_type: string;
      row_id: string;
      embedding: string;
      body: Record<string, unknown>;
      salience: number;
    };

    // Drive the join from the small VALUES list so each tuple is a primary-key
    // lookup on embeddings; model is a residual filter. The PK covers
    // the tuple, so no extra index is needed.
    const rows = await sql<EmbeddingRow[]>`
      SELECT e.row_namespace, e.row_type, e.row_id, e.embedding::text AS embedding,
             ${sql.unsafe(ROW_BODY_SQL)} AS body, e.salience
      FROM (VALUES ${sql(ids.map((id) => [id.namespace, id.type, id.id]))}) AS t(ns, ty, id)
      JOIN embeddings e
        ON e.row_namespace = t.ns AND e.row_type = t.ty AND e.row_id = t.id
      JOIN rows r
        ON r.namespace = e.row_namespace AND r.type = e.row_type AND r.id = e.row_id
      WHERE e.model = ${model}
        AND r.deleted_at IS NULL
    `;

    return rows.map((r) => ({
      namespace: r.row_namespace,
      type: r.row_type,
      id: r.row_id,
      row: r.body,
      vector: parseVectorText(r.embedding),
      salience: r.salience
    }));
  }

  async selectCandidates(selector: CandidateSelector, model: string): Promise<Candidate[]> {
    const sql = this.#sql as Sql;
    const namespaces = selector.scopes.map((s) => s.namespace);
    const types = selector.scopes.map((s) => s.type);
    const exclusionFields = selector.excludeTextPrefixes.map((e) => e.field);
    const exclusionPrefixes = selector.excludeTextPrefixes.map((e) => e.prefix);

    // No HNSW GUCs: this is an exhaustive scoped scan, not a kNN, so `model`
    // can sit in the WHERE.
    //
    // ORDER BY pins COLLATE "C" (byte order) to match the in-memory store's
    // comparator; the database collation would order case and punctuation
    // differently, and candidate order is part of the contract.
    const rows = await sql<
      Array<{
        row_namespace: string;
        row_type: string;
        row_id: string;
        embedding: string;
        body: Record<string, unknown>;
      }>
    >`
      SELECT e.row_namespace, e.row_type, e.row_id, e.embedding::text AS embedding,
             ${sql.unsafe(ROW_BODY_SQL)} AS body
      FROM embeddings e
      JOIN rows r
        ON r.namespace = e.row_namespace
       AND r.type      = e.row_type
       AND r.id        = e.row_id
      JOIN unnest(${namespaces}::text[], ${types}::text[]) AS scope(ns, type)
        ON scope.ns = e.row_namespace AND scope.type = e.row_type
      WHERE e.model = ${model}
        AND r.deleted_at IS NULL
        AND NOT EXISTS (
          SELECT 1
          FROM unnest(${exclusionFields}::text[], ${exclusionPrefixes}::text[]) AS ex(field, prefix)
          -- starts_with(), not LIKE: a caller-supplied prefix must be matched
          -- literally. LIKE treats '_' and '%' in the prefix as wildcards, so
          -- a prefix like 'perf_seed' would also exclude 'perfXseed…' — the
          -- in-memory side (String(value).startsWith(...)) never had that
          -- hazard, so the two implementations silently disagreed. Restricted
          -- to scalar JSON values (jsonb_typeof) to match the in-memory side,
          -- which coerces only string/number/boolean via String(value) — a
          -- composite (object/array) has no agreed-on text rendering between
          -- pg's jsonb ->> and JS's String(), so both sides now treat a
          -- composite as never-excluded rather than risk disagreeing.
          WHERE jsonb_typeof(${sql.unsafe(ROW_BODY_SQL)} -> ex.field) IN ('string', 'number', 'boolean')
            AND starts_with(${sql.unsafe(ROW_BODY_SQL)} ->> ex.field, ex.prefix)
        )
      ORDER BY e.row_namespace COLLATE "C" ASC, e.row_type COLLATE "C" ASC, e.row_id COLLATE "C" ASC
      LIMIT ${selector.limit}
    `;

    return rows.map((r) => ({
      namespace: r.row_namespace,
      type: r.row_type,
      id: r.row_id,
      vector: parseVectorText(r.embedding),
      row: r.body
    }));
  }

  /**
   * Deletes every embedding whose backing row is missing or soft-deleted.
   * Needed because `embeddings` has no FK to `rows` and no
   * dataset delete path touches it; tombstones are terminal, so soft-deleted
   * rows are safe to collect immediately. Run as a sweep stage by the binary.
   *
   * @returns number of orphaned embeddings deleted.
   */
  async purgeOrphans(): Promise<number> {
    const sql = this.#sql as Sql;
    const result = await sql`
      DELETE FROM embeddings e
      WHERE NOT EXISTS (
        SELECT 1 FROM rows r
        WHERE r.namespace = e.row_namespace
          AND r.type      = e.row_type
          AND r.id        = e.row_id
          AND r.deleted_at IS NULL
      )
    `;
    return result.count;
  }
}

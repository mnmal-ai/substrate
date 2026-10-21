/**
 * Postgres-backed `LexicalStore` — `lexical` + `ts_rank` over its GIN
 * index. Counterpart to `PgEmbeddingsStore`.
 *
 * Search joins `rows` the same way the KNN path does, with the same
 * `deleted_at IS NULL` predicate, so a deleted row cannot surface through this
 * arm after it has stopped surfacing through the dense one.
 */

import type postgres from 'postgres';
import type {
  LexicalStore,
  LexicalStoreDeleteInput,
  LexicalStoreSearchInput,
  LexicalStoreSearchResult,
  LexicalStoreUpsertInput
} from './lexical-store.js';
import { ROW_BODY_SQL, rowFilterSql } from './pg-row-filter.js';

/** Hard ceiling on `k`, mirroring the embeddings store's cap. */
const MAX_K = 100;

export interface PgLexicalStoreOptions {
  /**
   * Text search configuration used to parse the QUERY. Must match the one
   * migration 0006 baked into the generated `tsv` column, or queries silently
   * match nothing.
   */
  textSearchConfig?: string;
}

interface SearchRow {
  row_namespace: string;
  row_type: string;
  row_id: string;
  body: Record<string, unknown>;
  score: number;
}

export class PgLexicalStore implements LexicalStore {
  readonly #sql: ReturnType<typeof postgres>;
  readonly #tsConfig: string;

  constructor(sql: ReturnType<typeof postgres>, opts: PgLexicalStoreOptions = {}) {
    this.#sql = sql;
    this.#tsConfig = opts.textSearchConfig ?? 'english';
  }

  async upsert(input: LexicalStoreUpsertInput): Promise<void> {
    // `tsv` is generated, so it is absent here by necessity rather than by
    // omission — postgres refuses an explicit value for a generated column.
    await this.#sql`
      INSERT INTO lexical (row_namespace, row_type, row_id, content, updated_at)
      VALUES (${input.rowNamespace}, ${input.rowType}, ${input.rowId}, ${input.text}, ${input.now ?? new Date()})
      ON CONFLICT (row_namespace, row_type, row_id)
      DO UPDATE SET content = EXCLUDED.content, updated_at = EXCLUDED.updated_at
      WHERE lexical.updated_at <= EXCLUDED.updated_at
    `;
  }

  async delete(input: LexicalStoreDeleteInput): Promise<void> {
    await this.#sql`
      DELETE FROM lexical
      WHERE row_namespace = ${input.rowNamespace}
        AND row_type      = ${input.rowType}
        AND row_id        = ${input.rowId}
    `;
  }

  /**
   * Deletes every lexical row whose backing row is missing or soft-deleted,
   * as `PgEmbeddingsStore.purgeOrphans` does for vectors: `lexical` has no FK
   * to `rows`, so a drop, purge or tombstone would otherwise leave the text.
   *
   * @returns number of orphaned lexical rows deleted.
   */
  async purgeOrphans(): Promise<number> {
    const result = await this.#sql`
      DELETE FROM lexical l
      WHERE NOT EXISTS (
        SELECT 1 FROM rows r
        WHERE r.namespace = l.row_namespace
          AND r.type      = l.row_type
          AND r.id        = l.row_id
          AND r.deleted_at IS NULL
      )
    `;
    return result.count;
  }

  async countIndexed(namespace: string, type: string): Promise<number> {
    // Same join + liveness predicate as search, so the count names rows
    // recall could return rather than orphaned index entries.
    const rows = (await this.#sql<Array<{ n: string }>>`
      SELECT COUNT(*) AS n
      FROM lexical l
      JOIN rows r
        ON r.namespace = l.row_namespace
       AND r.type      = l.row_type
       AND r.id        = l.row_id
      WHERE l.row_namespace = ${namespace}
        AND l.row_type      = ${type}
        AND r.deleted_at IS NULL
    `) as unknown as Array<{ n: string }>;
    return Number(rows[0]?.n ?? 0);
  }

  /**
   * Returns up to `k` live rows ranked by `ts_rank`. Matches ALL query terms
   * first; only if that finds nothing, retries matching ANY term.
   *
   * Two passes rather than always-OR: nothing downstream filters lexical hits
   * by threshold, so an OR pass that always ran would admit rows matching only
   * a common term. The fallback fires only where the strict pass found nothing.
   * Both passes apply `rowFilter`, so the fallback fires when no MATCHING row
   * carries every term.
   */
  async search(input: LexicalStoreSearchInput): Promise<LexicalStoreSearchResult[]> {
    const k = Math.min(Math.max(1, Math.trunc(input.k)), MAX_K);
    // `websearch_to_tsquery`, unlike `to_tsquery`, cannot raise a syntax
    // error on free text.
    const strict = await this.#run(input, k, false);
    if (strict.length > 0) return strict;
    return this.#run(input, k, true);
  }

  async #run(
    input: LexicalStoreSearchInput,
    k: number,
    degrade: boolean
  ): Promise<LexicalStoreSearchResult[]> {
    // The OR query rewrites the tsquery pg already parsed, so there is no
    // free text to escape and phrases (`<->`) survive.
    //
    // NULL when the query carries a negation: `'a' & !'b'` rewritten to
    // `'a' | !'b'` would match nearly every row instead of excluding `b`.
    const query = degrade
      ? this.#sql`(
          SELECT CASE
                   WHEN position('!' in t) > 0 THEN NULL
                   ELSE replace(t, ' & ', ' | ')::tsquery
                 END AS query
          FROM (SELECT websearch_to_tsquery(${this.#tsConfig}, ${input.query})::text AS t) s
        )`
      : this.#sql`websearch_to_tsquery(${this.#tsConfig}, ${input.query})`;

    const rows = (await this.#sql<SearchRow[]>`
      SELECT
        l.row_namespace,
        l.row_type,
        l.row_id,
        ${this.#sql.unsafe(ROW_BODY_SQL)} AS body,
        ts_rank(l.tsv, q.query)      AS score
      FROM lexical l
      CROSS JOIN ${query} AS q(query)
      JOIN rows r
        ON r.namespace = l.row_namespace
       AND r.type      = l.row_type
       AND r.id        = l.row_id
      WHERE l.row_namespace = ${input.namespace}
        AND l.row_type      = ${input.type}
        AND r.deleted_at IS NULL
        AND q.query IS NOT NULL
        AND l.tsv @@ q.query
        ${rowFilterSql(this.#sql, input.rowFilter)}
      ORDER BY score DESC, l.row_id ASC
      LIMIT ${k}
    `) as unknown as SearchRow[];

    return rows.map((r) => ({
      rowNamespace: r.row_namespace,
      rowType: r.row_type,
      rowId: r.row_id,
      row: r.body,
      score: r.score
    }));
  }
}

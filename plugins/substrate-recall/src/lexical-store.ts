import type { KnnRowFilter } from './embeddings-store.js';

/**
 * Storage seam for the lexical arm — the keyword half of recall.
 *
 * Separate from `EmbeddingsStore` because the two indexes are independent: a
 * row can be lexically indexed with no embedder configured, and vice versa.
 */

/** Identifies the row whose lexical text is being written. */
export interface LexicalStoreUpsertInput {
  rowNamespace: string;
  rowType: string;
  rowId: string;
  /** The text to index. Tokenisation is the store's business, not the caller's. */
  text: string;
  /**
   * When the source row was read for indexing; defaults to now. An upsert
   * older than the stored text is ignored, so a late write cannot restore
   * wording a newer one removed.
   */
  now?: Date;
}

/** Identifies the single lexical row a `delete` call removes. */
export interface LexicalStoreDeleteInput {
  rowNamespace: string;
  rowType: string;
  rowId: string;
}

/** A lexical search request. Scoped like `EmbeddingsStoreKnnInput`. */
export interface LexicalStoreSearchInput {
  /** Row scope. Callers know exactly one (namespace, type) at recall time. */
  namespace: string;
  type: string;
  /** Raw search text. Tokenisation is the store's business, not the caller's. */
  query: string;
  /** Max rows to return. */
  k: number;
  /**
   * Restrict candidates to rows whose fields match, applied INSIDE the search
   * (both the all-terms pass and the any-term fallback) so k fills with
   * matching rows. Same semantics as `EmbeddingsStoreKnnInput.rowFilter`.
   */
  rowFilter?: KnnRowFilter;
}

export interface LexicalStoreSearchResult {
  /**
   * Hit identity, carried explicitly so fusion can join against the dense arm
   * whether or not a row resolver is wired.
   */
  rowNamespace: string;
  rowType: string;
  rowId: string;
  /** The row body when a resolver is wired; `{}` otherwise. */
  row: Record<string, unknown>;
  /** Relevance, higher is better. Comparable WITHIN one search, not across. */
  score: number;
}

export interface LexicalStore {
  /**
   * Index one row's text, replacing whatever was indexed for it before.
   * Idempotent on (rowNamespace, rowType, rowId).
   */
  upsert(input: LexicalStoreUpsertInput): Promise<void>;

  /**
   * Remove one row's lexical text, so a row that becomes un-indexable stops
   * being findable. Idempotent — removing an absent row is not an error.
   */
  delete(input: LexicalStoreDeleteInput): Promise<void>;

  /**
   * Count indexed rows for one (namespace, type). The pg implementation counts
   * only rows recall could return (not soft-deleted); the in-memory store
   * counts entries.
   */
  countIndexed(namespace: string, type: string): Promise<number>;

  /**
   * Rank indexed rows against `query`, best first, capped at `k`.
   *
   * Scores are comparable only within one call; backends produce different
   * magnitudes. Fusion therefore consumes ranks, not scores.
   */
  search(input: LexicalStoreSearchInput): Promise<LexicalStoreSearchResult[]>;
}

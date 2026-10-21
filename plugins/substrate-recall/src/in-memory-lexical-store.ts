/**
 * Reference `LexicalStore` for tests and memory-backed deployments.
 *
 * Keyed `${rowNamespace}/${rowType}/${rowId}`; `search` scores in JS.
 *
 * Fidelity is deliberately partial: Postgres stems through
 * `to_tsvector('english', …)` ("travelling" matches "travel"), while this
 * store matches whole lowercased tokens only. Otherwise both backends run
 * AND-first with an OR fallback, so stemming is the only difference in which
 * rows they admit. Parity tests never assert on a stemmed match.
 */

import type { Dataset } from '@mnmal-ai/substrate-types';
import { type KnnRowFilter, matchesRowFilter } from './embeddings-store.js';
import type {
  LexicalStore,
  LexicalStoreDeleteInput,
  LexicalStoreSearchInput,
  LexicalStoreSearchResult,
  LexicalStoreUpsertInput
} from './lexical-store.js';
import { unresolvedRow } from './row-visibility.js';

/**
 * Resolves a row body, mirroring pg's join against `rows`.
 *
 * Signature matches `InMemoryEmbeddingsStoreOptions.datasetFor` deliberately:
 * a host wires both from the same registry lookup.
 */
export interface InMemoryLexicalStoreOptions {
  datasetFor?: (namespace: string) => Dataset | undefined;
}

/** No row resolver is wired, so the row body is unknown and cannot satisfy a filter. */
const UNRESOLVED = Symbol('unresolved');

interface Entry {
  rowNamespace: string;
  rowType: string;
  rowId: string;
  tokens: Set<string>;
  updatedAt: Date;
}

/** Lowercase, split on anything that is not a letter or digit, drop empties. */
function tokenise(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 0);
}

export class InMemoryLexicalStore implements LexicalStore {
  readonly #byKey = new Map<string, Entry>();
  readonly #opts: InMemoryLexicalStoreOptions;

  constructor(opts: InMemoryLexicalStoreOptions = {}) {
    this.#opts = opts;
  }

  #key(ns: string, type: string, id: string): string {
    return `${ns}/${type}/${id}`;
  }

  async upsert(input: LexicalStoreUpsertInput): Promise<void> {
    const k = this.#key(input.rowNamespace, input.rowType, input.rowId);
    const now = input.now ?? new Date();
    // An older write's text never replaces a newer one, as in pg.
    if ((this.#byKey.get(k)?.updatedAt ?? now) > now) return;
    this.#byKey.set(k, {
      rowNamespace: input.rowNamespace,
      rowType: input.rowType,
      rowId: input.rowId,
      tokens: new Set(tokenise(input.text)),
      updatedAt: now
    });
  }

  async delete(input: LexicalStoreDeleteInput): Promise<void> {
    this.#byKey.delete(this.#key(input.rowNamespace, input.rowType, input.rowId));
  }

  async countIndexed(namespace: string, type: string): Promise<number> {
    let n = 0;
    for (const entry of this.#byKey.values()) {
      if (entry.rowNamespace === namespace && entry.rowType === type) n++;
    }
    return n;
  }

  async search(input: LexicalStoreSearchInput): Promise<LexicalStoreSearchResult[]> {
    const terms = [...new Set(tokenise(input.query))];
    if (terms.length === 0) return [];

    const scored: Array<{ entry: Entry; score: number }> = [];
    for (const entry of this.#byKey.values()) {
      if (entry.rowNamespace !== input.namespace) continue;
      if (entry.rowType !== input.type) continue;
      // Count of DISTINCT query terms present. Deliberately not term frequency:
      // a row repeating one term is not a better answer to a two-term query
      // than a row carrying both.
      const score = terms.reduce((n, t) => n + (entry.tokens.has(t) ? 1 : 0), 0);
      if (score === 0) continue;
      scored.push({ entry, score });
    }

    // AND first, OR only if no matching row carried every term — the same two
    // passes pg runs, so the backends differ only in stemming.
    const full = scored.filter((s) => s.score === terms.length);
    const strict = await this.#take(full, input.k, input.rowFilter);
    if (strict.length > 0 || full.length === scored.length) return strict;
    return this.#take(scored, input.k, input.rowFilter);
  }

  /**
   * The best `k` of `pool` whose rows can be read and satisfy `filter`. Rows
   * are read in rank order and only until k are kept, so the filter applies
   * before the cut.
   */
  async #take(
    pool: Array<{ entry: Entry; score: number }>,
    k: number,
    filter: KnnRowFilter | undefined
  ): Promise<LexicalStoreSearchResult[]> {
    const ranked = [...pool].sort(
      (a, b) => b.score - a.score || a.entry.rowId.localeCompare(b.entry.rowId)
    );
    const out: LexicalStoreSearchResult[] = [];
    for (const { entry, score } of ranked) {
      if (out.length >= k) break;
      const row = await this.#readRow(entry.rowNamespace, entry.rowType, entry.rowId);
      // A wired resolver that cannot find the row means the row is deleted;
      // pg's INNER JOIN would drop it, so this drops it too.
      if (row === null) continue;
      if (filter !== undefined && (row === UNRESOLVED || !matchesRowFilter(row, filter))) continue;
      out.push({
        rowNamespace: entry.rowNamespace,
        rowType: entry.rowType,
        rowId: entry.rowId,
        row: row === UNRESOLVED ? unresolvedRow({}) : row,
        score
      });
    }
    return out;
  }

  /** The row, `null` when it is gone, or UNRESOLVED when no resolver is wired. */
  async #readRow(
    ns: string,
    type: string,
    id: string
  ): Promise<Record<string, unknown> | typeof UNRESOLVED | null> {
    const dataset = this.#opts.datasetFor?.(ns);
    if (dataset === undefined || dataset === null) return UNRESOLVED;
    const read = await dataset.read(type, { id });
    return (read.rows[0] as Record<string, unknown> | undefined) ?? null;
  }
}

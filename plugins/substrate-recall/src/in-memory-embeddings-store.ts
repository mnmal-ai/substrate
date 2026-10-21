/**
 * InMemoryEmbeddingsStore — non-persistent `EmbeddingsStore` for tests and
 * memory-backed deployments. `knnSearch` computes cosine similarity in JS,
 * O(N · D) per search, so it is not for production-scale recall. Row bodies
 * are materialized through the optional `datasetFor` resolver, mirroring
 * pg's join against `rows`.
 */

import type { Dataset, Row } from '@mnmal-ai/substrate-types';
import type { Candidate, CandidateSelector } from './candidate-selection.js';
import { cosineSimilarity } from './cosine.js';
import {
  type EmbeddingsStore,
  type EmbeddingsStoreDeleteInput,
  type EmbeddingsStoreFetchResult,
  type EmbeddingsStoreKnnInput,
  type EmbeddingsStoreKnnResult,
  type EmbeddingsStoreUpsertInput,
  matchesRowFilter,
  type SalienceTarget
} from './embeddings-store.js';
import { unresolvedRow } from './row-visibility.js';

/** A row with no dataset wired to read it from. */
const UNRESOLVED = Symbol('unresolved');

interface Entry {
  rowNamespace: string;
  rowType: string;
  rowId: string;
  vector: Float32Array;
  model: string;
  updatedAt: Date;
  /** Per-row salience signal. Mirrors `embeddings.salience`. */
  salience: number;
  /** When `salience` was last touched; used for lazy exponential decay. */
  salienceUpdatedAt: Date;
}

export interface InMemoryEmbeddingsStoreOptions {
  /**
   * Optional resolver for the dataset holding a (namespace, type)'s row
   * bodies. Without it, results carry a `{ id }` stub as their row.
   */
  datasetFor?: (rowNamespace: string, rowType: string) => Dataset | undefined;
  /** Override for tests. Defaults to incrementing instance counter. */
  txScopeId?: string;
}

let nextTxScopeId = 1;

function key(ns: string, type: string, id: string): string {
  return `${ns}/${type}/${id}`;
}

export class InMemoryEmbeddingsStore implements EmbeddingsStore {
  readonly txScopeId: string;
  readonly #entries = new Map<string, Entry>();
  readonly #datasetFor: InMemoryEmbeddingsStoreOptions['datasetFor'];

  constructor(opts: InMemoryEmbeddingsStoreOptions = {}) {
    this.txScopeId = opts.txScopeId ?? `mem-embeddings:${nextTxScopeId++}`;
    this.#datasetFor = opts.datasetFor;
  }

  async upsert(input: EmbeddingsStoreUpsertInput): Promise<void> {
    const k = key(input.rowNamespace, input.rowType, input.rowId);
    const existing = this.#entries.get(k);
    // Salience survives re-embed, as in pg. New rows start at 0.
    const now = input.now ?? new Date();
    // An older write's vector never replaces a newer one, as in pg.
    if (existing !== undefined && existing.updatedAt > now) return;
    this.#entries.set(k, {
      rowNamespace: input.rowNamespace,
      rowType: input.rowType,
      rowId: input.rowId,
      vector: input.vector,
      model: input.model,
      updatedAt: now,
      salience: existing?.salience ?? 0,
      salienceUpdatedAt: existing?.salienceUpdatedAt ?? now
    });
  }

  async delete(input: EmbeddingsStoreDeleteInput): Promise<void> {
    this.#entries.delete(key(input.rowNamespace, input.rowType, input.rowId));
  }

  /**
   * Materialize a row body via `datasetFor`, mirroring pg's join against
   * `rows`. Returns UNRESOLVED when no dataset is wired, and `null`
   * when the row is missing or deleted so the caller can exclude it.
   */
  async #readRow(
    namespace: string,
    type: string,
    id: string
  ): Promise<Record<string, unknown> | typeof UNRESOLVED | null> {
    const dataset = this.#datasetFor?.(namespace, type);
    if (dataset === undefined) return UNRESOLVED;
    const read = await dataset.read(type, { id });
    const found = read.rows[0];
    return found === undefined ? null : (found as Row);
  }

  async knnSearch(input: EmbeddingsStoreKnnInput): Promise<EmbeddingsStoreKnnResult[]> {
    const threshold = typeof input.threshold === 'number' ? input.threshold : 0;
    const candidates: Array<{ entry: Entry; score: number }> = [];
    for (const entry of this.#entries.values()) {
      if (entry.rowNamespace !== input.namespace) continue;
      if (entry.rowType !== input.type) continue;
      if (entry.model !== input.model) continue;
      const score = cosineSimilarity(entry.vector, input.vector);
      if (score < threshold) continue;
      candidates.push({ entry, score });
    }
    candidates.sort((a, b) => b.score - a.score);
    const limit = Math.max(1, Math.floor(input.k));

    // Walk candidates until k are filled rather than slice-then-read, so a
    // deleted row's slot goes to the next-best live candidate.
    const results: EmbeddingsStoreKnnResult[] = [];
    for (const { entry, score } of candidates) {
      if (results.length >= limit) break;
      const read = await this.#readRow(entry.rowNamespace, entry.rowType, entry.rowId);
      if (read === null) continue;
      // A row that cannot be read does not match a filter, as in the lexical store.
      if (
        input.rowFilter !== undefined &&
        (read === UNRESOLVED || !matchesRowFilter(read, input.rowFilter))
      ) {
        continue;
      }
      const row = read === UNRESOLVED ? unresolvedRow({ id: entry.rowId }) : read;
      results.push({
        row,
        score,
        salience: entry.salience,
        // Copy (not alias) so a caller mutating the result can't corrupt the
        // stored vector.
        ...(input.returnVector === true ? { vector: Array.from(entry.vector) } : {})
      });
    }
    return results;
  }

  async boostSalience(
    targets: ReadonlyArray<SalienceTarget>,
    halfLifeHours: number,
    bump = 1
  ): Promise<ReadonlyArray<SalienceTarget>> {
    if (targets.length === 0) return [];
    const now = new Date();
    const halfLifeMs = halfLifeHours * 3600 * 1000;
    const applied: SalienceTarget[] = [];
    for (const t of targets) {
      const entry = this.#entries.get(key(t.namespace, t.type, t.id));
      if (entry === undefined) continue;
      const elapsedMs = Math.max(0, now.getTime() - entry.salienceUpdatedAt.getTime());
      const decay = Math.exp((-Math.LN2 * elapsedMs) / halfLifeMs);
      entry.salience = entry.salience * decay + bump;
      entry.salienceUpdatedAt = now;
      applied.push({ namespace: t.namespace, type: t.type, id: t.id });
    }
    return applied;
  }

  async fetchEmbeddings(
    ids: ReadonlyArray<{ namespace: string; type: string; id: string }>,
    model: string
  ): Promise<ReadonlyArray<EmbeddingsStoreFetchResult>> {
    if (ids.length === 0) return [];
    const out: EmbeddingsStoreFetchResult[] = [];
    for (const ref of ids) {
      const entry = this.#entries.get(key(ref.namespace, ref.type, ref.id));
      if (entry === undefined) continue;
      if (entry.model !== model) continue;
      const dataset = this.#datasetFor?.(entry.rowNamespace, entry.rowType);
      let row: Record<string, unknown> = unresolvedRow({ id: entry.rowId });
      if (dataset !== undefined) {
        const read = await dataset.read(entry.rowType, { id: entry.rowId });
        const found = read.rows[0];
        // Deleted rows don't contribute to salience spread — parity with
        // pg's `r.deleted_at IS NULL` predicate on fetchEmbeddings.
        if (found === undefined) continue;
        row = found as Row;
      }
      out.push({
        namespace: entry.rowNamespace,
        type: entry.rowType,
        id: entry.rowId,
        row,
        vector: entry.vector.slice(),
        salience: entry.salience
      });
    }
    return out;
  }

  async selectCandidates(selector: CandidateSelector, model: string): Promise<Candidate[]> {
    const inScope = (ns: string, type: string): boolean =>
      selector.scopes.some((s) => s.namespace === ns && s.type === type);

    // Plain `<`/`>`, not `localeCompare`: ordering is part of the contract and
    // must agree with pg's `COLLATE "C"` byte order.
    const cmp = (x: string, y: string): number => (x < y ? -1 : x > y ? 1 : 0);
    const entries = Array.from(this.#entries.values())
      .filter((e) => e.model === model && inScope(e.rowNamespace, e.rowType))
      .sort(
        (a, b) =>
          cmp(a.rowNamespace, b.rowNamespace) || cmp(a.rowType, b.rowType) || cmp(a.rowId, b.rowId)
      );

    const out: Candidate[] = [];
    for (const e of entries) {
      if (out.length >= selector.limit) break;
      // A row #readRow cannot materialize is excluded, as pg's join excludes it.
      const read = await this.#readRow(e.rowNamespace, e.rowType, e.rowId);
      if (read === null) continue;
      const row = read === UNRESOLVED ? { id: e.rowId } : read;
      const excluded = selector.excludeTextPrefixes.some((ex) => {
        const value = row[ex.field];
        // Mirrors pg's `->>`: scalars are compared as text; absent and null
        // never match.
        if (value === undefined || value === null) return false;
        // Composites are never excluded, on either side: pg and JS render
        // them as text differently.
        const t = typeof value;
        if (t !== 'string' && t !== 'number' && t !== 'boolean') return false;
        return String(value).startsWith(ex.prefix);
      });
      if (excluded) continue;
      out.push({
        namespace: e.rowNamespace,
        type: e.rowType,
        id: e.rowId,
        vector: new Float32Array(e.vector),
        row
      });
    }
    return out;
  }
}

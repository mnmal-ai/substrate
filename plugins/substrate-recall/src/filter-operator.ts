/**
 * embeddingSimilarOperator — FilterOperatorDef that delegates vector recall
 * to EmbeddingsStore.knnSearch. Registered by the substrate-recall KernelPlugin
 * as the `embeddingSimilar` where-clause extension.
 *
 * Usage in a where clause:
 *   { embeddingSimilar: { to: 'jazz piano' } }
 *   { embeddingSimilar: { to: 'jazz piano', threshold: 0.4, k: 5 } }
 *   { embeddingSimilar: { to: 'jazz piano', where: { project: { eq: 'x' } } } }
 *
 * `where` scopes the search itself (eq / in on row fields). A
 * predicate elsewhere in the frame's where is applied AFTER the top-k, so in
 * a store shared by several projects it can come back empty.
 *
 * The operator embeds the query string via the configured Embedder, then
 * calls knnSearch on the EmbeddingsStore for the substrate's namespace/type.
 * The substrate handle carries `{ namespace, type, k?, returnVector? }` — the
 * engine threads this in from the query context (`ExtensionOpContext`).
 *
 * Returns `{ hits: [{ id, score, vector? }] }`, best first. `vector` is present
 * iff the substrate projects `_vector` and the store returned one. Hits with an
 * empty id are skipped: they cannot be stitched back by the `id IN` rewrite.
 *
 * It never boosts salience: a query frame is a read, and boosting is a write
 * gated by write policy on the recall and salience-boost routes. `boost: false`
 * is accepted as a no-op; `boost: true` is refused.
 */

import type { Embedder } from '@mnmal-ai/substrate-embedder';
import type { FilterOperatorDef } from '@mnmal-ai/substrate-types';
import { type EmbeddingsStore, type KnnRowFilter, rowFilterProblem } from './embeddings-store.js';
import { MAX_RECALL_QUERY_CHARS } from './recall/handler.js';

interface OperatorContext {
  namespace?: string;
  type?: string;
  /** Max rows. Falls back to a default of 50. Maps to EmbeddingsStoreKnnInput.k. */
  k?: number;
  /** Set by datasets when the frame projects `_vector`. */
  returnVector?: boolean;
}

/** Normalized operator value — exactly the provided keys (exactOptionalPropertyTypes). */
interface SimilarValue {
  to: string;
  threshold?: number;
  k?: number;
  /** Row-field scope applied inside the vector search. */
  where?: KnnRowFilter;
}

export interface EmbeddingSimilarOperatorDeps {
  embedder: Embedder;
  store: EmbeddingsStore;
}

export function embeddingSimilarOperator(deps: EmbeddingSimilarOperatorDeps): FilterOperatorDef {
  const { embedder, store } = deps;

  return {
    computedFields: ['_score', '_vector'],

    validate: (value) => {
      if (typeof value !== 'object' || value === null) {
        return { ok: false, reason: 'embeddingSimilar value must be an object' };
      }
      const v = value as {
        to?: unknown;
        threshold?: unknown;
        k?: unknown;
        boost?: unknown;
        where?: unknown;
      };
      if (typeof v.to !== 'string' || v.to.length === 0) {
        return { ok: false, reason: 'embeddingSimilar.to must be a non-empty string' };
      }
      if (v.to.length > MAX_RECALL_QUERY_CHARS) {
        return {
          ok: false,
          reason: `embeddingSimilar.to is longer than ${MAX_RECALL_QUERY_CHARS} characters`
        };
      }
      if (v.threshold !== undefined && typeof v.threshold !== 'number') {
        return { ok: false, reason: 'embeddingSimilar.threshold must be a number' };
      }
      if (v.where !== undefined) {
        const problem = rowFilterProblem(v.where);
        if (problem !== null) return { ok: false, reason: `embeddingSimilar.where ${problem}` };
      }
      if (v.k !== undefined && typeof v.k !== 'number') {
        return { ok: false, reason: 'embeddingSimilar.k must be a number' };
      }
      if (v.boost !== undefined && v.boost !== false) {
        return {
          ok: false,
          reason:
            'embeddingSimilar.boost: a query does not boost salience; use POST /substrate/v1/recall or /substrate/v1/salience/boost'
        };
      }
      const normalized: SimilarValue = {
        to: v.to,
        ...(v.threshold !== undefined ? { threshold: v.threshold } : {}),
        ...(v.k !== undefined ? { k: v.k } : {}),
        ...(v.where !== undefined ? { where: v.where as KnnRowFilter } : {})
      };
      return { ok: true, value: normalized };
    },

    execute: async (value, context) => {
      const v = value as SimilarValue;
      const handle = context as OperatorContext;

      if (handle.namespace === undefined || handle.type === undefined) {
        throw new Error(
          'embeddingSimilar requires operator context context to specify namespace + type'
        );
      }
      const namespace = handle.namespace;
      const type = handle.type;

      const k = Math.min(100, Math.max(1, Math.floor(v.k ?? handle.k ?? 50)));
      const queryVector = await embedder.embed(v.to);

      const results = await store.knnSearch({
        namespace,
        type,
        model: embedder.modelId,
        vector: queryVector,
        k,
        ...(typeof v.threshold === 'number' && v.threshold > 0 ? { threshold: v.threshold } : {}),
        ...(handle.returnVector === true ? { returnVector: true } : {}),
        ...(v.where !== undefined ? { rowFilter: v.where } : {})
      });

      const hits: Array<{ id: string; score: number; vector?: number[] }> = [];
      for (const r of results) {
        const id = String(r.row.id ?? '');
        if (id.length === 0) continue; // can't stitch by id
        hits.push({
          id,
          score: r.score,
          ...(r.vector !== undefined ? { vector: r.vector } : {})
        });
      }
      return { hits };
    }
  };
}

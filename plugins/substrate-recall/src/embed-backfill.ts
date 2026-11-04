/**
 * Re-embeds rows whose write-path embed failed or timed out. Such a row is
 * committed with no vector (or keeps a stale one), and nothing else retries it,
 * so without this pass it stays invisible to vector recall until a manual
 * reindex. Each embedded type is paged by row id across passes, so rows that
 * stay unembeddable (a null source) cannot starve the rest.
 */

import type { Dataset, Row } from '@mnmal-ai/substrate-types';
import type { EmbedSourceRegistry } from './embed-source-registry.js';
import type { EmbeddingsStore } from './embeddings-store.js';

export interface EmbedBackfillDeps {
  registry: EmbedSourceRegistry;
  store: EmbeddingsStore;
  resolveDataset: (namespace: string) => Dataset | null;
  /** Per-type resume point, `<ns>/<Type>` → last id seen. Owned by the caller across passes. */
  cursors: Map<string, string>;
  perTypeLimit: number;
}

export interface EmbedBackfillResult {
  embedded: number;
  unindexable: number;
  failed: number;
  /** Set when the embedder reported itself unavailable; the pass stopped there. */
  stopped?: string;
}

export async function runEmbedBackfill(deps: EmbedBackfillDeps): Promise<EmbedBackfillResult> {
  const result: EmbedBackfillResult = { embedded: 0, unindexable: 0, failed: 0 };
  const staleRowIds = deps.store.staleRowIds?.bind(deps.store);
  if (staleRowIds === undefined) return result;
  for (const { namespace, type } of deps.registry.types()) {
    const reembed = deps.registry.get(namespace, type)?.reembed;
    const dataset = deps.resolveDataset(namespace);
    if (reembed === undefined || dataset === null) continue;
    const key = `${namespace}/${type}`;
    const ids = await staleRowIds({
      namespace,
      type,
      afterId: deps.cursors.get(key) ?? '',
      limit: deps.perTypeLimit
    });
    // A short page reached the end of the type: start again from the top next pass.
    if (ids.length < deps.perTypeLimit) deps.cursors.delete(key);
    else deps.cursors.set(key, ids[ids.length - 1] as string);
    if (ids.length === 0) continue;
    // Re-read: the row may have changed since its embed failed.
    const { rows } = await dataset.read(type, { ids, limit: ids.length });
    for (const row of rows) {
      const outcome = await reembed(row as Row);
      if (outcome.status === 'embedded') result.embedded++;
      else if (outcome.status === 'unindexable') result.unindexable++;
      else if (outcome.status === 'failed') {
        result.failed++;
        if (outcome.code === 'unavailable') return { ...result, stopped: outcome.error };
      }
    }
  }
  return result;
}

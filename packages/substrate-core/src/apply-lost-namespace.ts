/**
 * Eager reconciler for lost namespaces. Spec: §6.4.
 *
 * Applies the declared policy to every edge pointing at a disposed namespace
 * now rather than at the next sweep, using the sweep's `applyPolicy` and its
 * cascade drain (§6.3). Idempotent: handled edges are tombstoned or stamped,
 * so a re-run is a no-op on them.
 */

import type { Edge, SweepDeps } from '@mnmal-ai/substrate-types';
import { applyPolicy } from './sweep.js';

export interface ApplyLostNamespaceOptions {
  batchSize?: number;
}

export interface ApplyLostNamespaceResult {
  affectedEdges: number;
}

const DEFAULT_BATCH_SIZE = 1000;

export async function applyLostNamespace(
  lostNs: string,
  deps: SweepDeps,
  opts: ApplyLostNamespaceOptions = {}
): Promise<ApplyLostNamespaceResult> {
  const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;

  const processedEdgeIds = new Set<string>();
  const cascadeQueue: Edge[] = [];
  // Cascade fan-out produces edges pointing at the newly-tombstoned `from`
  // row, which is in a DIFFERENT namespace from the lost one. Those still
  // need their policy applied — that's the whole point of cascade — so we
  // mark cascaded ids as pre-approved and skip the `to.ns === lostNs` gate.
  const cascadedFromFanout = new Set<string>();
  let affectedEdges = 0;
  let cursor: string | null = null;

  // Outer paging loop: readNextBatch advances by edge.id; exhaustion returns
  // an empty batch and we bail. We do NOT wrap the cursor to null like the
  // sweep does — this is a one-shot pass, not a steady-state reconciler.
  while (true) {
    const batch = await deps.edges.readNextBatch(cursor, batchSize);
    if (batch.edges.length === 0) break;

    const worklist: Edge[] = [...batch.edges];

    // Inner drain: fold cascade fan-out into the same worklist, dedupe by id.
    // Mirrors the sweep's drain so a lost-ns cascade that fans out completes
    // in one pass.
    while (worklist.length > 0) {
      const edge = worklist.shift();
      if (!edge) break;
      if (processedEdgeIds.has(edge.id)) continue;
      processedEdgeIds.add(edge.id);
      if (edge.deletedAt !== undefined) continue;
      // Base-batch gate: only edges pointing at the lost ns are eligible.
      // Cascaded edges (fan-out from a prior applyPolicy) bypass the gate so
      // the cascade chain completes.
      const isBaseBatchCandidate = edge.to.ns === lostNs;
      const isFanoutCandidate = cascadedFromFanout.has(edge.id);
      if (!isBaseBatchCandidate && !isFanoutCandidate) continue;

      await applyPolicy(edge, cascadeQueue, deps);
      affectedEdges++;

      if (cascadeQueue.length > 0) {
        const inflight = new Set<string>([...worklist.map((e) => e.id), ...processedEdgeIds]);
        for (const e of cascadeQueue) {
          // Mark as cascaded BEFORE the inflight check: an edge already in
          // the worklist (or just processed) originated from the base batch,
          // where the `to.ns === lostNs` gate would skip it. Promoting it
          // into the cascade-approved set ensures the subsequent visit (or a
          // re-queue below) processes it.
          cascadedFromFanout.add(e.id);
          if (inflight.has(e.id)) continue;
          worklist.push(e);
        }
        cascadeQueue.length = 0;
      }
    }

    cursor = batch.lastId;
    if (cursor === null) break;
  }

  deps.metric('namespace_lost_applied', { ns: lostNs, affectedEdges });
  return { affectedEdges };
}

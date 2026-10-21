/**
 * Two-phase delete outer entry. Spec: §6.2 Phase 0 + Phase 1.
 *
 * This is the verb the server calls when an outer mutation issues a delete.
 * It does NOT propagate to incoming edges — Phase 2 (propagation) is the
 * sweep's job. Local-sync drain is a seam the server can wire up separately by
 * calling the same `applyPolicy` helper over `findEdgesTo(ref)`; this module
 * deliberately stays narrow so the outer path is auditable in one file.
 */

import type { Dataset, EdgeRef, EdgesStore } from '@mnmal-ai/substrate-types';
import { RestrictViolation } from '@mnmal-ai/substrate-types';

export interface DeleteRowArgs {
  dataset: Dataset;
  edges: EdgesStore;
  ref: EdgeRef;
  now: () => Date;
}

export interface DeleteRowResult {
  ok: true;
  tombstonedAt: Date;
}

export async function deleteRow(args: DeleteRowArgs): Promise<DeleteRowResult> {
  const gate = await args.edges.canDelete(args.ref);
  if (!gate.ok) {
    throw new RestrictViolation(args.ref, gate.blockedBy);
  }

  await args.dataset.tombstone(args.ref.type, [args.ref.id]);
  return { ok: true, tombstonedAt: args.now() };
}

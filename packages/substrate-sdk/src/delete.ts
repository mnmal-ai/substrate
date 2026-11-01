/**
 * Two-phase delete outer entry. Spec: §6.2 Phase 0 + Phase 1.
 *
 * This is the verb the server calls when an outer mutation issues a delete.
 * It does NOT propagate to incoming edges — Phase 2 (propagation) is the
 * sweep's job. Local-sync drain is a seam the server can wire up separately by
 * calling the same `applyPolicy` helper over `findEdgesTo(ref)`; this module
 * deliberately stays narrow so the outer path is auditable in one file.
 */

import type { Dataset, Edge, EdgeRef, EdgesStore, Id } from '@mnmal-ai/substrate-types';
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

export interface DeleteRowsArgs {
  dataset: Dataset;
  edges: EdgesStore;
  type: string;
  ids: Id[];
}

/**
 * `deleteRow` for many rows of one type in the dataset's namespace: one
 * `findEdgesToMany` gates them all, then one `tombstone` call. Throws
 * `RestrictViolation` for the first id, in `ids` order, that a live `restrict`
 * edge blocks, before tombstoning anything. Returns the ids tombstoned.
 */
export async function deleteRows(args: DeleteRowsArgs): Promise<Id[]> {
  if (args.ids.length === 0) return [];
  const refs: EdgeRef[] = args.ids.map((id) => ({
    ns: args.dataset.namespace,
    type: args.type,
    id
  }));
  const blocked = new Map<string, Edge[]>();
  for (const e of await args.edges.findEdgesToMany(refs)) {
    if (e.policy !== 'restrict' || e.deletedAt != null) continue;
    const key = String(e.to.id);
    blocked.set(key, [...(blocked.get(key) ?? []), e]);
  }
  for (const ref of refs) {
    const by = blocked.get(String(ref.id));
    if (by !== undefined) throw new RestrictViolation(ref, by);
  }
  const { ids } = await args.dataset.tombstone(args.type, args.ids);
  return ids;
}

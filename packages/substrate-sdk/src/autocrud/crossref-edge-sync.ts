/**
 * CrossRef edge reconciliation for the update path.
 *
 * The create path (`createResolverWithEdges`) writes a first-class
 * `EdgesStore` edge per crossRef value; without reconciliation a repointed
 * crossRef would leave the stale edge (which the sweep's `applyPolicy` walks
 * for `onDelete`) aimed at the old target. `EdgesStore.write` always inserts a
 * fresh edge and `to`/`policy` are immutable on `EdgesStore.update`, so
 * repointing means tombstone the stale edge(s) + write a new one.
 */

import type { Edge, EdgeRef, EdgesStore, EdgeWriteInput } from '@mnmal-ai/substrate-types';
import type { CrossRefFieldInfo } from './crossref-existence.js';

/**
 * Reconcile first-class edges against an update patch. For every crossRef
 * field that is a KEY in `patchParams` (a field simply absent from the patch
 * is left untouched — partial updates must not churn edges for fields the
 * caller never mentioned), this tombstones the field's current live edge(s)
 * and writes a fresh edge at the new target when the target actually changed.
 * A no-op repoint (same target, or clearing an already-null field) is
 * detected and skipped so a no-change update doesn't churn edge history.
 */
export async function reconcileCrossRefEdgesOnUpdate(
  edges: EdgesStore,
  fromRef: EdgeRef,
  crossRefs: readonly CrossRefFieldInfo[],
  patchParams: Record<string, unknown>
): Promise<void> {
  if (!crossRefs.some(({ fieldName }) => Object.hasOwn(patchParams, fieldName))) return;
  const plan = planCrossRefEdges(
    await edges.findEdgesFrom(fromRef),
    fromRef,
    crossRefs,
    patchParams
  );
  await edges.tombstoneMany(plan.tombstone);
  await edges.writeMany(plan.write);
}

/**
 * The edge changes one update patch needs, given the owner's live outbound
 * edges: the stale edge ids to tombstone and the fresh edges to write. Pure,
 * so a batch plans every element from one `findEdgesFromMany` and applies them
 * with one `tombstoneMany` and one `writeMany`.
 */
export function planCrossRefEdges(
  currentEdgesFromOwner: readonly Edge[],
  fromRef: EdgeRef,
  crossRefs: readonly CrossRefFieldInfo[],
  patchParams: Record<string, unknown>
): { tombstone: string[]; write: EdgeWriteInput[] } {
  const plan: { tombstone: string[]; write: EdgeWriteInput[] } = { tombstone: [], write: [] };
  for (const { fieldName, def } of crossRefs) {
    if (!Object.hasOwn(patchParams, fieldName)) continue;
    const rawValue = patchParams[fieldName];
    const newId: string | number | null =
      typeof rawValue === 'string' || typeof rawValue === 'number' ? rawValue : null;

    const currentEdges = currentEdgesFromOwner.filter((e) => e.fieldName === fieldName);
    const currentId = currentEdges[0]?.to.id ?? null;

    // Only a single (or zero) current edge can be "unchanged" — with 2+ live
    // edges for one (from, fieldName) the invariant is already broken, so
    // always reconcile (tombstone all + write one) to self-heal, even when
    // the new value happens to match the first duplicate's target.
    const unchanged =
      currentEdges.length <= 1 &&
      (currentId === null ? newId === null : newId !== null && String(currentId) === String(newId));
    if (unchanged) continue;

    for (const edge of currentEdges) plan.tombstone.push(edge.id);
    if (newId !== null) {
      plan.write.push({
        from: fromRef,
        to: { ns: def.ns, type: def.type, id: newId },
        fieldName,
        policy: def.onDelete
      });
    }
  }
  return plan;
}

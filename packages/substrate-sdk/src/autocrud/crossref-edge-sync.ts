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

import type { EdgeRef, EdgesStore } from '@mnmal-ai/substrate-types';
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
  const touched = crossRefs.filter(({ fieldName }) => Object.hasOwn(patchParams, fieldName));
  if (touched.length === 0) return;

  // All crossRef fields share the same from-ref, so one lookup serves them all.
  const currentEdgesFromOwner = await edges.findEdgesFrom(fromRef);

  // Distinct fieldNames map to distinct edges, so each field's reconcile is
  // independent — run them concurrently, mirroring how
  // `createResolverWithEdges` parallelizes its per-field edge writes.
  await Promise.all(
    touched.map(async ({ fieldName, def }) => {
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
        (currentId === null
          ? newId === null
          : newId !== null && String(currentId) === String(newId));
      if (unchanged) return;

      for (const edge of currentEdges) {
        await edges.tombstone(edge.id);
      }
      if (newId !== null) {
        await edges.write({
          from: fromRef,
          to: { ns: def.ns, type: def.type, id: newId },
          fieldName,
          policy: def.onDelete
        });
      }
    })
  );
}

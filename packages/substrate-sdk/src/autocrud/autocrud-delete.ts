/**
 * autoCRUD `delete<T>` resolver. Spec: §5.1, §6.2 (Phase 0 + Phase 1).
 *
 * Uses `deleteRow` from this package (`../delete.js`) so the Phase 0 restrict
 * gate and the Phase 1 dataset.tombstone fire together. `RestrictViolation` is
 * propagated — the engine's mutate dispatcher catches it and surfaces it as an
 * envelope error without rolling back the surrounding frame (restrict is a
 * refusal, not a substrate failure).
 *
 * Cross-store atomicity caveat (§6.2): the dataset tombstone runs inside the
 * frame's transaction (via `args.dataset`). On pg the edges store is enlisted in
 * the same transaction; an edges store that is not (e.g. `MemoryEdgesStore`)
 * can see a visibility-ordering quirk on rollback, never data loss —
 * `applyPolicy` (§6.3) is idempotent and the sweep retries every cycle.
 */

import type {
  Dataset,
  EdgeRef,
  EdgesStore,
  Id,
  TypedResolver,
  WriteEvent
} from '@mnmal-ai/substrate-types';
import { ResolverFrameError } from '@mnmal-ai/substrate-types';
import { deleteRow } from '../delete.js';
import { resolveEntityId } from '../short-id-resolver.js';
import { coerceId, rejectUnknownParams } from './internal.js';

const KNOWN_DELETE_PARAMS: ReadonlySet<string> = new Set(['id']);

/**
 * Delete resolver return shape. Carries the row's string index signature so
 * it slots into `Row` (which has `[field: string]: unknown`) without cast
 * gymnastics — the autoCRUD registration path wants the common `Row | Row[]`
 * return type.
 */
export interface DeleteResolverResult {
  id: Id;
  deleted: boolean;
  [field: string]: unknown;
}

export function deleteResolver(
  typeName: string,
  dataset: Dataset,
  edges: EdgesStore
): TypedResolver<DeleteResolverResult> {
  return async (_ctx, args) => {
    rejectUnknownParams('delete', typeName, args.params, KNOWN_DELETE_PARAMS);
    // Prefer engine-supplied handles so the tx view and the engine's edges
    // store take precedence. Closed-over values are a fallback for direct-call
    // tests.
    const ds = args.dataset ?? dataset;
    const edgeStore = args.edges ?? edges;
    const id = coerceId(args.params?.id);
    if (id === undefined) {
      throw new ResolverFrameError(
        'missing_id',
        `deleteResolver('${typeName}'): params.id is required`,
        { field: 'id' }
      );
    }

    // Resolve short-form (e.g. "1") to the underlying row id. If both raw and
    // short-form lookups miss, return { deleted: false }.
    const rowId = await resolveEntityId(ds, typeName, id);
    if (rowId === null) return { id, deleted: false };

    const ref: EdgeRef = { ns: ds.namespace, type: typeName, id: rowId };

    // Detect whether the row existed BEFORE the delete — matches the
    // dataset.tombstone semantic of `{ deleted: 0, ids: [] }` for a missing
    // row. We need this because `deleteRow` returns `{ ok: true }` whether the
    // row was there or not (the dataset swallows missing ids silently).
    const { rows: existing } = await ds.read(typeName, { id: rowId });
    if (existing.length === 0) {
      return { id, deleted: false };
    }

    await deleteRow({ dataset: ds, edges: edgeStore, ref, now: () => new Date() });
    // §5.4 subscription hook — emit the pre-tombstone snapshot so the bus can
    // filter-test and emit `remove` for matching subscriptions. Post-commit
    // tombstones no longer satisfy any where-clause, so the engine collapses
    // every live subscription hit into a `remove` regardless of the row's
    // field values. `existing[0]` is guaranteed non-undefined because we
    // short-circuited on `existing.length === 0` above; exactOptionalProperty
    // forbids surfacing `undefined` as the `row` field, so we build the event
    // conditionally.
    const preRow = existing[0];
    if (args.onWrite !== undefined) {
      const event: WriteEvent = {
        ns: ds.namespace,
        type: typeName,
        id: rowId,
        operation: 'delete',
        ...(preRow !== undefined ? { row: preRow } : {})
      };
      args.onWrite(event);
    }
    return { id: rowId, deleted: true };
  };
}

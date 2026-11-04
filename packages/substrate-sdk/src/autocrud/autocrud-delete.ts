/**
 * autoCRUD `delete<T>` resolver. Spec: §5.1, §6.2 (Phase 0 + Phase 1).
 *
 * The resolvers live in `batch.ts`: the single-frame resolver is the batch
 * resolver called with one element. Both use `deleteRows` (`../delete.js`) so
 * the Phase 0 restrict gate and the Phase 1 dataset.tombstone fire together,
 * once per batch. `RestrictViolation` is
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

import type { Id } from '@mnmal-ai/substrate-types';
import { ResolverFrameError } from '@mnmal-ai/substrate-types';
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

/**
 * One delete element's validation: returns the requested id or throws the
 * element's refusal. The single and batch delete resolvers both call it.
 */
export function prepareDelete(typeName: string, params: Record<string, unknown> | undefined): Id {
  rejectUnknownParams('delete', typeName, params, KNOWN_DELETE_PARAMS);
  const id = coerceId(params?.id);
  if (id === undefined) {
    throw new ResolverFrameError(
      'missing_id',
      `deleteResolver('${typeName}'): params.id is required`,
      { field: 'id' }
    );
  }
  return id;
}

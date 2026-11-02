/**
 * autoCRUD `update<T>` resolver. Spec: §5.1, §5.2.1 (id-based form).
 *
 * Shape: `params = { id, ...newFields }`. The resolvers live in `batch.ts`:
 * the single-frame resolver is the batch resolver called with one element,
 * and a batch applies every patch with one live-only `patchRows`, which
 * preserves createdAt/createdBy and returns the merged rows.
 * Runs inside the engine's G1 transaction via `args.dataset` — a mid-update
 * throw rolls back the frame.
 *
 * `_deletedAt` in params throws `ReservedField` before the write: the dataset's
 * write path would silently strip it, so the throw is the only way callers
 * learn they supplied a forbidden key.
 *
 * Filter-based update (`update<T>({ where }, { ...newFields })`) is spec
 * §5.2.1 and out of scope here.
 */

import type {
  Dataset,
  FieldDef,
  Id,
  RequestContext,
  ResolverArgs,
  Row
} from '@mnmal-ai/substrate-types';
import { normaliseVocabValues, ReservedField, ResolverFrameError } from '@mnmal-ai/substrate-types';
import {
  assertEnumValues,
  assertNoClientServerFields,
  assertNoNullOnNonNullable,
  assertNoUnknownFields,
  assertScalarTypes,
  coerceId,
  dropUndefinedParams,
  resolveIdentity
} from './internal.js';

export interface UpdateResolverOptions {
  /** Type field definitions. Used to reject client-supplied server fields. */
  fields?: Record<string, FieldDef>;
}

/**
 * The trusted write-tail of an id-based update: applies the whole patch to
 * the live row in one round-trip, stamping updatedAt/updatedBy, and emits
 * the §5.4 onWrite event when a row actually landed. Returns null when the
 * row is missing or tombstoned.
 *
 * `updateResolver` delegates here after its guards; custom system-stamped
 * resolvers (e.g. a status transition such as `approveRequest`) call it
 * directly with an already-resolved row id. It deliberately runs NO
 * client-field guards — that is what lets a system writer stamp serverSet
 * fields like `approvedAt`. Callers own validation and permission
 * checks; this owns the metadata idiom so it stays single-sourced.
 */
export async function applyUpdatePatch(
  ds: Dataset,
  typeName: string,
  rowId: Id,
  patchFields: Record<string, unknown>,
  ctx: RequestContext,
  onWrite?: ResolverArgs['onWrite']
): Promise<Row | null> {
  // Live rows only: a row tombstoned or purged since the caller resolved its
  // id matches nothing, so an update can never revive or re-create it.
  // conditionalUpdate bumps updatedAt + updatedBy and preserves createdAt +
  // createdBy.
  const { row: merged } = await ds.conditionalUpdate(
    typeName,
    rowId,
    {},
    patchFields,
    resolveIdentity(ctx),
    ctx.now
  );
  if (merged === null) return null;

  onWrite?.({
    ns: ds.namespace,
    type: typeName,
    id: merged.id,
    operation: 'update',
    row: merged
  });
  return merged;
}

/**
 * One update element's validation, run in JS before any write: returns the
 * requested id and the normalised params (the patch plus `id`). Throws the
 * element's refusal. The single and batch update resolvers both call it, so
 * the checks exist once.
 */
export function prepareUpdate(
  typeName: string,
  rawParams: Record<string, unknown> | undefined,
  fields: Record<string, FieldDef> | undefined
): { id: Id; params: Record<string, unknown> } {
  const id = coerceId(rawParams?.id);
  if (id === undefined) {
    throw new ResolverFrameError(
      'missing_id',
      `updateResolver('${typeName}'): params.id is required`,
      { field: 'id' }
    );
  }

  // Reject client-supplied server fields (Tier-1: row metadata;
  // Tier-2: serverSet date fields). Runs before field iteration so the error
  // code is unambiguous.
  if (fields) {
    assertNoClientServerFields(rawParams ?? {}, fields, 'update');
  }

  // Synonyms in a governed vocabulary are stored as their canonical value.
  // An undefined value is an unsent key in a partial patch, not a write.
  const sent = dropUndefinedParams(rawParams ?? {});
  const params = fields !== undefined ? normaliseVocabValues(sent, fields) : sent;

  // Reserved-field guard: `_deletedAt` must never flow through update —
  // tombstone is the only safe path. Throw before any DB work.
  if ('_deletedAt' in params) {
    throw new ReservedField('_deletedAt');
  }

  if (fields) {
    // Controlled-vocabulary guard. Runs after reserved-field guards so those
    // error codes take precedence. Only the patch's present keys are checked.
    assertEnumValues(params, fields);
    // Contract guard: the declared FieldDef map is the allow-list. Reject any
    // undeclared key in the patch so a stale field name fails loud instead of
    // being spread into the row body. Runs after the reserved-field / enum
    // guards so they keep their more-specific codes.
    assertNoUnknownFields(params, fields, 'update');
    assertNoNullOnNonNullable(params, fields, 'update');
    assertScalarTypes(params, fields, 'update');
  }
  return { id, params };
}

/**
 * The reported miss of an update: a null result beside empty `errors` reads
 * exactly like a write that landed. `get` still returns null — asking about a
 * missing row has a true answer; asserting a write against one does not.
 */
export function updateNotFound(typeName: string, id: Id): ResolverFrameError {
  return new ResolverFrameError(
    'not_found',
    `updateResolver('${typeName}'): no row with id '${String(id)}'`,
    { field: 'id' }
  );
}

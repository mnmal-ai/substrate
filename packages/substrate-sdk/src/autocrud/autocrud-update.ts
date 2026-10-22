/**
 * autoCRUD `update<T>` resolver. Spec: §5.1, §5.2.1 (id-based form).
 *
 * Shape: `params = { id, ...newFields }`. One `conditionalUpdate()` per
 * update against the live row: it preserves createdAt/createdBy (no
 * pre-read) and returns the merged row (no post-read).
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
  EdgesStore,
  FieldDef,
  Id,
  RequestContext,
  ResolverArgs,
  Row,
  TypedResolver
} from '@mnmal-ai/substrate-types';
import { normaliseVocabValues, ReservedField, ResolverFrameError } from '@mnmal-ai/substrate-types';
import { resolveEntityId } from '../short-id-resolver.js';
import { reconcileCrossRefEdgesOnUpdate } from './crossref-edge-sync.js';
import { assertCrossRefTargetsExist, collectCrossRefFields } from './crossref-existence.js';
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

export function updateResolver<T extends Row = Row>(
  typeName: string,
  dataset: Dataset,
  edges: EdgesStore,
  options: UpdateResolverOptions = {}
): TypedResolver<T | null> {
  const crossRefs = collectCrossRefFields(options.fields);

  return async (ctx, args) => {
    // Prefer engine-supplied handle (tx view on mutate — matches G1 contract).
    const ds = args.dataset ?? dataset;
    const id = coerceId(args.params?.id);
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
    if (options.fields) {
      assertNoClientServerFields(args.params ?? {}, options.fields, 'update');
    }

    // Synonyms in a governed vocabulary are stored as their canonical value.
    // An undefined value is an unsent key in a partial patch, not a write.
    const sent = dropUndefinedParams(args.params ?? {});
    const inParams =
      options.fields !== undefined ? normaliseVocabValues(sent, options.fields) : sent;

    // Reserved-field guard: `_deletedAt` must never flow through update —
    // tombstone is the only safe path. Throw before any DB work.
    if ('_deletedAt' in inParams) {
      throw new ReservedField('_deletedAt');
    }

    // Controlled-vocabulary guard. Runs after reserved-field guards so those
    // error codes take precedence. Only the patch's present keys are checked.
    if (options.fields) {
      assertEnumValues(inParams, options.fields);
    }

    // Contract guard: the declared FieldDef map is the allow-list. Reject any
    // undeclared key in the patch so a stale field name fails loud instead of
    // being spread into the row body. Runs LAST so the reserved-field / enum
    // guards keep their more-specific codes.
    if (options.fields) {
      assertNoUnknownFields(inParams, options.fields, 'update');
      assertNoNullOnNonNullable(inParams, options.fields, 'update');
      assertScalarTypes(inParams, options.fields, 'update');
    }

    // Resolve short-form (e.g. "1") to the underlying row id.
    //
    // A MISS IS REPORTED, not swallowed: a null result beside empty `errors`
    // reads exactly like a write that landed. `get` still returns null — asking
    // about a missing row has a true answer; asserting a write against one
    // does not.
    const rowId = await resolveEntityId(ds, typeName, id);
    if (rowId === null) {
      throw new ResolverFrameError(
        'not_found',
        `updateResolver('${typeName}'): no row with id '${String(id)}'`,
        { field: 'id' }
      );
    }

    // Refuse repointing a crossRef to a missing target (unless the field
    // declares onMissing: 'allow'). Runs after the row-existence check so an
    // update to a non-existent row reports `not_found` first.
    const params = inParams;
    await assertCrossRefTargetsExist(args, crossRefs, params, ds.namespace);

    // Single ds.write carries the whole patch + bumps metadata atomically
    // (the COALESCE idiom lives in applyUpdatePatch).
    const patchFields: Record<string, unknown> = {};
    for (const [field, value] of Object.entries(params)) {
      if (field === 'id') continue;
      patchFields[field] = value;
    }
    const merged = await applyUpdatePatch(ds, typeName, rowId, patchFields, ctx, args.onWrite);
    if (merged === null) {
      throw new ResolverFrameError(
        'not_found',
        `updateResolver('${typeName}'): no row with id '${String(id)}'`,
        { field: 'id' }
      );
    }
    if (crossRefs.length > 0) {
      // Reconcile first-class edges against the patch — the row write above
      // only touches the stored field value; a repointed
      // crossRef otherwise leaves the old edge live, and the sweep's
      // applyPolicy fires onDelete against the stale target. Runs after the
      // row write commits so a mid-reconcile throw doesn't leave the row
      // patched with no edge (the engine's G1 transaction still unwinds the
      // whole frame on throw, edges included).
      const edgeStore = args.edges ?? edges;
      const fromRef = { ns: ds.namespace, type: typeName, id: rowId };
      await reconcileCrossRefEdgesOnUpdate(edgeStore, fromRef, crossRefs, params);
    }
    return merged as T;
  };
}

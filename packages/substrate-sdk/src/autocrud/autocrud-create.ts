/**
 * autoCRUD `create<T>` resolver. Spec: §5.1.
 *
 * Accepts the entity body via `params`. When `id` is absent the dataset
 * assigns a version-7 UUID from its own clock and the resolver takes it from
 * the write result. `_deletedAt` is stripped at the dataset layer.
 *
 * When `options.fields` is supplied, any field with `readonly: true` is
 * rejected if the caller includes it in params — shortId is the primary use
 * case. The engine allocates shortId post-write and binds
 * it in the same transaction via `ds.allocateShortIds` / `ds.bindShortIds`.
 *
 * The resolvers live in `batch.ts`: the single-frame resolver is the batch
 * resolver called with one element, and both validate with `prepareCreateRow`.
 */

import type { FieldDef, WriteRow } from '@mnmal-ai/substrate-types';
import { normaliseVocabValues } from '@mnmal-ai/substrate-types';
import {
  applyScalarDefaults,
  assertEnumValues,
  assertNoClientServerFields,
  assertNoNullOnNonNullable,
  assertNoReadonlyFields,
  assertNoUnknownFields,
  assertRequiredFields,
  assertScalarTypes,
  coerceId,
  dropUndefinedParams
} from './internal.js';

/**
 * One create element's validation, run in JS before any write: returns the
 * row to insert, without `_metadata`, and with no `id` when the dataset is to
 * assign one. Throws the element's refusal. The single and batch create
 * resolvers both call it, so the checks exist once.
 */
export function prepareCreateRow(
  rawParams: Record<string, unknown> | undefined,
  fields: Record<string, FieldDef> | undefined
): WriteRow {
  // Own a shallow copy — applyScalarDefaults mutates it to fill omitted
  // defaults, and the caller's bag must not be mutated out from under them.
  const params = dropUndefinedParams(rawParams ?? {});

  if (fields) {
    // Reject client-supplied server fields (Tier-1: row metadata;
    // Tier-2: serverSet date fields). Must run before any other validation so
    // the error code is unambiguous.
    assertNoClientServerFields(params, fields, 'create');

    assertNoReadonlyFields(params, fields);

    // Controlled-vocabulary guard. Runs after readonly/server-field checks so
    // their codes take precedence; covers memory + pg uniformly.
    Object.assign(params, normaliseVocabValues(params, fields));
    assertEnumValues(params, fields);

    // Contract guard: the declared FieldDef map is the allow-list. Reject any
    // undeclared top-level key so a typo or stale field name fails loud instead
    // of being silently spread into the row body. Runs after the readonly /
    // server-field / enum guards so they keep their more-specific codes.
    assertNoUnknownFields(params, fields, 'create');

    // Fill create-time defaults, then enforce required scalars. A `default`
    // makes omission legitimate (e.g. archived → false); a non-nullable scalar
    // with neither a supplied value nor a default is required, and its absence
    // fails loud (`missing_required_field`) rather than writing a partial row.
    assertNoNullOnNonNullable(params, fields, 'create');
    assertScalarTypes(params, fields, 'create');
    applyScalarDefaults(params, fields);
    assertRequiredFields(params, fields);
  }

  // Omitted (or not a string/number): the dataset assigns the id.
  const { id: rawId, ...body } = params;
  const id = coerceId(rawId);
  return id === undefined ? body : { ...body, id };
}

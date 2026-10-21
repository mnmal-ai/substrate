/**
 * Shared plan-cache primitives for the positional encoder + decoder. Spec §7.2.
 *
 * Each codec passes its own cache instance and error factory; the error
 * classes live in their respective modules. Package-internal — not exported
 * from `index.ts`.
 */

import type { FieldDef, FieldInput, Schema } from '@mnmal-ai/substrate-types';

/**
 * Per-row decode/encode plan. One entry per selected field: name, the
 * FieldInput sub-selection (`true` for scalar/crossRef leaves, nested
 * FieldInput for struct/list), and the resolved FieldDef from the type's
 * fieldMap (undefined for fields not declared in the schema — both codecs
 * permit pass-through for those).
 */
export type RowPlan = Array<readonly [string, true | FieldInput, FieldDef | undefined]>;

/**
 * Per-struct field-def plan. One entry per declared field: name + FieldDef.
 * Used when encoding/decoding without a caller-supplied FieldInput selection
 * (e.g. struct fields under a list arm).
 */
export type FieldDefPlan = Array<readonly [string, FieldDef]>;

/**
 * Per-(FieldInput, fieldMap) cache. Two-level WeakMap so plans are GC'd when
 * either the selection object or the fieldMap is dropped. Each codec owns its
 * own instance to avoid cross-codec cache poisoning.
 */
export type RowPlanCache = WeakMap<FieldInput, WeakMap<Record<string, FieldDef>, RowPlan>>;

export type FieldDefPlanCache = WeakMap<Record<string, FieldDef>, FieldDefPlan>;

/**
 * Lookup-or-build the per-(fields, fieldMap) plan. O(1) on hit; O(F) on miss
 * for F selected fields.
 */
export function getRowPlan(
  cache: RowPlanCache,
  fields: FieldInput,
  fieldMap: Record<string, FieldDef>
): RowPlan {
  let perFieldMap = cache.get(fields);
  if (perFieldMap === undefined) {
    perFieldMap = new WeakMap();
    cache.set(fields, perFieldMap);
  }
  const cached = perFieldMap.get(fieldMap);
  if (cached !== undefined) return cached;
  const entries = Object.entries(fields);
  const plan: RowPlan = new Array(entries.length);
  for (let i = 0; i < entries.length; i++) {
    const pair = entries[i] as [string, true | FieldInput];
    plan[i] = [
      pair[0],
      pair[1],
      Object.hasOwn(fieldMap, pair[0]) ? fieldMap[pair[0]] : undefined
    ] as const;
  }
  perFieldMap.set(fieldMap, plan);
  return plan;
}

/**
 * Lookup-or-build the per-fields FieldDefPlan. O(1) on hit; O(F) on miss.
 */
export function getFieldDefPlan(
  cache: FieldDefPlanCache,
  fields: Record<string, FieldDef>
): FieldDefPlan {
  const cached = cache.get(fields);
  if (cached !== undefined) return cached;
  const entries = Object.entries(fields);
  const plan: FieldDefPlan = new Array(entries.length);
  for (let i = 0; i < entries.length; i++) {
    const pair = entries[i] as [string, FieldDef];
    plan[i] = [pair[0], pair[1]] as const;
  }
  cache.set(fields, plan);
  return plan;
}

/**
 * Schema lookup for a type name. Tries the regular type registry first; falls
 * back to mutations whose `returns` is a struct (the natural lookup for
 * nested selection through a mutation-typed frame key). Returns `undefined`
 * when the type is unknown — callers throw their own typed error with the
 * appropriate path context.
 *
 * Non-struct mutation returns (e.g. delete's `{id, deleted}`) intentionally
 * surface as an empty field map rather than undefined — the lookup
 * succeeded; the type has no nested selection. Both codecs treat the empty
 * map as "no fields to project".
 */
export function lookupFieldMap(
  schema: Schema,
  typeName: string
): Record<string, FieldDef> | undefined {
  const typeEntry = Object.hasOwn(schema.types, typeName) ? schema.types[typeName] : undefined;
  if (typeEntry !== undefined) return typeEntry.fields;
  const mutationEntry = Object.hasOwn(schema.mutations, typeName)
    ? schema.mutations[typeName]
    : undefined;
  if (mutationEntry !== undefined) {
    const ret = mutationEntry.returns;
    if (ret.kind === 'struct') return ret.fields;
    return {};
  }
  return undefined;
}

/**
 * Resolve a type's field map, or throw the error `makeError` builds when the
 * type is unknown.
 */
export function resolveFieldMap(
  schema: Schema,
  typeName: string,
  path: string[],
  makeError: (message: string, path: string[]) => Error
): Record<string, FieldDef> {
  const fieldMap = lookupFieldMap(schema, typeName);
  if (fieldMap === undefined) {
    throw makeError(`unknown type '${typeName}' in schema`, path);
  }
  return fieldMap;
}

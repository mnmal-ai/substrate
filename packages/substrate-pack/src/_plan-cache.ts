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
export type RowPlan = Array<readonly [string, true | FieldInput, FieldDef | undefined, WalkSlot?]>;

/**
 * A walk-result slot in a row plan. Undeclared keys pass through raw, so walk
 * results are encoded deliberately instead:
 *   - `agg`: the row's `_agg` map, as its values in the selection's order.
 *   - `nested`: a `{ _walk }` selection, as a list of rows positional under
 *     the far type's plan; `fields` is the selection's own with `id` first,
 *     since a nested row always carries its id.
 *   - `truncated`: the row's `_truncated` map as-is, null when nothing was
 *     cut. Present only, and last, when the selection has a nested walk.
 */
export type WalkSlot =
  | { kind: 'agg'; names: string[] }
  | { kind: 'nested'; type: string; fields: FieldInput }
  | { kind: 'truncated' };

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** The slot for one selection entry, or undefined for a plain field. */
function walkSlot(
  name: string,
  sel: true | FieldInput,
  fieldMap: Record<string, FieldDef>
): WalkSlot | undefined {
  if (!isObj(sel)) return undefined;
  if (name === '_agg') return { kind: 'agg', names: Object.keys(sel) };
  const walk = sel._walk;
  if (!isObj(walk)) return undefined;
  // Walks stay in their namespace (the validator refuses otherwise), so the
  // far type is named by `in`'s type or by the `out` crossRef's target.
  let type: string | undefined;
  if (typeof walk.in === 'string') type = /^[^/]+\/([^./]+)\./.exec(walk.in)?.[1];
  else if (typeof walk.out === 'string') {
    const def = Object.hasOwn(fieldMap, walk.out) ? fieldMap[walk.out] : undefined;
    if (def?.kind === 'crossRef') type = def.type;
  }
  if (type === undefined) return undefined;
  const fields = isObj(sel.fields) ? (sel.fields as FieldInput) : {};
  return { kind: 'nested', type, fields: { id: true, ...fields } };
}

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
  let nested = false;
  for (let i = 0; i < entries.length; i++) {
    const pair = entries[i] as [string, true | FieldInput];
    const def = Object.hasOwn(fieldMap, pair[0]) ? fieldMap[pair[0]] : undefined;
    const slot = def === undefined ? walkSlot(pair[0], pair[1], fieldMap) : undefined;
    if (slot?.kind === 'nested') nested = true;
    plan[i] =
      slot === undefined ? ([pair[0], pair[1], def] as const) : [pair[0], pair[1], def, slot];
  }
  if (nested) plan.push(['_truncated', true, undefined, { kind: 'truncated' }]);
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

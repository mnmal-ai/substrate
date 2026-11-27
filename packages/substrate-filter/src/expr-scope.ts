/**
 * How a type's fields appear to expressions: the one mapping from a field
 * declaration to an expression type, shared by the validator and both datasets.
 */
import type { Expr, ExprType, FieldDef, WalkAgg } from '@mnmal-ai/substrate-types';
import { METADATA_FILTER_FIELDS, parseWalkRef } from '@mnmal-ai/substrate-types';
import type { FieldDefOf } from './predicate.js';
import type { TypeRef } from './walk-hops.js';

/** `number`, `int16` and `int32` (as `int64`), `int64`, `string`, `boolean` and `date` fields, and a crossRef's id (a string); json, list and struct fields are not usable. */
export function exprTypeOfField(def: FieldDef | undefined): ExprType | undefined {
  if (def === undefined) return undefined;
  if (def.kind === 'crossRef') return 'string';
  if (def.kind !== 'scalar') return undefined;
  if (def.type === 'json') return undefined;
  // An int16 or int32 reads as an int64, so its arithmetic and sums stay exact integers.
  return def.type === 'int16' || def.type === 'int32' ? 'int64' : (def.type as ExprType);
}

/**
 * The type of a date or number metadata name (`createdAt`, `updatedAt`, `seq`), which an
 * expression reads as metadata; the names are reserved, so no declared field shares them. The
 * string metadata names are not expression fields.
 */
export function metadataExprType(name: unknown): ExprType | undefined {
  if (typeof name !== 'string' || !Object.hasOwn(METADATA_FILTER_FIELDS, name)) return undefined;
  const t = exprTypeOfField(METADATA_FILTER_FIELDS[name]);
  return t === 'date' || t === 'number' ? t : undefined;
}

const lookups = new WeakMap<FieldDefOf, (name: string) => ExprType | undefined>();

/**
 * A stable `fieldType` lookup per `fieldDefOf`: the evaluator keys its per-node
 * type cache on the lookup, so one read must reuse one.
 */
export function fieldTypeLookup(
  fieldDefOf: FieldDefOf | undefined
): (name: string) => ExprType | undefined {
  if (fieldDefOf === undefined) return metadataExprType;
  let f = lookups.get(fieldDefOf);
  if (f === undefined) {
    f = (name) => metadataExprType(name) ?? exprTypeOfField(fieldDefOf(name));
    lookups.set(fieldDefOf, f);
  }
  return f;
}

/** Whether `where` is an object carrying `$expr`. */
export const hasExprKey = (where: unknown): where is { $expr: Expr } =>
  typeof where === 'object' && where !== null && Object.hasOwn(where, '$expr');

/** The type a walk (`in` or `out`) from `near` reaches, or undefined when it names none. */
export function walkFarType(
  walk: { in?: string; out?: string },
  near: TypeRef,
  fieldDef: (ref: TypeRef, field: string) => FieldDef | undefined
): TypeRef | undefined {
  if (walk.in !== undefined) {
    const ref = parseWalkRef(walk.in);
    return ref === null ? undefined : { ns: ref.ns, type: ref.type };
  }
  const def = fieldDef(near, walk.out ?? '');
  return def?.kind === 'crossRef' ? { ns: def.ns, type: def.type } : undefined;
}

/**
 * The function a walk aggregate applies and the far field it reads (the field
 * definition is undefined for count): `near` is the seed type, `fieldDef`
 * resolves any type's field.
 */
function aggField(
  spec: WalkAgg,
  near: TypeRef,
  fieldDef: (ref: TypeRef, field: string) => FieldDef | undefined
): { fn: string; def: FieldDef | undefined } | undefined {
  const rec = spec as unknown as Record<string, unknown>;
  const named = (['count', 'sum', 'avg', 'min', 'max', 'latest', 'percentile'] as const).find((k) =>
    Object.hasOwn(rec, k)
  );
  if (named === undefined) return undefined;
  if (named === 'count') return { fn: named, def: undefined };
  const arg = rec[named] as { value: string; nearest?: boolean };
  // An interpolated percentile is typed as avg; a nearest one takes its field's type, as min.
  const fn = named !== 'percentile' ? named : arg.nearest === true ? 'min' : 'avg';
  const field = named === 'latest' || named === 'percentile' ? arg.value : rec[named];
  const far = walkFarType(spec, near, fieldDef);
  return far === undefined || typeof field !== 'string'
    ? undefined
    : { fn, def: fieldDef(far, field) };
}

/** The integer type of a field definition, or undefined when it is not an int16, int32 or int64 scalar. */
export function integerType(def: FieldDef | undefined): 'int16' | 'int32' | 'int64' | undefined {
  return def?.kind === 'scalar' &&
    (def.type === 'int16' || def.type === 'int32' || def.type === 'int64')
    ? def.type
    : undefined;
}

const isIntegerDef = (def: FieldDef | undefined): boolean => integerType(def) !== undefined;

/**
 * Whether a walk aggregate's value is an int64: the sum of an integer field,
 * or the min, max or latest of an int64 field. (An int16 or int32 min or max is a number.)
 */
export function walkAggIsInt64(
  spec: WalkAgg,
  near: TypeRef,
  fieldDef: (ref: TypeRef, field: string) => FieldDef | undefined
): boolean {
  const r = aggField(spec, near, fieldDef);
  if (r === undefined) return false;
  if (r.fn === 'sum') return isIntegerDef(r.def);
  return r.fn !== 'count' && r.fn !== 'avg' && integerType(r.def) === 'int64';
}

/**
 * The expression type of a walk `_agg`'s value: `number` for count and avg, an
 * int64 for the sum of an integer field (else a number), else the type of the
 * field it reads on the far type.
 */
export function walkAggExprType(
  spec: WalkAgg,
  near: TypeRef,
  fieldDef: (ref: TypeRef, field: string) => FieldDef | undefined
): ExprType | undefined {
  const r = aggField(spec, near, fieldDef);
  if (r === undefined) return undefined;
  if (r.fn === 'count' || r.fn === 'avg') return 'number';
  if (r.fn === 'sum') return isIntegerDef(r.def) ? 'int64' : 'number';
  return exprTypeOfField(r.def);
}

/**
 * How a type's fields appear to expressions: the one mapping from a field
 * declaration to an expression type, shared by the validator and both datasets.
 */
import type { Expr, ExprType, FieldDef, WalkAgg } from '@mnmal-ai/substrate-types';
import { METADATA_FILTER_FIELDS } from '@mnmal-ai/substrate-types';
import type { FieldDefOf } from './predicate.js';

/** `number`, `int64`, `string`, `boolean` and `date` fields, and a crossRef's id (a string); json, list and struct fields are not usable. */
export function exprTypeOfField(def: FieldDef | undefined): ExprType | undefined {
  if (def === undefined) return undefined;
  if (def.kind === 'crossRef') return 'string';
  if (def.kind !== 'scalar') return undefined;
  return def.type === 'json' ? undefined : (def.type as ExprType);
}

/**
 * The type of a date or number metadata name (`createdAt`, `updatedAt`, `seq`). In an expression
 * these names always mean the metadata column, shadowing a declared field, as in where and
 * orderBy. Every other name, string metadata included, is a declared field.
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

/**
 * The expression type of a frame `_agg`'s value: `number` for count, sum and
 * avg, else the type of the field it reads on the far type. `near` is the seed
 * type; `fieldDef` resolves any type's field.
 */
export function walkAggExprType(
  spec: WalkAgg,
  near: string,
  fieldDef: (type: string, field: string) => FieldDef | undefined
): ExprType | undefined {
  const rec = spec as unknown as Record<string, unknown>;
  if (Object.hasOwn(rec, 'count') || Object.hasOwn(rec, 'sum') || Object.hasOwn(rec, 'avg')) {
    return 'number';
  }
  const latest = Object.hasOwn(rec, 'latest') ? (rec.latest as { value: string }) : undefined;
  const field = latest !== undefined ? latest.value : (rec.min ?? rec.max);
  let far: string | undefined;
  if (spec.in !== undefined) far = /^[^/]+\/([^./]+)\./.exec(spec.in)?.[1];
  else {
    const def = fieldDef(near, spec.out ?? '');
    far = def?.kind === 'crossRef' ? def.type : undefined;
  }
  return far === undefined || typeof field !== 'string'
    ? undefined
    : exprTypeOfField(fieldDef(far, field));
}

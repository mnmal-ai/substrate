/**
 * Canonical builtin filter-operator allowlists, per field kind — the single
 * source of truth. The validator builds its membership Sets from these arrays
 * and each shipped dataset declares `operators: fullBuiltinOperators()`; do not
 * copy the literals elsewhere.
 *
 * A dataset may narrow deliberately by spreading the helper and overriding one
 * kind (`{ ...fullBuiltinOperators(), crossRef: ['eq'] }`); the allowlist-parity
 * test flags the difference. An operator still needs both validator
 * recognition and a dataset declaration.
 *
 * Prefer `fullBuiltinOperators()` over the raw lists when declaring dataset
 * capabilities: it returns fresh mutable arrays per call, so no two dataset
 * instances share a reference.
 */

import type { FieldKind } from '@mnmal-ai/substrate-types';

export const NUMBER_OPS: readonly string[] = [
  'eq',
  'neq',
  'gt',
  'gte',
  'lt',
  'lte',
  'between',
  'in',
  'nin'
];
// Range operators on strings are lexicographic: evaluateWhere (memory
// snapshots + all live pushes) compares UTF-16 code units; pg compares by
// column collation. Byte-stable only for ASCII-shaped keys (ISO-8601
// timestamps, ULIDs, zero-padded sequences) — the intended use cases.
export const STRING_OPS: readonly string[] = [
  'eq',
  'neq',
  'gt',
  'gte',
  'lt',
  'lte',
  'between',
  'contains',
  'startsWith',
  'endsWith',
  'in',
  'nin'
];
export const BOOLEAN_OPS: readonly string[] = ['eq'];
/**
 * A crossRef stores a target id, so equality and set membership apply; `neq:
 * null` is the only way to ask for rows that DO point at something. Range and
 * pattern operators stay out — lexicographic ordering of opaque ids is
 * meaningless.
 */
export const CROSSREF_OPS: readonly string[] = ['eq', 'neq', 'in', 'nin'];
// List fields support element-membership only. `has` takes a single
// element matched against the list's declared `of` type.
export const LIST_OPS: readonly string[] = ['has'];

// Json fields are filtered through a path predicate only:
// `{ values: { path: ['year'], gt: 1990 } }`. The full scalar set plus list
// membership, since the value at a path may be any JSON type. Semantics are
// type-strict and live in `json-path.ts`.
export const JSON_PATH_OPS: readonly string[] = [
  'eq',
  'neq',
  'gt',
  'gte',
  'lt',
  'lte',
  'between',
  'in',
  'nin',
  'contains',
  'startsWith',
  'endsWith',
  'has'
];

/**
 * The builtin operators per field kind, as data — what `fullBuiltinOperators`
 * copies and what the validator's Sets are built from. `scalar.json`
 * operators apply only inside a `{ path: [...] }` predicate, and
 * `scalar.date` shares the numeric set.
 */
export const BUILTIN_OPERATORS: Record<FieldKind, readonly string[]> = {
  'scalar.number': NUMBER_OPS,
  'scalar.string': STRING_OPS,
  'scalar.boolean': BOOLEAN_OPS,
  'scalar.date': NUMBER_OPS,
  'scalar.json': JSON_PATH_OPS,
  crossRef: CROSSREF_OPS,
  list: LIST_OPS
};

/**
 * Fresh mutable per-kind operator lists for dataset `capabilities.operators`.
 * A new object with new arrays on every call — dataset instances never share
 * a reference with each other or with the canonical lists above.
 */
export function fullBuiltinOperators(): Record<FieldKind, string[]> {
  return {
    'scalar.number': [...NUMBER_OPS],
    'scalar.string': [...STRING_OPS],
    'scalar.boolean': [...BOOLEAN_OPS],
    'scalar.date': [...NUMBER_OPS],
    'scalar.json': [...JSON_PATH_OPS],
    crossRef: [...CROSSREF_OPS],
    list: [...LIST_OPS]
  };
}

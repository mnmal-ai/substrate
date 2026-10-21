/**
 * Pure where-clause evaluator. Spec §5.2 / §5.4.
 *
 * Mirrors the predicate semantics the memory dataset applies at `read()` time
 * so live-subscription filter-testing (§5.4 — "does this pushed row still match
 * the subscription's where?") produces the same verdict the initial snapshot
 * would. Living here lets the memory dataset re-use it and the engine consult
 * it without depending on the dataset package.
 *
 * Scope: this evaluator runs on substrate-native row shapes (POJOs). It is
 * deliberately NOT a re-implementation of the pg dataset's SQL generator —
 * there's nothing to run against pg rows inside the engine.
 */

import {
  type FieldPredicate,
  type Row,
  UnsupportedFilterError,
  type WhereClause
} from '@mnmal-ai/substrate-types';
import { getExtensionOperator } from './extension-operators.js';
import {
  assertJsonPathPredicate,
  evaluateJsonPathPredicate,
  isJsonPathPredicate
} from './json-path.js';

/**
 * Tier-1 row-metadata column projections.
 *
 * WHERE-clause keys matching these names are resolved against `row._metadata`
 * rather than the body. The six API-level filterable column names map onto the
 * nested `_metadata` shape so callers never need to know the internal layout.
 *
 * `null` is returned for absent projections (legacy rows with no `_metadata`,
 * or rows whose `createdBy`/`updatedBy` is null) — this produces sane
 * null-comparison behaviour (e.g. `{ gt: threshold }` → false; `{ eq: null }`
 * → true) consistent with the existing null-sorts-last ordering contract.
 */
const METADATA_COLUMN_PROJECTIONS: Record<string, (row: Row) => unknown> = {
  createdAt: (row: Row) => row._metadata?.createdAt ?? null,
  updatedAt: (row: Row) => row._metadata?.updatedAt ?? null,
  createdById: (row: Row) => row._metadata?.createdBy?.id ?? null,
  createdByKind: (row: Row) => row._metadata?.createdBy?.kind ?? null,
  updatedById: (row: Row) => row._metadata?.updatedBy?.id ?? null,
  updatedByKind: (row: Row) => row._metadata?.updatedBy?.kind ?? null
} as const;

/**
 * Resolve the effective filter value for `name` on `row`.
 *
 * For the 6 Tier-1 metadata column names, value is read from `row._metadata`
 * via the projection table. All other names fall through to direct body access
 * (`row[name]`), preserving the existing filter semantics.
 */
export function getFieldValue(row: Row, name: string): unknown {
  const projector = METADATA_COLUMN_PROJECTIONS[name];
  if (projector !== undefined) return projector(row);
  return row[name];
}

const KNOWN_OPS = new Set<string>([
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
]);

/**
 * Walk a where-clause for predicates the evaluator cannot honour, WITHOUT a row
 * to test against. Throws the same `UnsupportedFilterError` a real evaluation
 * would.
 *
 * Needed because `evaluateWhere` runs only per candidate row, so an empty
 * collection would otherwise answer a malformed filter with a believable `[]`.
 *
 * Checks operand SHAPES and unknown operators with a scalar operand. An unknown
 * operator over an object leaf is indistinguishable from a nested struct filter
 * without the field's declared kind, which the filter validator holds and a
 * substrate does not, so it is left to the validator.
 *
 * Registered extension operators are skipped — they validate their own operands,
 * and some legacy operands (a bare array) would fail the predicate-object check.
 */
export function assertWhereHonourable(where: WhereClause): void {
  if (where === null || typeof where !== 'object' || Array.isArray(where)) return;
  for (const [key, child] of Object.entries(where as Record<string, unknown>)) {
    if (key === 'AND' || key === 'OR') {
      if (Array.isArray(child)) for (const sub of child) assertWhereHonourable(sub as WhereClause);
      continue;
    }
    if (key === 'NOT') {
      assertWhereHonourable(child as WhereClause);
      continue;
    }
    if (getExtensionOperator(key) !== undefined) continue;
    assertFieldPredicateHonourable(key, child);
  }
}

function assertFieldPredicateHonourable(field: string, predicate: unknown): void {
  if (predicate === null || typeof predicate !== 'object' || Array.isArray(predicate)) {
    throw new UnsupportedFilterError(
      field,
      '<none>',
      `expected a predicate object such as { eq: ... }, got ${Array.isArray(predicate) ? 'an array' : typeof predicate}`
    );
  }
  if (isJsonPathPredicate(predicate)) {
    assertJsonPathPredicate(field, predicate);
    return;
  }
  const entries = Object.entries(predicate as Record<string, unknown>);
  // No known operator among the keys — either a nested struct filter or a
  // typo'd operator. The LEAF SHAPE separates them: a nested struct's
  // sub-clause is always a predicate OBJECT (`{ address: { city: { eq: 'x' } } }`), while a typo'd
  // operator carries a bare operand (`{ project: { bogusOp: 'x' } }`). So a
  // scalar leaf here is decidably a bad operator, and only object-vs-object
  // (`{ field: { bogusOp: { eq: 'x' } } }`) stays genuinely ambiguous — that
  // one is the validator's, since it needs the field's declared kind.
  if (!entries.some(([k]) => KNOWN_OPS.has(k))) {
    for (const [k, v] of entries) {
      if (getExtensionOperator(k) !== undefined) continue;
      if (v === null || typeof v !== 'object' || Array.isArray(v)) {
        throw new UnsupportedFilterError(field, k, 'is not a recognised filter operator');
      }
      assertFieldPredicateHonourable(k, v);
    }
    return;
  }
  for (const [op, operand] of entries) {
    switch (op) {
      case 'in':
      case 'nin':
        if (!Array.isArray(operand)) {
          throw new UnsupportedFilterError(field, op, 'requires an array value');
        }
        break;
      case 'between':
        if (!Array.isArray(operand) || operand.length !== 2) {
          throw new UnsupportedFilterError(field, op, 'requires a two-element [low, high] array');
        }
        break;
      case 'contains':
      case 'startsWith':
      case 'endsWith':
        if (typeof operand !== 'string') {
          throw new UnsupportedFilterError(field, op, 'requires a string value');
        }
        break;
      default:
        break;
    }
  }
}

export function evaluateWhere(row: Row, where: WhereClause): boolean {
  if (where === null || typeof where !== 'object' || Array.isArray(where)) return true;
  for (const [k, child] of Object.entries(where as Record<string, unknown>)) {
    if (k === 'AND') {
      if (Array.isArray(child)) {
        for (const sub of child) {
          if (!evaluateWhere(row, sub as WhereClause)) return false;
        }
      }
    } else if (k === 'OR') {
      if (Array.isArray(child)) {
        let any = false;
        for (const sub of child) {
          if (evaluateWhere(row, sub as WhereClause)) {
            any = true;
            break;
          }
        }
        if (!any) return false;
      }
    } else if (k === 'NOT') {
      if (evaluateWhere(row, child as WhereClause)) return false;
    } else {
      if (!evaluateFieldPredicate(k, getFieldValue(row, k), child)) return false;
    }
  }
  return true;
}

function evaluateFieldPredicate(field: string, value: unknown, predicate: unknown): boolean {
  if (predicate === null || typeof predicate !== 'object' || Array.isArray(predicate)) {
    // `where: { kind: 'depends_on' }` — a bare value where an operator object
    // belongs. Throw rather than return false: a silent non-match here
    // disagrees with pg and hides the caller's mistake.
    throw new UnsupportedFilterError(
      field,
      '<none>',
      `expected a predicate object such as { eq: ... }, got ${Array.isArray(predicate) ? 'an array' : typeof predicate}`
    );
  }
  // Json path predicate. Checked before the struct discriminator:
  // `path` is not an operator, so that branch would read it as a sub-field.
  if (isJsonPathPredicate(predicate)) return evaluateJsonPathPredicate(field, value, predicate);
  const p = predicate as FieldPredicate & Record<string, unknown>;
  const keys = Object.keys(p);
  const hasOp = keys.some((k) => KNOWN_OPS.has(k));
  // A predicate with no known-operator keys is a nested where against a struct
  // field's sub-schema; recurse on the value as if it were a row.
  if (!hasOp && keys.length > 0) {
    // A null/absent struct is a legitimate non-match — the row simply has no
    // sub-object to test.
    if (value === null || value === undefined) return false;
    // A PRIMITIVE value is different in kind. No nested where can apply to a
    // string or a number, so these keys were meant as operators and none is
    // recognised — throw rather than report a silent non-match.
    if (typeof value !== 'object') {
      throw new UnsupportedFilterError(
        field,
        keys[0] ?? '<none>',
        'is not a recognised filter operator, and the field holds a ' +
          `${typeof value} so it cannot be a nested struct filter either`
      );
    }
    return evaluateWhere(value as Row, p as WhereClause);
  }

  for (const op of keys) {
    const operand = p[op as keyof FieldPredicate] as unknown;
    if (!applyOp(field, op, value, operand)) return false;
  }
  return true;
}

function applyOp(field: string, op: string, value: unknown, operand: unknown): boolean {
  switch (op) {
    case 'eq':
      return equals(value, operand);
    case 'neq':
      return !equals(value, operand);
    case 'gt':
      // null value cannot satisfy an ordered comparison — null sorts last in
      // orderBy (matches pg NULLS LAST) but is excluded from range filters.
      if (value == null) return false;
      return compare(value, operand) > 0;
    case 'gte':
      if (value == null) return false;
      return compare(value, operand) >= 0;
    case 'lt':
      if (value == null) return false;
      return compare(value, operand) < 0;
    case 'lte':
      if (value == null) return false;
      return compare(value, operand) <= 0;
    case 'between': {
      if (!Array.isArray(operand) || operand.length !== 2) {
        throw new UnsupportedFilterError(field, op, 'requires a two-element [low, high] array');
      }
      // A null row value cannot satisfy an ordered comparison — a data fact,
      // not a caller error, so it stays a plain non-match.
      if (value == null) return false;
      return compare(value, operand[0]) >= 0 && compare(value, operand[1]) <= 0;
    }
    case 'in':
    case 'nin': {
      if (!Array.isArray(operand)) {
        throw new UnsupportedFilterError(field, op, 'requires an array value');
      }
      const member = operand.some((e) => equals(value, e));
      return op === 'in' ? member : !member;
    }
    // The OPERAND being a non-string is a caller error; the row VALUE being a
    // non-string is a data fact. Only the first throws — conflating them would
    // turn "this row holds a number" into a query failure.
    case 'contains':
    case 'startsWith':
    case 'endsWith': {
      if (typeof operand !== 'string') {
        throw new UnsupportedFilterError(field, op, 'requires a string value');
      }
      if (typeof value !== 'string') return false;
      const v = value.toLowerCase();
      const o = operand.toLowerCase();
      if (op === 'contains') return v.includes(o);
      if (op === 'startsWith') return v.startsWith(o);
      return v.endsWith(o);
    }
    case 'has':
      // List-element membership: `value` is the row's list, `operand` the
      // element. Element-typed equality (so number 10 ≠ string "10"). An
      // empty or non-array value never matches.
      return Array.isArray(value) && value.some((e) => equals(e, operand));
    default:
      // Unreachable via a validated filter — KNOWN_OPS gates entry to this
      // switch and the engine validates first. Throws rather than returning a
      // silent `false` when validation was skipped.
      throw new UnsupportedFilterError(field, op, 'is not a recognised filter operator');
  }
}

function equals(a: unknown, b: unknown): boolean {
  // Treat null and undefined as equivalent. Mirrors pg's behaviour where
  // `body ->> 'field'` returns SQL NULL for both absent keys and explicit
  // JSONB nulls. Without this branch, `eq: null` and `in: [..., null]` miss
  // rows whose field is absent (value === undefined), diverging from pg.
  if (a == null && b == null) return true;
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (a instanceof Date && typeof b === 'string') return a.toISOString() === b;
  if (b instanceof Date && typeof a === 'string') return (b as Date).toISOString() === a;
  return a === b;
}

function compare(a: unknown, b: unknown): number {
  // Nullish sorts last — matches pg's `NULLS LAST` default and the memory
  // dataset's orderBy convention.
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  if (a instanceof Date || b instanceof Date) {
    const at = a instanceof Date ? a.getTime() : typeof a === 'string' ? Date.parse(a) : Number(a);
    const bt = b instanceof Date ? b.getTime() : typeof b === 'string' ? Date.parse(b) : Number(b);
    return at < bt ? -1 : at > bt ? 1 : 0;
  }
  if (typeof a === 'number' && typeof b === 'number') return a < b ? -1 : a > b ? 1 : 0;
  const as = String(a);
  const bs = String(b);
  return as < bs ? -1 : as > bs ? 1 : 0;
}

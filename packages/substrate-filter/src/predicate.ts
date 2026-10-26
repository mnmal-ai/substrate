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
  type FieldDef,
  type FieldPredicate,
  METADATA_FILTER_FIELDS,
  normalizeIsoTimestamp,
  type Row,
  UnsupportedFilterError,
  type WhereClause
} from '@mnmal-ai/substrate-types';
import { getExtensionOperator } from './extension-operators.js';
import {
  assertJsonPathPredicate,
  compareCodePoints,
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
  updatedByKind: (row: Row) => row._metadata?.updatedBy?.kind ?? null,
  seq: (row: Row) => row._metadata?.seq ?? null
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

/** A type's field declarations, by top-level field name. */
export type FieldDefOf = (field: string) => FieldDef | undefined;

/**
 * Whether `field` holds a date: the `createdAt`/`updatedAt` columns always do,
 * a body field when its declaration says so. Date fields compare as instants.
 */
export function isDateField(field: string, fieldDefOf?: FieldDefOf): boolean {
  const def = METADATA_FILTER_FIELDS[field] ?? fieldDefOf?.(field);
  return def?.kind === 'scalar' && def.type === 'date';
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

/**
 * `fieldDefOf` names the row type's declared fields, so `date` fields compare
 * as instants (as pg's timestamptz does). Without it, only `createdAt` and
 * `updatedAt` do; nested struct fields always compare as written.
 */
export function evaluateWhere(row: Row, where: WhereClause, fieldDefOf?: FieldDefOf): boolean {
  if (where === null || typeof where !== 'object' || Array.isArray(where)) return true;
  for (const [k, child] of Object.entries(where as Record<string, unknown>)) {
    if (k === 'AND') {
      if (Array.isArray(child)) {
        for (const sub of child) {
          if (!evaluateWhere(row, sub as WhereClause, fieldDefOf)) return false;
        }
      }
    } else if (k === 'OR') {
      if (Array.isArray(child)) {
        let any = false;
        for (const sub of child) {
          if (evaluateWhere(row, sub as WhereClause, fieldDefOf)) {
            any = true;
            break;
          }
        }
        if (!any) return false;
      }
    } else if (k === 'NOT') {
      if (evaluateWhere(row, child as WhereClause, fieldDefOf)) return false;
    } else {
      const asDate = isDateField(k, fieldDefOf);
      if (!evaluateFieldPredicate(k, getFieldValue(row, k), child, asDate)) return false;
    }
  }
  return true;
}

function evaluateFieldPredicate(
  field: string,
  value: unknown,
  predicate: unknown,
  asDate = false
): boolean {
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
    if (!applyOp(field, op, value, operand, asDate)) return false;
  }
  return true;
}

function applyOp(
  field: string,
  op: string,
  value: unknown,
  operand: unknown,
  asDate: boolean
): boolean {
  switch (op) {
    case 'eq':
      return equals(value, operand, asDate);
    case 'neq':
      return !equals(value, operand, asDate);
    case 'gt':
      return rangeCmp(value, operand, asDate) > 0;
    case 'gte':
      return rangeCmp(value, operand, asDate) >= 0;
    case 'lt':
      return rangeCmp(value, operand, asDate) < 0;
    case 'lte':
      return rangeCmp(value, operand, asDate) <= 0;
    case 'between': {
      if (!Array.isArray(operand) || operand.length !== 2) {
        throw new UnsupportedFilterError(field, op, 'requires a two-element [low, high] array');
      }
      return rangeCmp(value, operand[0], asDate) >= 0 && rangeCmp(value, operand[1], asDate) <= 0;
    }
    case 'in':
    case 'nin': {
      if (!Array.isArray(operand)) {
        throw new UnsupportedFilterError(field, op, 'requires an array value');
      }
      const member = operand.some((e) => equals(value, e, asDate));
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

function equals(a: unknown, b: unknown, asDate = false): boolean {
  // Treat null and undefined as equivalent. Mirrors pg's behaviour where
  // `body ->> 'field'` returns SQL NULL for both absent keys and explicit
  // JSONB nulls. Without this branch, `eq: null` and `in: [..., null]` miss
  // rows whose field is absent (value === undefined), diverging from pg.
  if (a == null && b == null) return true;
  if (asDate || a instanceof Date || b instanceof Date) {
    // A stored value pg's substrate_ts reads as NULL never matches.
    const at = storedMicros(a);
    const bt = toMicros(b);
    return at !== undefined && bt !== undefined && at === bt;
  }
  return a === b;
}

/**
 * {@link compareFilterValues} for a range operator, or NaN, which fails every
 * ordered test, where pg's compare is NULL: a null value, a non-number value
 * against a number operand (substrate_num), or either side not an instant in
 * date mode (substrate_ts).
 */
function rangeCmp(value: unknown, operand: unknown, asDate: boolean): number {
  if (value == null) return Number.NaN;
  if (typeof operand === 'number' && typeof value !== 'number') return Number.NaN;
  if (
    (asDate || value instanceof Date || operand instanceof Date) &&
    (storedMicros(value) === undefined || toMicros(operand) === undefined)
  ) {
    return Number.NaN;
  }
  return compareFilterValues(value, operand, asDate);
}

/**
 * Orders two filter values: nullish last, dates (when `asDate`, or either side
 * is a `Date`) by instant, numbers numerically, anything else as text by code point.
 */
export function compareFilterValues(a: unknown, b: unknown, asDate = false): number {
  // Nullish sorts last — matches pg's `NULLS LAST` default and the memory
  // dataset's orderBy convention.
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  if (asDate || a instanceof Date || b instanceof Date) {
    const at = toMicros(a);
    const bt = toMicros(b);
    if (at !== undefined && bt !== undefined) return at < bt ? -1 : at > bt ? 1 : 0;
  }
  if (typeof a === 'number' && typeof b === 'number') return a < b ? -1 : a > b ? 1 : 0;
  // By code point, as pg's COLLATE "C" orders UTF-8; JS `<` orders UTF-16 units.
  return compareCodePoints(String(a), String(b));
}

/**
 * {@link toMicros} for a stored value: `undefined` wherever `substrate_ts` is
 * NULL, a number included. Only the shared ISO grammar is read; operands are
 * cast leniently, as pg's `tsParam` casts them.
 */
function storedMicros(v: unknown): bigint | undefined {
  if (v instanceof Date) return toMicros(v);
  if (typeof v !== 'string' || normalizeIsoTimestamp(v) === undefined) return undefined;
  return toMicros(v);
}

/**
 * A row value as pg sorts it: a date-field value `substrate_ts` cannot read, or
 * a number-field value that is not a number, becomes null and sorts last.
 */
export function asSortValue(field: string, value: unknown, fieldDefOf?: FieldDefOf): unknown {
  if (value == null) return value;
  if (isDateField(field, fieldDefOf)) return storedMicros(value) === undefined ? null : value;
  const def = METADATA_FILTER_FIELDS[field] ?? fieldDefOf?.(field);
  if (def?.kind === 'scalar' && def.type === 'number' && typeof value !== 'number') return null;
  return value;
}

/**
 * Microseconds since the epoch, pg's timestamptz precision, as a bigint: a
 * double is exact only to 2^53 µs (about 1685-2255), and the grammar spans
 * years 0001-9999. `Date.parse` keeps only milliseconds, so the 4th-6th
 * fraction digits are added back. A number is read as epoch milliseconds;
 * anything unparseable is `undefined`.
 */
function toMicros(v: unknown): bigint | undefined {
  if (v instanceof Date) return msToMicros(v.getTime());
  if (typeof v === 'number') return msToMicros(v);
  if (typeof v !== 'string') return undefined;
  // The grammar's own form (no offset is UTC); anything else as Date.parse reads it.
  const iso = normalizeIsoTimestamp(v) ?? v;
  const micros = msToMicros(Date.parse(iso));
  if (micros === undefined) return undefined;
  const frac = /[T ][\d:]+\.(\d+)/.exec(iso)?.[1] ?? '';
  return micros + BigInt(frac.padEnd(6, '0').slice(3, 6));
}

/** Epoch milliseconds as microseconds, exact: `ms * 1000` as a double is not, past 2^53. */
function msToMicros(ms: number): bigint | undefined {
  if (!Number.isFinite(ms)) return undefined;
  const whole = Math.floor(ms);
  return BigInt(whole) * 1000n + BigInt(Math.round((ms - whole) * 1000));
}

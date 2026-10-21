/**
 * Path-addressed predicates on json fields.
 *
 * `{ values: { path: ['year'], gt: 1990 } }`. The data keys live inside the
 * `path` ARRAY, so a key an end user invented — `contains`, `in`, `has` — can
 * never be read as an operator. An array-valued `path` is also what tells this apart from a
 * struct that declares a sub-field named `path`: that one's value is an object.
 *
 * This file is the reference semantics. The pg compiler
 * (`substrate-dataset-pg/src/pg-sql/predicates-json-path.ts`) must return the same
 * rows, and live subscriptions on BOTH substrates evaluate through here.
 */

import { UnsupportedFilterError } from '@mnmal-ai/substrate-types';
import { JSON_PATH_OPS } from './builtin-operators.js';

export const JSON_PATH_MAX_DEPTH = 16;

/** Most `in` / `nin` members both substrates accept (pg binds two per member). */
export const JSON_PATH_MAX_IN = 10_000;

/**
 * Most `in` members still treated as index-served. jsonb `@>` has no planner
 * statistics, so each OR'd containment adds a default-selectivity guess, and
 * past a few dozen the planner scans the partition regardless of the GIN.
 */
export const JSON_PATH_INDEXED_IN_MAX = 32;

const OPS: ReadonlySet<string> = new Set(JSON_PATH_OPS);

export interface JsonPathPredicate {
  path: string[];
  [op: string]: unknown;
}

type JsonScalar = string | number | boolean;

const isScalar = (v: unknown): v is JsonScalar =>
  typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';

export function isJsonPathPredicate(p: unknown): p is JsonPathPredicate {
  return (
    p !== null &&
    typeof p === 'object' &&
    !Array.isArray(p) &&
    Array.isArray((p as { path?: unknown }).path)
  );
}

export function jsonPathProblem(path: readonly unknown[]): string | null {
  if (path.length === 0) return 'path must name at least one key';
  if (path.length > JSON_PATH_MAX_DEPTH) return `path is deeper than ${JSON_PATH_MAX_DEPTH} keys`;
  if (path.some((seg) => typeof seg !== 'string' || seg.length === 0)) {
    return 'path segments must be non-empty strings';
  }
  return null;
}

/** Why `operand` cannot go with `op` on a json path, or null when it can. */
export function jsonPathOperandProblem(op: string, operand: unknown): string | null {
  if (!OPS.has(op)) return 'is not a recognised filter operator';
  if (operand instanceof Date) {
    return 'cannot take a Date — json has no date type, pass an ISO string';
  }
  // JSON has no NaN or Infinity, and pg would receive them as null
  // (JSON.stringify), matching the explicit-null rows memory does not.
  const members = Array.isArray(operand) ? operand : [operand];
  if (members.some((m) => typeof m === 'number' && !Number.isFinite(m))) {
    return 'requires finite numbers — json has no NaN or Infinity';
  }
  switch (op) {
    case 'eq':
    case 'neq':
      return operand === null || isScalar(operand)
        ? null
        : 'requires a string, number, boolean or null';
    case 'in':
    case 'nin':
      if (!Array.isArray(operand)) return 'requires an array value';
      if (operand.length > JSON_PATH_MAX_IN) return `accepts at most ${JSON_PATH_MAX_IN} members`;
      return operand.every((e) => e === null || isScalar(e))
        ? null
        : 'requires array members that are strings, numbers, booleans or null';
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte':
      return typeof operand === 'number' || typeof operand === 'string'
        ? null
        : 'requires a number or string';
    case 'between': {
      if (!Array.isArray(operand) || operand.length !== 2) {
        return 'requires a two-element [low, high] array';
      }
      const [lo, hi] = operand;
      const bothNumbers = typeof lo === 'number' && typeof hi === 'number';
      const bothStrings = typeof lo === 'string' && typeof hi === 'string';
      return bothNumbers || bothStrings
        ? null
        : 'requires both bounds to be numbers or both strings';
    }
    case 'contains':
    case 'startsWith':
    case 'endsWith':
      return typeof operand === 'string' ? null : 'requires a string value';
    default: // 'has'
      return isScalar(operand) ? null : 'requires a string, number or boolean';
  }
}

/**
 * Whether `op` scans the (namespace, type) partition on pg even when the field
 * is `field.json({ indexed: true })`. Only containment is served by the derived
 * `(body -> field)` GIN; a null operand needs an IS NULL test containment
 * cannot express, and a long `in` is scanned by the planner anyway.
 */
export function jsonPathNeedsScan(op: string, operand: unknown): boolean {
  if (op === 'has') return false;
  if (op === 'eq') return operand === null;
  if (op === 'in') {
    return (
      Array.isArray(operand) &&
      (operand.length > JSON_PATH_INDEXED_IN_MAX || operand.some((e) => e === null))
    );
  }
  return true;
}

/** The value at `path`, walking plain objects only. `undefined` means absent. */
export function resolveJsonPath(value: unknown, path: readonly string[]): unknown {
  let cur = value;
  for (const seg of path) {
    if (cur === null || typeof cur !== 'object' || Array.isArray(cur)) return undefined;
    if (!Object.hasOwn(cur, seg)) return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

export function assertJsonPathPredicate(field: string, predicate: JsonPathPredicate): void {
  const pathProblem = jsonPathProblem(predicate.path);
  if (pathProblem !== null) throw new UnsupportedFilterError(field, 'path', pathProblem);
  const ops = Object.keys(predicate).filter((k) => k !== 'path');
  if (ops.length === 0) {
    throw new UnsupportedFilterError(field, 'path', 'needs at least one operator beside it');
  }
  for (const op of ops) {
    const problem = jsonPathOperandProblem(op, predicate[op]);
    if (problem !== null) throw new UnsupportedFilterError(field, op, problem);
  }
}

export function evaluateJsonPathPredicate(
  field: string,
  fieldValue: unknown,
  predicate: JsonPathPredicate
): boolean {
  assertJsonPathPredicate(field, predicate);
  const value = resolveJsonPath(fieldValue, predicate.path);
  for (const [op, operand] of Object.entries(predicate)) {
    if (op === 'path') continue;
    if (!applyJsonPathOp(op, value, operand)) return false;
  }
  return true;
}

function jsonEquals(value: unknown, operand: unknown): boolean {
  if (operand === null) return value === null || value === undefined;
  return value === operand;
}

/** Code-point order, matching pg's `COLLATE "C"` over UTF-8. */
function compareCodePoints(a: string, b: string): number {
  const ai = a[Symbol.iterator]();
  const bi = b[Symbol.iterator]();
  for (;;) {
    const x = ai.next();
    const y = bi.next();
    if (x.done === true || y.done === true) {
      return x.done === true && y.done === true ? 0 : x.done === true ? -1 : 1;
    }
    const cx = x.value.codePointAt(0)!;
    const cy = y.value.codePointAt(0)!;
    if (cx !== cy) return cx < cy ? -1 : 1;
  }
}

/** Null when the JSON types differ — a mismatch is a non-match, not an error. */
function sameTypeCompare(value: unknown, operand: unknown): number | null {
  if (typeof value === 'number' && typeof operand === 'number') {
    return value < operand ? -1 : value > operand ? 1 : 0;
  }
  if (typeof value === 'string' && typeof operand === 'string') {
    return compareCodePoints(value, operand);
  }
  return null;
}

function applyJsonPathOp(op: string, value: unknown, operand: unknown): boolean {
  switch (op) {
    case 'eq':
      return jsonEquals(value, operand);
    case 'neq':
      return !jsonEquals(value, operand);
    case 'in':
      return (operand as unknown[]).some((e) => jsonEquals(value, e));
    case 'nin':
      return !(operand as unknown[]).some((e) => jsonEquals(value, e));
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      const c = sameTypeCompare(value, operand);
      if (c === null) return false;
      return op === 'gt' ? c > 0 : op === 'gte' ? c >= 0 : op === 'lt' ? c < 0 : c <= 0;
    }
    case 'between': {
      const [lo, hi] = operand as [unknown, unknown];
      const a = sameTypeCompare(value, lo);
      const b = sameTypeCompare(value, hi);
      return a !== null && b !== null && a >= 0 && b <= 0;
    }
    case 'contains':
    case 'startsWith':
    case 'endsWith': {
      if (typeof value !== 'string') return false;
      const v = value.toLowerCase();
      const o = (operand as string).toLowerCase();
      return op === 'contains'
        ? v.includes(o)
        : op === 'startsWith'
          ? v.startsWith(o)
          : v.endsWith(o);
    }
    default: // 'has' — operands were checked by assertJsonPathPredicate
      return Array.isArray(value) && value.some((e) => e === operand);
  }
}

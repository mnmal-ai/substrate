/**
 * WHERE-clause → SQL translation: logical combinators, per-field predicate
 * dispatch (id / shortId / metadata / promoted-column / body-path), the
 * operator-fragment compiler, and the `conditionalUpdate` match fragment.
 */

import { isJsonPathPredicate } from '@mnmal-ai/substrate-filter';
import { type Id, UnsupportedFilterError, type WhereClause } from '@mnmal-ai/substrate-types';
import type { Sql, TransactionSql } from 'postgres';
import { buildJsonPathPredicate } from './predicates-json-path.js';
import { buildMetadataColumnPredicate } from './predicates-metadata.js';
import { buildPromotedBodyColumnPredicate } from './predicates-promoted.js';
import {
  asJsonValue,
  type BodyOrderByCast,
  combineAnd,
  combineOr,
  escapeLike,
  type Fragment,
  idToText,
  isMetadataField,
  metaStr,
  type PromotedColumnLookup,
  scalarParam
} from './primitives.js';

export function buildWhere(
  sql: Sql | TransactionSql,
  where: WhereClause,
  castFor: (field: string) => BodyOrderByCast | null,
  promotedFor: PromotedColumnLookup
): Fragment | null {
  if (where === null || typeof where !== 'object' || Array.isArray(where)) return null;
  const keys = Object.keys(where);
  if (keys.length === 0) return null;

  // AND/OR/NOT and field keys at one level all AND together, as in memory's
  // evaluateWhere; dropping the field keys beside a combinator widens the read.
  const fragments: Fragment[] = [];
  for (const k of keys) {
    const child = (where as Record<string, unknown>)[k];
    if (k === 'AND' || k === 'OR') {
      if (!Array.isArray(child)) continue;
      const subs: Fragment[] = [];
      for (const sub of child) {
        const frag = buildWhere(sql, sub as WhereClause, castFor, promotedFor);
        if (frag !== null) subs.push(frag);
      }
      if (subs.length > 0)
        fragments.push(k === 'AND' ? combineAnd(sql, subs) : combineOr(sql, subs));
    } else if (k === 'NOT') {
      const inner = buildWhere(sql, child as WhereClause, castFor, promotedFor);
      if (inner !== null) fragments.push(sql`NOT (${inner})`);
    } else {
      const frag = buildFieldPredicate(sql, k, child, castFor, promotedFor);
      if (frag !== null) fragments.push(frag);
    }
  }
  if (fragments.length === 0) return null;
  return combineAnd(sql, fragments);
}

function buildFieldPredicate(
  sql: Sql | TransactionSql,
  field: string,
  predicate: unknown,
  castFor: (field: string) => BodyOrderByCast | null,
  promotedFor: PromotedColumnLookup
): Fragment | null {
  if (predicate === null || typeof predicate !== 'object' || Array.isArray(predicate)) {
    // A bare value where an operator object belongs (`where: { project: 'x' }`).
    // Throw: dropping it would match every row.
    throw new UnsupportedFilterError(
      field,
      '<none>',
      `expected a predicate object such as { eq: ... }, got ${Array.isArray(predicate) ? 'an array' : typeof predicate}`
    );
  }
  // The PK column, not the body: many types don't declare id in body.
  if (field === 'id') {
    return buildIdPredicate(sql, predicate as Record<string, unknown>);
  }
  // shortId is a sidecar-joined field (s.short_id), not a JSONB body field.
  // Route it through the specialised short-id predicate builder.
  if (field === 'shortId') {
    return buildShortIdPredicate(sql, predicate as Record<string, unknown>);
  }
  // Row-metadata fields route to dedicated columns — not body->> extraction.
  if (isMetadataField(field)) {
    return buildMetadataColumnPredicate(sql, field, predicate as Record<string, unknown>);
  }
  // Body-promoted fields route to their dedicated column only (no body
  // fallback). See `PgDatasetOptions.promotedColumns`.
  const promotedField = promotedFor(field);
  if (promotedField !== undefined) {
    return buildPromotedBodyColumnPredicate(
      sql,
      field,
      promotedField,
      predicate as Record<string, unknown>
    );
  }
  // Json path predicate. Only an ARRAY-valued `path` — a struct
  // sub-field that happens to be named `path` carries an object and falls
  // through to the struct walk below.
  if (isJsonPathPredicate(predicate)) {
    return buildJsonPathPredicate(sql, field, predicate);
  }
  // Everything else lives in the JSONB body and is addressed by PATH, so that
  // struct sub-clauses can extend it. The dedicated columns above cannot be
  // struct-nested, which is why the split happens here.
  return buildFieldPredicateForPath(sql, [field], predicate, castFor);
}

function buildFieldPredicateForPath(
  sql: Sql | TransactionSql,
  path: string[],
  predicate: unknown,
  castFor: (field: string) => BodyOrderByCast | null
): Fragment | null {
  const field = path.join('.');
  const entries = Object.entries(predicate as Record<string, unknown>);

  // Nested-struct sub-clause: `{ address: { city: { eq: 'x' } } }`.
  // Discriminated exactly as the memory evaluator does, so the two agree: no
  // key is a known operator AND every value is a non-array object. A bare
  // operand under an unknown key is a typo, not a sub-clause, and falls through
  // to the operator path below where it is refused by name.
  if (
    entries.length > 0 &&
    !entries.some(([k]) => KNOWN_BODY_OPS.has(k)) &&
    entries.every(([, v]) => v !== null && typeof v === 'object' && !Array.isArray(v))
  ) {
    const subs: Fragment[] = [];
    for (const [subField, subPredicate] of entries) {
      const frag = buildBodyPathPredicate(sql, [...path, subField], subPredicate, castFor);
      if (frag !== null) subs.push(frag);
    }
    if (subs.length === 0) return null;
    return combineAnd(sql, subs);
  }

  // Declared casts are top-level only; struct-nested fields use operand-type
  // inference, which is what the memory substrate does too.
  const declaredCast = path.length === 1 ? castFor(field) : null;
  const fragments: Fragment[] = [];
  for (const [op, operand] of entries) {
    const frag = buildOpFragment(sql, path, op, operand, declaredCast);
    if (frag !== null) fragments.push(frag);
  }
  if (fragments.length === 0) return null;
  return combineAnd(sql, fragments);
}

/**
 * Operators the generic body compiler recognises. Used only to tell an operator
 * predicate from a nested-struct sub-clause; the authoritative per-operator
 * handling is `buildOpFragment`'s switch.
 */
const KNOWN_BODY_OPS: ReadonlySet<string> = new Set([
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

/** Recurse into a struct sub-clause, carrying the accumulated body path. */
function buildBodyPathPredicate(
  sql: Sql | TransactionSql,
  path: string[],
  predicate: unknown,
  castFor: (field: string) => BodyOrderByCast | null
): Fragment | null {
  if (predicate === null || typeof predicate !== 'object' || Array.isArray(predicate)) {
    throw new UnsupportedFilterError(
      path.join('.'),
      '<none>',
      `expected a predicate object such as { eq: ... }, got ${Array.isArray(predicate) ? 'an array' : typeof predicate}`
    );
  }
  return buildFieldPredicateForPath(sql, path, predicate, castFor);
}

/**
 * Build WHERE predicates against the native `id` column (the row PK).
 *
 * Range operators compare the text ids lexicographically. Numeric ids
 * stringify cleanly.
 */
function buildIdPredicate(
  sql: Sql | TransactionSql,
  predicate: Record<string, unknown>
): Fragment | null {
  const fragments: Fragment[] = [];
  for (const [op, operand] of Object.entries(predicate)) {
    let frag: Fragment | null = null;
    switch (op) {
      case 'eq':
        if (operand === null || operand === undefined) {
          frag = sql`id IS NULL`;
        } else {
          frag = sql`id = ${idToText(operand as Id)}`;
        }
        break;
      case 'neq':
        if (operand === null || operand === undefined) {
          frag = sql`id IS NOT NULL`;
        } else {
          frag = sql`id IS DISTINCT FROM ${idToText(operand as Id)}`;
        }
        break;
      case 'in':
        if (Array.isArray(operand) && operand.length > 0) {
          const vals = operand.map((v) => idToText(v as Id));
          frag = sql`id IN ${sql(vals)}`;
        } else if (Array.isArray(operand) && operand.length === 0) {
          // Empty IN — match nothing.
          frag = sql`FALSE`;
        }
        break;
      case 'nin':
        if (Array.isArray(operand) && operand.length > 0) {
          const vals = operand.map((v) => idToText(v as Id));
          frag = sql`id NOT IN ${sql(vals)}`;
        }
        break;
      case 'contains':
        if (typeof operand === 'string') {
          frag = sql`id ILIKE ${`%${escapeLike(operand)}%`}`;
        }
        break;
      case 'startsWith':
        if (typeof operand === 'string') {
          frag = sql`id ILIKE ${`${escapeLike(operand)}%`}`;
        }
        break;
      case 'endsWith':
        if (typeof operand === 'string') {
          frag = sql`id ILIKE ${`%${escapeLike(operand)}`}`;
        }
        break;
      // Lexicographic string comparisons.
      case 'gt':
        frag = sql`id > ${metaStr('id', op, operand)}`;
        break;
      case 'gte':
        frag = sql`id >= ${metaStr('id', op, operand)}`;
        break;
      case 'lt':
        frag = sql`id < ${metaStr('id', op, operand)}`;
        break;
      case 'lte':
        frag = sql`id <= ${metaStr('id', op, operand)}`;
        break;
      case 'between': {
        if (!Array.isArray(operand) || operand.length !== 2) {
          throw new UnsupportedFilterError('id', op, 'requires a two-element [low, high] array');
        }
        frag = sql`id BETWEEN ${metaStr('id', op, operand[0])} AND ${metaStr('id', op, operand[1])}`;
        break;
      }
      default:
        throw new UnsupportedFilterError('id', op, 'is not a recognised filter operator');
    }
    if (frag !== null) fragments.push(frag);
  }
  if (fragments.length === 0) return null;
  return combineAnd(sql, fragments);
}

/** Operand-shape guards for the numeric shortId column: anything else is refused, never dropped. */
function num(field: string, op: string, v: unknown): number {
  if (typeof v !== 'number') throw new UnsupportedFilterError(field, op, 'requires a number');
  return v;
}

function numArray(field: string, op: string, v: unknown): number[] {
  if (!Array.isArray(v) || v.some((e) => typeof e !== 'number')) {
    throw new UnsupportedFilterError(field, op, 'requires an array of numbers');
  }
  return v as number[];
}

/** Build WHERE predicates against `s.short_id` (the LEFT-joined sidecar column). */
function buildShortIdPredicate(
  sql: Sql | TransactionSql,
  predicate: Record<string, unknown>
): Fragment | null {
  const col = sql`s.short_id`;
  const fragments: Fragment[] = [];
  for (const [op, operand] of Object.entries(predicate)) {
    let frag: Fragment | null = null;
    switch (op) {
      case 'eq':
        frag = sql`${col} = ${num('shortId', op, operand)}`;
        break;
      case 'neq':
        frag = sql`${col} IS DISTINCT FROM ${num('shortId', op, operand)}`;
        break;
      case 'gt':
        frag = sql`${col} > ${num('shortId', op, operand)}`;
        break;
      case 'gte':
        frag = sql`${col} >= ${num('shortId', op, operand)}`;
        break;
      case 'lt':
        frag = sql`${col} < ${num('shortId', op, operand)}`;
        break;
      case 'lte':
        frag = sql`${col} <= ${num('shortId', op, operand)}`;
        break;
      case 'between': {
        const range = numArray('shortId', op, operand);
        if (range.length !== 2) {
          throw new UnsupportedFilterError(
            'shortId',
            op,
            'requires a two-element [low, high] array'
          );
        }
        frag = sql`${col} BETWEEN ${range[0] as number} AND ${range[1] as number}`;
        break;
      }
      // `in: []` matches nothing; `nin: []` excludes nothing.
      case 'in':
        frag =
          numArray('shortId', op, operand).length === 0
            ? sql`FALSE`
            : sql`${col} = ANY(${numArray('shortId', op, operand)})`;
        break;
      case 'nin':
        frag =
          numArray('shortId', op, operand).length === 0
            ? sql`TRUE`
            : sql`${col} <> ALL(${numArray('shortId', op, operand)})`;
        break;
      default:
        throw new UnsupportedFilterError('shortId', op, 'is not a recognised filter operator');
    }
    if (frag !== null) fragments.push(frag);
  }
  if (fragments.length === 0) return null;
  return combineAnd(sql, fragments);
}

/**
 * Build a single SQL comparison for (field, op, operand). Values come from
 * callers (attacker-controlled in principle) so every operand MUST be passed
 * through a parameterised slot. `sql.unsafe()` is deliberately avoided.
 *
 * Case-sensitivity note (design call): `contains` / `startsWith` / `endsWith`
 * use ILIKE for case-INSENSITIVE matching. Memory dataset mirrors this.
 */
/**
 * `body ->> 'a'` for one segment, `body -> 'a' -> 'b' ->> 'c'` for a path.
 * Segments are parameterised, never concatenated.
 */
function buildBodyTextExpr(sql: Sql | TransactionSql, path: string[]): Fragment {
  let expr = sql`body`;
  for (let i = 0; i < path.length - 1; i++) expr = sql`${expr} -> ${path[i] as string}`;
  return sql`(${expr} ->> ${path[path.length - 1] as string})`;
}

/** Same walk, but landing on `->` so the leaf stays jsonb (for `@>` containment). */
function buildBodyJsonExpr(sql: Sql | TransactionSql, path: string[]): Fragment {
  let expr = sql`body`;
  for (const seg of path) expr = sql`${expr} -> ${seg}`;
  return sql`(${expr})`;
}

function buildOpFragment(
  sql: Sql | TransactionSql,
  path: string[],
  op: string,
  operand: unknown,
  declaredCast: BodyOrderByCast | null
): Fragment | null {
  // Dotted path for error messages only — never interpolated into SQL.
  const field = path.join('.');
  // JSONB text extraction. A single segment is `body ->> field`; a struct path
  // walks with `->` and lands with `->>` (`body -> 'address' ->> 'city'`), which
  // keeps intermediate hops as jsonb and yields text at the leaf. Every segment
  // goes through a parameter slot, so a field name can never smuggle SQL.
  const textExpr = buildBodyTextExpr(sql, path);
  const jsonExpr = buildBodyJsonExpr(sql, path);
  const num = sql`(${textExpr})::numeric`;

  // A `date`-declared field also accepts an ISO-string operand, which operand
  // inference alone would text-compare; cast it to timestamptz.
  const isTs = (v: unknown): boolean =>
    v instanceof Date || (declaredCast === 'timestamptz' && typeof v === 'string');
  const tsIso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));
  // `<expr> = ANY(values)`: numbers against numeric values, the rest typed by
  // their first member. Never NULL, so `NOT anyOf(...)` is safe.
  const anyOf = (values: unknown[]): Fragment => {
    const nums = values.filter((v): v is number => typeof v === 'number');
    const rest = values.filter((v) => typeof v !== 'number');
    const parts: Fragment[] = [];
    if (nums.length > 0) parts.push(ifJsonNumber(sql, jsonExpr, sql`${num} = ANY(${nums})`));
    if (rest.length > 0) {
      parts.push(
        isTs(rest[0])
          ? sql`COALESCE((${textExpr})::timestamptz = ANY(${rest.map(tsIso)}), FALSE)`
          : sql`COALESCE(${textExpr} = ANY(${rest.map(scalarParam)}), FALSE)`
      );
    }
    return combineOr(sql, parts);
  };

  switch (op) {
    case 'eq': {
      if (operand === null) return sql`${textExpr} IS NULL`;
      if (typeof operand === 'boolean') {
        // body ->> returns text; compare the text form so booleans work without a cast dance.
        return sql`${textExpr} = ${operand ? 'true' : 'false'}`;
      }
      if (typeof operand === 'number') {
        return ifJsonNumber(sql, jsonExpr, sql`${num} = ${operand}`);
      }
      if (isTs(operand)) {
        return sql`(${textExpr})::timestamptz = ${tsIso(operand)}`;
      }
      return sql`${textExpr} = ${scalarParam(operand)}`;
    }
    case 'neq': {
      if (operand === null) return sql`${textExpr} IS NOT NULL`;
      if (typeof operand === 'boolean') {
        return sql`${textExpr} IS DISTINCT FROM ${operand ? 'true' : 'false'}`;
      }
      if (typeof operand === 'number') {
        return sql`NOT ${ifJsonNumber(sql, jsonExpr, sql`${num} = ${operand}`)}`;
      }
      if (isTs(operand)) {
        return sql`(${textExpr})::timestamptz IS DISTINCT FROM ${tsIso(operand)}`;
      }
      return sql`${textExpr} IS DISTINCT FROM ${scalarParam(operand)}`;
    }
    case 'gt':
      return numericCmp(sql, field, textExpr, jsonExpr, operand, '>', declaredCast);
    case 'gte':
      return numericCmp(sql, field, textExpr, jsonExpr, operand, '>=', declaredCast);
    case 'lt':
      return numericCmp(sql, field, textExpr, jsonExpr, operand, '<', declaredCast);
    case 'lte':
      return numericCmp(sql, field, textExpr, jsonExpr, operand, '<=', declaredCast);
    case 'between': {
      if (!Array.isArray(operand) || operand.length !== 2) {
        throw new UnsupportedFilterError(field, op, 'requires a two-element [low, high] array');
      }
      const low = operand[0];
      const high = operand[1];
      if (typeof low === 'number' && typeof high === 'number') {
        return ifJsonNumber(sql, jsonExpr, sql`${num} BETWEEN ${low} AND ${high}`);
      }
      if (isTs(low) || isTs(high)) {
        return sql`(${textExpr})::timestamptz BETWEEN ${tsIso(low)} AND ${tsIso(high)}`;
      }
      return sql`${textExpr} COLLATE "C" BETWEEN ${scalarParam(low)} AND ${scalarParam(high)}`;
    }
    case 'in': {
      if (!Array.isArray(operand)) {
        throw new UnsupportedFilterError(field, op, 'requires an array value');
      }
      // A null in the list means "or absent", as in memory: `= ANY` never
      // matches NULL, so it is split out.
      const values = operand.filter((v) => v !== null && v !== undefined);
      const wantsNull = values.length < operand.length;
      const any = values.length === 0 ? sql`FALSE` : anyOf(values);
      return wantsNull ? sql`(${any} OR ${textExpr} IS NULL)` : any;
    }
    case 'nin': {
      if (!Array.isArray(operand)) {
        throw new UnsupportedFilterError(field, op, 'requires an array value');
      }
      if (operand.length === 0) return sql`TRUE`;
      // A null in the list excludes absent values too, mirroring `in`.
      const values = operand.filter((v) => v !== null && v !== undefined);
      if (values.length < operand.length) {
        if (values.length === 0) return sql`${textExpr} IS NOT NULL`;
        return sql`(${textExpr} IS NOT NULL AND NOT ${anyOf(values)})`;
      }
      // Absent values are outside the list, so `nin` admits them, as `neq` and
      // the memory evaluator do.
      return sql`(${textExpr} IS NULL OR NOT ${anyOf(values)})`;
    }
    case 'contains': {
      if (typeof operand !== 'string') {
        throw new UnsupportedFilterError(field, op, 'requires a string value');
      }
      // Pattern operators on the body are unindexed; seq-scan accepted.
      const pattern = `%${escapeLike(operand)}%`;
      return sql`${textExpr} ILIKE ${pattern}`;
    }
    case 'startsWith': {
      if (typeof operand !== 'string') {
        throw new UnsupportedFilterError(field, op, 'requires a string value');
      }
      const pattern = `${escapeLike(operand)}%`;
      return sql`${textExpr} ILIKE ${pattern}`;
    }
    case 'endsWith': {
      if (typeof operand !== 'string') {
        throw new UnsupportedFilterError(field, op, 'requires a string value');
      }
      const pattern = `%${escapeLike(operand)}`;
      return sql`${textExpr} ILIKE ${pattern}`;
    }
    case 'has': {
      // List membership: `@>` with a one-element array, preserving native types
      // (10 ≠ "10"); a GIN on `(body -> 'field')` serves it.
      // `sql.json([..])` sends a real jsonb array — a plain stringified value
      // with `::jsonb` would double-encode into a jsonb *string*, not an array.
      const elem = operand instanceof Date ? operand.toISOString() : operand;
      return sql`${buildBodyJsonExpr(sql, path)} @> ${sql.json(asJsonValue([elem]))}`;
    }
    default:
      throw new UnsupportedFilterError(field, op, 'is not a recognised filter operator');
  }
}

/**
 * `cond` only where the jsonb value is a number, else FALSE. CASE because SQL
 * does not promise AND short-circuits, so one non-numeric value could still
 * reach `::numeric` and abort the whole query; COALESCE so a mismatch is
 * FALSE, never NULL under a caller's NOT.
 */
function ifJsonNumber(sql: Sql | TransactionSql, jsonExpr: Fragment, cond: Fragment): Fragment {
  return sql`COALESCE(CASE WHEN jsonb_typeof(${jsonExpr}) = 'number' THEN ${cond} END, FALSE)`;
}

/**
 * Compare `(body ->> field)` with a cast appropriate to the value. Numbers use
 * `::numeric`, Dates (or ISO-string operands on a `date`-declared field) use
 * `::timestamptz`, plain strings use text.
 */
function numericCmp(
  sql: Sql | TransactionSql,
  field: string,
  textExpr: Fragment,
  jsonExpr: Fragment,
  operand: unknown,
  cmp: '>' | '>=' | '<' | '<=',
  declaredCast: BodyOrderByCast | null
): Fragment {
  if (typeof operand === 'number') {
    // Can't interpolate the operator — template tag slots are value slots, not
    // arbitrary SQL. Spread a fixed set of operator fragments instead.
    const n = sql`(${textExpr})::numeric`;
    switch (cmp) {
      case '>':
        return ifJsonNumber(sql, jsonExpr, sql`${n} > ${operand}`);
      case '>=':
        return ifJsonNumber(sql, jsonExpr, sql`${n} >= ${operand}`);
      case '<':
        return ifJsonNumber(sql, jsonExpr, sql`${n} < ${operand}`);
      case '<=':
        return ifJsonNumber(sql, jsonExpr, sql`${n} <= ${operand}`);
    }
  }
  if (operand instanceof Date || (declaredCast === 'timestamptz' && typeof operand === 'string')) {
    const iso = operand instanceof Date ? operand.toISOString() : String(operand);
    switch (cmp) {
      case '>':
        return sql`(${textExpr})::timestamptz > ${iso}`;
      case '>=':
        return sql`(${textExpr})::timestamptz >= ${iso}`;
      case '<':
        return sql`(${textExpr})::timestamptz < ${iso}`;
      case '<=':
        return sql`(${textExpr})::timestamptz <= ${iso}`;
    }
  }
  if (typeof operand === 'string') {
    // Byte order, as memory and the json-path builder compare, not the
    // database collation.
    const s = sql`${textExpr} COLLATE "C"`;
    switch (cmp) {
      case '>':
        return sql`${s} > ${operand}`;
      case '>=':
        return sql`${s} >= ${operand}`;
      case '<':
        return sql`${s} < ${operand}`;
      case '<=':
        return sql`${s} <= ${operand}`;
    }
  }
  // Ordered comparison against something that is neither number, date nor
  // string — booleans, objects, null. Nothing sensible to emit, and emitting
  // nothing silently widened the result set.
  throw new UnsupportedFilterError(
    field,
    cmp,
    `cannot compare against a ${operand === null ? 'null' : typeof operand} value`
  );
}

/**
 * Predicate fragment used by `conditionalUpdate`. Mirrors the equality rules
 * of `read()`'s `eq` operator so a `conditionalUpdate({ consumedAt: null })`
 * matches the same rows a subsequent `read({ where: { consumedAt: { eq: null } } })`
 * would. `null` maps to `IS NULL`; `Date` is compared on the `::timestamptz`
 * cast of the extracted text; scalars compare via the textual representation
 * pg's JSONB `->>` operator returns.
 */
export function conditionalMatchFragment(
  sql: Sql | TransactionSql,
  field: string,
  expected: unknown
): Fragment {
  const textExpr = sql`(body ->> ${field})`;
  if (expected === null || expected === undefined) return sql`${textExpr} IS NULL`;
  if (typeof expected === 'boolean') {
    return sql`${textExpr} = ${expected ? 'true' : 'false'}`;
  }
  if (typeof expected === 'number') {
    return ifJsonNumber(sql, sql`(body -> ${field})`, sql`(${textExpr})::numeric = ${expected}`);
  }
  if (expected instanceof Date) {
    return sql`(${textExpr})::timestamptz = ${expected.toISOString()}`;
  }
  return sql`${textExpr} = ${String(expected)}`;
}

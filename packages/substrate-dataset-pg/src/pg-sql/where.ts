/**
 * WHERE-clause → SQL translation: logical combinators, per-field predicate
 * dispatch (id / shortId / metadata / promoted-column / body-path), the
 * operator-fragment compiler, and the `conditionalUpdate` match fragment.
 */

import { bindingWalks, isJsonPathPredicate, isRefOperand } from '@mnmal-ai/substrate-filter';
import {
  type Id,
  type RefOperand,
  ResolverFrameError,
  UnsupportedFilterError,
  WALK_UNSUPPORTED_REF,
  type WalkAggPredicate,
  type WalkNode,
  type WhereClause
} from '@mnmal-ai/substrate-types';
import type { Sql, TransactionSql } from 'postgres';
import { buildAggPredicate } from './aggregate.js';
import { buildJsonPathPredicate } from './predicates-json-path.js';
import { buildMetadataColumnPredicate } from './predicates-metadata.js';
import { buildPromotedBodyColumnPredicate } from './predicates-promoted.js';
import {
  asJsonValue,
  type BodyOrderByCast,
  bodyJson,
  bodyNum,
  bodyRawText,
  bodyText,
  bodyTs,
  combineAnd,
  combineOr,
  escapeLike,
  type Fragment,
  idToText,
  isMetadataField,
  metaStr,
  notNullAnd,
  type PromotedColumnLookup,
  qualifier,
  scalarParam,
  tsArrayParam,
  tsParam
} from './primitives.js';
import { buildGroup, buildRefCompare, buildWalk, type WalkScope } from './walk.js';

/**
 * The WHERE fragment for `where`, or null when it constrains nothing. With a
 * `scope`, expressions are qualified by `scope.alias` and the walk grammar
 * (`_walk`, `$ref`) compiles; an AND group's `any` walks with `as` become one
 * jointly quantified `EXISTS` (see `buildGroup`). Without one the text is
 * exactly what it was before walks, and `_walk` / `$ref` are refused.
 */
export function buildWhere(
  sql: Sql | TransactionSql,
  where: WhereClause,
  castFor: (field: string) => BodyOrderByCast | null,
  promotedFor: PromotedColumnLookup,
  scope?: WalkScope
): Fragment | null {
  if (where === null || typeof where !== 'object' || Array.isArray(where)) return null;
  const keys = Object.keys(where);
  if (keys.length === 0) return null;
  // As memory's evaluateMembers: an object holding `_agg` is one aggregate comparison.
  if (Object.hasOwn(where, '_agg')) {
    if (scope === undefined) {
      throw new ResolverFrameError(WALK_UNSUPPORTED_REF, `'_agg' is not supported here`);
    }
    return buildAggPredicate(sql, where as WalkAggPredicate, promotedFor, scope);
  }
  if (scope !== undefined && bindingWalks(where).length > 0) {
    return buildGroup(sql, where, castFor, promotedFor, scope);
  }

  // AND/OR/NOT and field keys at one level all AND together, as in memory's
  // evaluateWhere; dropping the field keys beside a combinator widens the read.
  const fragments: Fragment[] = [];
  for (const k of keys) {
    const child = (where as Record<string, unknown>)[k];
    if (k === 'AND' || k === 'OR') {
      if (!Array.isArray(child)) continue;
      const subs: Fragment[] = [];
      for (const sub of child) {
        const frag = buildWhere(sql, sub as WhereClause, castFor, promotedFor, scope);
        if (frag !== null) subs.push(frag);
      }
      if (subs.length > 0)
        fragments.push(k === 'AND' ? combineAnd(sql, subs) : combineOr(sql, subs));
    } else if (k === 'NOT') {
      const inner = buildWhere(sql, child as WhereClause, castFor, promotedFor, scope);
      if (inner !== null) fragments.push(sql`NOT (${inner})`);
    } else if (k === '_walk') {
      if (scope === undefined) {
        throw new ResolverFrameError(WALK_UNSUPPORTED_REF, `'_walk' is not supported here`);
      }
      fragments.push(buildWalk(sql, child as WalkNode, promotedFor, scope));
    } else {
      const frag = buildFieldPredicate(sql, k, child, castFor, promotedFor, scope);
      if (frag !== null) fragments.push(frag);
    }
  }
  if (fragments.length === 0) return null;
  return combineAnd(sql, fragments);
}

/** True when `field` is a predicate key anywhere in the tree, under AND/OR/NOT included. */
export function whereReferencesField(where: unknown, field: string): boolean {
  if (where === null || typeof where !== 'object' || Array.isArray(where)) return false;
  for (const [k, child] of Object.entries(where)) {
    if (k === field) return true;
    if ((k === 'AND' || k === 'OR') && Array.isArray(child)) {
      if (child.some((sub) => whereReferencesField(sub, field))) return true;
    } else if (k === 'NOT' && whereReferencesField(child, field)) return true;
  }
  return false;
}

function buildFieldPredicate(
  sql: Sql | TransactionSql,
  field: string,
  predicate: unknown,
  castFor: (field: string) => BodyOrderByCast | null,
  promotedFor: PromotedColumnLookup,
  scope?: WalkScope
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
  // `$ref` operands compare against another row's field; the rest compile as usual.
  const entries = Object.entries(predicate as Record<string, unknown>);
  if (entries.some(([, v]) => isRefOperand(v))) {
    if (scope === undefined) throw new UnsupportedFilterError(field, '$ref', 'needs a walk scope');
    const frags = entries
      .filter(([, v]) => isRefOperand(v))
      .map(([op, v]) => buildRefCompare(sql, field, op, v as RefOperand, castFor, scope));
    const rest = entries.filter(([, v]) => !isRefOperand(v));
    const restFrag =
      rest.length === 0
        ? null
        : buildFieldPredicate(sql, field, Object.fromEntries(rest), castFor, promotedFor, scope);
    return combineAnd(sql, restFrag === null ? frags : [...frags, restFrag]);
  }
  const alias = scope?.alias;
  // The PK column, not the body: many types don't declare id in body.
  if (field === 'id') {
    return buildIdPredicate(sql, predicate as Record<string, unknown>, alias);
  }
  // shortId is a sidecar-joined field (s.short_id), not a JSONB body field.
  // Route it through the specialised short-id predicate builder. A walk's far
  // row has no join, so it looks its short id up.
  if (field === 'shortId') {
    const col =
      scope === undefined || scope.alias === scope.seedAlias
        ? sql`s.short_id`
        : sql`${sql.unsafe(
            `(SELECT ws.short_id FROM short_ids ws WHERE ws.namespace = ${alias}.namespace AND ws.type = ${alias}.type AND ws.row_id = ${alias}.id LIMIT 1)`
          )}`;
    return buildShortIdPredicate(sql, predicate as Record<string, unknown>, col);
  }
  // Row-metadata fields route to dedicated columns — not body->> extraction.
  if (isMetadataField(field)) {
    return buildMetadataColumnPredicate(sql, field, predicate as Record<string, unknown>, alias);
  }
  // Body-promoted fields route to their dedicated column only (no body
  // fallback). See `PgDatasetOptions.promotedColumns`.
  const promotedField = promotedFor(field);
  if (promotedField !== undefined) {
    return buildPromotedBodyColumnPredicate(
      sql,
      field,
      promotedField,
      predicate as Record<string, unknown>,
      alias
    );
  }
  // Json path predicate. Only an ARRAY-valued `path` — a struct
  // sub-field that happens to be named `path` carries an object and falls
  // through to the struct walk below.
  if (isJsonPathPredicate(predicate)) {
    return buildJsonPathPredicate(sql, field, predicate, alias);
  }
  // Everything else lives in the JSONB body and is addressed by PATH, so that
  // struct sub-clauses can extend it. The dedicated columns above cannot be
  // struct-nested, which is why the split happens here.
  return buildFieldPredicateForPath(sql, [field], predicate, castFor, alias);
}

function buildFieldPredicateForPath(
  sql: Sql | TransactionSql,
  path: string[],
  predicate: unknown,
  castFor: (field: string) => BodyOrderByCast | null,
  alias?: string
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
      const frag = buildBodyPathPredicate(sql, [...path, subField], subPredicate, castFor, alias);
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
    const frag = buildOpFragment(sql, path, op, operand, declaredCast, alias);
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
  castFor: (field: string) => BodyOrderByCast | null,
  alias?: string
): Fragment | null {
  if (predicate === null || typeof predicate !== 'object' || Array.isArray(predicate)) {
    throw new UnsupportedFilterError(
      path.join('.'),
      '<none>',
      `expected a predicate object such as { eq: ... }, got ${Array.isArray(predicate) ? 'an array' : typeof predicate}`
    );
  }
  return buildFieldPredicateForPath(sql, path, predicate, castFor, alias);
}

/**
 * Build WHERE predicates against the native `id` column (the row PK).
 *
 * Range operators compare the text ids lexicographically. Numeric ids
 * stringify cleanly.
 */
function buildIdPredicate(
  sql: Sql | TransactionSql,
  predicate: Record<string, unknown>,
  alias?: string
): Fragment | null {
  const id = sql.unsafe(`${qualifier(alias)}id`);
  const fragments: Fragment[] = [];
  for (const [op, operand] of Object.entries(predicate)) {
    let frag: Fragment | null = null;
    switch (op) {
      case 'eq':
        if (operand === null || operand === undefined) {
          frag = sql`${id} IS NULL`;
        } else {
          frag = sql`${id} = ${idToText(operand as Id)}`;
        }
        break;
      case 'neq':
        if (operand === null || operand === undefined) {
          frag = sql`${id} IS NOT NULL`;
        } else {
          frag = sql`${id} IS DISTINCT FROM ${idToText(operand as Id)}`;
        }
        break;
      case 'in':
        if (Array.isArray(operand) && operand.length > 0) {
          const vals = operand.map((v) => idToText(v as Id));
          frag = sql`${id} IN ${sql(vals)}`;
        } else if (Array.isArray(operand) && operand.length === 0) {
          // Empty IN — match nothing.
          frag = sql`FALSE`;
        }
        break;
      case 'nin':
        if (Array.isArray(operand) && operand.length > 0) {
          const vals = operand.map((v) => idToText(v as Id));
          frag = sql`${id} NOT IN ${sql(vals)}`;
        }
        break;
      case 'contains':
        if (typeof operand === 'string') {
          frag = sql`${id} ILIKE ${`%${escapeLike(operand)}%`}`;
        }
        break;
      case 'startsWith':
        if (typeof operand === 'string') {
          frag = sql`${id} ILIKE ${`${escapeLike(operand)}%`}`;
        }
        break;
      case 'endsWith':
        if (typeof operand === 'string') {
          frag = sql`${id} ILIKE ${`%${escapeLike(operand)}`}`;
        }
        break;
      // Lexicographic string comparisons.
      case 'gt':
        frag = sql`${id} > ${metaStr('id', op, operand)}`;
        break;
      case 'gte':
        frag = sql`${id} >= ${metaStr('id', op, operand)}`;
        break;
      case 'lt':
        frag = sql`${id} < ${metaStr('id', op, operand)}`;
        break;
      case 'lte':
        frag = sql`${id} <= ${metaStr('id', op, operand)}`;
        break;
      case 'between': {
        if (!Array.isArray(operand) || operand.length !== 2) {
          throw new UnsupportedFilterError('id', op, 'requires a two-element [low, high] array');
        }
        frag = sql`${id} BETWEEN ${metaStr('id', op, operand[0])} AND ${metaStr('id', op, operand[1])}`;
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
  predicate: Record<string, unknown>,
  col: Fragment
): Fragment | null {
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
 * Build a single SQL comparison for (field, op, operand). Operands come from
 * callers (attacker-controlled in principle), so every one goes through a
 * parameterised slot. Field names are inlined as escaped literals, so that
 * expression indexes match the compiled text.
 *
 * Case-sensitivity note (design call): `contains` / `startsWith` / `endsWith`
 * use ILIKE for case-INSENSITIVE matching. Memory dataset mirrors this.
 */
function buildOpFragment(
  sql: Sql | TransactionSql,
  path: string[],
  op: string,
  operand: unknown,
  declaredCast: BodyOrderByCast | null,
  alias?: string
): Fragment | null {
  // Dotted path for error messages only.
  const field = path.join('.');
  // A struct path walks with `->` and lands with `->>`
  // (`body -> 'address' ->> 'city'`), keeping intermediate hops jsonb.
  const textExpr = bodyText(sql, path, alias);
  const num = bodyNum(sql, path, alias);
  const ts = bodyTs(sql, path, alias);

  // A `date`-declared field also accepts an ISO-string operand, which operand
  // inference alone would text-compare; compare it as an instant.
  const isTs = (v: unknown): boolean =>
    v instanceof Date || (declaredCast === 'timestamptz' && typeof v === 'string');
  // `<expr> = ANY(values)`: numbers against numeric values, the rest typed by
  // their first member. Never NULL, so `NOT anyOf(...)` is safe.
  const anyOf = (values: unknown[]): Fragment => {
    const nums = values.filter((v): v is number => typeof v === 'number');
    const rest = values.filter((v) => typeof v !== 'number');
    const parts: Fragment[] = [];
    if (nums.length > 0) parts.push(notNullAnd(sql, num, sql`${num} = ANY(${nums})`));
    if (rest.length > 0) {
      parts.push(
        isTs(rest[0])
          ? notNullAnd(sql, ts, sql`${ts} = ANY(${tsArrayParam(sql, rest)})`)
          : notNullAnd(sql, textExpr, sql`${textExpr} = ANY(${rest.map(scalarParam)})`)
      );
    }
    return combineOr(sql, parts);
  };

  switch (op) {
    case 'eq': {
      if (operand === null) return sql`${textExpr} IS NULL`;
      if (typeof operand === 'boolean') {
        // body ->> returns text; compare the text form so booleans work without a cast dance.
        // Inlined, so a generic plan can still match a partial index's predicate.
        return sql`${textExpr} = ${sql.unsafe(operand ? "'true'" : "'false'")}`;
      }
      if (typeof operand === 'number') return notNullAnd(sql, num, sql`${num} = ${operand}`);
      if (isTs(operand)) return notNullAnd(sql, ts, sql`${ts} = ${tsParam(sql, operand)}`);
      return sql`${textExpr} = ${scalarParam(operand)}`;
    }
    case 'neq': {
      if (operand === null) return sql`${textExpr} IS NOT NULL`;
      if (typeof operand === 'boolean') {
        return sql`${textExpr} IS DISTINCT FROM ${sql.unsafe(operand ? "'true'" : "'false'")}`;
      }
      if (typeof operand === 'number') {
        return sql`NOT ${notNullAnd(sql, num, sql`${num} = ${operand}`)}`;
      }
      if (isTs(operand)) return sql`${ts} IS DISTINCT FROM ${tsParam(sql, operand)}`;
      return sql`${textExpr} IS DISTINCT FROM ${scalarParam(operand)}`;
    }
    case 'gt':
      return rangeCmp(sql, path, operand, '>', declaredCast, alias);
    case 'gte':
      return rangeCmp(sql, path, operand, '>=', declaredCast, alias);
    case 'lt':
      return rangeCmp(sql, path, operand, '<', declaredCast, alias);
    case 'lte':
      return rangeCmp(sql, path, operand, '<=', declaredCast, alias);
    case 'between': {
      if (!Array.isArray(operand) || operand.length !== 2) {
        throw new UnsupportedFilterError(field, op, 'requires a two-element [low, high] array');
      }
      const low = operand[0];
      const high = operand[1];
      if (typeof low === 'number' && typeof high === 'number') {
        return notNullAnd(sql, num, sql`${num} BETWEEN ${low} AND ${high}`);
      }
      if (isTs(low) || isTs(high)) {
        return notNullAnd(
          sql,
          ts,
          sql`${ts} BETWEEN ${tsParam(sql, low)} AND ${tsParam(sql, high)}`
        );
      }
      return sql`${textExpr} BETWEEN ${scalarParam(low)} AND ${scalarParam(high)}`;
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
    case 'contains':
    case 'startsWith':
    case 'endsWith': {
      if (typeof operand !== 'string') {
        throw new UnsupportedFilterError(field, op, 'requires a string value');
      }
      // Pattern operators on the body are unindexed; seq-scan accepted.
      const e = escapeLike(operand);
      const pattern = op === 'contains' ? `%${e}%` : op === 'startsWith' ? `${e}%` : `%${e}`;
      return sql`${bodyRawText(sql, path, alias)} ILIKE ${pattern}`;
    }
    case 'has': {
      // List membership: `@>` with a one-element array, preserving native types
      // (10 ≠ "10"); a GIN on `(body -> 'field')` serves it.
      // `sql.json([..])` sends a real jsonb array — a plain stringified value
      // with `::jsonb` would double-encode into a jsonb *string*, not an array.
      const elem = operand instanceof Date ? operand.toISOString() : operand;
      return sql`${bodyJson(sql, path, alias)} @> ${sql.json(asJsonValue([elem]))}`;
    }
    default:
      throw new UnsupportedFilterError(field, op, 'is not a recognised filter operator');
  }
}

/**
 * An ordered compare, typed by the operand: numbers through `substrate_num`,
 * Dates (or ISO-string operands on a `date`-declared field) through
 * `substrate_ts`, plain strings as collated text. A stored value of another
 * shape reads as NULL and never matches.
 */
function rangeCmp(
  sql: Sql | TransactionSql,
  path: string[],
  operand: unknown,
  cmp: '>' | '>=' | '<' | '<=',
  declaredCast: BodyOrderByCast | null,
  alias?: string
): Fragment {
  // Template slots are value slots, so the operator comes from a fixed set.
  const compare = (expr: Fragment, param: number | string | Fragment): Fragment => {
    switch (cmp) {
      case '>':
        return sql`${expr} > ${param}`;
      case '>=':
        return sql`${expr} >= ${param}`;
      case '<':
        return sql`${expr} < ${param}`;
      case '<=':
        return sql`${expr} <= ${param}`;
    }
  };
  if (typeof operand === 'number') {
    const num = bodyNum(sql, path, alias);
    return notNullAnd(sql, num, compare(num, operand));
  }
  if (operand instanceof Date || (declaredCast === 'timestamptz' && typeof operand === 'string')) {
    const ts = bodyTs(sql, path, alias);
    return notNullAnd(sql, ts, compare(ts, tsParam(sql, operand)));
  }
  // Byte order, as memory and the json-path builder compare.
  if (typeof operand === 'string') return compare(bodyText(sql, path, alias), operand);
  // Ordered comparison against something that is neither number, date nor
  // string — booleans, objects, null. Nothing sensible to emit, and emitting
  // nothing silently widened the result set.
  throw new UnsupportedFilterError(
    path.join('.'),
    cmp,
    `cannot compare against a ${operand === null ? 'null' : typeof operand} value`
  );
}

/**
 * Predicate fragment used by `conditionalUpdate`. Mirrors the equality rules
 * of `read()`'s `eq` operator so a `conditionalUpdate({ consumedAt: null })`
 * matches the same rows a subsequent `read({ where: { consumedAt: { eq: null } } })`
 * would. `null` maps to `IS NULL`; a `Date` compares through `substrate_ts`;
 * other scalars compare via the textual representation `->>` returns.
 */
export function conditionalMatchFragment(
  sql: Sql | TransactionSql,
  field: string,
  expected: unknown
): Fragment {
  const textExpr = bodyText(sql, [field]);
  if (expected === null || expected === undefined) return sql`${textExpr} IS NULL`;
  if (typeof expected === 'boolean') {
    return sql`${textExpr} = ${expected ? 'true' : 'false'}`;
  }
  if (typeof expected === 'number') {
    const num = bodyNum(sql, [field]);
    return notNullAnd(sql, num, sql`${num} = ${expected}`);
  }
  if (expected instanceof Date) return sql`${bodyTs(sql, [field])} = ${tsParam(sql, expected)}`;
  return sql`${textExpr} = ${String(expected)}`;
}

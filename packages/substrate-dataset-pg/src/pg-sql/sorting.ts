/**
 * ORDER BY + keyset-cursor → SQL translation.
 *
 * `sortExpr` is the single source for ORDER BY and both halves of the keyset
 * cursor comparison, so sorting and paging cannot diverge.
 */

import { CursorDecodeError } from '@mnmal-ai/substrate-filter';
import type { ExprType, FieldDef, Id } from '@mnmal-ai/substrate-types';
import type { Sql, TransactionSql } from 'postgres';
import type { TypeTable } from '../type-table.js';
import {
  type BodyOrderByCast,
  bodyInt64,
  bodyNum,
  bodyRawText,
  bodyText,
  bodyTs,
  columnAs,
  columnOrderExpr,
  combineAnd,
  combineOr,
  type Fragment,
  idToText,
  isMetadataField,
  METADATA_COLUMNS,
  scalarParam,
  tsParam
} from './primitives.js';

/** The expression an orderBy key sorts by when it names a `select` entry, or undefined for any other key. */
export type ComputedLookup = ((field: string) => Fragment | undefined) & {
  /** The type of a `select` key's value. */
  typeOf?: (field: string) => ExprType | undefined;
};

const noComputed: ComputedLookup = () => undefined;

export { normalizeOrderBy } from '@mnmal-ai/substrate-filter';

/**
 * Maps a FieldDef to the pg cast applied to its `body ->> field` text
 * extraction. Returns `null` for kinds where text compare is correct (string),
 * opaque (json), structural (struct/list/crossRef), or undeclared.
 *
 * Type → cast table:
 *   field.number()  / 'number'  → 'numeric'
 *   field.int64()   / 'int64'   → 'bigint'
 *   field.date()    / 'date'    → 'timestamptz'
 *   field.boolean() / 'boolean' → 'boolean'
 *   field.string()  / 'string'  → null   (text compare is correct)
 *   field.json()    / 'json'    → null   (opaque body — orderBy is rejected
 *                                          by the validator anyway)
 *   crossRef / struct / list   → null   (orderBy on these isn't a scalar
 *                                          comparison; let text-compare
 *                                          surface the bug at validation)
 */
export function resolveBodyOrderByCast(def: FieldDef | undefined): BodyOrderByCast | null {
  if (def === undefined) return null;
  if (def.kind !== 'scalar') return null;
  switch (def.type) {
    case 'number':
      return 'numeric';
    case 'int64':
      return 'bigint';
    case 'date':
      return 'timestamptz';
    case 'boolean':
      return 'boolean';
    default:
      return null;
  }
}

/**
 * `alias` qualifies a type table's columns: in ORDER BY a bare name is the
 * SELECT list's column of that name first, and a date column is projected
 * under its own name as text, which no index on the column serves.
 */
export function buildOrderBy(
  sql: Sql | TransactionSql,
  orderBy: Array<[string, 'asc' | 'desc']>,
  castFor: (field: string) => BodyOrderByCast | null,
  table: TypeTable,
  computedFor: ComputedLookup = noComputed,
  alias?: string
): Fragment {
  if (orderBy.length === 0) return sql``;
  const parts: Fragment[] = [];
  for (const [field, dir] of orderBy) {
    parts.push(orderByFragment(sql, field, dir, castFor(field), table, computedFor, alias));
  }
  if (parts.length === 1) return sql`ORDER BY ${parts[0] as Fragment}`;
  // Flat composition, as in combineAnd.
  const commaFragment = sql`,`;
  const interleaved: Fragment[] = [parts[0] as Fragment];
  for (let i = 1; i < parts.length; i++) {
    interleaved.push(commaFragment, parts[i] as Fragment);
  }
  return sql`ORDER BY ${interleaved}`;
}

/**
 * The SQL expression a field SORTS BY — the single source for ORDER BY and for
 * both halves of the keyset cursor comparison.
 *
 * Do not case out field kinds anywhere else: if sorting and paging use
 * different expressions, rows silently vanish from later pages.
 */
function sortExpr(
  sql: Sql | TransactionSql,
  field: string,
  bodyCast: BodyOrderByCast | null,
  table: TypeTable,
  computedFor: ComputedLookup,
  alias?: string
): Fragment {
  if (field === 'id') return sql`id`;
  const computed = computedFor(field);
  if (computed !== undefined) return computed;
  // shortId lives on the LEFT-joined sidecar. Without this branch it falls
  // through to `body ->> 'shortId'`, which is always NULL — every row collapses
  // to insertion order regardless of direction.
  if (field === 'shortId') return sql`s.short_id`;
  // Metadata columns are drawn from closed constant maps, never from
  // caller input — the `sql.unsafe` contract in this file's header.
  // Text columns sort by byte order (COLLATE "C"), as body text and the
  // memory dataset do, whatever the database collation.
  if (isMetadataField(field)) {
    const col = METADATA_COLUMNS[field];
    return field === 'createdAt' || field === 'updatedAt' || field === 'seq'
      ? sql.unsafe(col)
      : sql.unsafe(`${col} COLLATE "C"`);
  }
  // A type table's column field sorts by its column's kind.
  const column = table.column(field);
  if (column !== undefined) return columnOrderExpr(sql, table, column, alias);
  // Body field: cast by declared kind when known, else text compare.
  return bodyOrderByExpr(sql, field, bodyCast, table);
}

/**
 * Projects each non-`id` ORDER BY field's sort expression alongside the row,
 * so the keyset cursor's value comes from the expression that sorted, not the
 * materialized row (which holds only the projected fields). Returns the SELECT
 * fragment and the field → alias map.
 *
 * Aliases are POSITIONAL (`__sort_0`, ...), not field-derived: pg truncates
 * identifiers at 63 bytes, so long field names could collide.
 */
export function buildSortKeyProjection(
  sql: Sql | TransactionSql,
  orderBy: Array<[string, 'asc' | 'desc']>,
  castFor: (field: string) => BodyOrderByCast | null,
  table: TypeTable,
  computedFor: ComputedLookup = noComputed
): { fragment: Fragment; aliases: Map<string, string> } {
  const aliases = new Map<string, string>();
  const fragments: Fragment[] = [];
  for (const [field] of orderBy) {
    // `id` is carried by the cursor in its own right, never as an orderByValue.
    if (field === 'id' || aliases.has(field)) continue;
    const alias = `__sort_${aliases.size}`;
    aliases.set(field, alias);
    const cast = castFor(field);
    const expr = sortExpr(sql, field, cast, table, computedFor);
    // A timestamptz key comes back as a JS Date, which keeps milliseconds only:
    // `.123456` would round-trip as `.123` and the next page would re-serve (asc)
    // or skip (desc) the cursor row. Text keeps every digit; `sortParam` casts
    // it back to timestamptz.
    fragments.push(
      sortKeyIsTimestamp(field, cast, table, computedFor)
        ? sql`, (${expr})::text AS ${sql(alias)}`
        : sql`, ${expr} AS ${sql(alias)}`
    );
  }
  if (fragments.length === 0) return { fragment: sql``, aliases };
  return { fragment: fragments as unknown as Fragment, aliases };
}

/** Whether `buildSortKeyProjection` projects the field's key as timestamptz text. */
function sortKeyIsTimestamp(
  field: string,
  cast: BodyOrderByCast | null,
  table: TypeTable,
  computedFor: ComputedLookup = noComputed
): boolean {
  if (computedFor(field) !== undefined) return computedFor.typeOf?.(field) === 'date';
  if (field === 'createdAt' || field === 'updatedAt') return true;
  if (isMetadataField(field)) return false;
  const column = table.column(field);
  return column === undefined ? cast === 'timestamptz' : column.kind === 'date';
}

/**
 * `buildOrderBy` re-expressed over a subquery `rel` that projected the sort
 * keys under `aliases` (from `buildSortKeyProjection`) and `id`. Same
 * directions and NULLS LAST; a timestamp key, projected as text, casts back
 * so it orders as a timestamp.
 */
export function buildProjectedOrderBy(
  sql: Sql | TransactionSql,
  orderBy: Array<[string, 'asc' | 'desc']>,
  aliases: Map<string, string>,
  castFor: (field: string) => BodyOrderByCast | null,
  table: TypeTable,
  rel: string,
  computedFor: ComputedLookup = noComputed
): Fragment {
  const parts: string[] = [];
  for (const [field, dir] of orderBy) {
    let expr: string;
    if (field === 'id') {
      expr = `${rel}.id`;
    } else {
      const alias = aliases.get(field);
      if (alias === undefined) throw new Error(`orderBy key '${field}' has no projected alias`);
      expr = sortKeyIsTimestamp(field, castFor(field), table, computedFor)
        ? `${rel}.${alias}::timestamptz`
        : `${rel}.${alias}`;
    }
    parts.push(`${expr} ${dir === 'asc' ? 'ASC' : 'DESC'} NULLS LAST`);
  }
  // `rel` is a caller constant and aliases are positional `__sort_<n>`, so
  // nothing from caller input reaches `sql.unsafe`.
  return parts.length === 0 ? sql`` : sql.unsafe(`ORDER BY ${parts.join(', ')}`);
}

/**
 * The parameter side of a comparison against `sortExpr(field)`, cast to match
 * it. Keep its cases in step with `sortExpr`.
 */
function sortParam(
  sql: Sql | TransactionSql,
  field: string,
  value: unknown,
  bodyCast: BodyOrderByCast | null,
  table: TypeTable,
  computedFor: ComputedLookup
): Fragment {
  if (field === 'id') return sql`${idToText(value as Id)}`;
  if (computedFor(field) !== undefined) {
    const type = computedFor.typeOf?.(field) ?? 'number';
    // A cursor carries an int64 as decimal text and a date as text.
    if (type === 'int64') return sql`${String(value)}::bigint`;
    if (type === 'date') return tsParam(sql, value);
    if (type === 'string') return sql`${String(value)}::text`;
    if (type === 'boolean') return sql`${Boolean(value)}::boolean`;
    // A number key is float8; a cursor value that is not a finite number was not issued here.
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new CursorDecodeError(`cursor value for '${field}' is not a finite number`);
    }
    return sql`${value}::float8`;
  }
  if (field === 'shortId') return sql`${value as number}`;
  if (field === 'seq') return sql`${String(value)}::bigint`;
  if (isMetadataField(field)) {
    // Timestamp columns compare as timestamptz so the btree index is usable;
    // the string columns compare directly.
    return field === 'createdAt' || field === 'updatedAt'
      ? tsParam(sql, value)
      : sql`${value as string}`;
  }
  const column = table.column(field);
  if (column !== undefined) {
    switch (columnAs(column.kind)) {
      case 'date':
        return tsParam(sql, value);
      case 'number':
        // numeric, as a promoting field's key is; a float8 column takes it as float8.
        return sql`${value as number}::numeric`;
      case 'int64':
        // A cursor carries an int64 as its decimal text.
        return sql`${String(value)}::bigint`;
      case 'boolean':
        return sql`${Boolean(value)}::boolean`;
      default:
        return sql`${String(value)}::text`;
    }
  }
  return castParam(sql, value, bodyCast);
}

function orderByFragment(
  sql: Sql | TransactionSql,
  field: string,
  dir: 'asc' | 'desc',
  bodyCast: BodyOrderByCast | null,
  table: TypeTable,
  computedFor: ComputedLookup,
  alias?: string
): Fragment {
  const expr = sortExpr(sql, field, bodyCast, table, computedFor, alias);
  // NULLS LAST in both directions, matching the memory dataset.
  // `cursorCmpFragment` must agree or pagination drops the null rows.
  return dir === 'asc' ? sql`${expr} ASC NULLS LAST` : sql`${expr} DESC NULLS LAST`;
}

/**
 * The body-field expression for a sort: the filter compiler's expression for
 * the declared kind, so an expression index serves both. A wrong-shaped number
 * or date reads as NULL and sorts last.
 */
function bodyOrderByExpr(
  sql: Sql | TransactionSql,
  field: string,
  cast: BodyOrderByCast | null,
  table: TypeTable
): Fragment {
  switch (cast) {
    case null:
      // Byte order, matching memory's sort and the body filters' string compares.
      return bodyText(sql, [field], undefined, table.jsonb);
    case 'numeric':
      return bodyNum(sql, [field], undefined, table.jsonb);
    case 'bigint':
      return bodyInt64(sql, [field], undefined, table.jsonb);
    case 'timestamptz':
      return bodyTs(sql, [field], undefined, table.jsonb);
    case 'boolean':
      return sql`${bodyRawText(sql, [field], undefined, table.jsonb)}::boolean`;
  }
}

/**
 * Cursor tuple compare. For `ORDER BY a ASC, b DESC, id ASC`, the "next page"
 * predicate is the OR of equality-prefixes:
 *    (a > cursor.a)
 *    OR (a = cursor.a AND b < cursor.b)
 *    OR (a = cursor.a AND b = cursor.b AND id > cursor.id)
 *
 * A top-level OR cannot be an index condition, so a nullable leading key `a`
 * is bounded instead, and only its non-null rows are matched; the null tail
 * after a non-null cursor is `buildCursorNullTail`'s second query:
 *    cursor.a NOT NULL — a >= cursor.a AND (a > cursor.a OR (a = cursor.a AND <rest>))
 *                        (`<=` and `<` for DESC)
 *    cursor.a IS NULL  — a IS NULL AND <rest>
 * where `<rest>` is the disjunction over the later keys. A leading `id` is
 * NOT NULL and keeps the plain disjunction, whose first arm is sargable.
 *
 * We build the disjunction explicitly — postgres's ROW(...) tuple compare
 * would be simpler but doesn't honour per-column direction mixing.
 */
export function buildCursorCompare(
  sql: Sql | TransactionSql,
  orderBy: Array<[string, 'asc' | 'desc']>,
  values: unknown[],
  cursorId: Id,
  castFor: (field: string) => BodyOrderByCast | null,
  table: TypeTable,
  computedFor: ComputedLookup = noComputed
): Fragment | null {
  const resolved = resolveCursorKeys(orderBy, values, cursorId);
  const [lead, ...rest] = resolved;
  if (lead === undefined) return null;
  if (lead.field === 'id') return cursorDisjunction(sql, resolved, castFor, table, computedFor);
  const restCmp = cursorDisjunction(sql, rest, castFor, table, computedFor);
  const cast = castFor(lead.field);
  const eq = cursorEqFragment(sql, lead.field, lead.value, cast, table, computedFor);
  if (lead.value === null || lead.value === undefined) return combineAnd(sql, [eq, restCmp]);
  // `op` is one of four constants, never caller input.
  const cmp = (op: '<' | '<=' | '>' | '>='): Fragment =>
    sql`${sortExpr(sql, lead.field, cast, table, computedFor)} ${sql.unsafe(op)} ${sortParam(sql, lead.field, lead.value, cast, table, computedFor)}`;
  const asc = lead.dir === 'asc';
  return combineAnd(sql, [
    cmp(asc ? '>=' : '<='),
    combineOr(sql, [cmp(asc ? '>' : '<'), combineAnd(sql, [eq, restCmp])])
  ]);
}

/**
 * The null tail that follows a cursor under NULLS LAST: `lead IS NULL` when
 * the leading key is nullable (not `id`) and the cursor's leading value is
 * not null, else null. Every row it matches sorts after the cursor, so the
 * tail query needs no other cursor condition. `createdAt` and `updatedAt` count
 * as nullable: their columns are nullable in both baselines.
 */
export function buildCursorNullTail(
  sql: Sql | TransactionSql,
  orderBy: Array<[string, 'asc' | 'desc']>,
  values: unknown[],
  castFor: (field: string) => BodyOrderByCast | null,
  table: TypeTable,
  computedFor: ComputedLookup = noComputed
): Fragment | null {
  const lead = orderBy[0];
  if (lead === undefined || lead[0] === 'id') return null;
  if (values[0] === null || values[0] === undefined) return null;
  return sql`${sortExpr(sql, lead[0], castFor(lead[0]), table, computedFor)} IS NULL`;
}

type CursorKey = { field: string; dir: 'asc' | 'desc'; value: unknown };

/** Pairs each orderBy key with its cursor value: `id` from `cursorId`, the rest from `values` in order. */
function resolveCursorKeys(
  orderBy: Array<[string, 'asc' | 'desc']>,
  values: unknown[],
  cursorId: Id
): CursorKey[] {
  const resolved: CursorKey[] = [];
  let nonIdIdx = 0;
  for (const [field, dir] of orderBy) {
    if (field === 'id') {
      resolved.push({ field, dir, value: cursorId });
    } else {
      resolved.push({ field, dir, value: values[nonIdIdx] });
      nonIdIdx++;
    }
  }
  return resolved;
}

/** The OR over i of (eq₁ AND ... AND eqᵢ₋₁ AND cmpᵢ). */
function cursorDisjunction(
  sql: Sql | TransactionSql,
  resolved: CursorKey[],
  castFor: (field: string) => BodyOrderByCast | null,
  table: TypeTable,
  computedFor: ComputedLookup
): Fragment {
  const orParts: Fragment[] = [];
  for (let i = 0; i < resolved.length; i++) {
    const parts: Fragment[] = [];
    for (let j = 0; j < i; j++) {
      const prior = resolved[j] as CursorKey;
      parts.push(
        cursorEqFragment(sql, prior.field, prior.value, castFor(prior.field), table, computedFor)
      );
    }
    const cur = resolved[i] as CursorKey;
    parts.push(
      cursorCmpFragment(sql, cur.field, cur.dir, cur.value, castFor(cur.field), table, computedFor)
    );
    orParts.push(combineAnd(sql, parts));
  }
  return combineOr(sql, orParts);
}

/**
 * Equality against the sort key, for the `eq₁ AND ... AND cmpᵢ` prefix of the
 * keyset disjunction. A NULL sort key compares with `IS NULL`, never `= NULL`.
 */
function cursorEqFragment(
  sql: Sql | TransactionSql,
  field: string,
  value: unknown,
  bodyCast: BodyOrderByCast | null,
  table: TypeTable,
  computedFor: ComputedLookup
): Fragment {
  const expr = sortExpr(sql, field, bodyCast, table, computedFor);
  if (value === null || value === undefined) return sql`${expr} IS NULL`;
  return sql`${expr} = ${sortParam(sql, field, value, bodyCast, table, computedFor)}`;
}

/**
 * "Strictly after the cursor" for one sort key, under `NULLS LAST`. On a
 * nullable key a bare `expr > $1` would exclude null rows, since `NULL > x` is NULL.
 * Used for the keys after a nullable leading key, which `buildCursorCompare`
 * bounds instead. The two cases:
 *
 *   cursor value NOT NULL — the rows after it are the ones further along in
 *     direction, PLUS the entire null tail, hence the `OR ... IS NULL`.
 *   cursor value IS NULL — nothing sorts after a null, so no row qualifies on
 *     THIS key and the disjunction must fall through to the next one. `false`
 *     is the correct answer, not `IS NULL`: the outer construction pairs this
 *     with `eq` on the preceding keys, and returning `IS NULL` here would
 *     re-emit every null row that has already been served.
 */
function cursorCmpFragment(
  sql: Sql | TransactionSql,
  field: string,
  dir: 'asc' | 'desc',
  value: unknown,
  bodyCast: BodyOrderByCast | null,
  table: TypeTable,
  computedFor: ComputedLookup
): Fragment {
  const expr = sortExpr(sql, field, bodyCast, table, computedFor);
  if (value === null || value === undefined) return sql`false`;
  const param = sortParam(sql, field, value, bodyCast, table, computedFor);
  // `id` is NOT NULL in both baselines: no null tail, and a bare compare is
  // sargable. Every other sort key's column or expression can be null.
  if (field === 'id') return dir === 'asc' ? sql`${expr} > ${param}` : sql`${expr} < ${param}`;
  return dir === 'asc'
    ? sql`(${expr} > ${param} OR ${expr} IS NULL)`
    : sql`(${expr} < ${param} OR ${expr} IS NULL)`;
}

/**
 * The parameter side of a body-field cursor compare, with the cast matching
 * the orderBy expression: `castParam(sql, 5, 'numeric')` → `$N::numeric`.
 * Returns the bare parameter when `cast === null`.
 */
function castParam(
  sql: Sql | TransactionSql,
  value: unknown,
  cast: BodyOrderByCast | null
): Fragment {
  if (cast === 'timestamptz') return tsParam(sql, value);
  const param = scalarParam(value);
  if (cast === null) return sql`${param as string | number | boolean | null}`;
  // Coerce JS booleans/numbers/strings into the bound pg type. The
  // `sql.unsafe` only emits the closed-set cast suffix; the value travels
  // through the parameterised slot.
  return sql`${param as string | number | boolean | null}${sql.unsafe(`::${cast}`)}`;
}

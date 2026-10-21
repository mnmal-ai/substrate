/**
 * ORDER BY + keyset-cursor → SQL translation.
 *
 * `sortExpr` is the single source for ORDER BY and both halves of the keyset
 * cursor comparison, so sorting and paging cannot diverge.
 */

import type { FieldDef, Id, OrderByClause } from '@mnmal-ai/substrate-types';
import type { Sql, TransactionSql } from 'postgres';
import {
  type BodyOrderByCast,
  combineAnd,
  combineOr,
  type Fragment,
  idToText,
  isMetadataField,
  METADATA_COLUMNS,
  type PromotedColumnLookup,
  promotedColumnSql,
  scalarParam
} from './primitives.js';

export function normalizeOrderBy(
  orderBy: OrderByClause[] | undefined
): Array<[string, 'asc' | 'desc']> {
  const out: Array<[string, 'asc' | 'desc']> = [];
  if (orderBy !== undefined) {
    for (const clause of orderBy) {
      for (const [field, dir] of Object.entries(clause) as Array<[string, 'asc' | 'desc']>) {
        out.push([field, dir]);
      }
    }
  }
  const hasId = out.some(([f]) => f === 'id');
  if (!hasId) out.push(['id', 'asc']);
  return out;
}

/**
 * Maps a FieldDef to the pg cast applied to its `body ->> field` text
 * extraction. Returns `null` for kinds where text compare is correct (string),
 * opaque (json), structural (struct/list/crossRef), or undeclared.
 *
 * Type → cast table:
 *   field.number()  / 'number'  → 'numeric'
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
    case 'date':
      return 'timestamptz';
    case 'boolean':
      return 'boolean';
    default:
      return null;
  }
}

export function buildOrderBy(
  sql: Sql | TransactionSql,
  orderBy: Array<[string, 'asc' | 'desc']>,
  castFor: (field: string) => BodyOrderByCast | null,
  promotedFor: PromotedColumnLookup
): Fragment {
  if (orderBy.length === 0) return sql``;
  const parts: Fragment[] = [];
  for (const [field, dir] of orderBy) {
    parts.push(orderByFragment(sql, field, dir, castFor(field), promotedFor));
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
  promotedFor: PromotedColumnLookup
): Fragment {
  if (field === 'id') return sql`id`;
  // shortId lives on the LEFT-joined sidecar. Without this branch it falls
  // through to `body ->> 'shortId'`, which is always NULL — every row collapses
  // to insertion order regardless of direction.
  if (field === 'shortId') return sql`s.short_id`;
  // Metadata + promoted columns are drawn from closed constant maps, never from
  // caller input — the `sql.unsafe` contract in this file's header.
  if (isMetadataField(field)) return sql.unsafe(METADATA_COLUMNS[field]);
  const promoted = promotedFor(field);
  if (promoted !== undefined) return sql.unsafe(promotedColumnSql(promoted));
  // Body field: cast by declared kind when known, else text compare.
  return bodyOrderByExpr(sql, field, bodyCast);
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
  promotedFor: PromotedColumnLookup
): { fragment: Fragment; aliases: Map<string, string> } {
  const aliases = new Map<string, string>();
  const fragments: Fragment[] = [];
  for (const [field] of orderBy) {
    // `id` is carried by the cursor in its own right, never as an orderByValue.
    if (field === 'id' || aliases.has(field)) continue;
    const alias = `__sort_${aliases.size}`;
    aliases.set(field, alias);
    fragments.push(sql`, ${sortExpr(sql, field, castFor(field), promotedFor)} AS ${sql(alias)}`);
  }
  if (fragments.length === 0) return { fragment: sql``, aliases };
  return { fragment: fragments as unknown as Fragment, aliases };
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
  promotedFor: PromotedColumnLookup
): Fragment {
  if (field === 'id') return sql`${idToText(value as Id)}`;
  if (field === 'shortId') return sql`${value as number}`;
  if (isMetadataField(field)) {
    // Timestamp columns compare as timestamptz so the btree index is usable;
    // the string columns compare directly.
    return field === 'createdAt' || field === 'updatedAt'
      ? sql`${value as string}::timestamptz`
      : sql`${value as string}`;
  }
  const promoted = promotedFor(field);
  if (promoted !== undefined) {
    // The column is typed, so bind the operand to that type rather than letting
    // pg infer from a text literal.
    return promoted.kind === 'boolean'
      ? sql`${Boolean(value)}::boolean`
      : sql`${String(value)}::text`;
  }
  return castParam(sql, value, bodyCast);
}

function orderByFragment(
  sql: Sql | TransactionSql,
  field: string,
  dir: 'asc' | 'desc',
  bodyCast: BodyOrderByCast | null,
  promotedFor: PromotedColumnLookup
): Fragment {
  const expr = sortExpr(sql, field, bodyCast, promotedFor);
  // NULLS LAST in both directions, matching the memory dataset.
  // `cursorCmpFragment` must agree or pagination drops the null rows.
  return dir === 'asc' ? sql`${expr} ASC NULLS LAST` : sql`${expr} DESC NULLS LAST`;
}

/**
 * The body-field extraction expression for a sort, with the cast applied when
 * one is given. `sql.unsafe` emits only the closed `BodyOrderByCast` suffix;
 * `field` is parameterised.
 */
function bodyOrderByExpr(
  sql: Sql | TransactionSql,
  field: string,
  cast: BodyOrderByCast | null
): Fragment {
  // Byte order, matching memory's sort and the body filters' string compares.
  if (cast === null) return sql`(body ->> ${field}) COLLATE "C"`;
  return sql`(body ->> ${field})${sql.unsafe(`::${cast}`)}`;
}

/**
 * Cursor tuple compare. For `ORDER BY a ASC, b DESC, id ASC`, the "next page"
 * predicate is:
 *    (a > cursor.a)
 *    OR (a = cursor.a AND b < cursor.b)
 *    OR (a = cursor.a AND b = cursor.b AND id > cursor.id)
 *
 * We build the OR of equality-prefixes explicitly — postgres's ROW(...) tuple
 * compare would be simpler but doesn't honour per-column direction mixing.
 */
export function buildCursorCompare(
  sql: Sql | TransactionSql,
  orderBy: Array<[string, 'asc' | 'desc']>,
  values: unknown[],
  cursorId: Id,
  castFor: (field: string) => BodyOrderByCast | null,
  promotedFor: PromotedColumnLookup
): Fragment | null {
  if (orderBy.length === 0) return null;

  // Resolve the cursor value for each orderBy clause. Non-id clauses consume
  // from `values` in order; id always pulls from `cursorId`.
  const resolved: Array<{ field: string; dir: 'asc' | 'desc'; value: unknown }> = [];
  let nonIdIdx = 0;
  for (const [field, dir] of orderBy) {
    if (field === 'id') {
      resolved.push({ field, dir, value: cursorId });
    } else {
      resolved.push({ field, dir, value: values[nonIdIdx] });
      nonIdIdx++;
    }
  }

  // Build (eq₁ AND eq₂ AND ... AND eqᵢ₋₁ AND cmpᵢ) for each i.
  const orParts: Fragment[] = [];
  for (let i = 0; i < resolved.length; i++) {
    const parts: Fragment[] = [];
    for (let j = 0; j < i; j++) {
      const prior = resolved[j] as (typeof resolved)[number];
      parts.push(
        cursorEqFragment(sql, prior.field, prior.value, castFor(prior.field), promotedFor)
      );
    }
    const cur = resolved[i] as (typeof resolved)[number];
    parts.push(
      cursorCmpFragment(sql, cur.field, cur.dir, cur.value, castFor(cur.field), promotedFor)
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
  promotedFor: PromotedColumnLookup
): Fragment {
  const expr = sortExpr(sql, field, bodyCast, promotedFor);
  if (value === null || value === undefined) return sql`${expr} IS NULL`;
  return sql`${expr} = ${sortParam(sql, field, value, bodyCast, promotedFor)}`;
}

/**
 * "Strictly after the cursor" for one sort key, under `NULLS LAST`. A bare
 * `expr > $1` would exclude null rows, since `NULL > x` is NULL. The two cases:
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
  promotedFor: PromotedColumnLookup
): Fragment {
  const expr = sortExpr(sql, field, bodyCast, promotedFor);
  if (value === null || value === undefined) return sql`false`;
  const param = sortParam(sql, field, value, bodyCast, promotedFor);
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
  const param = scalarParam(value);
  if (cast === null) return sql`${param as string | number | boolean | null}`;
  // Coerce JS booleans/numbers/strings into the bound pg type. The
  // `sql.unsafe` only emits the closed-set cast suffix; the value travels
  // through the parameterised slot.
  return sql`${param as string | number | boolean | null}${sql.unsafe(`::${cast}`)}`;
}

/**
 * Walk aggregates (`_agg`, in fields and where) and nested projection,
 * compiled to SQL (spec 2026-10-24-typed-edge-walks §1, §3, §5). The memory
 * reference (`@mnmal-ai/substrate-filter` walk.ts `applyAgg`, and the memory
 * dataset's `walkProjection`) is what these fragments answer:
 *
 * - an aggregate is a correlated scalar subquery over the hop's live rows
 *   that pass the walk's `where`, valued as jsonb exactly as memory returns
 *   it: a count, float8 avg/sum/min/max over numbers, and for a date min/max
 *   or a `latest` the winning row's STORED value (ties id ascending, nulls last);
 * - a nested list is `jsonb_agg` over `ORDER BY …, id LIMIT limit+1`; the
 *   extra row only says the list was cut, as `_truncated: { <name>: true }`.
 *
 * The tree is assumed validated (substrate-core walk-validator).
 */

import { isDateField, isRefOperand } from '@mnmal-ai/substrate-filter';
import {
  type NestedSelection,
  UnsupportedFilterError,
  type WalkAgg,
  type WalkAggPredicate,
  type WhereClause
} from '@mnmal-ai/substrate-types';
import type { Sql, TransactionSql } from 'postgres';
import { metadataColumnSql } from './predicates-metadata.js';
import {
  bodyJson,
  combineAnd,
  type Fragment,
  isMetadataField,
  NON_BODY_FIELD_KEYS,
  type PromotedColumnLookup,
  tsParam
} from './primitives.js';
import { buildObject } from './projection.js';
import { normalizeOrderBy, resolveBodyOrderByCast } from './sorting.js';
import {
  compareRef,
  float8Lit,
  hop,
  refOperand,
  refValue,
  sortKey,
  type WalkScope
} from './walk.js';
import { buildWhere } from './where.js';

/** How an aggregate's value compares: as a number, as an instant, or as stored. */
type AggKind = 'number' | 'date' | 'other';

const AGG_OPS = ['avg', 'sum', 'min', 'max'] as const;

/** A field of `alias`'s row as memory's `getFieldValue` reads it, as jsonb. */
function valueJson(sql: Sql | TransactionSql, field: string, alias: string): Fragment {
  if (!isMetadataField(field)) return bodyJson(sql, [field], alias);
  const col = metadataColumnSql(field, alias);
  // As `materialize` renders a timestamp column: a JS Date's ISO string.
  return sql.unsafe(
    field === 'createdAt' || field === 'updatedAt'
      ? `to_jsonb(to_char(${col} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))`
      : `to_jsonb(${col})`
  );
}

/**
 * A walk aggregate for `scope`'s row: a scalar subquery valued as jsonb (SQL
 * NULL or jsonb null where memory gives null), and the kind it compares as.
 */
export function buildWalkAgg(
  sql: Sql | TransactionSql,
  spec: WalkAgg,
  promotedFor: PromotedColumnLookup,
  scope: WalkScope
): { value: Fragment; kind: AggKind } {
  const alias = scope.nextAlias();
  const a = sql.unsafe(alias);
  const { type, cond } = hop(sql, spec, scope, alias);
  const far =
    spec.where === undefined
      ? null
      : buildWhere(
          sql,
          spec.where,
          (f) => resolveBodyOrderByCast(scope.fieldDef(type, f)),
          promotedFor,
          { ...scope, alias, type }
        );
  const rows = (extra?: Fragment) =>
    combineAnd(sql, [
      cond,
      ...(far === null ? [] : [far]),
      ...(extra === undefined ? [] : [extra])
    ]);
  const isDate = (f: string) => isDateField(f, (x) => scope.fieldDef(type, x));
  // The winning row's stored `value`, ordered by `key`, ties id ascending.
  const pickValue = (value: string, key: Fragment, dir: string, extra?: Fragment) =>
    sql`(SELECT ${valueJson(sql, value, alias)} FROM rows ${a} WHERE ${rows(extra)} ORDER BY ${key} ${sql.unsafe(dir)} NULLS LAST, ${a}.id COLLATE "C" ASC LIMIT 1)`;

  if (Object.hasOwn(spec, 'count')) {
    return {
      value: sql`(SELECT to_jsonb(count(*)) FROM rows ${a} WHERE ${rows()})`,
      kind: 'number'
    };
  }
  if ('latest' in spec && Object.hasOwn(spec, 'latest')) {
    const { by, value } = spec.latest;
    const key = sortKey(sql, by, resolveBodyOrderByCast(scope.fieldDef(type, by)), alias);
    const numeric =
      value === 'seq' || resolveBodyOrderByCast(scope.fieldDef(type, value)) === 'numeric';
    return {
      value: pickValue(value, key, 'DESC'),
      kind: isDate(value) ? 'date' : numeric ? 'number' : 'other'
    };
  }
  const op = AGG_OPS.find((k) => Object.hasOwn(spec, k));
  if (op === undefined) throw new Error('internal: aggregate names no function');
  const field = (spec as unknown as Record<string, string>)[op] as string;
  if ((op === 'min' || op === 'max') && isDate(field)) {
    // Unreadable dates drop out, as memory's pick puts them last and then nulls them.
    const ts = refValue(sql, field, 'date', alias);
    return {
      value: pickValue(field, ts, op === 'min' ? 'ASC' : 'DESC', sql`${ts} IS NOT NULL`),
      kind: 'date'
    };
  }
  // float8 throughout, so the value is the double memory computes.
  const n = refValue(sql, field, 'number', alias);
  return {
    value: sql`(SELECT to_jsonb(${sql.unsafe(op)}(${n})) FROM rows ${a} WHERE ${rows()})`,
    kind: 'number'
  };
}

/**
 * `{ _agg, <cmp>: operand }`: never NULL, false for a null aggregate or a
 * null operand. Dates compare as instants; a number operand (or any operand
 * of a number aggregate) as float8; anything else as stored, eq/neq by jsonb
 * equality and ranges by text in byte order, as memory's `applyOp`.
 */
export function buildAggPredicate(
  sql: Sql | TransactionSql,
  where: WalkAggPredicate,
  promotedFor: PromotedColumnLookup,
  scope: WalkScope
): Fragment {
  const { value, kind } = buildWalkAgg(sql, where._agg, promotedFor, scope);
  const x = scope.nextAlias();
  const v = sql.unsafe(`${x}.v`);
  const parts: Fragment[] = [sql`${v} IS NOT NULL AND ${v} <> 'null'::jsonb`];
  for (const [op, raw] of Object.entries(where)) {
    if (op === '_agg') continue;
    if (raw == null) {
      parts.push(sql`FALSE`);
    } else if (isRefOperand(raw)) {
      if (kind === 'other') {
        throw new UnsupportedFilterError('_agg', op, 'a $ref compares number or date aggregates');
      }
      const left = kind === 'date' ? sql`substrate_ts(${v})` : sql`substrate_num(${v})::float8`;
      parts.push(compareRef(sql, '_agg', op, left, refOperand(sql, '_agg', op, raw, kind, scope)));
    } else if (kind === 'date') {
      parts.push(compareRef(sql, '_agg', op, sql`substrate_ts(${v})`, tsParam(sql, raw)));
    } else if (kind === 'number' || typeof raw === 'number') {
      const right = float8Lit(sql, '_agg', op, raw);
      parts.push(compareRef(sql, '_agg', op, sql`substrate_num(${v})::float8`, right));
    } else if (op === 'eq' || op === 'neq') {
      parts.push(
        sql`${v} ${sql.unsafe(op === 'eq' ? '=' : '<>')} ${JSON.stringify(raw)}::text::jsonb`
      );
    } else {
      const text = sql`(${v} #>> '{}') COLLATE "C"`;
      parts.push(compareRef(sql, '_agg', op, text, sql`${String(raw)}::text`));
    }
  }
  return sql`EXISTS (SELECT 1 FROM (SELECT ${value} AS v) ${sql.unsafe(x)} WHERE ${combineAnd(sql, parts)})`;
}

const isNested = (v: unknown): v is NestedSelection =>
  typeof v === 'object' && v !== null && Object.hasOwn(v, '_walk');

/**
 * A row's walk selections as one jsonb object: `_agg`, each nested list and,
 * only when a list was cut, `_truncated`. Null when there are none. Each list
 * is computed once, in a FROM-less subquery, and read twice: its first
 * `limit` rows, and whether it holds one more.
 */
export function buildWalkProjection(
  sql: Sql | TransactionSql,
  aggs: Record<string, WalkAgg> | undefined,
  nested: Record<string, NestedSelection>,
  promotedFor: PromotedColumnLookup,
  scope: WalkScope
): Fragment | null {
  const pairs: Fragment[] = [];
  if (aggs !== undefined) {
    const values = Object.entries(aggs).map(
      ([name, spec]) => sql`${name}::text, ${buildWalkAgg(sql, spec, promotedFor, scope).value}`
    );
    pairs.push(sql`'_agg'::text, ${buildObject(sql, values)}`);
  }
  const lists = Object.entries(nested);
  if (lists.length === 0) return pairs.length === 0 ? null : buildObject(sql, pairs);
  const x = scope.nextAlias();
  const cols: Fragment[] = [];
  const cut: Fragment[] = [];
  for (const [i, [name, sel]] of lists.entries()) {
    const col = sql.unsafe(`${x}.c${i}`);
    cols.push(sql`${buildNested(sql, sel, promotedFor, scope)} AS ${sql.unsafe(`c${i}`)}`);
    if (sel.limit === undefined) {
      pairs.push(sql`${name}::text, ${col}`);
    } else {
      // jsonb - n drops element n, the look-ahead row, if there is one.
      pairs.push(sql`${name}::text, ${col} - ${sel.limit}::int`);
      cut.push(
        sql`${name}::text, CASE WHEN jsonb_array_length(${col}) > ${sel.limit}::int THEN true END`
      );
    }
  }
  const truncated =
    cut.length === 0
      ? sql``
      : sql` || jsonb_strip_nulls(jsonb_build_object('_truncated', NULLIF(jsonb_strip_nulls(${buildObject(sql, cut)}), '{}'::jsonb)))`;
  const list = cols.flatMap((c, i) => (i === 0 ? [c] : [sql`,`, c]));
  return sql`(SELECT ${buildObject(sql, pairs)}${truncated} FROM (SELECT ${list}) ${sql.unsafe(x)})`;
}

/**
 * One nested selection for `scope`'s row: a jsonb array of up to `limit + 1`
 * far rows, each `id`, its selected fields (null when absent) and its own
 * walk selections; no `_metadata`.
 */
export function buildNested(
  sql: Sql | TransactionSql,
  sel: NestedSelection,
  promotedFor: PromotedColumnLookup,
  scope: WalkScope
): Fragment {
  const alias = scope.nextAlias();
  const a = sql.unsafe(alias);
  const { type, cond } = hop(sql, sel._walk, scope, alias);
  const castFor = (f: string) => resolveBodyOrderByCast(scope.fieldDef(type, f));
  const farScope: WalkScope = { ...scope, alias, type };
  const filters = [sel._walk.where, sel.where]
    .filter((w): w is WhereClause => w !== undefined)
    .map((w) => buildWhere(sql, w, castFor, promotedFor, farScope))
    .filter((f): f is Fragment => f !== null);

  const order = normalizeOrderBy(sel.orderBy).map(([field, dir]) => {
    // shortId never reaches here: the walk validator refuses it in a nested orderBy.
    const key =
      field === 'id'
        ? sql.unsafe(`${alias}.id COLLATE "C"`)
        : sortKey(sql, field, castFor(field), alias);
    return sql`${key} ${sql.unsafe(dir === 'asc' ? 'ASC' : 'DESC')} NULLS LAST`;
  });
  const orderBy = order.flatMap((o, i) => (i === 0 ? [o] : [sql`,`, o]));
  const limit = sel.limit === undefined ? sql`` : sql`LIMIT ${sel.limit + 1}`;

  const fields = sel.fields;
  const subNested = Object.fromEntries(
    Object.entries(fields).filter(([, v]) => isNested(v))
  ) as Record<string, NestedSelection>;
  const subAggs = Object.hasOwn(fields, '_agg')
    ? (fields._agg as Record<string, WalkAgg>)
    : undefined;
  const plain = Object.keys(fields).filter(
    (k) => k !== 'id' && k !== '_agg' && !NON_BODY_FIELD_KEYS.has(k) && !isNested(fields[k])
  );
  // The id as `materialize` reads it: the body's when it is a number or string.
  const id = sql.unsafe(
    `CASE WHEN jsonb_typeof(${alias}.body -> 'id') IN ('number', 'string') THEN ${alias}.body -> 'id' ELSE to_jsonb(${alias}.id) END`
  );
  const obj = buildObject(sql, [
    sql`'id'::text, ${id}`,
    ...plain.map((k) => sql`${k}::text, ${bodyJson(sql, [k], alias)}`)
  ]);
  const sub = buildWalkProjection(sql, subAggs, subNested, promotedFor, farScope);
  const row = sub === null ? obj : sql`${obj} || ${sub}`;
  return sql`(SELECT COALESCE(jsonb_agg(${row} ORDER BY ${a}.__rn), '[]'::jsonb) FROM (SELECT ${a}.*, row_number() OVER (ORDER BY ${orderBy}) AS __rn FROM rows ${a} WHERE ${combineAnd(sql, [cond, ...filters])} ORDER BY __rn ${limit}) ${a})`;
}

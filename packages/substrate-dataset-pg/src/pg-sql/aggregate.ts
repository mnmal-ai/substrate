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

import { isDateField, isRefOperand, windowGroupBy } from '@mnmal-ai/substrate-filter';
import {
  type FieldDef,
  type NestedSelection,
  UnsupportedFilterError,
  type WalkAgg,
  type WalkAggPredicate,
  type WalkNode,
  type WhereClause
} from '@mnmal-ai/substrate-types';
import type { Sql, TransactionSql } from 'postgres';
import { extraWins } from '../row-codec.js';
import type { TypeTable } from '../type-table.js';
import { metadataColumnSql } from './predicates-metadata.js';
import {
  type BodyOrderByCast,
  combineAnd,
  type Fragment,
  fieldExpr,
  fieldExprSql,
  isMetadataField,
  NON_BODY_FIELD_KEYS,
  qualifier,
  tsParam
} from './primitives.js';
import { buildObject } from './projection.js';
import { normalizeOrderBy, resolveBodyOrderByCast } from './sorting.js';
import {
  compareRef,
  float8Lit,
  hop,
  refIsCostly,
  refOperand,
  refValue,
  type SeedBase,
  seedFilter,
  sortKey,
  type WalkScope,
  windowKey
} from './walk.js';
import { buildWhere } from './where.js';

/** How an aggregate's value compares: as a number, as an instant, or as stored. */
type AggKind = 'number' | 'date' | 'other';

const AGG_OPS = ['avg', 'sum', 'min', 'max'] as const;

/** A field of `table`'s row `alias` as memory's `getFieldValue` reads it, as jsonb. */
function valueJson(
  sql: Sql | TransactionSql,
  table: TypeTable,
  field: string,
  alias: string
): Fragment {
  if (!isMetadataField(field)) return fieldExpr(sql, table, field, 'json', alias);
  const col = metadataColumnSql(field, alias);
  // As `materialize` renders a timestamp column: a JS Date's ISO string.
  return sql.unsafe(
    field === 'createdAt' || field === 'updatedAt'
      ? `to_jsonb(to_char(${col} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))`
      : `to_jsonb(${col})`
  );
}

/**
 * A pick: the stored `value` of the row first by `key` in `dir` (nulls last,
 * ties id ascending) among the rows passing `filter` as well.
 */
interface Pick {
  value: string;
  /** The field `key` reads, by which an index on it is found. */
  by: string;
  key: Fragment;
  dir: 'ASC' | 'DESC';
  filter?: Fragment;
}

/**
 * `spec` over `table`'s rows aliased `alias`, and the kind it compares as: an
 * aggregate expression (jsonb, NULL where memory gives null), or for a date
 * min/max or a `latest` the pick its caller runs as a bounded top-1.
 */
function aggOver(
  sql: Sql | TransactionSql,
  spec: WalkAgg,
  table: TypeTable,
  alias: string,
  fieldDef: (field: string) => FieldDef | undefined
): { kind: AggKind } & ({ agg: Fragment; pick?: undefined } | { pick: Pick; agg?: undefined }) {
  const isDate = (f: string) => isDateField(f, fieldDef);
  if (Object.hasOwn(spec, 'count')) return { agg: sql`to_jsonb(count(*))`, kind: 'number' };
  if ('latest' in spec) {
    const { by, value } = spec.latest;
    const key = sortKey(sql, table, by, resolveBodyOrderByCast(fieldDef(by)), alias);
    const numeric = value === 'seq' || resolveBodyOrderByCast(fieldDef(value)) === 'numeric';
    return {
      pick: { value, by, key, dir: 'DESC' },
      kind: isDate(value) ? 'date' : numeric ? 'number' : 'other'
    };
  }
  const op = AGG_OPS.find((k) => Object.hasOwn(spec, k));
  if (op === undefined) throw new Error('internal: aggregate names no function');
  const field = (spec as unknown as Record<string, string>)[op] as string;
  if ((op === 'min' || op === 'max') && isDate(field)) {
    // Unreadable dates drop out, as memory's pick puts them last and then nulls them.
    const ts = refValue(sql, table, field, 'date', alias);
    const dir = op === 'min' ? 'ASC' : 'DESC';
    return {
      pick: { value: field, by: field, key: ts, dir, filter: sql`${ts} IS NOT NULL` },
      kind: 'date'
    };
  }
  // float8 throughout, so the value is the double memory computes.
  const n = refValue(sql, table, field, 'number', alias);
  if (op === 'min' || op === 'max')
    return { agg: sql`to_jsonb(${sql.unsafe(op)}(${n}))`, kind: 'number' };
  // Todo #1809: sum and avg are exact, in numeric (substrate_num reads the
  // stored decimal, never ::float8::numeric, which keeps 15 digits), then cast
  // once to float8. That cast raises where the double would be ±Infinity or a
  // nonzero value would round to 0, so those are decided first, exactly: a sum
  // past MAX by half an ulp or more is NULL, as memory's; a tiny one is 0, as
  // memory's float64 arithmetic gives. Memory sums in float64, so the last bit,
  // and overflow under cancellation, can differ: accepted, as for avg/sum before.
  // A `column`-state number is float8, so it is cast to numeric too, through
  // its shortest exact text: float8::numeric keeps 15 digits. Any other number
  // field reads as numeric already.
  const s = sql`${sql.unsafe(op)}(${exactNumeric(sql, table, field, alias)})`;
  return {
    agg: sql`to_jsonb(CASE WHEN abs(${s}) >= ${sql.unsafe(OVERFLOW)} THEN NULL
      WHEN abs(${s}) <= ${sql.unsafe(UNDERFLOW)} THEN 0::float8 ELSE ${s}::float8 END)`,
    kind: 'number'
  };
}

/** A number field read as an exact numeric: a stored decimal is never narrowed through float8. */
export function exactNumeric(
  sql: Sql | TransactionSql,
  table: TypeTable,
  field: string,
  alias: string
): Fragment {
  const c = table.column(field);
  return isMetadataField(field)
    ? sql.unsafe(`${metadataColumnSql(field, alias)}::numeric`)
    : c === undefined || extraWins(c)
      ? fieldExpr(sql, table, field, 'number', alias)
      : sql`${fieldExpr(sql, table, field, 'number', alias)}::text::numeric`;
}

/** 2^1024 − 2^970, the least value float8 rounds to Infinity, as an exact numeric. */
const OVERFLOW = `${2n ** 1024n - 2n ** 970n}::numeric`;
/** 2^-1075 (= 5^1075 / 10^1075), the greatest value float8 rounds to 0, as an exact numeric. */
const UNDERFLOW = `0.${(5n ** 1075n).toString().padStart(1075, '0')}::numeric`;

/**
 * `p` over `table`'s rows aliased `alias` passing `where`: `ORDER BY key, id LIMIT 1`,
 * a top-1 an index can serve, never a sort of every row. An index keyed the
 * other way (`indexDir`) is read backward, nulls first, so the order is
 * written nulls first over the non-null keys, which that scan serves, and the
 * least id with a null key follows only when there is none: the same row.
 */
function pickRow(
  sql: Sql | TransactionSql,
  p: Pick,
  table: TypeTable,
  alias: string,
  where: Fragment,
  indexDir?: 'asc' | 'desc'
): Fragment {
  const a = sql.unsafe(alias);
  const t = sql.unsafe(table.from);
  const select = valueJson(sql, table, p.value, alias);
  const byId = sql`${a}.id COLLATE "C" ASC LIMIT 1`;
  const backward = indexDir !== undefined && indexDir !== p.dir.toLowerCase();
  // A date min/max filter already drops null keys; otherwise a backward read drops them here.
  const notNull = p.filter ?? (backward ? sql`${p.key} IS NOT NULL` : undefined);
  const rows = combineAnd(sql, notNull === undefined ? [where] : [where, notNull]);
  const nulls = sql.unsafe(`${p.dir} NULLS ${backward ? 'FIRST' : 'LAST'}`);
  const keyed = sql`SELECT ${select} FROM ${t} ${a} WHERE ${rows} ORDER BY ${p.key} ${nulls}, ${byId}`;
  if (!backward || p.filter !== undefined) return sql`(${keyed})`;
  // As firstRow's: a correlated, non-parallel Append runs in order under LIMIT 1,
  // so the null branch answers only when the keyed one is empty.
  return sql`((${keyed}) UNION ALL (SELECT ${select} FROM ${t} ${a} WHERE ${where} AND ${p.key} IS NULL ORDER BY ${byId}) LIMIT 1)`;
}

/**
 * A walk aggregate for `scope`'s row: a scalar subquery valued as jsonb (SQL
 * NULL or jsonb null where memory gives null), and the kind it compares as.
 */
export function buildWalkAgg(
  sql: Sql | TransactionSql,
  spec: WalkAgg,
  table: TypeTable,
  scope: WalkScope
): { value: Fragment; kind: AggKind } {
  const alias = scope.nextAlias();
  const { type, from, cond, via } = hop(sql, spec, scope, alias, table);
  const farTable = scope.tableFor(type);
  const far =
    spec.where === undefined
      ? null
      : buildWhere(
          sql,
          spec.where,
          (f) => resolveBodyOrderByCast(scope.fieldDef(type, f)),
          farTable,
          { ...scope, alias, type }
        );
  const { agg, pick, kind } = aggOver(sql, spec, farTable, alias, (f) => scope.fieldDef(type, f));
  const rows = combineAnd(sql, far === null ? [cond] : [cond, far]);
  // Todo #1819: a pick is a top-1 in the (crossRef, key) index's own order, one
  // probe per hub; a max(key) subquery is a full Aggregate wherever pg's
  // min/max rewrite does not fire, which reads every neighbour.
  const value =
    pick === undefined
      ? sql`(SELECT ${agg} FROM ${sql.unsafe(from)} ${sql.unsafe(alias)} WHERE ${rows})`
      : pickRow(
          sql,
          pick,
          farTable,
          alias,
          rows,
          via === undefined ? undefined : scope.indexDir?.(type, via, pick.by)
        );
  return { value, kind };
}

/** One hop and where's shared aggregates over `alias` rows: the jsonb object, the hop and the where. */
function sharedScan(
  sql: Sql | TransactionSql,
  group: Array<[string, WalkAgg]>,
  table: TypeTable,
  scope: WalkScope,
  alias: string
): {
  type: string;
  from: string;
  via?: string;
  cond: Fragment;
  pin: Fragment;
  far: Fragment | null;
  obj: Fragment;
} {
  const [, first] = group[0] as [string, WalkAgg];
  const h = hop(sql, first, scope, alias, table);
  const farTable = scope.tableFor(h.type);
  const far =
    first.where === undefined
      ? null
      : buildWhere(
          sql,
          first.where,
          (f) => resolveBodyOrderByCast(scope.fieldDef(h.type, f)),
          farTable,
          { ...scope, alias, type: h.type }
        );
  const values = group.map(([name, spec]) => {
    const { agg } = aggOver(sql, spec, farTable, alias, (f) => scope.fieldDef(h.type, f));
    return sql`${name}::text, ${agg as Fragment}`;
  });
  return { ...h, far, obj: buildObject(sql, values) };
}

/**
 * Registers the frame `_agg` windows the group-by rule picks (#1815,
 * `windowGroupBy` holds the rule) and returns the page's LEFT JOINs to them.
 * Each window is one CTE: its aggregates over the far rows in the window,
 * `GROUP BY` the crossRef (`__k`, the eager index's key; null keys left out,
 * since they join no seed), one pass over the window's index range. A seed
 * reads its group by key, and the where's walk over the same window becomes
 * `id IN` its keys, so the window is read once for both.
 *
 * The seeds are a subset of the keys. When the read's other conjuncts (or
 * `ids`) narrow the seeds, the keys are semi-joined to them inside the CTE,
 * so `certId in [100 ids]` aggregates only those certs' rows, and pg may
 * read them by the (crossRef, …) index instead of the whole window.
 */
export function prepareWindows(
  sql: Sql | TransactionSql,
  params: {
    where?: WhereClause;
    agg?: Record<string, WalkAgg>;
    count?: boolean;
    aggregate?: unknown;
    limit?: number;
  },
  base: SeedBase,
  rowCastFor: (field: string) => BodyOrderByCast | null,
  table: TypeTable,
  scope: WalkScope,
  indexed: (type: string, field: string) => boolean
): Fragment {
  const groups = new Map<string, Array<[string, WalkAgg]>>();
  for (const [name, spec] of Object.entries(params.agg ?? {})) {
    const { type } = hop(sql, spec, scope, 'x', table);
    const fieldDef = (f: string) => scope.fieldDef(type, f);
    if (!windowGroupBy(spec, params, fieldDef, (f) => indexed(type, f))) continue;
    const key = windowKey(spec);
    groups.set(key, [...(groups.get(key) ?? []), [name, spec]]);
  }
  let joins = sql``;
  for (const [key, group] of groups) {
    const alias = scope.nextAlias();
    const cte = `win_${alias}`;
    const { type, from, via, pin, far, obj } = sharedScan(sql, group, table, scope, alias);
    const farTable = scope.tableFor(type);
    // Bare for a crossRef column, which has `id`'s collation.
    const k = sql.unsafe(fieldExprSql(farTable, via as string, 'text', alias));
    // The window's own walks are implied by `__k`; every other conjunct narrows it.
    const seeds = seedFilter(sql, params.where, base, rowCastFor, table, scope, (i) => {
      const w = (i as { _walk?: WalkNode })._walk;
      return w !== undefined && windowKey(w) === key;
    });
    const r = scope.seedAlias;
    const mine = seeds.narrows
      ? [
          sql`${k} IN (SELECT ${sql.unsafe(farTable.column(via as string) === undefined ? `${r}.id::text COLLATE "C"` : `${r}.id`)} FROM ${sql.unsafe(table.from)} ${sql.unsafe(r)} WHERE ${seeds.filter})`
        ]
      : [];
    const rows = combineAnd(sql, [
      pin,
      sql`${k} IS NOT NULL`,
      ...(far === null ? [] : [far]),
      ...mine
    ]);
    scope.ctes ??= [];
    scope.ctes.push(
      sql`${sql.unsafe(cte)} AS MATERIALIZED (SELECT ${k} AS __k, ${obj} AS __g FROM ${sql.unsafe(from)} ${sql.unsafe(alias)} WHERE ${rows} GROUP BY 1)`
    );
    scope.windows ??= new Map();
    scope.windows.set(key, cte);
    joins = sql`${joins} LEFT JOIN ${sql.unsafe(cte)} ON ${sql.unsafe(`${cte}.__k = (${qualifier(scope.alias)}id::text COLLATE "C")`)}`;
  }
  return joins;
}

/**
 * A row's `_agg` selections as one jsonb object. Counts, sums, averages and
 * numeric min/max over the same hop and `where` are one scan of the
 * neighbourhood, not one each; a pick is its own probe.
 */
function buildWalkAggs(
  sql: Sql | TransactionSql,
  aggs: Record<string, WalkAgg>,
  table: TypeTable,
  scope: WalkScope
): Fragment {
  const shared = new Map<string, Array<[string, WalkAgg]>>();
  const parts: Fragment[] = [];
  const own: Fragment[] = [];
  for (const [name, spec] of Object.entries(aggs)) {
    const { type } = hop(sql, spec, scope, 'x', table);
    const far = scope.tableFor(type);
    if (aggOver(sql, spec, far, 'x', (f) => scope.fieldDef(type, f)).pick !== undefined) {
      own.push(sql`${name}::text, ${buildWalkAgg(sql, spec, table, scope).value}`);
      continue;
    }
    const key = windowKey(spec);
    shared.set(key, [...(shared.get(key) ?? []), [name, spec]]);
  }
  for (const [key, group] of shared) {
    const alias = scope.nextAlias();
    const { from, cond, obj, far } = sharedScan(sql, group, table, scope, alias);
    const window = scope.alias === scope.seedAlias ? scope.windows?.get(key) : undefined;
    if (window !== undefined) {
      // A seed with no row in the window reads the aggregates of none: count 0, the rest null.
      parts.push(
        sql`COALESCE(${sql.unsafe(`${window}.__g`)}, (SELECT ${obj} FROM ${sql.unsafe(from)} ${sql.unsafe(alias)} WHERE FALSE))`
      );
      continue;
    }
    const rows = combineAnd(sql, far === null ? [cond] : [cond, far]);
    parts.push(sql`(SELECT ${obj} FROM ${sql.unsafe(from)} ${sql.unsafe(alias)} WHERE ${rows})`);
  }
  if (own.length > 0 || parts.length === 0) parts.push(buildObject(sql, own));
  return parts.reduce((a, b) => sql`${a} || ${b}`);
}

/** The number of `scope`'s rows matching `where`, as one row `{ n }`. */
export function buildFrameCount(
  sql: Sql | TransactionSql,
  where: Fragment,
  scope: WalkScope,
  joins: Fragment = sql``
): Fragment {
  const from = scope.tableFor(scope.type).from;
  return sql`SELECT count(*)::float8 AS n FROM ${sql.unsafe(from)} ${sql.unsafe(scope.alias)}${joins} WHERE ${where}`;
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
  table: TypeTable,
  scope: WalkScope
): Fragment {
  const { value, kind } = buildWalkAgg(sql, where._agg, table, scope);
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
      const right = refOperand(sql, '_agg', op, raw, kind, scope);
      parts.push(compareRef(sql, '_agg', op, left, right, refIsCostly(raw)));
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
  table: TypeTable,
  scope: WalkScope
): Fragment | null {
  const pairs: Fragment[] = [];
  if (aggs !== undefined) pairs.push(sql`'_agg'::text, ${buildWalkAggs(sql, aggs, table, scope)}`);
  const lists = Object.entries(nested);
  if (lists.length === 0) return pairs.length === 0 ? null : buildObject(sql, pairs);
  const x = scope.nextAlias();
  const cols: Fragment[] = [];
  const cut: Fragment[] = [];
  for (const [i, [name, sel]] of lists.entries()) {
    const col = sql.unsafe(`${x}.c${i}`);
    cols.push(sql`${buildNested(sql, sel, table, scope)} AS ${sql.unsafe(`c${i}`)}`);
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
  // OFFSET 0 keeps the subquery from being flattened, which would inline each list at both reads.
  return sql`(SELECT ${buildObject(sql, pairs)}${truncated} FROM (SELECT ${list} OFFSET 0) ${sql.unsafe(x)})`;
}

/** A top-level walk selection read as its own column: the `_agg` object, or one nested list. */
export interface WalkColumn {
  name: string;
  column: string;
  /** A nested list's limit: the column holds up to one row more. */
  limit?: number;
}

/**
 * A row's top-level walk selections as their own SELECT items, beside `extra`:
 * `_agg` as one jsonb object, each nested list as a json array of up to
 * `limit + 1` rows. {@link mergeWalkColumns} cuts the lists and merges them
 * into `extra` as {@link buildWalkProjection} does in SQL, which costs pg far
 * more per row on a large read. Null when there are none.
 */
export function buildWalkColumns(
  sql: Sql | TransactionSql,
  aggs: Record<string, WalkAgg> | undefined,
  nested: Record<string, NestedSelection>,
  table: TypeTable,
  scope: WalkScope
): { select: Fragment; columns: WalkColumn[] } | null {
  const columns: WalkColumn[] = [];
  const items: Fragment[] = [];
  if (aggs !== undefined) {
    columns.push({ name: '_agg', column: '__walk_agg' });
    items.push(sql`${buildWalkAggs(sql, aggs, table, scope)} AS __walk_agg`);
  }
  for (const [i, [name, sel]] of Object.entries(nested).entries()) {
    const column = `__walk_${i}`;
    columns.push(sel.limit === undefined ? { name, column } : { name, column, limit: sel.limit });
    items.push(sql`${buildNested(sql, sel, table, scope, 'json')} AS ${sql.unsafe(column)}`);
  }
  if (items.length === 0) return null;
  return { select: sql`${items.flatMap((f, i) => (i === 0 ? [f] : [sql`,`, f]))}`, columns };
}

/**
 * `record` with its walk columns merged into `extra` as SQL's `extra || walk`
 * would: each list cut to its limit, `_truncated` naming the lists that had
 * more, the walk's keys winning, and every key in jsonb's order (shorter
 * first, then bytewise), so `decodeRow` reads the row it did before. Pass one
 * `orders` map per read: it caches the sorted order of each key set seen.
 */
export function mergeWalkColumns<R extends { extra: Record<string, unknown> | null }>(
  record: R,
  columns: readonly WalkColumn[],
  orders: Map<string, string[]> = new Map()
): R {
  const extra = record.extra ?? {};
  const walk: Record<string, unknown> = {};
  const cut: Record<string, true> = {};
  let anyCut = false;
  for (const c of columns) {
    const v = (record as Record<string, unknown>)[c.column];
    if (c.limit !== undefined && Array.isArray(v) && v.length > c.limit) {
      walk[c.name] = v.slice(0, c.limit);
      cut[c.name] = true;
      anyCut = true;
    } else {
      walk[c.name] = v;
    }
  }
  if (anyCut) walk._truncated = jsonbOrdered(cut);
  // Rows of one read share a few key sets, so each set is sorted once (`orders` is per read).
  const extraKeys = Object.keys(extra);
  const sig = `${anyCut ? 1 : 0}${extraKeys.join('\0')}`;
  let order = orders.get(sig);
  if (order === undefined) {
    order = [...new Set([...extraKeys, ...Object.keys(walk)])].sort(jsonbKeyOrder);
    orders.set(sig, order);
  }
  const merged: Record<string, unknown> = {};
  for (const k of order) merged[k] = Object.hasOwn(walk, k) ? walk[k] : extra[k];
  record.extra = merged;
  return record;
}

/** jsonb's object key order: shorter (in UTF-8 bytes) first, then bytewise. */
export function jsonbKeyOrder(a: string, b: string): number {
  // An ASCII key is one byte per UTF-16 unit, so string comparison is bytewise.
  if (Buffer.byteLength(a) === a.length && Buffer.byteLength(b) === b.length)
    return a.length - b.length || (a < b ? -1 : a > b ? 1 : 0);
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length - y.length || Buffer.compare(x, y);
}

function jsonbOrdered<T>(o: Record<string, T>): Record<string, T> {
  const out: Record<string, T> = {};
  for (const k of Object.keys(o).sort(jsonbKeyOrder)) out[k] = o[k] as T;
  return out;
}

/**
 * One nested selection for `scope`'s row: a jsonb array (or, with `as` json, a
 * json array of jsonb objects) of up to `limit + 1` far rows, each `id`, its
 * selected fields (null when absent) and its own walk selections; no `_metadata`.
 */
export function buildNested(
  sql: Sql | TransactionSql,
  sel: NestedSelection,
  table: TypeTable,
  scope: WalkScope,
  as: 'json' | 'jsonb' = 'jsonb'
): Fragment {
  const alias = scope.nextAlias();
  const a = sql.unsafe(alias);
  const { type, from, cond } = hop(sql, sel._walk, scope, alias, table);
  const farTable = scope.tableFor(type);
  const castFor = (f: string) => resolveBodyOrderByCast(scope.fieldDef(type, f));
  const farScope: WalkScope = { ...scope, alias, type };
  const filters = [sel._walk.where, sel.where]
    .filter((w): w is WhereClause => w !== undefined)
    .map((w) => buildWhere(sql, w, castFor, farTable, farScope))
    .filter((f): f is Fragment => f !== null);

  // The engine gives a list with no orderBy its far type's natural order (#1821); bare, it is id.
  const order = normalizeOrderBy(sel.orderBy).map(([field, dir]) => {
    // shortId never reaches here: the walk validator refuses it in a nested orderBy.
    const key =
      field === 'id'
        ? sql.unsafe(`${alias}.id COLLATE "C"`)
        : sortKey(sql, farTable, field, castFor(field), alias);
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
  // The id as `materialize` reads it: the body's (`extra`'s) when it is a number or string.
  const doc = `${alias}.${farTable.jsonb}`;
  const id = sql.unsafe(
    `CASE WHEN jsonb_typeof(${doc} -> 'id') IN ('number', 'string') THEN ${doc} -> 'id' ELSE to_jsonb(${alias}.id) END`
  );
  const obj = buildObject(sql, [
    sql`'id'::text, ${id}`,
    ...plain.map((k) => sql`${k}::text, ${fieldExpr(sql, farTable, k, 'json', alias)}`)
  ]);
  const sub = buildWalkProjection(sql, subAggs, subNested, farTable, farScope);
  const row = sub === null ? obj : sql`${obj} || ${sub}`;
  // The LIMIT is on the order itself, so an index in that order stops after it.
  const agg = sql.unsafe(as === 'json' ? 'json_agg' : 'jsonb_agg');
  return sql`(SELECT COALESCE(${agg}(${row} ORDER BY ${orderBy}), ${sql.unsafe(`'[]'::${as}`)}) FROM (SELECT ${a}.* FROM ${sql.unsafe(from)} ${a} WHERE ${combineAnd(sql, [cond, ...filters])} ORDER BY ${orderBy} ${limit}) ${a})`;
}

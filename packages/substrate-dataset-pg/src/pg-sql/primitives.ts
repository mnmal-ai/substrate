/**
 * Shared foundations for the pg SQL builders: the Fragment alias, low-level
 * primitives, promoted-column machinery and scalar helpers. Imports nothing
 * from the other builders and holds no connection state.
 *
 * SQL-injection contract: every caller-supplied
 * value flows through postgres.js's parameterised tagged-template slots.
 * `sql.unsafe(...)` is used ONLY for identifiers/cast suffixes drawn from
 * closed constant maps in this file, and for field names inlined as escaped
 * literals by `sqlStringLiteral`.
 */

import type { Id } from '@mnmal-ai/substrate-types';
import { normalizeIsoTimestamp, UnsupportedFilterError } from '@mnmal-ai/substrate-types';
import type { PendingQuery, Row as PgRow, Sql, TransactionSql } from 'postgres';
import { extraWins, RAW_KEY } from '../row-codec.js';
import type { ColumnKind, TypedColumn, TypeTable } from '../type-table.js';

export type Fragment = PendingQuery<PgRow[]>;

export const idToText = (id: Id): string => (typeof id === 'number' ? String(id) : id);

export const LOGICAL_KEYS = new Set(['AND', 'OR', 'NOT']);

/**
 * Row-metadata field → native column. Predicates on these fields use the
 * indexed columns rather than `body ->> field`. The `r.` alias matches
 * `read()`'s SELECT.
 */
export const METADATA_COLUMNS = {
  createdAt: 'r.created_at',
  updatedAt: 'r.updated_at',
  createdById: 'r.created_by_id',
  createdByKind: 'r.created_by_kind',
  updatedById: 'r.updated_by_id',
  updatedByKind: 'r.updated_by_kind',
  seq: 'r.seq'
} as const;

export type MetadataFieldName = keyof typeof METADATA_COLUMNS;

export function isMetadataField(field: string): field is MetadataFieldName {
  return Object.hasOwn(METADATA_COLUMNS, field);
}

/**
 * A body key mirrored into a dedicated column on `rows`, so filters and
 * sorts on it hit an index instead of extracting from JSONB.
 *
 * `column` is a BARE column name, not a qualified `r.<col>` fragment: taking a
 * fragment from a caller would put caller text into `sql.unsafe`.
 */
export interface PromotedBodyColumn {
  column: string;
  kind: 'boolean' | 'text';
}

export type PromotedBodyColumnMap = Readonly<Record<string, PromotedBodyColumn>>;

/**
 * Resolves a field name to its promoted column, or `undefined`.
 */
export type PromotedColumnLookup = (field: string) => PromotedBodyColumn | undefined;

/**
 * Legal bare column identifier: lower-snake, no quoting, no qualifier. This
 * allow-list is what stands between a caller-supplied map and `sql.unsafe`.
 */
const COLUMN_NAME_PATTERN = /^[a-z_][a-z0-9_]*$/;

/**
 * Validates a caller-supplied map and returns the lookup the SQL builders use.
 * Throws if any column is not a bare identifier.
 *
 * The validation is load-bearing: the builders interpolate the column through
 * `sql.unsafe`, and the map may come from config.
 */
export function resolvePromotedColumns(map: PromotedBodyColumnMap): PromotedColumnLookup {
  const resolved = new Map<string, PromotedBodyColumn>();
  for (const [field, def] of Object.entries(map)) {
    if (!COLUMN_NAME_PATTERN.test(def.column)) {
      throw new Error(
        `promotedColumns['${field}']: column '${def.column}' is not a bare identifier ` +
          `(expected ${COLUMN_NAME_PATTERN.source}). The table qualifier is added internally; ` +
          `pass 'severity', not 'r.severity'.`
      );
    }
    resolved.set(field, def);
  }
  return (field: string): PromotedBodyColumn | undefined => resolved.get(field);
}

/** The qualified expression source for a promoted column — `r.<column>`, or `<alias>.<column>`. */
export function promotedColumnSql(def: PromotedBodyColumn, alias = 'r'): string {
  return `${qualifier(alias)}${def.column}`;
}

/**
 * Row-shape keys that DO NOT live in `r.body` — they're synthesised from
 * dedicated columns (`_metadata`, `shortId`, `_deletedAt`) or extracted by
 * `materialize()` (`id` lives both in the column and in body, but is force-
 * included by the projection builder regardless of whether the caller asked).
 *
 * Used by `buildRowProjection` to filter caller-supplied `fields` keys when
 * deciding which body keys to materialise from JSONB.
 */
export const NON_BODY_FIELD_KEYS = new Set(['_metadata', '_deletedAt', 'shortId']);

/**
 * Pg cast applied to a body field's text extraction according to its
 * declared kind, so `count` sorts 2 before 10. `ORDER BY` and the cursor
 * compare must apply the same cast.
 */
export type BodyOrderByCast = 'numeric' | 'timestamptz' | 'boolean';

/** An operand's text: the shared ISO grammar in its explicit-offset form (no offset is UTC), as `substrate_ts` reads a stored value. */
const isoOf = (v: unknown): string =>
  v instanceof Date ? v.toISOString() : (normalizeIsoTimestamp(String(v)) ?? String(v));

/**
 * A timestamptz parameter, bound as TEXT and cast in SQL. When pg infers a
 * parameter's type as timestamptz (`$1::timestamptz`, or a compare against a
 * timestamptz column), postgres.js serialises the value through a JS Date,
 * which keeps milliseconds only: `.123456` arrives as `.123`, so equality
 * misses and every range compare is off by the dropped microseconds.
 */
export function tsParam(sql: Sql | TransactionSql, v: unknown): Fragment {
  return sql`${isoOf(v)}::text::timestamptz`;
}

/** {@link tsParam} for an array operand (`= ANY(...)`). */
export function tsArrayParam(sql: Sql | TransactionSql, vs: unknown[]): Fragment {
  return sql`${vs.map(isoOf)}::text[]::timestamptz[]`;
}

/**
 * A complete SQL string literal for `s`: `'o''neil'`. A value holding a
 * backslash takes the `E'…'` form with the backslash doubled, because in a
 * plain literal `standard_conforming_strings = off` would read `\'` as an
 * escaped quote and let the value break out. Without a backslash the plain
 * form reads the same under either setting, and keeps the text of existing
 * index DDL unchanged. pg literals cannot carry NUL, so that is refused.
 */
export function sqlStringLiteral(s: string): string {
  if (s.includes('\0')) {
    throw new UnsupportedFilterError(s, '<name>', 'refused: the field name contains NUL');
  }
  const quoted = s.replace(/'/g, "''");
  return s.includes('\\') ? `E'${quoted.replace(/\\/g, '\\\\')}'` : `'${quoted}'`;
}

/**
 * Body-field expressions as SQL TEXT, with every name inlined as a literal.
 * The compiler and the index DDL both build from these, because an
 * expression index serves only a filter whose expression matches it. An
 * `alias` qualifies `body` (a walk's far row); without one the text is the
 * index DDL's.
 */
/** `<alias>.`, checked as a bare identifier since it reaches `sql.unsafe`; empty without one. */
export function qualifier(alias: string | undefined): string {
  if (alias === undefined) return '';
  if (!COLUMN_NAME_PATTERN.test(alias))
    throw new Error(`internal: '${alias}' is not a table alias`);
  return `${alias}.`;
}

/** The row's jsonb column: `body` on the old layouts, `extra` on a type table. */
export type JsonbColumn = TypeTable['jsonb'];

const jsonSql = (path: readonly string[], alias?: string, jsonb: JsonbColumn = 'body'): string =>
  `${qualifier(alias)}${jsonb}${path.map((p) => ` -> ${sqlStringLiteral(p)}`).join('')}`;
const rawTextSql = (path: readonly string[], alias?: string, jsonb?: JsonbColumn): string =>
  `(${jsonSql(path.slice(0, -1), alias, jsonb)} ->> ${sqlStringLiteral(path[path.length - 1] as string)})`;
const textSql = (path: readonly string[], alias?: string, jsonb?: JsonbColumn): string =>
  `(${rawTextSql(path, alias, jsonb)} COLLATE "C")`;
const numSql = (path: readonly string[], alias?: string, jsonb?: JsonbColumn): string =>
  `substrate_num(${jsonSql(path, alias, jsonb)})`;
const tsSql = (path: readonly string[], alias?: string, jsonb?: JsonbColumn): string =>
  `substrate_ts(${jsonSql(path, alias, jsonb)})`;

/** What a field expression yields: compare and sort forms, uncollated text (ILIKE), or the jsonb value. */
export type FieldAs = 'text' | 'rawText' | 'number' | 'date' | 'boolean' | 'json';

/** The jsonb-path expression for `as`: the one every body/extra builder below emits. */
function pathSql(
  path: readonly string[],
  as: FieldAs,
  alias?: string,
  jsonb?: JsonbColumn
): string {
  switch (as) {
    case 'text':
      return textSql(path, alias, jsonb);
    case 'rawText':
      return rawTextSql(path, alias, jsonb);
    case 'number':
      return numSql(path, alias, jsonb);
    case 'date':
      return tsSql(path, alias, jsonb);
    case 'boolean':
      return `${rawTextSql(path, alias, jsonb)}::boolean`;
    case 'json':
      return `(${jsonSql(path, alias, jsonb)})`;
  }
}

/** The `as` a column of `kind` compares and sorts as. */
export function columnAs(kind: ColumnKind): Exclude<FieldAs, 'rawText' | 'json'> {
  return kind === 'number' || kind === 'date' || kind === 'boolean' ? kind : 'text';
}

/**
 * A date column as text in the `toISOString()` grammar with microseconds, read
 * in UTC whatever the session TimeZone: pg prints an old instant with an LMT
 * offset in a non-UTC session, which postgres.js reads as Invalid Date. A
 * column holds years 1 to 9999 UTC only where `decodeRow` reads it: the codec
 * nulls an instant before year 1 (which `YYYY` would print without its BC) and
 * shields any other value whose text differs from the written one under `$raw`.
 */
export const utcTextSql = (expr: string, frac: 'MS' | 'US'): string =>
  `to_char(${expr} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.${frac}"Z"')`;

/** `alias.<column>`, checked as a bare identifier since it reaches `sql.unsafe`. */
export function columnSql(column: TypedColumn, alias?: string): string {
  if (!COLUMN_NAME_PATTERN.test(column.column)) {
    throw new Error(`internal: '${column.column}' is not a bare column name`);
  }
  return `${qualifier(alias)}${column.column}`;
}

/** A column read as `as`: itself for its own kind; jsonb or `decodeRow`'s text for a value read. */
function columnExprSql(column: TypedColumn, as: FieldAs, alias?: string): string {
  const col = columnSql(column, alias);
  switch (as) {
    case 'json':
      return column.kind === 'date' ? `to_jsonb(${utcTextSql(col, 'MS')})` : `to_jsonb(${col})`;
    case 'rawText':
      // Uncollated, as `->>` is, so ILIKE case-folds under the database collation. A
      // crossRef column has the database collation already, as `id` does.
      if (column.kind === 'text' || column.kind === 'enum') return `(${col} COLLATE "default")`;
      if (column.kind === 'crossRef') return col;
      return column.kind === 'date' ? utcTextSql(col, 'MS') : `${col}::text`;
    default:
      // Text and enum columns are `COLLATE "C"` already, so a compare needs no COLLATE; a
      // crossRef compares for equality (joins with `id`) and is ordered by `columnOrderExpr`.
      return col;
  }
}

/**
 * A `promoting` or `orphaned` field's `extra` value as `as`, which never raises:
 * the field may hold anything (an orphaned one is undeclared), so a value that
 * does not fit reads NULL, which matches nothing, as memory's compare does.
 * `substrate_num` and `substrate_ts` are already safe; a boolean is guarded here.
 */
function extraBranchSql(field: string, as: FieldAs, kind: ColumnKind, alias?: string): string {
  const name = sqlStringLiteral(field);
  const v = `${qualifier(alias)}extra -> ${name}`;
  switch (as) {
    case 'boolean':
      return `CASE WHEN jsonb_typeof(${v}) = 'boolean' THEN (${v})::boolean END`;
    case 'json':
      // A null in `extra` reads absent, as `decodeRow` has it; `->>` already gives NULL for it.
      return `NULLIF(${pathSql([field], as, alias, 'extra')}, 'null'::jsonb)`;
    case 'text':
      // Uncollated for a crossRef, as its column is.
      return pathSql([field], kind === 'crossRef' ? 'rawText' : 'text', alias, 'extra');
    default:
      return pathSql([field], as, alias, 'extra');
  }
}

/**
 * A top-level field of `table`'s row as `as`. A `column`-state field is its
 * column; a `promoting` or `orphaned` one is its `extra` key when present, else
 * its column: `extraWins` in row-codec.ts, the one rule `decodeRow` reads by
 * (F13, F35), so filters and reads cannot disagree. Any other field, and every
 * field of a `rowsTypeTable`, is the `body`/`extra` path expression. A `json`
 * read also overlays `$raw`, last, as `decodeRow` does.
 *
 * A promoting number is numeric in both branches: `substrate_num` gives the
 * stored decimal exactly (Todo #1809), and a float8 CASE would round it, or
 * raise on one past float8's range.
 */
export function fieldExprSql(table: TypeTable, field: string, as: FieldAs, alias?: string): string {
  const c = table.column(field);
  if (c === undefined) return pathSql([field], as, alias, table.jsonb);
  const col = columnExprSql(c, as, alias);
  if (!extraWins(c)) return as === 'json' ? rawOverlay(field, col, alias) : col;
  const q = qualifier(alias);
  // Through text: float8::numeric keeps 15 digits, the shortest exact text all of them.
  const fromColumn = as === 'number' ? `${col}::text::numeric` : col;
  const value = `CASE WHEN ${q}extra ? ${sqlStringLiteral(field)} THEN ${extraBranchSql(field, as, c.kind, alias)} ELSE ${fromColumn} END`;
  return as === 'json' ? rawOverlay(field, value, alias) : value;
}

/** `value` under the field's `$raw` entry, which `decodeRow` overlays last. */
const rawOverlay = (field: string, value: string, alias?: string): string =>
  `COALESCE(${qualifier(alias)}extra -> ${sqlStringLiteral(RAW_KEY)} -> ${sqlStringLiteral(field)}, ${value})`;

/**
 * A column field as it orders (sorts, ranges, pick keys): its compare form, in
 * byte order as memory sorts. Text and enum columns are `"C"` already; a
 * crossRef column has the database collation, so it is ordered under `"C"`.
 */
export function columnOrderExpr(
  sql: Sql | TransactionSql,
  table: TypeTable,
  column: TypedColumn,
  alias?: string
): Fragment {
  const e = fieldExprSql(table, column.field, columnAs(column.kind), alias);
  return sql.unsafe(column.kind === 'crossRef' ? `(${e} COLLATE "C")` : e);
}

/** {@link fieldExprSql} as a fragment. */
export function fieldExpr(
  sql: Sql | TransactionSql,
  table: TypeTable,
  field: string,
  as: FieldAs,
  alias?: string
): Fragment {
  return sql.unsafe(fieldExprSql(table, field, as, alias));
}

/** A field name as an inlined SQL literal: `'o''neil'`. */
export function fieldLit(sql: Sql | TransactionSql, name: string): Fragment {
  return sql.unsafe(sqlStringLiteral(name));
}

/** `((body -> 'a' ->> 'b') COLLATE "C")`: the one text expression for compares and sorts. */
export function bodyText(
  sql: Sql | TransactionSql,
  path: readonly string[],
  alias?: string,
  jsonb?: JsonbColumn
): Fragment {
  return sql.unsafe(pathSql(path, 'text', alias, jsonb));
}

/** `(body -> 'a' ->> 'b')` uncollated, for ILIKE, which a "C" collation would not case-fold. */
export function bodyRawText(
  sql: Sql | TransactionSql,
  path: readonly string[],
  alias?: string,
  jsonb?: JsonbColumn
): Fragment {
  return sql.unsafe(pathSql(path, 'rawText', alias, jsonb));
}

/** `(body -> 'a' -> 'b')`: the leaf stays jsonb. */
export function bodyJson(
  sql: Sql | TransactionSql,
  path: readonly string[],
  alias?: string,
  jsonb?: JsonbColumn
): Fragment {
  return sql.unsafe(pathSql(path, 'json', alias, jsonb));
}

/** `substrate_num(body -> …)`: the number, or NULL for any other jsonb. */
export function bodyNum(
  sql: Sql | TransactionSql,
  path: readonly string[],
  alias?: string,
  jsonb?: JsonbColumn
): Fragment {
  return sql.unsafe(pathSql(path, 'number', alias, jsonb));
}

/** `substrate_ts(body -> …)`: the instant, or NULL for anything but an ISO date or date-time string. */
export function bodyTs(
  sql: Sql | TransactionSql,
  path: readonly string[],
  alias?: string,
  jsonb?: JsonbColumn
): Fragment {
  return sql.unsafe(pathSql(path, 'date', alias, jsonb));
}

/** The DDL text of the expression the compiler emits for a top-level field (qualified by `alias`, if given). */
export function indexExpressionSql(
  kind: 'text' | 'number' | 'date',
  field: string,
  alias?: string,
  jsonb?: JsonbColumn
): string {
  return pathSql([field], kind, alias, jsonb);
}

/**
 * `cond` where `expr` is not NULL, else FALSE, never NULL, so a caller's NOT
 * stays sound. The bare `cond` conjunct keeps it index-servable, where a
 * COALESCE would hide it from the planner.
 */
export function notNullAnd(sql: Sql | TransactionSql, expr: Fragment, cond: Fragment): Fragment {
  return sql`(${expr} IS NOT NULL AND ${cond})`;
}

export type SqlJsonValue = Parameters<Sql['json']>[0];
export const asJsonValue = (v: unknown): SqlJsonValue => v as SqlJsonValue;

export function scalarParam(value: unknown): string | number | boolean | null {
  if (value instanceof Date) return value.toISOString();
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  // Defensive fallback — stringify. The validator should have rejected before
  // we reach here, but this keeps the types honest without widening to any.
  return String(value);
}

export function escapeLike(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

/** Operand-shape guard for string operands. See UnsupportedFilterError. */
export function metaStr(field: string, op: string, v: unknown): string {
  if (typeof v !== 'string') {
    throw new UnsupportedFilterError(field, op, 'requires a string value');
  }
  return v;
}

/**
 * Join a list of boolean fragments with AND. Returns a degenerate `TRUE`
 * fragment when the list is empty so callers can always drop it into a
 * `WHERE ${whereSql}` slot without a branch.
 *
 * Composition is flat: postgres.js joins an interpolated Fragment[] with
 * spaces, so interleaving `AND` fragments yields one template with no nested
 * PendingQuery per predicate.
 */
export function combineAnd(sql: Sql | TransactionSql, fragments: Fragment[]): Fragment {
  if (fragments.length === 0) return sql`TRUE`;
  if (fragments.length === 1) return sql`(${fragments[0] as Fragment})`;
  return sql`(${interleaveOperator(sql, fragments, ' AND ')})`;
}

export function combineOr(sql: Sql | TransactionSql, fragments: Fragment[]): Fragment {
  if (fragments.length === 0) return sql`FALSE`;
  if (fragments.length === 1) return sql`(${fragments[0] as Fragment})`;
  return sql`(${interleaveOperator(sql, fragments, ' OR ')})`;
}

/**
 * Build `[frag0, sql`<op>`, frag1, sql`<op>`, ...]` so postgres.js's
 * Fragment[] interpolation produces `frag0 <op> frag1 <op> ...` in a single
 * flat template. Callers handle the empty and single-fragment cases.
 */
function interleaveOperator(
  sql: Sql | TransactionSql,
  fragments: Fragment[],
  op: ' AND ' | ' OR '
): Fragment[] {
  const opFragment = op === ' AND ' ? sql`AND` : sql`OR`;
  const out: Fragment[] = [fragments[0] as Fragment];
  for (let i = 1; i < fragments.length; i++) {
    out.push(opFragment, fragments[i] as Fragment);
  }
  return out;
}

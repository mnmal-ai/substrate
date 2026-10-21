/**
 * Shared foundations for the pg SQL builders: the Fragment alias, low-level
 * primitives, promoted-column machinery and scalar helpers. Imports nothing
 * from the other builders and holds no connection state.
 *
 * SQL-injection contract: every caller-supplied
 * value flows through postgres.js's parameterised tagged-template slots.
 * `sql.unsafe(...)` is used ONLY for identifiers/cast suffixes drawn from
 * closed constant maps in this file, never for caller input.
 */

import type { Id } from '@mnmal-ai/substrate-types';
import { UnsupportedFilterError } from '@mnmal-ai/substrate-types';
import type { PendingQuery, Row as PgRow, Sql, TransactionSql } from 'postgres';

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
  updatedByKind: 'r.updated_by_kind'
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

/** The qualified expression source for a promoted column — `r.<column>`. */
export function promotedColumnSql(def: PromotedBodyColumn): string {
  return `r.${def.column}`;
}

/**
 * Row-shape keys that DO NOT live in `r.body` — they're synthesised from
 * dedicated columns (`_metadata`, `shortId`, `_deletedAt`) or extracted by
 * `materialize()` (`id` lives both in the column and in body, but is force-
 * included by the projection builder regardless of whether the caller asked).
 *
 * Used by `buildBodyProjection` to filter caller-supplied `fields` keys when
 * deciding which body keys to materialise from JSONB.
 */
export const NON_BODY_FIELD_KEYS = new Set(['_metadata', '_deletedAt', 'shortId']);

/**
 * Pg cast applied to a body field's text extraction according to its
 * declared kind, so `count` sorts 2 before 10. `ORDER BY` and the cursor
 * compare must apply the same cast.
 */
export type BodyOrderByCast = 'numeric' | 'timestamptz' | 'boolean';

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

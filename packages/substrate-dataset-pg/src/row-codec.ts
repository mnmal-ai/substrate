/**
 * The `tables` layout's row codec: a row's declared column fields go to their
 * typed columns, everything else to `extra jsonb`. When a column cannot
 * reproduce the written value exactly (date text not in `toISOString()` form,
 * a misfit kind, an enum value outside the vocabulary, a numeric crossRef id),
 * the written value is kept under `extra.$raw.<field>` and reads return it, so
 * every row reads back as written. A field's value is never stored twice,
 * apart from that `$raw` copy.
 */

import { ReservedField } from '@mnmal-ai/substrate-types';
import type { ColumnKind, TypedColumn, TypeTable } from './type-table.js';

/** The reserved `extra` key holding each column field's written value when its column differs. */
export const RAW_KEY = '$raw';

export interface EncodedRow {
  /**
   * Keyed by column name: every column field the row writes. `null` when the
   * column is set NULL, for an explicit null or a value the column cannot hold.
   */
  columns: Record<string, string | number | boolean | null>;
  /** Undeclared keys, non-column fields, `pending` fields and `orphaned` columns' fields. */
  extra: Record<string, unknown>;
  /** `$raw` entries: the written value of each column field whose column differs from it. */
  raw: Record<string, unknown>;
  /** Declared column fields (`pending` included) the row sets to null; they read back absent. */
  clear: string[];
}

/**
 * THE precedence rule (F13, F35), shared with Task 10's `fieldExpr` and Task
 * 14's `rowJson`: for a `promoting` or `orphaned` column, the field's `extra`
 * key wins when present, else the column. A `column`-state field reads its
 * column only, because a write never puts it in `extra`. `$raw` overlays last.
 */
export function extraWins(column: TypedColumn): boolean {
  return column.state !== 'column';
}

/**
 * Splits `row` into columns, `extra`, `$raw` and cleared fields. A
 * `promoting` field goes to its column, and the writer must also strip its
 * `extra` key in the same statement (Task 11). An `orphaned` column is never
 * written: its field is undeclared, so the value goes to `extra`.
 */
export function encodeRow(table: TypeTable, row: Record<string, unknown>): EncodedRow {
  if (Object.hasOwn(row, RAW_KEY)) throw new ReservedField(RAW_KEY);
  const out: EncodedRow = { columns: {}, extra: {}, raw: {}, clear: [] };
  for (const [field, value] of Object.entries(row)) {
    const c = table.column(field);
    const held = c !== undefined && c.state !== 'orphaned' ? c : undefined;
    if (value === null && (held !== undefined || table.pending.includes(field))) {
      out.clear.push(field);
      if (held !== undefined) out.columns[held.column] = null;
      continue;
    }
    if (held === undefined) {
      out.extra[field] = value;
      continue;
    }
    const v = toColumn(held, value);
    out.columns[held.column] = v;
    // Column values are already canonical, so strict equality is the deep-equal check.
    if (v !== value) out.raw[field] = value;
  }
  return out;
}

/**
 * The row stored in `record` (a type-table row as pg returns it): non-null
 * columns in canonical JSON form, the `extra` keys other than `$raw` under
 * {@link extraWins}, then the `$raw` entries over both.
 */
export function decodeRow(
  table: TypeTable,
  record: Record<string, unknown>
): Record<string, unknown> {
  // Read once: `extra` may be TOASTed, so each access would detoast it again.
  const extra = (record.extra ?? {}) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const c of table.columns()) {
    const v = record[c.column];
    if (v !== null && v !== undefined) out[c.field] = canonical(c.kind, v);
  }
  for (const [k, v] of Object.entries(extra)) {
    if (k === RAW_KEY) continue;
    const c = table.column(k);
    if (c === undefined || extraWins(c)) out[k] = v;
  }
  const raw = extra[RAW_KEY];
  if (raw !== null && typeof raw === 'object') Object.assign(out, raw);
  return out;
}

/** The value `column` holds for `value`, in canonical form; `null` when it cannot hold it. */
function toColumn(column: TypedColumn, value: unknown): string | number | boolean | null {
  switch (column.kind) {
    case 'text':
      return typeof value === 'string' ? value : null;
    case 'enum':
      return typeof value === 'string' && (column.vocab ?? []).includes(value) ? value : null;
    case 'crossRef':
      if (typeof value === 'number' && Number.isFinite(value)) return String(value);
      return typeof value === 'string' ? value : null;
    case 'number':
      return typeof value === 'number' && Number.isFinite(value) ? value : null;
    case 'boolean':
      return typeof value === 'boolean' ? value : null;
    case 'date': {
      if (typeof value !== 'string') return null;
      const d = new Date(value);
      // pg's timestamptz takes years 1..9999 in ISO form; outside that, or invalid, it misfits.
      const year = d.getUTCFullYear();
      return Number.isNaN(d.getTime()) || year < 1 || year > 9999 ? null : d.toISOString();
    }
  }
}

/** A column value as pg returns it, in the JSON form a row carries: dates as `toISOString()`. */
function canonical(kind: ColumnKind, value: unknown): unknown {
  if (kind !== 'date') return value;
  return (value instanceof Date ? value : new Date(String(value))).toISOString();
}

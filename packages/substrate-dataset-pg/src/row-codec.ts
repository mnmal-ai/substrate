/**
 * The `tables` layout's row codec: a row's declared column fields go to their
 * typed columns, everything else to `extra jsonb`. When a column cannot
 * reproduce the written value exactly (date text not in `toISOString()` form,
 * a misfit kind, an enum value outside the vocabulary, a numeric crossRef id),
 * the written value is kept under `extra.$raw.<field>` and reads return it, so
 * every row reads back as written. A field's value is never stored twice,
 * apart from that `$raw` copy.
 */

import { normalizeIsoTimestamp, ReservedField } from '@mnmal-ai/substrate-types';
import type { ColumnKind, TypedColumn, TypeTable } from './type-table.js';

/** The reserved `extra` key holding each column field's written value when its column differs. */
export const RAW_KEY = '$raw';

export interface EncodedRow {
  /**
   * Keyed by column name: every column field the row writes. `null` when the
   * column is set NULL, for an explicit null or a value the column cannot hold.
   * A date column's value is the shared ISO grammar's text with microseconds:
   * bind it as text (`::text::timestamptz`, as `tsParam` does), never through a
   * JS Date, which keeps milliseconds only.
   */
  columns: Record<string, string | number | boolean | null>;
  /** Undeclared keys, non-column fields, `pending` fields and `orphaned` columns' fields. */
  extra: Record<string, unknown>;
  /** `$raw` entries: the written value of each column field whose column differs from it. */
  raw: Record<string, unknown>;
  /** Declared column fields (`pending` included) the row sets to null; they read back absent. */
  clear: string[];
  /**
   * Every key of the written row. Remove these keys from `extra` and from
   * `extra.$raw` before merging `extra`/`raw`; drop `$raw` when it ends empty.
   * That one rule clears a stale `$raw`, a `promoting` field's old `extra` key
   * and a cleared field's key, in every state. {@link applyPatch} is it in JS.
   */
  unset: string[];
}

/**
 * THE precedence rule (F13, F35), shared with Task 10's `fieldExpr` and Task
 * 14's `rowJson`: for a `promoting` or `orphaned` column, the field's `extra`
 * key wins when present, else the column. A `column`-state field reads its
 * column only, because a write never puts it in `extra`. `$raw` overlays last.
 * A `null` in `extra` on a declared column field (`promoting` or `pending`)
 * reads absent, as Task 2's contract has it.
 */
export function extraWins(column: TypedColumn): boolean {
  return column.state !== 'column';
}

/**
 * Splits `row` into columns, `extra`, `$raw`, cleared fields and the keys to
 * unset. An `orphaned` column is only ever cleared: its field is undeclared, so
 * the value goes to `extra`. A non-finite number on a column field is refused with
 * a RangeError, because jsonb would turn its `$raw` copy into `null`.
 */
export function encodeRow(table: TypeTable, row: Record<string, unknown>): EncodedRow {
  if (Object.hasOwn(row, RAW_KEY)) throw new ReservedField(RAW_KEY, 'by a create or an update');
  const out: EncodedRow = { columns: {}, extra: {}, raw: {}, clear: [], unset: Object.keys(row) };
  for (const [field, value] of Object.entries(row)) {
    const c = table.column(field);
    // Its column is cleared, so a value left there always predates the orphaning and every
    // write of the field since; declared again, the field never reads a stale one back.
    if (c?.state === 'orphaned') out.columns[c.column] = null;
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
    if (typeof value === 'number' && !Number.isFinite(value)) {
      throw new RangeError(`field '${field}' is ${value}, which a row cannot store`);
    }
    // A JS Date is written as the JSON text it serialises to, as a jsonb body stored it.
    const written = value instanceof Date ? value.toJSON() : value;
    const v = toColumn(held, written);
    out.columns[held.column] = v;
    if (v === null || readBack(held.kind, v) !== written) out.raw[field] = written;
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
  const raw = extra[RAW_KEY];
  const overlay = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const out: Record<string, unknown> = {};
  for (const c of table.columns()) {
    const v = record[c.column];
    // A `$raw` entry overlays the column, so an unreadable column value there is never read.
    if (v === null || v === undefined || Object.hasOwn(overlay, c.field)) continue;
    out[c.field] = canonical(c.kind, v);
  }
  for (const [k, v] of Object.entries(extra)) {
    if (k === RAW_KEY) continue;
    const c = table.column(k);
    if (c !== undefined && !extraWins(c)) continue;
    const declared = c !== undefined ? c.state === 'promoting' : table.pending.includes(k);
    if (v === null && declared) delete out[k];
    else out[k] = v;
  }
  Object.assign(out, overlay);
  return out;
}

/**
 * `record` after writing `encoded` over it, by the rule on
 * {@link EncodedRow.unset}. The oracle the writer's SQL is tested against:
 * `(extra - unset) || extra_new || {$raw: (extra->'$raw' - unset) || raw}`.
 */
export function applyPatch(
  record: Record<string, unknown>,
  encoded: EncodedRow
): Record<string, unknown> {
  const prior = (record.extra ?? {}) as Record<string, unknown>;
  const unset = new Set([...encoded.unset, RAW_KEY]);
  const keep = (o: Record<string, unknown>) =>
    Object.fromEntries(Object.entries(o).filter(([k]) => !unset.has(k)));
  const extra = { ...keep(prior), ...encoded.extra };
  const raw = { ...keep((prior[RAW_KEY] ?? {}) as Record<string, unknown>), ...encoded.raw };
  if (Object.keys(raw).length > 0) extra[RAW_KEY] = raw;
  return { ...record, ...encoded.columns, extra };
}

/** The value `column` holds for `value`; `null` when it cannot hold it. */
function toColumn(column: TypedColumn, value: unknown): string | number | boolean | null {
  switch (column.kind) {
    case 'text':
      return typeof value === 'string' ? value : null;
    case 'enum':
      return typeof value === 'string' && (column.vocab ?? []).includes(value) ? value : null;
    case 'crossRef':
      if (typeof value === 'number') return String(value);
      return typeof value === 'string' ? value : null;
    case 'number':
      return typeof value === 'number' ? value : null;
    case 'int64':
      return typeof value === 'bigint' ? String(value) : null;
    case 'boolean':
      return typeof value === 'boolean' ? value : null;
    case 'date': {
      if (typeof value !== 'string') return null;
      // The one date grammar memory and `substrate_ts` read; no offset is UTC.
      const iso = normalizeIsoTimestamp(value);
      // The grammar bounds the local year only: an offset can put the instant in
      // 1 BC, which pg prints with `BC` and postgres.js reads as Invalid Date.
      return iso === undefined || new Date(iso).getUTCFullYear() < 1 ? null : iso;
    }
  }
}

/** What reading column value `v` back gives, or `undefined` when that read is lossy. */
function readBack(kind: ColumnKind, v: string | number | boolean): unknown {
  if (kind === 'int64') return BigInt(v as string);
  if (kind !== 'date') return v;
  const d = new Date(v as string);
  // postgres.js parses pg's output with `new Date`, which maps years 0-99 onto
  // 19xx; <= 100 because a session offset can print a UTC year-100 instant as 99.
  return d.getUTCFullYear() <= 100 ? undefined : d.toISOString();
}

/** `utcTextSql(col, 'US')` output for a year 1 to 9999 instant. */
const UTC_US_TEXT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

/** A column value as pg returns it, in the JSON form a row carries: dates as `toISOString()`. */
function canonical(kind: ColumnKind, value: unknown): unknown {
  // pg returns a bigint column as text, which keeps every digit.
  if (kind === 'int64') return BigInt(value as string);
  if (kind !== 'date') return value;
  // `utcTextSql`'s microsecond text: its first 23 characters plus `Z` are what the Date round trip
  // prints (both truncate to the millisecond), at a fraction of the cost on a large read.
  if (typeof value === 'string' && UTC_US_TEXT.test(value)) return `${value.slice(0, 23)}Z`;
  // `buildRowProjection` gives UTC text (`utcTextSql`), which reads the same in any session TimeZone;
  // a Date from a plain SELECT is TZ-dependent, as pg prints an old instant with an LMT offset.
  return (value instanceof Date ? value : new Date(String(value))).toISOString();
}

/**
 * migrate-store's conversion of old-layout rows into a type table: each body
 * is split by the row codec into columns, `extra` and `$raw`, and a batch is
 * one multi-row INSERT built by {@link writeRowsStatement} (`insertOnly`,
 * metadata passed through), which also registers the ids in `row_ids` (F37).
 */

import type { ActorIdentity, RowMetadata } from '@mnmal-ai/substrate-types';
import type { Sql } from 'postgres';
import { encodeRow, RAW_KEY } from './row-codec.js';
import type { TypeTable } from './type-table.js';
import { type RowToWrite, writeRowsStatement } from './write-rows.js';

/**
 * One old-layout `rows` row. Timestamps are timestamptz text, so microseconds
 * survive (a JS Date keeps milliseconds); `seq` is bigint text.
 */
export interface SourceRow {
  id: string;
  body: Record<string, unknown>;
  deleted_at: string | null;
  created_at: string | null;
  updated_at: string | null;
  created_by_kind: string | null;
  created_by_id: string | null;
  updated_by_kind: string | null;
  updated_by_id: string | null;
  seq: string | null;
}

/** A value its declared column cannot hold, kept under `$raw`; or a source body's own `$raw` key. */
export interface Misfit {
  id: string;
  field: string;
}

/** `JSON.rawJSON` and friends (Node >= 21), not yet in the ES2025 lib. */
const NativeJSON = JSON as unknown as {
  rawJSON(text: string): unknown;
  isRawJSON(v: unknown): v is { rawJSON: string };
};

/**
 * A source body's jsonb text as a JS object that loses nothing: a number
 * whose JS form would change its text (beyond double precision, `1.0`,
 * `1e400`) stays a `JSON.rawJSON` of the exact source text, which
 * `JSON.stringify` writes back verbatim into `extra` and `$raw`.
 */
export function parseSourceBody(text: string): Record<string, unknown> {
  return JSON.parse(text, (_k, v, ctx?: { source?: string }) =>
    typeof v === 'number' && ctx?.source !== undefined && String(v) !== ctx.source
      ? NativeJSON.rawJSON(ctx.source)
      : v
  ) as Record<string, unknown>;
}

/** A JSON number's value, normalised: `<sign><significant digits>e<exp>` for 0.digits × 10^exp; `0` for zero. */
function decimalOf(text: string): string {
  const m = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(text);
  if (m === null) return text;
  const all = `${m[2]}${m[3] ?? ''}`;
  const lead = /^0*/.exec(all)?.[0].length ?? 0;
  const digits = all.slice(lead).replace(/0+$/, '');
  if (digits === '') return '0';
  return `${m[1]}${digits}e${Number(m[4] ?? 0) + (m[2] as string).length - lead}`;
}

/** The text jsonb gives a `double precision` column's value: its shortest round-trip digits, written out without an exponent. */
function columnText(d: number): string {
  const [mantissa, e] = d.toExponential().split('e') as [string, string];
  const neg = mantissa.startsWith('-');
  const digits = mantissa.replace(/[-.]/g, '');
  const point = Number(e) + 1;
  const plain =
    point <= 0
      ? `0.${'0'.repeat(-point)}${digits}`
      : point >= digits.length
        ? `${digits}${'0'.repeat(point - digits.length)}`
        : `${digits.slice(0, point)}.${digits.slice(point)}`;
  return d === 0 ? '0' : `${neg ? '-' : ''}${plain}`;
}

/**
 * The rule for a number column, given the source's numeric text: it holds the
 * value when the text parses to a finite double equal to it, as that double's
 * shortest decimal (`0.1`, `1.0`, `1.50`) or, for an integer, its exact value
 * (`1152921504606846976`). Then `$raw` keeps the text only when jsonb would
 * render the column differently. Anything else (`12345678901234567890`,
 * `1e400`) is a misfit: NULL column, exact text under `$raw`.
 */
function numberColumn(text: string): { value: number; raw: boolean } | undefined {
  const d = Number(text);
  if (!Number.isFinite(d)) return undefined;
  const want = decimalOf(text);
  const exact =
    want === decimalOf(columnText(d)) ||
    (Number.isInteger(d) && want === decimalOf(BigInt(d).toString()));
  return exact ? { value: d, raw: text !== columnText(d) } : undefined;
}

/** The stored actor, kind and id as they are, a half-null pair included. */
const actor = (kind: string | null, id: string | null): ActorIdentity | null =>
  kind === null && id === null ? null : ({ kind, id } as unknown as ActorIdentity);

/**
 * Inserts `records` into `table` in one statement. Bodies should come from
 * {@link parseSourceBody}, so numbers keep their source text. A misfit value
 * gets a NULL column and is kept under `$raw`, so it reads back as written. A body's own
 * `$raw` key, which a write would refuse (`ReservedField`), is a misfit on
 * `$raw` whose value is kept under `$raw.$raw`, so it too reads back as written.
 * `inserted` counts the rows that landed; a row whose id the table already
 * holds is skipped.
 */
export async function copyRows(
  target: Sql,
  table: TypeTable,
  records: ReadonlyArray<SourceRow>
): Promise<{ inserted: number; misfits: Misfit[] }> {
  const misfits: Misfit[] = [];
  const rows: RowToWrite[] = records.map((r) => {
    if (r.body === null || typeof r.body !== 'object' || Array.isArray(r.body)) {
      throw new TypeError(
        `${table.namespace}/${table.type}/${r.id}: the body is not a JSON object`
      );
    }
    const { [RAW_KEY]: ownRaw, ...body } = r.body;
    const hasOwnRaw = Object.hasOwn(r.body, RAW_KEY);
    // Number columns: hold a value only when exact (see `numberColumn`); keep its text when jsonb would change it.
    const keepText: Record<string, unknown> = {};
    for (const [field, v] of Object.entries(body)) {
      const c = table.column(field);
      if (c?.kind !== 'number' || c.state === 'orphaned') continue;
      const text = typeof v === 'number' ? String(v) : NativeJSON.isRawJSON(v) ? v.rawJSON : null;
      if (text === null) continue;
      const fit = numberColumn(text);
      if (fit === undefined) continue; // A rawJSON value: encodeRow gives it a NULL column and $raw.
      body[field] = fit.value;
      if (fit.raw) keepText[field] = NativeJSON.rawJSON(text);
    }
    const encoded = encodeRow(table, body);
    Object.assign(encoded.raw, keepText);
    for (const field of Object.keys(encoded.raw)) {
      if (Object.hasOwn(keepText, field)) continue;
      const column = table.column(field)?.column;
      if (column !== undefined && encoded.columns[column] === null)
        misfits.push({ id: r.id, field });
    }
    if (hasOwnRaw) {
      misfits.push({ id: r.id, field: RAW_KEY });
      encoded.raw[RAW_KEY] = ownRaw;
    }
    const metadata: RowMetadata = {
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      createdBy: actor(r.created_by_kind, r.created_by_id),
      updatedBy: actor(r.updated_by_kind, r.updated_by_id)
    };
    return { ...encoded, id: r.id, metadata, deletedAt: r.deleted_at, seq: r.seq };
  });
  if (rows.length === 0) return { inserted: 0, misfits };
  const landed = await target`${writeRowsStatement(target, table, rows, {
    insertOnly: true,
    visibleOrder: false,
    metadata: 'passthrough'
  })}`;
  return { inserted: landed.length, misfits };
}

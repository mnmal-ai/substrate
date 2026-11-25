/** A type-table record as the row `PgDataset` returns. */

import type { ActorIdentity, FieldDef, Id, ReadParams, Row } from '@mnmal-ai/substrate-types';
import { isColumnField } from '@mnmal-ai/substrate-types';
import { assembleRowMetadata, readsRowMetadata } from './pg-sql.js';
import { decodeRow, RAW_KEY } from './row-codec.js';
import type { TypeTable } from './type-table.js';
import { guardedRows } from './write-rows.js';

export const RESERVED_DELETED_AT = '_deletedAt';

/** The `updatedBy` a write without an actor stamps. */
export const ANONYMOUS: ActorIdentity = { kind: 'system', id: 'anonymous' };

/** A written row as {@link guardedRows} returns it: `id` null on the row carrying `ok` alone. */
export type GuardedRecord = TableRowRecord & { ok: boolean; iso: string };

/** A type-table row as returned for `decodeRow`: `extra` and its columns. */
export type TableRowRecord = {
  id: string;
  extra: Record<string, unknown>;
  deleted_at: Date | null;
  /** From short_ids; null when no binding exists. */
  short_id: number | null;
  // Row-metadata columns. NULL for legacy rows.
  created_at: Date | null;
  updated_at: Date | null;
  created_by_kind: string | null;
  created_by_id: string | null;
  updated_by_kind: string | null;
  updated_by_id: string | null;
  /** bigint as a string; null off visible-order types. */
  seq: string | null;
};

/**
 * `fields` is the type's, which the caller looks up once however many rows it
 * builds. The row is decoded first; `requested`, a read's `fields`, then
 * trims the `$raw` entries `decodeRow` overlays, since the projection keeps
 * `$raw` whole.
 */
export function materialize(
  record: TableRowRecord,
  fields: Record<string, FieldDef> | undefined,
  table: TypeTable,
  requested?: ReadParams['fields']
): Row {
  const body = decodeRow(table, record);
  const raw = (record.extra as Record<string, unknown> | null)?.[RAW_KEY];
  // A `$raw` entry the projection did not ask for is dropped (the projection keeps `$raw` whole).
  const trimRaw =
    requested !== undefined && raw !== null && typeof raw === 'object'
      ? (raw as Record<string, unknown>)
      : undefined;
  // Prefer the body.id (preserves number vs string at write time) over the
  // text PK column when present.
  const id = extractOriginalId(record.id, body);
  const kept = (k: string): boolean => {
    if (k === 'id' || k === RESERVED_DELETED_AT || k === '_metadata') return false; // the latter two never stored
    if (
      trimRaw !== undefined &&
      Object.hasOwn(trimRaw, k) &&
      !Object.hasOwn(requested as object, k)
    )
      return false;
    // A null on a declared scalar or crossRef reads back absent, as on memory.
    if (body[k] === null && fields !== undefined && Object.hasOwn(fields, k)) {
      const def = fields[k];
      if (def !== undefined && isColumnField(def)) return false;
    }
    return true;
  };
  // Set from the record, over any body key of the same name.
  const deletedAt = record.deleted_at !== null ? record.deleted_at : undefined;
  // postgres.js returns bigint columns as strings; shortId values fit safely in Number.
  const shortId =
    record.short_id !== null && record.short_id !== undefined ? Number(record.short_id) : undefined;
  // The read selected the metadata columns only if the projection asks for them.
  const meta = readsRowMetadata(requested) ? assembleRowMetadata(record) : undefined;
  const special = (k: string): unknown =>
    k === RESERVED_DELETED_AT
      ? deletedAt
      : k === 'shortId'
        ? shortId
        : k === '_metadata'
          ? meta
          : undefined;

  // One object, built in its final key order: a projection answers in its own order (#1861), as
  // memory and the transports do, with `id` leading unless the request places it; then the rest
  // of the row in column order; then the record's own keys.
  const out: Row =
    requested === undefined || !Object.hasOwn(requested, 'id') ? { id } : ({} as Row);
  if (requested !== undefined) {
    for (const k of Object.keys(requested)) {
      if (k === 'id') out.id = id;
      else if (special(k) !== undefined) out[k] = special(k);
      else if (Object.hasOwn(body, k) && kept(k)) out[k] = body[k];
    }
  }
  for (const k in body) {
    if (!Object.hasOwn(out, k) && kept(k)) out[k] = special(k) ?? body[k];
  }
  if (deletedAt !== undefined && !Object.hasOwn(out, RESERVED_DELETED_AT))
    out[RESERVED_DELETED_AT] = deletedAt;
  if (shortId !== undefined && !Object.hasOwn(out, 'shortId')) out.shortId = shortId;
  if (meta !== undefined && !Object.hasOwn(out, '_metadata')) out._metadata = meta;
  return out;
}

export function extractOriginalId(textId: string, body: Record<string, unknown>): Id {
  const bodyId = body.id;
  if (typeof bodyId === 'number' || typeof bodyId === 'string') return bodyId;
  return textId;
}

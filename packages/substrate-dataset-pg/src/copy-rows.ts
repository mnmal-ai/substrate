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

/** The stored actor, kind and id as they are, a half-null pair included. */
const actor = (kind: string | null, id: string | null): ActorIdentity | null =>
  kind === null && id === null ? null : ({ kind, id } as unknown as ActorIdentity);

/**
 * Inserts `records` into `table` in one statement. A misfit value gets a NULL
 * column and is kept under `$raw`, so it reads back as written. A body's own
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
    const encoded = encodeRow(table, body);
    for (const field of Object.keys(encoded.raw)) {
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

/**
 * The promotion sweep (`tables` layout): each `pending` field gets its column,
 * and each `promoting` field's values move out of `extra` into it. One field
 * at a time, so DDL touches one type's table, under a short `lock_timeout`.
 *
 * Per field:
 * 1. `pending` only: ADD COLUMN under `lock_timeout`. On a lock timeout the
 *    field is `busy` and the sweep moves on; the next sweep retries it.
 * 2. `pending` only: record it `promoting`, and notify.
 * 3. Backfill, keyset-paginated by `id` (F14): each page moves the values of
 *    its rows that carry the key, through the row codec, so a misfit lands in
 *    `$raw` exactly as a write would put it. A row a writer changed between
 *    the page's read and its update is left for the straggler pass.
 * 4. Reconcile the type's indexes, which builds any waiting on the column.
 * 5. Record it `column`, notify, and run one straggler pass (step 3 again),
 *    for values a writer with a stale table put in `extra` meanwhile.
 *
 * A unique index refusing a backfilled value (23505), or one that cannot be
 * built over the moved values, fails the field: it stays `promoting`, so reads
 * still see its `extra` values, and the index is never weakened to let the
 * move through.
 */

import type { PromotionEvent } from '@mnmal-ai/substrate-types';
import type { Sql } from 'postgres';
import { UniqueIndexDuplicatesError } from './index-reconciler.js';
import { encodeRow, RAW_KEY } from './row-codec.js';
import { ident } from './type-storage.js';
import { addPendingColumn, loadTypeTable, PG_TYPE, type TypeTable } from './type-table.js';

/** Busy or failed attempts in a row after which a field's promotion is reported `failed`. */
export const PROMOTION_FAILED_AFTER = 3;

export interface PromotePendingFieldsOptions {
  /** The longest an ADD COLUMN waits for its table's lock, in ms. */
  lockTimeoutMs: number;
  /** Rows per backfill page. */
  batchRows: number;
  /** Stops the sweep between pages and fields; an interrupted field is not counted an attempt. */
  signal?: AbortSignal;
  onEvent?: (e: PromotionEvent) => void;
  /** Only this namespace's fields; every namespace's when omitted. */
  namespace?: string;
  /**
   * Reconciles `namespace`/`type`'s declared indexes (step 4), and again once
   * the field is `column`, so their reported states settle. Without it no
   * index is built here; the next boot or index pass builds them.
   */
  reconcile?: (namespace: string, type: string) => Promise<void>;
}

interface FieldRow {
  namespace: string;
  type: string;
  field: string;
  state: 'pending' | 'promoting';
  attempts: number;
}

/** Promotes every `pending` and `promoting` field in the store; see the module comment. */
export async function promotePendingFields(
  sql: Sql,
  opts: PromotePendingFieldsOptions
): Promise<PromotionEvent[]> {
  const rows = await sql<FieldRow[]>`
    SELECT namespace, type, field, state, attempts FROM substrate_type_fields
    WHERE state IN ('pending', 'promoting')
      ${opts.namespace === undefined ? sql`` : sql`AND namespace = ${opts.namespace}`}
    ORDER BY namespace COLLATE "C", type COLLATE "C", field COLLATE "C"`;
  const events: PromotionEvent[] = [];
  const emit = (f: FieldRow, kind: PromotionEvent['kind'], attempts: number, error?: string) => {
    const e: PromotionEvent = {
      kind,
      namespace: f.namespace,
      type: f.type,
      field: f.field,
      attempts,
      ...(error !== undefined ? { error } : {})
    };
    events.push(e);
    opts.onEvent?.(e);
  };
  // A function, so each check reads the signal anew rather than a narrowed value.
  const stopped = (): boolean => opts.signal?.aborted === true;
  for (const f of rows) {
    if (stopped()) break;
    const attempts = f.attempts + 1;
    try {
      if (f.state === 'pending') {
        const added = await addPendingColumn(sql, f.namespace, f.type, f.field, opts.lockTimeoutMs);
        if (added === 'skipped') continue;
        if (added === 'busy') {
          const error = `its table's lock was held past ${opts.lockTimeoutMs} ms`;
          await recordAttempt(sql, f, attempts, error);
          if (attempts >= PROMOTION_FAILED_AFTER) emit(f, 'failed', attempts, error);
          else emit(f, 'busy', attempts);
          continue;
        }
      }
      const table = await loadTypeTable(sql, f.namespace, f.type);
      if (table?.column(f.field)?.state !== 'promoting') continue;
      if (!(await backfill(sql, table, f.field, opts))) break;
      await opts.reconcile?.(f.namespace, f.type);
      if (stopped()) break;
      await setState(sql, f, 'column');
      let finished: boolean;
      try {
        finished = await backfill(sql, table, f.field, opts);
      } catch (err) {
        // A straggler a unique index refuses: back to `promoting`, so reads see it in `extra`.
        await setState(sql, f, 'promoting');
        throw err;
      }
      if (!finished) {
        // Stopped mid-pass: a `column` field's `extra` key is never read, so the next sweep finishes it.
        await setState(sql, f, 'promoting');
        break;
      }
      await opts.reconcile?.(f.namespace, f.type);
      await recordAttempt(sql, f, 0, null);
      emit(f, 'promoted', attempts);
    } catch (err) {
      if (stopped()) break;
      const error = failure(err, f.field);
      await recordAttempt(sql, f, attempts, error);
      emit(f, 'failed', attempts, error);
    }
  }
  return events;
}

/** The failure as one line; a unique conflict names the declared index and the field. */
function failure(err: unknown, field: string): string {
  if (err instanceof UniqueIndexDuplicatesError) {
    return `unique index ${err.index ?? '(unnamed)'} refuses ${err.count} duplicated value(s) of ${field}`;
  }
  const pg = err as { code?: unknown; constraint_name?: unknown };
  if (pg?.code === '23505' && typeof pg.constraint_name === 'string') {
    return `unique index ${pg.constraint_name} refuses a duplicate value of ${field}`;
  }
  return (err instanceof Error ? err.message : String(err)).split('\n')[0] as string;
}

async function recordAttempt(
  sql: Sql,
  f: FieldRow,
  attempts: number,
  error: string | null
): Promise<void> {
  await sql`UPDATE substrate_type_fields SET attempts = ${attempts}, last_error = ${error}
            WHERE namespace = ${f.namespace} AND type = ${f.type} AND field = ${f.field}`;
}

async function setState(sql: Sql, f: FieldRow, state: 'column' | 'promoting'): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`UPDATE substrate_type_fields SET state = ${state}
             WHERE namespace = ${f.namespace} AND type = ${f.type} AND field = ${f.field}`;
    await tx`SELECT pg_notify('substrate_catalog', ${`${f.namespace}/${f.type}`})`;
  });
}

/**
 * Step 3: moves `field`'s values from `extra` into its column, a page of
 * `batchRows` rows at a time, keyset-paginated by `id` so no page rescans the
 * table (F14). False when `signal` stopped it.
 */
async function backfill(
  sql: Sql,
  table: TypeTable,
  field: string,
  opts: Pick<PromotePendingFieldsOptions, 'batchRows' | 'signal'>
): Promise<boolean> {
  const column = table.column(field);
  if (column === undefined) throw new Error(`internal: ${table.type}.${field} has no column`);
  const from = sql.unsafe(table.from);
  const col = sql.unsafe(ident(column.column));
  const cast = sql.unsafe(PG_TYPE[column.kind]);
  let last = '';
  for (;;) {
    if (opts.signal?.aborted === true) return false;
    // `v` is the stored JSON text, so the update's guard compares it exactly.
    const page = await sql<Array<{ id: string; v: string | null }>>`
      SELECT id, CASE WHEN extra ? ${field} THEN (extra -> ${field})::text END AS v
      FROM ${from} WHERE id > ${last} ORDER BY id LIMIT ${opts.batchRows}`;
    const ids: string[] = [];
    const values: string[] = [];
    const columns: Array<string | null> = [];
    const raws: Array<string | null> = [];
    for (const r of page) {
      if (r.v === null) continue;
      const encoded = encodeRow(table, { [field]: JSON.parse(r.v) as unknown });
      const c = encoded.columns[column.column];
      ids.push(r.id);
      values.push(r.v);
      columns.push(c === null || c === undefined ? null : String(c));
      raws.push(Object.hasOwn(encoded.raw, field) ? JSON.stringify(encoded.raw[field]) : null);
    }
    if (ids.length > 0) {
      // Only a row still holding the value read: a current writer has meanwhile
      // set the column and stripped the key, and a stale one put a newer value.
      await sql`
        UPDATE ${from} AS t SET
          ${col} = u.c::${cast},
          extra = CASE
            WHEN u.raw IS NOT NULL THEN (t.extra - ${field}::text) || jsonb_build_object(${RAW_KEY}::text,
              COALESCE(t.extra -> ${RAW_KEY}, '{}'::jsonb) || jsonb_build_object(${field}::text, u.raw::jsonb))
            WHEN (t.extra -> ${RAW_KEY}) - ${field}::text = '{}'::jsonb THEN t.extra - ${field}::text - ${RAW_KEY}::text
            ELSE (t.extra - ${field}::text) #- ARRAY[${RAW_KEY}::text, ${field}::text]
          END
        FROM unnest(${ids}::text[], ${values}::text[], ${columns as string[]}::text[], ${raws as string[]}::text[])
          AS u(id, v, c, raw)
        WHERE t.id = u.id AND t.extra -> ${field}::text = u.v::jsonb`;
    }
    if (page.length < opts.batchRows) return true;
    last = (page[page.length - 1] as { id: string }).id;
  }
}

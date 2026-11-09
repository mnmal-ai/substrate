/**
 * The promotion sweep (`tables` layout): each `pending` field gets its column,
 * and each `promoting` field's values move out of `extra` into it. One field
 * at a time, so DDL touches one type's table, under a short `lock_timeout`.
 *
 * Per field:
 * 1. `pending` only: ADD COLUMN, with the type lock's wait and the table
 *    lock's both under `lock_timeout`. On a timeout the field is `busy` and
 *    the sweep moves on; the next sweep retries it.
 * 2. `pending` only: record it `promoting`, and notify.
 * 3. Backfill, keyset-paginated by `id` (F14): each page moves the values of
 *    its rows that carry the key, through the row codec, so a misfit lands in
 *    `$raw` exactly as a write would put it; and a `$raw` value the column
 *    now admits (its enum vocabulary widened) into the column. Those rows are locked in id order
 *    first, as batch writers lock them; a deadlock or lock timeout is `busy`.
 *    A row a writer changed between the page's read and its update is left
 *    for the straggler pass.
 * 4. Reconcile the type's indexes, which builds any waiting on the column.
 * 5. Record it `column` (only from `promoting`, under the type lock, so never
 *    over a boot that orphaned or redeclared it), bump the catalog version,
 *    notify, and run one straggler pass (step 3 again), for values a writer
 *    put in `extra` before the move. The move locks the table SHARE, retried
 *    NOWAIT until `lock_timeout` so writes never queue behind it (held past
 *    it, the field is `busy`; `noWriters` queues instead), so every such write has
 *    committed before it, and any later one fails its version check and is
 *    rebuilt against the new table (`guardCte`).
 *
 * A unique index refusing a backfilled value (23505), or one that cannot be
 * built over the moved values, fails the field and is never weakened to let
 * the move through. Before step 5 the field stays `promoting`, so reads still
 * see its `extra` values. A field goes back from `column` only when its enum
 * vocabulary widens (`ensureTypeTable`), so step 3 moves the `$raw` values the
 * vocabulary now admits; otherwise never: a straggler
 * that fails (or a straggler pass that is stopped) leaves the field `column`
 * with its error recorded, which brings it back to a later sweep's straggler
 * pass until that pass finishes. A field that failed on a unique conflict,
 * `promoting` or `column`, comes back only once the type's catalog version has
 * moved on (`error_version`), since a rescan of the whole table at the same
 * version only meets it again.
 *
 * Every server process sweeps, so each field is swept under a session
 * advisory lock taken with a try ({@link promotionLockKey}): a field another
 * sweep holds is skipped, not swept twice, and reported `busy` with
 * {@link HELD_ELSEWHERE}. The lock never waits, so it is in no wait cycle;
 * it is session-level, not transaction-level, because the
 * field's own index builds (CONCURRENTLY) would wait forever on an open
 * transaction of the sweep's.
 */

import { type PromotionEvent, parseInt64 } from '@mnmal-ai/substrate-types';
import type { Sql } from 'postgres';
import { tryWithPgAdvisoryLock } from './advisory-lock.js';
import { UniqueIndexDuplicatesError } from './index-reconciler.js';
import { ident } from './layout.js';
import { encodeRow, RAW_KEY } from './row-codec.js';
import {
  addPendingColumn,
  loadTypeTable,
  moveFieldState,
  PG_TYPE,
  type TypeTable
} from './type-table.js';

/**
 * The error of a `busy` event for a field whose sweep lock another sweep holds:
 * not an attempt, and never recorded, only reported.
 */
export const HELD_ELSEWHERE = 'held by another process';

/** Busy or failed attempts in a row after which a field's promotion is reported `failed`. */
export const PROMOTION_FAILED_AFTER = 3;

/**
 * The `last_error` prefix of an attempt that met a held lock (`busy:`) or a
 * stopping sweep (`stopped:`): reported failed only from
 * {@link PROMOTION_FAILED_AFTER} attempts, where any other error fails at once.
 */
export const isTransientPromotionError = (error: string): boolean =>
  error.startsWith('busy: ') || error.startsWith('stopped: ');

export interface PromotePendingFieldsOptions {
  /** The longest an ADD COLUMN waits for its table's lock, in ms. */
  lockTimeoutMs: number;
  /** Rows per backfill page. */
  batchRows: number;
  /** Stops the sweep between pages and fields; an interrupted field is not counted an attempt. */
  signal?: AbortSignal;
  /** Clears `error_version` first, so fields a unique conflict holds back are swept again. */
  retryConflicts?: boolean;
  /**
   * The store has no other writers (migrate-store's target): a move to `column`
   * waits in the lock queue, which has a blocking autovacuum cancelled, rather
   * than retrying without queueing in front of writers.
   */
  noWriters?: boolean;
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
  state: 'pending' | 'promoting' | 'column';
  attempts: number;
}

/** Promotes every `pending` and `promoting` field in the store; see the module comment. */
export async function promotePendingFields(
  sql: Sql,
  opts: PromotePendingFieldsOptions
): Promise<PromotionEvent[]> {
  const scope = opts.namespace === undefined ? sql`` : sql`AND namespace = ${opts.namespace}`;
  if (opts.retryConflicts === true) {
    await sql`UPDATE substrate_type_fields SET error_version = NULL
              WHERE error_version IS NOT NULL ${scope}`;
  }
  const rows = await sql<FieldRow[]>`
    SELECT namespace, type, field, state, attempts FROM substrate_type_fields f
    WHERE ${due(sql)} ${scope}
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
  /** A lock that stayed held: `busy`, retried by the next sweep, and `failed` from the third in a row. */
  const busy = async (f: FieldRow, attempts: number, error: string) => {
    await recordAttempt(sql, f, attempts, `busy: ${error}`);
    if (attempts >= PROMOTION_FAILED_AFTER) emit(f, 'failed', attempts, error);
    else emit(f, 'busy', attempts);
  };
  // A function, so each check reads the signal anew rather than a narrowed value.
  const stopped = (): boolean => opts.signal?.aborted === true;
  /** One field, under its sweep lock; true when the sweep stops. */
  const sweepOne = async (selected: FieldRow): Promise<boolean> => {
    // Re-read under the lock: another sweep may have settled it since the selection.
    const [f] = await sql<FieldRow[]>`
      SELECT namespace, type, field, state, attempts FROM substrate_type_fields f
      WHERE namespace = ${selected.namespace} AND type = ${selected.type}
        AND field = ${selected.field} AND ${due(sql)}`;
    if (f === undefined) return false;
    const attempts = f.attempts + 1;
    // The catalog version the current pass started at: a unique conflict there is recorded at it.
    let at: string | undefined;
    try {
      if (f.state === 'pending') {
        const added = await addPendingColumn(sql, f.namespace, f.type, f.field, opts.lockTimeoutMs);
        if (added === 'skipped') return false;
        if (added === 'busy') {
          await busy(f, attempts, `its table's lock was held past ${opts.lockTimeoutMs} ms`);
          return false;
        }
      }
      const table = await loadTypeTable(sql, f.namespace, f.type);
      const state = table?.column(f.field)?.state;
      if (table === undefined || (state !== 'promoting' && state !== 'column')) return false;
      at = table.version;
      if (state === 'promoting') {
        if (!(await backfill(sql, table, f.field, opts))) return true;
        await opts.reconcile?.(f.namespace, f.type);
        if (stopped()) return true;
        // Never over a boot that orphaned or redeclared the field meanwhile.
        let moved: boolean;
        try {
          moved = await moveFieldState(
            sql,
            f.namespace,
            f.type,
            f.field,
            'promoting',
            'column',
            opts.lockTimeoutMs,
            opts.noWriters === true
          );
        } catch (err) {
          if ((err as { code?: unknown }).code !== '55P03') throw err;
          await busy(
            f,
            attempts,
            `its move to column could not lock its table within ${opts.lockTimeoutMs} ms (an open write transaction, an autovacuum or an index build held it)`
          );
          return false;
        }
        if (!moved) return false;
      }
      // `column` from here on (only a later widening sends it back): a straggler that cannot
      // move fails the field, and its error makes a later sweep run this pass again. Through the
      // current descriptor, so a vocabulary widened since the load moves the values it admits.
      const current = await loadTypeTable(sql, f.namespace, f.type);
      if (current?.column(f.field)?.state !== 'column') return false;
      at = current.version;
      if (!(await backfill(sql, current, f.field, opts))) {
        await recordAttempt(sql, f, f.attempts, 'stopped: its straggler pass did not finish');
        return true;
      }
      await recordAttempt(sql, f, 0, null);
      emit(f, 'promoted', attempts);
      // Settles the indexes' reported states; the field is promoted whatever this does.
      await opts.reconcile?.(f.namespace, f.type).catch((err: unknown) => {
        process.stderr.write(
          `[substrate] indexes of ${f.namespace}/${f.type} not reconciled after promoting ${f.field}: ${failure(err, f.field)}\n`
        );
      });
    } catch (err) {
      const code = (err as { code?: unknown }).code;
      // A conflict is recorded even when the sweep is stopping; anything else then is the stop.
      if (stopped() && !isUniqueConflict(err)) return true;
      if (code === '40P01' || code === '55P03') {
        await busy(f, attempts, `a lock on its rows was contended (${code})`);
        return false;
      }
      const error = failure(err, f.field);
      await recordAttempt(sql, f, attempts, error, isUniqueConflict(err) ? (at ?? null) : null);
      emit(f, 'failed', attempts, error);
    }
    return false;
  };
  for (const f of rows) {
    if (stopped()) break;
    // shortcut: a pool of one cannot hold the lock's connection and sweep beside it, so it sweeps
    // unlocked; give the sweeping pool two connections or more to keep sweeps exclusive.
    if (sql.options.max <= 1) {
      if (await sweepOne(f)) break;
      continue;
    }
    const held = await tryWithPgAdvisoryLock(
      sql,
      promotionLockKey(f.namespace, f.type, f.field),
      () => sweepOne(f)
    );
    if (!held.acquired) emit(f, 'busy', f.attempts, HELD_ELSEWHERE);
    else if (held.value) break;
  }
  return events;
}

/**
 * The advisory key of one field's sweep: a sweep that cannot take it at once
 * skips the field, which another process (or a concurrent sweep in this one)
 * is sweeping.
 */
export const promotionLockKey = (namespace: string, type: string, field: string): string =>
  `substrate-promote:${namespace}/${type}.${field}`;

/**
 * The fields a sweep takes (`f` is `substrate_type_fields`): `pending` and
 * `promoting` ones, and a `column` one whose straggler pass failed or was
 * stopped, except one that failed on a unique conflict (`error_version`) at
 * the type's current catalog version, which another full scan would only meet
 * again.
 */
const due = (sql: Sql) => sql`(f.state IN ('pending', 'promoting')
  OR (f.state = 'column' AND f.last_error IS NOT NULL))
  AND f.error_version IS DISTINCT FROM (
    SELECT v.version FROM substrate_type_tables v WHERE v.namespace = f.namespace AND v.type = f.type)`;

const isUniqueConflict = (err: unknown): boolean =>
  err instanceof UniqueIndexDuplicatesError || (err as { code?: unknown })?.code === '23505';

/** The failure as one line; a unique conflict names the declared index and the field. */
function failure(err: unknown, field: string): string {
  if (err instanceof UniqueIndexDuplicatesError) {
    return `unique index ${err.index ?? '(unnamed)'} refuses ${err.count} duplicated value(s) of ${field}`;
  }
  const pg = err as { code?: unknown; constraint_name?: unknown; detail?: unknown };
  if (pg?.code === '23505' && typeof pg.constraint_name === 'string') {
    // pg's detail names the duplicated key: `Key (f_x)=(v) already exists.`
    const detail = typeof pg.detail === 'string' ? `: ${pg.detail}` : '';
    return `unique index ${pg.constraint_name} refuses a duplicate value of ${field}${detail}`;
  }
  return (err instanceof Error ? err.message : String(err)).split('\n')[0] as string;
}

async function recordAttempt(
  sql: Sql,
  f: FieldRow,
  attempts: number,
  error: string | null,
  /** The catalog version a unique conflict was met at; see {@link due}. */
  errorVersion: string | null = null
): Promise<void> {
  await sql`UPDATE substrate_type_fields
            SET attempts = ${attempts}, last_error = ${error}, error_version = ${errorVersion}::bigint
            WHERE namespace = ${f.namespace} AND type = ${f.type} AND field = ${f.field}`;
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
    // `v` (`extra`) and `rv` (`$raw`) are the stored JSON text, so the updates' guards compare them exactly.
    const page = await sql<Array<{ id: string; v: string | null; rv: string | null }>>`
      SELECT id, CASE WHEN extra ? ${field} THEN (extra -> ${field})::text END AS v,
        CASE WHEN extra -> ${RAW_KEY}::text ? ${field} THEN (extra -> ${RAW_KEY}::text -> ${field})::text END AS rv
      FROM ${from} WHERE id > ${last} ORDER BY id LIMIT ${opts.batchRows}`;
    const ids: string[] = [];
    const values: string[] = [];
    const columns: Array<string | null> = [];
    const raws: Array<string | null> = [];
    // A `$raw` value the column now admits (a widened vocabulary): moved out of `$raw`.
    const fitIds: string[] = [];
    const fitValues: string[] = [];
    const fitColumns: string[] = [];
    for (const r of page) {
      const stored = r.v ?? r.rv;
      if (stored === null) continue;
      // A JSON number past 2^53 would lose digits in JSON.parse; an int64 column reads its text.
      const parsed =
        column.kind === 'int64' &&
        /^-?\d+$/.test(stored) &&
        parseInt64(BigInt(stored)) !== undefined
          ? BigInt(stored)
          : JSON.parse(stored);
      const encoded = encodeRow(table, { [field]: parsed as unknown });
      const c = encoded.columns[column.column];
      const misfit = Object.hasOwn(encoded.raw, field);
      if (r.v === null) {
        if (misfit || c === null || c === undefined) continue;
        fitIds.push(r.id);
        fitValues.push(stored);
        fitColumns.push(String(c));
        continue;
      }
      ids.push(r.id);
      values.push(r.v);
      columns.push(c === null || c === undefined ? null : String(c));
      // A misfit keeps the stored JSON text, so no digit is lost and nothing needs re-serialising.
      raws.push(misfit ? stored : null);
    }
    if (ids.length + fitIds.length > 0) {
      // Rows are locked in id order first, as every batch writer locks them,
      // so the update cannot deadlock against one. Only a row still holding the
      // value read is moved: a current writer has meanwhile set the column and
      // stripped the key, and a stale one put a newer value.
      const locked = [...ids, ...fitIds];
      await sql.begin(async (tx) => {
        await tx`SELECT 1 FROM ${from} WHERE id = ANY(${locked}::text[]) ORDER BY id FOR UPDATE`;
        if (fitIds.length > 0) {
          await tx`
          UPDATE ${from} AS t SET
            ${col} = u.c::${cast},
            extra = CASE
              WHEN (t.extra -> ${RAW_KEY}) - ${field}::text = '{}'::jsonb THEN t.extra - ${RAW_KEY}::text
              ELSE t.extra #- ARRAY[${RAW_KEY}::text, ${field}::text]
            END
          FROM unnest(${fitIds}::text[], ${fitValues}::text[], ${fitColumns}::text[]) AS u(id, rv, c)
          WHERE t.id = u.id AND NOT t.extra ? ${field}::text
            AND t.extra -> ${RAW_KEY}::text -> ${field}::text = u.rv::jsonb`;
        }
        if (ids.length === 0) return;
        await tx`
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
      });
    }
    if (page.length < opts.batchRows) return true;
    last = (page[page.length - 1] as { id: string }).id;
  }
}

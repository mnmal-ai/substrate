/** `PgDataset`'s patch and by-filter writes: one guarded statement each. */

import { preResolveExtensionOperatorsDetailed } from '@mnmal-ai/substrate-filter';
import type { FilterWriteResult, Row, WhereClause } from '@mnmal-ai/substrate-types';
import { filterTooBroad } from '@mnmal-ai/substrate-types';
import { castFor, type PgContext, uniqueViolation } from './pg-dataset-context.js';
import { type GuardedRecord, materialize } from './pg-dataset-row.js';
import { buildWhere, type Fragment, whereReferencesField } from './pg-sql.js';
import { encodeRow } from './row-codec.js';
import type { TypeTable } from './type-table.js';
import {
  guardCte,
  guardedRows,
  inputCte,
  mergeAssignments,
  returnedRowSql,
  setList,
  shortIdJoinSql
} from './write-rows.js';

/**
 * Merges each patch into its row of type table `table` in one statement, by
 * `applyPatch`'s rule, and returns the rows it changed. `stamp` adds SET
 * items; `match` must also hold on the stored row. `live`: only live rows,
 * locked in id order first, so overlapping concurrent batches queue instead
 * of deadlocking.
 */
export async function patchTable(
  ctx: PgContext,
  type: string,
  table: TypeTable,
  patches: ReadonlyArray<{ id: string; patch: Record<string, unknown> }>,
  stamp: Fragment | null,
  match: ((table: TypeTable) => Fragment) | null,
  live: boolean
): Promise<Row[]> {
  const ids = patches.map((p) => p.id);
  const written = await ctx.guarded(type, table, (t) =>
    patchStatement(ctx, type, t, patches, ids, stamp, match?.(t) ?? null, live)
  );
  const fields = ctx.typeDefLookup?.(type, ctx.namespace)?.fields;
  return written.records.map((r) => materialize(r, fields, written.table));
}

/** {@link #patchTable}'s one statement, built for `table`. */
async function patchStatement(
  ctx: PgContext,
  type: string,
  table: TypeTable,
  patches: ReadonlyArray<{ id: string; patch: Record<string, unknown> }>,
  ids: string[],
  stamp: Fragment | null,
  match: Fragment | null,
  live: boolean
): Promise<GuardedRecord[]> {
  const sql = ctx.sql;
  const rel = sql.unsafe(table.from);
  const encoded = patches.map((p) => ({ ...encodeRow(table, p.patch), id: p.id }));
  // Gated on the guard, so a refused (stale) patch locks no row (M7).
  const locked = live
    ? sql`,
    locked AS MATERIALIZED (
      SELECT count(*) AS n FROM (
        SELECT t.id FROM ${rel} t
        WHERE t.id = ANY(${ids}::text[]) AND t.deleted_at IS NULL AND (SELECT ok FROM guard)
        ORDER BY t.id
        FOR NO KEY UPDATE OF t
      ) x
    )`
    : sql``;
  return (await sql`
    WITH ${inputCte(sql, table, encoded)}${locked},
    updated AS (
      UPDATE ${rel} t
      SET ${sql.unsafe(setList(mergeAssignments(table, 't', 'i', encoded)))}${stamp === null ? sql`` : sql`, ${stamp}`}
      FROM input i${live ? sql`, locked` : sql``}
      WHERE t.id = i.rid${live ? sql` AND t.deleted_at IS NULL` : sql``}${match === null ? sql`` : sql` AND ${match}`}
      RETURNING t.*
    )
    ${guardedRows(sql, sql`SELECT ${returnedRowSql(sql, table, 'u')} FROM updated u ${sql.unsafe(shortIdJoinSql(table, 'u.id'))}`)}
  `.catch((err: unknown) => {
    throw uniqueViolation(ctx, type, err);
  })) as unknown as GuardedRecord[];
}

/**
 * One statement: `m` locks up to `maxMatch + 1` live matches, `u` writes
 * them only when there are at most `maxMatch`, re-testing `where` on each,
 * and the outer select always returns one row carrying `count(m)`, so a
 * too-broad filter tells from zero matches. Under READ COMMITTED a row a
 * concurrent writer changed is re-tested on its new version after the lock
 * (`FOR UPDATE`), so one moved out of the filter is neither locked nor
 * written. Locks are taken in id order, so overlapping filter writes queue
 * rather than deadlock. `preImage` returns the rows without the write's
 * `deleted_at`. `build` gives, for the table the write is built for, the
 * SET list and the CTE `assign` reads as `i` (when it reads one). A stale
 * table's guard matches nothing, and the write is rebuilt (`#guarded`).
 */
export async function filterWrite(
  ctx: PgContext,
  type: string,
  where: WhereClause,
  maxMatch: number,
  build: (table: TypeTable) => { input: Fragment | null; assign: Fragment },
  preImage: boolean,
  table: TypeTable
): Promise<FilterWriteResult> {
  // k as memory's read passes it: the match limit.
  const { where: resolved } = await preResolveExtensionOperatorsDetailed(where, {
    namespace: ctx.namespace,
    type,
    k: maxMatch + 1
  });
  // shortId lives on the sidecar, so a where that reads it joins short_ids, as `read` does.
  const joinShortIds = whereReferencesField(resolved, 'shortId');
  const fields = ctx.typeDefLookup?.(type, ctx.namespace)?.fields;
  const written = await ctx.guarded(type, table, async (t) => {
    const { input, assign } = build(t);
    const records = await filterStatement(ctx, t, resolved, joinShortIds, maxMatch, input, assign);
    const head = records[0];
    if (head?.ok === true && head.matched > maxMatch) {
      throw filterTooBroad(ctx.namespace, type, maxMatch);
    }
    return records;
  });
  const rows = written.records.map((r) => {
    const row = materialize(r, fields, written.table);
    if (preImage) delete row._deletedAt;
    return row;
  });
  return { count: rows.length, ids: rows.map((r) => r.id), rows };
}

/** {@link #filterWrite}'s one statement, built for `table`. */
async function filterStatement(
  ctx: PgContext,
  table: TypeTable,
  resolved: WhereClause,
  joinShortIds: boolean,
  maxMatch: number,
  input: Fragment | null,
  assign: Fragment
): Promise<Array<GuardedRecord & { matched: number }>> {
  const sql = ctx.sql;
  const filter = buildWhere(sql, resolved, castFor(ctx, table.type), table) ?? sql`true`;
  const rel = sql.unsafe(table.from);
  // The UPDATE target cannot appear in a FROM join's ON, so the sidecar joins on m.
  const sidecar = (id: string) => (joinShortIds ? sql.unsafe(shortIdJoinSql(table, id)) : sql``);
  return (await sql`
    WITH ${input ?? guardCte(sql, table)},
    m AS (
      SELECT r.id AS mid FROM ${rel} r ${sidecar('r.id')}
      WHERE (SELECT ok FROM guard) AND ${filter} AND r.deleted_at IS NULL
      ORDER BY r.id
      LIMIT ${maxMatch + 1}
      FOR UPDATE OF r
    ),
    u AS (
      UPDATE ${rel} r SET ${assign}
      FROM m ${sidecar('m.mid')}${input === null ? sql`` : sql`, input i`}
      WHERE r.id = m.mid
        AND (SELECT count(*) FROM m) <= ${maxMatch}
        AND ${filter} AND r.deleted_at IS NULL
      RETURNING r.*
    )
    SELECT g.ok, (SELECT count(*) FROM m)::int AS matched, ${returnedRowSql(sql, table, 'u')}
    FROM guard g
    LEFT JOIN u ON true
    ${sql.unsafe(shortIdJoinSql(table, 'u.id'))}
  `) as unknown as Array<GuardedRecord & { matched: number }>;
}

/**
 * SQL over the `r` (rows) alias shared by the pg recall stores: the relation
 * `r` reads, the row body as the dataset read path returns it, and the row
 * filter.
 *
 * On the old layouts `r` is `rows`, and every statement is as it was before
 * type tables. On `tables` it is a relation with `rows`' columns built from the
 * type tables (`rowsFrom`), so the same statements read it, and its `body` is
 * the row `dataset.read` returns.
 */

import { type PgHandle, type TypeTableRef, typeTableRef } from '@mnmal-ai/substrate-dataset-pg';
import type postgres from 'postgres';
import type { Sql } from 'postgres';
import { type KnnRowFilter, ROW_FILTER_FIELD } from './embeddings-store.js';

/** The row body over `r`, as the dataset read path returns it: `rowsFrom` names it `body`. */
export const ROW_BODY_SQL = 'r.body';

/** A type and its rows' ref; `ref` is undefined when the type has no table yet. */
export interface ScopedRef {
  namespace: string;
  type: string;
  ref: TypeTableRef | undefined;
}

/** {@link ScopedRef} of each `{ namespace, type }`. */
export function scopedRefs(
  sql: PgHandle,
  scopes: ReadonlyArray<{ namespace: string; type: string }>
): Promise<ScopedRef[]> {
  return Promise.all(
    scopes.map(async ({ namespace, type }) => ({
      namespace,
      type,
      ref: await typeTableRef(sql, namespace, type)
    }))
  );
}

/** True on the old layouts, whose one `rows` holds every type. */
export const isRowsRef = (ref: TypeTableRef): boolean => ref.scope('r') !== null;

const EMPTY_ROWS =
  '(SELECT NULL::text AS namespace, NULL::text AS type, NULL::text AS id, NULL::timestamptz AS deleted_at, NULL::timestamptz AS updated_at, NULL::jsonb AS body WHERE false)';

/**
 * The relation the stores join as `r`: `rows` on the old layouts; on `tables`,
 * the scopes' type tables as one relation with `rows`' columns (namespace,
 * type, id, deleted_at, updated_at, body). `wide` (one scope only) adds the
 * type table's own columns, which `rowFilterSql` reads through `ref.text`.
 */
export function rowsFrom(
  sql: Sql,
  scoped: ReadonlyArray<ScopedRef>,
  wide = false
): postgres.Fragment {
  const present = scoped.flatMap((s) => (s.ref === undefined ? [] : [{ ...s, ref: s.ref }]));
  const rows = present.find((s) => isRowsRef(s.ref));
  if (rows !== undefined) return sql.unsafe(rows.ref.from);
  if (present.length === 0) return sql.unsafe(EMPTY_ROWS);
  const columns = wide ? 'x.*' : 'x.id, x.deleted_at, x.updated_at';
  let union = sql``;
  for (const [i, { namespace, type, ref }] of present.entries()) {
    union = sql`${union}${sql.unsafe(i === 0 ? '' : ' UNION ALL ')}SELECT ${namespace}::text AS namespace, ${type}::text AS type, ${sql.unsafe(`${columns}, ${ref.rowJson('x')} AS body FROM ${ref.from} x`)}`;
  }
  return sql`(${union})`;
}

/**
 * The row filter as `AND …` clauses, for appending to a WHERE. Every
 * comparison is as text against the row, the same semantics as
 * `matchesRowFilter`: `r.body ->> field` on the old layouts, and on a type
 * table `ref.text`, over the columns a `wide` `rowsFrom` exposes. Field names
 * are re-checked against ROW_FILTER_FIELD and values are bound, so nothing
 * caller-supplied is spliced into SQL unquoted.
 */
export function rowFilterSql(tx: Sql, ref: TypeTableRef, filter: KnnRowFilter | undefined) {
  if (filter === undefined) return tx``;
  let out = tx``;
  for (const [field, pred] of Object.entries(filter)) {
    if (!ROW_FILTER_FIELD.test(field))
      throw new Error(`row filter field '${field}' is not a plain identifier`);
    // The old layouts keep their statement as it was: the field bound, not inlined.
    const onRows = isRowsRef(ref);
    const text = onRows ? tx`(r.body ->> ${field})` : tx.unsafe(ref.text('r', field));
    const isNull = onRows
      ? tx`(r.body ->> ${field}) IS NULL`
      : tx.unsafe(`${ref.text('r', field)} IS NULL`);
    const values = pred.in ?? [pred.eq ?? null];
    const strings = values.filter((v) => v !== null).map((v) => String(v));
    const wantsNull = values.some((v) => v === null);
    const clause =
      strings.length === 0
        ? isNull
        : wantsNull
          ? tx`(${text} = ANY(${strings}::text[]) OR ${isNull})`
          : tx`${text} = ANY(${strings}::text[])`;
    out = tx`${out} AND ${clause}`;
  }
  return out;
}

/**
 * `purgeOrphans` on `tables`: once per distinct type in `table` (`embeddings`
 * or `lexical`), deletes the entries whose row is missing or tombstoned in its
 * type table. A type with no table deletes all of its entries.
 *
 * @returns the number of entries deleted.
 */
export async function purgeTypeTableOrphans(
  sql: Sql,
  table: 'embeddings' | 'lexical'
): Promise<number> {
  const types = await sql<Array<{ namespace: string; type: string }>>`
    SELECT DISTINCT row_namespace AS namespace, row_type AS type FROM ${sql(table)}`;
  let deleted = 0;
  for (const scope of await scopedRefs(sql, types)) {
    const result = await sql`
      DELETE FROM ${sql(table)} o
      WHERE o.row_namespace = ${scope.namespace}
        AND o.row_type      = ${scope.type}
        AND NOT EXISTS (
          SELECT 1 FROM ${rowsFrom(sql, [scope])} r
          WHERE r.id = o.row_id AND r.deleted_at IS NULL
        )
    `;
    deleted += result.count;
  }
  return deleted;
}

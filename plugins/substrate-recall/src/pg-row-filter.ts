/**
 * SQL over the `r` (rows) alias shared by the pg recall stores: the row
 * body as the dataset read path returns it, and the row filter.
 */

import type { Sql } from 'postgres';
import { type KnnRowFilter, ROW_FILTER_FIELD } from './embeddings-store.js';

/** The row body, as the dataset read path returns it. */
export const ROW_BODY_SQL = 'r.body';

/**
 * The row filter as `AND …` clauses, for appending to a WHERE. Every
 * comparison is as text against the body, the same semantics as
 * `matchesRowFilter`. Field names are re-checked
 * against ROW_FILTER_FIELD and values are bound, so nothing caller-supplied is
 * spliced into SQL.
 */
export function rowFilterSql(tx: Sql, filter: KnnRowFilter | undefined) {
  if (filter === undefined) return tx``;
  let out = tx``;
  for (const [field, pred] of Object.entries(filter)) {
    if (!ROW_FILTER_FIELD.test(field))
      throw new Error(`row filter field '${field}' is not a plain identifier`);
    const text = tx`(r.body ->> ${field})`;
    const isNull = tx`(r.body ->> ${field}) IS NULL`;
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

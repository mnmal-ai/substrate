/**
 * Raw-SQL cleanup for the suites: each type has a table of its own, listed in
 * the catalog (`substrate_type_tables`), and its ids in `row_ids`.
 */

import type { Sql, TransactionSql } from 'postgres';
import { ident, typeTableName } from '../src/layout.js';
import type { TypeTable } from '../src/type-table.js';

/** The type tables of `namespace`, as quoted identifiers. */
async function typeTables(sql: Sql, namespace: string): Promise<string[]> {
  const rows = await sql<Array<{ table_name: string }>>`
    SELECT table_name FROM substrate_type_tables WHERE namespace = ${namespace}`;
  return rows.map((r) => `"${r.table_name.replace(/"/g, '""')}"`);
}

/** Deletes every row of `namespace`, keeping its type tables (a dataset may hold them cached). */
export async function clearNamespace(sql: Sql, namespace: string): Promise<void> {
  for (const t of await typeTables(sql, namespace)) await sql.unsafe(`DELETE FROM ${t}`);
  // short_ids cascade from row_ids.
  await sql`DELETE FROM row_ids WHERE namespace = ${namespace}`;
}

/** Teardown: drops `namespace`'s type tables and catalog rows. */
export async function dropNamespace(sql: Sql, namespace: string): Promise<void> {
  for (const t of await typeTables(sql, namespace)) await sql.unsafe(`DROP TABLE IF EXISTS ${t}`);
  await sql`DELETE FROM substrate_type_fields WHERE namespace = ${namespace}`;
  await sql`DELETE FROM substrate_type_tables WHERE namespace = ${namespace}`;
  await sql`DELETE FROM row_ids WHERE namespace = ${namespace}`;
  await sql`DELETE FROM visible_seqs WHERE namespace = ${namespace}`;
}

/** All rows of every namespace, with their ids and short ids. Keeps type tables. */
export async function truncateRows(sql: Sql): Promise<void> {
  const rows = await sql<
    Array<{ table_name: string }>
  >`SELECT table_name FROM substrate_type_tables`;
  const tables = rows.map((r) => `"${r.table_name.replace(/"/g, '""')}"`);
  await sql.unsafe(`TRUNCATE TABLE ${[...tables, 'row_ids', 'short_ids'].join(', ')}`);
}

/** The type table holding `type`'s rows, quoted. */
export async function relationOf(
  sql: Sql | TransactionSql,
  namespace: string,
  type: string
): Promise<string> {
  const [t] = await sql<Array<{ table_name: string }>>`
    SELECT table_name FROM substrate_type_tables WHERE namespace = ${namespace} AND type = ${type}`;
  if (t === undefined) throw new Error(`${namespace}/${type} has no type table`);
  return `"${t.table_name.replace(/"/g, '""')}"`;
}

/** `<type table> WHERE`, for a raw statement on `type`'s rows to finish. */
export async function rowsWhere(sql: Sql, namespace: string, type: string): Promise<string> {
  return `${await relationOf(sql, namespace, type)} WHERE`;
}

/** Registers a row id a short id can bind to without writing a row, in `row_ids`. */
export async function seedRowId(
  sql: Sql,
  namespace: string,
  type: string,
  id: string
): Promise<void> {
  await sql`INSERT INTO row_ids (namespace, type, id) VALUES (${namespace}, ${type}, ${id})
    ON CONFLICT DO NOTHING`;
}

/** {@link dropNamespace} for every namespace starting `prefix`. */
export async function dropNamespacesLike(sql: Sql, prefix: string): Promise<void> {
  const like = `${prefix}%`;
  const found = await sql<Array<{ namespace: string }>>`
    SELECT DISTINCT namespace FROM substrate_type_tables WHERE namespace LIKE ${like}`;
  for (const { namespace } of found) await dropNamespace(sql, namespace);
}

/** The descriptor of `namespace`/`type`'s table with no field columns: every field reads from `extra`. */
export function bareTypeTable(namespace: string, type: string): TypeTable {
  return {
    namespace,
    type,
    from: ident(typeTableName(namespace, type)),
    jsonb: 'extra',
    column: () => undefined,
    columns: () => [],
    pending: [],
    orphaned: []
  };
}

/**
 * The storage layout this run's suites built (`SUBSTRATE_TEST_LAYOUT`), and
 * cleanup that works in each: the old layouts keep every row in `rows`; on
 * `tables` each type has a table of its own, listed in the catalog.
 */

import type { Sql, TransactionSql } from 'postgres';

export const LAYOUT = process.env.SUBSTRATE_TEST_LAYOUT ?? 'legacy';
export const TABLES = LAYOUT === 'tables';

/** The type tables of `namespace`, as quoted identifiers. */
async function typeTables(sql: Sql, namespace: string): Promise<string[]> {
  const rows = await sql<Array<{ table_name: string }>>`
    SELECT table_name FROM substrate_type_tables WHERE namespace = ${namespace}`;
  return rows.map((r) => `"${r.table_name.replace(/"/g, '""')}"`);
}

/** Deletes every row of `namespace`, keeping its type tables (a dataset may hold them cached). */
export async function clearNamespace(sql: Sql, namespace: string): Promise<void> {
  if (!TABLES) {
    await sql`DELETE FROM rows WHERE namespace = ${namespace}`;
    return;
  }
  for (const t of await typeTables(sql, namespace)) await sql.unsafe(`DELETE FROM ${t}`);
  // short_ids cascade from row_ids.
  await sql`DELETE FROM row_ids WHERE namespace = ${namespace}`;
}

/** Teardown: drops `namespace`'s type tables and catalog rows on `tables`; else deletes its rows. */
export async function dropNamespace(sql: Sql, namespace: string): Promise<void> {
  if (!TABLES) {
    await sql`DELETE FROM rows WHERE namespace = ${namespace}`;
    return;
  }
  for (const t of await typeTables(sql, namespace)) await sql.unsafe(`DROP TABLE IF EXISTS ${t}`);
  await sql`DELETE FROM substrate_type_fields WHERE namespace = ${namespace}`;
  await sql`DELETE FROM substrate_type_tables WHERE namespace = ${namespace}`;
  await sql`DELETE FROM row_ids WHERE namespace = ${namespace}`;
  await sql`DELETE FROM visible_seqs WHERE namespace = ${namespace}`;
}

/** All rows of every namespace, as `TRUNCATE TABLE rows, short_ids` on the old layouts. Keeps type tables. */
export async function truncateRows(sql: Sql): Promise<void> {
  if (!TABLES) {
    await sql`TRUNCATE TABLE rows, short_ids`;
    return;
  }
  const rows = await sql<
    Array<{ table_name: string }>
  >`SELECT table_name FROM substrate_type_tables`;
  const tables = rows.map((r) => `"${r.table_name.replace(/"/g, '""')}"`);
  await sql.unsafe(`TRUNCATE TABLE ${[...tables, 'row_ids', 'short_ids'].join(', ')}`);
}

/** The relation holding `type`'s rows, quoted: `rows`, or its type table. */
export async function relationOf(
  sql: Sql | TransactionSql,
  namespace: string,
  type: string
): Promise<string> {
  if (!TABLES) return 'rows';
  const [t] = await sql<Array<{ table_name: string }>>`
    SELECT table_name FROM substrate_type_tables WHERE namespace = ${namespace} AND type = ${type}`;
  if (t === undefined) throw new Error(`${namespace}/${type} has no type table`);
  return `"${t.table_name.replace(/"/g, '""')}"`;
}

/**
 * `<relation> WHERE <type's rows> AND`, for a raw statement on `type`'s rows to
 * finish: `rows` scoped to the type, or its type table.
 */
export async function rowsWhere(sql: Sql, namespace: string, type: string): Promise<string> {
  const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;
  const rel = await relationOf(sql, namespace, type);
  return TABLES
    ? `${rel} WHERE`
    : `${rel} WHERE namespace = ${lit(namespace)} AND type = ${lit(type)} AND`;
}

/** Registers a row id a short id can bind to without writing a row: `rows` or `row_ids`. */
export async function seedRowId(
  sql: Sql,
  namespace: string,
  type: string,
  id: string
): Promise<void> {
  await (TABLES
    ? sql`INSERT INTO row_ids (namespace, type, id) VALUES (${namespace}, ${type}, ${id})
          ON CONFLICT DO NOTHING`
    : sql`INSERT INTO rows (namespace, type, id, body) VALUES (${namespace}, ${type}, ${id}, '{}'::jsonb)
          ON CONFLICT (namespace, type, id) DO NOTHING`);
}

/** {@link dropNamespace} for every namespace starting `prefix`. */
export async function dropNamespacesLike(sql: Sql, prefix: string): Promise<void> {
  const like = `${prefix}%`;
  if (!TABLES) {
    await sql`DELETE FROM rows WHERE namespace LIKE ${like}`;
    return;
  }
  const found = await sql<Array<{ namespace: string }>>`
    SELECT DISTINCT namespace FROM substrate_type_tables WHERE namespace LIKE ${like}`;
  for (const { namespace } of found) await dropNamespace(sql, namespace);
}

/**
 * Raw-SQL helpers for the pg suites: each type has a table of its own, listed
 * in `substrate_type_tables`, and its ids in `row_ids`.
 */

import type { Sql } from 'postgres';

const quote = (name: string): string => `"${name.replace(/"/g, '""')}"`;

/** Deletes the rows and ids of the namespaces, keeping their type tables. */
export async function deleteNamespaces(sql: Sql, ...namespaces: string[]): Promise<void> {
  const tables = await sql<Array<{ table_name: string }>>`
    SELECT table_name FROM substrate_type_tables WHERE namespace = ANY(${namespaces})`;
  for (const t of tables) await sql.unsafe(`DELETE FROM ${quote(t.table_name)}`);
  await sql`DELETE FROM row_ids WHERE namespace = ANY(${namespaces})`;
}

/** The type table `namespace`/`type`'s rows live in, quoted. */
export async function relationOf(sql: Sql, namespace: string, type: string): Promise<string> {
  const [t] = await sql<Array<{ table_name: string }>>`
    SELECT table_name FROM substrate_type_tables WHERE namespace = ${namespace} AND type = ${type}`;
  if (t === undefined) throw new Error(`${namespace}/${type} has no table`);
  return quote(t.table_name);
}

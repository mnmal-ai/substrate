/**
 * The storage layout this run's pg suites built (`SUBSTRATE_TEST_LAYOUT`): the
 * old layouts keep every row in `rows`; on `tables` each type has a table of
 * its own, listed in `substrate_type_tables`, and its ids in `row_ids`.
 */

import type { Sql } from 'postgres';

export const TABLES = process.env.SUBSTRATE_TEST_LAYOUT === 'tables';

const quote = (name: string): string => `"${name.replace(/"/g, '""')}"`;

/** `DELETE FROM rows WHERE namespace IN (…)`; on `tables`, the namespaces' type tables and ids. */
export async function deleteNamespaces(sql: Sql, ...namespaces: string[]): Promise<void> {
  if (!TABLES) {
    await sql`DELETE FROM rows WHERE namespace = ANY(${namespaces})`;
    return;
  }
  const tables = await sql<Array<{ table_name: string }>>`
    SELECT table_name FROM substrate_type_tables WHERE namespace = ANY(${namespaces})`;
  for (const t of tables) await sql.unsafe(`DELETE FROM ${quote(t.table_name)}`);
  await sql`DELETE FROM row_ids WHERE namespace = ANY(${namespaces})`;
}

/** The relation `namespace`/`type`'s rows live in, quoted: `rows`, or its type table. */
export async function relationOf(sql: Sql, namespace: string, type: string): Promise<string> {
  if (!TABLES) return 'rows';
  const [t] = await sql<Array<{ table_name: string }>>`
    SELECT table_name FROM substrate_type_tables WHERE namespace = ${namespace} AND type = ${type}`;
  if (t === undefined) throw new Error(`${namespace}/${type} has no table`);
  return quote(t.table_name);
}

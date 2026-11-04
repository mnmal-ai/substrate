/**
 * The raw-SQL cleanup the pg suites need: each type has a table of its own,
 * listed in `substrate_type_tables`, and its ids in `row_ids`.
 */

import { PgDataset } from '@mnmal-ai/substrate-dataset-pg';
import type { WhereClause } from '@mnmal-ai/substrate-types';
import type { Sql } from 'postgres';

const quote = (name: string): string => `"${name.replace(/"/g, '""')}"`;

/** The type tables, quoted, of the namespaces `namespace LIKE like` or `= ANY(namespaces)` picks. */
async function typeTables(sql: Sql, namespaces: string[], like?: string): Promise<string[]> {
  const rows =
    like === undefined
      ? await sql<Array<{ table_name: string }>>`
          SELECT table_name FROM substrate_type_tables WHERE namespace = ANY(${namespaces})`
      : await sql<Array<{ table_name: string }>>`
          SELECT table_name FROM substrate_type_tables WHERE namespace LIKE ${like}`;
  return rows.map((r) => quote(r.table_name));
}

/** Deletes the rows and ids of the namespaces, keeping their type tables. */
export async function deleteNamespaces(sql: Sql, ...namespaces: string[]): Promise<void> {
  for (const t of await typeTables(sql, namespaces)) await sql.unsafe(`DELETE FROM ${t}`);
  await sql`DELETE FROM row_ids WHERE namespace = ANY(${namespaces})`;
}

/** {@link deleteNamespaces} for every namespace `LIKE like`. */
export async function deleteNamespacesLike(sql: Sql, like: string): Promise<void> {
  for (const t of await typeTables(sql, [], like)) await sql.unsafe(`DELETE FROM ${t}`);
  await sql`DELETE FROM row_ids WHERE namespace LIKE ${like}`;
}

/** Every type table, `row_ids` and `short_ids`, truncated. */
export async function truncateRows(sql: Sql): Promise<void> {
  const tables = await sql<Array<{ table_name: string }>>`
    SELECT table_name FROM substrate_type_tables`;
  await sql.unsafe(
    `TRUNCATE TABLE ${[...tables.map((t) => quote(t.table_name)), 'row_ids', 'short_ids'].join(', ')}`
  );
}

/** The type table `namespace`/`type`'s rows live in, quoted (undefined before it has one). */
export async function relationOf(
  sql: Sql,
  namespace: string,
  type: string
): Promise<string | undefined> {
  const [t] = await sql<Array<{ table_name: string }>>`
    SELECT table_name FROM substrate_type_tables WHERE namespace = ${namespace} AND type = ${type}`;
  return t === undefined ? undefined : quote(t.table_name);
}

/**
 * Purges the rows of `namespace`/`type` that `where` matches, tombstoned ones
 * too, through the dataset, so a field is found wherever its value lives (a
 * column, or `extra` while it is promoting).
 */
export async function purgeWhere(
  sql: Sql,
  namespace: string,
  type: string,
  where?: WhereClause
): Promise<void> {
  const ds = new PgDataset({ namespace, sql });
  const { rows } = await ds.read(type, {
    ...(where !== undefined ? { where } : {}),
    includeDeleted: true,
    limit: 100_000
  });
  if (rows.length > 0)
    await ds.purge(
      type,
      rows.map((r) => r.id)
    );
}

const UUID_PATTERN = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

/** The rows (and ids) whose id is not UUID-shaped, which the UUID CHECKs refuse. */
export async function deleteNonUuidTypeTableRows(sql: Sql): Promise<void> {
  const tables = await sql<Array<{ table_name: string }>>`
    SELECT table_name FROM substrate_type_tables`;
  for (const t of tables) {
    await sql.unsafe(`DELETE FROM ${quote(t.table_name)} WHERE id !~ $1`, [UUID_PATTERN]);
  }
  await sql`DELETE FROM row_ids WHERE id !~ ${UUID_PATTERN}`;
}

/** Drops the UUID CHECKs on `row_ids` and on every type table. */
export async function dropTypeTableUuidChecks(sql: Sql): Promise<void> {
  await sql`ALTER TABLE row_ids DROP CONSTRAINT IF EXISTS row_ids_id_uuid_format`;
  const tables = await sql<Array<{ table_name: string }>>`
    SELECT table_name FROM substrate_type_tables`;
  for (const t of tables) {
    await sql.unsafe(`ALTER TABLE ${quote(t.table_name)} DROP CONSTRAINT IF EXISTS id_uuid_format`);
  }
}

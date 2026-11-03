/**
 * Creates the `rows` table the recall stores join against, through the real
 * migrations, so it has the layout this run selected. Called once, from
 * `_global-setup.ts`: the migrations build indexes CONCURRENTLY, which wait on
 * every open transaction in the database, so they must not run under a hook
 * timeout while other packages' suites hold transactions.
 *
 * Also the raw row seeding the recall suites use, which writes `rows` on the
 * old layouts and the type tables on `tables`.
 */

import { ensureTypeTable, loadTypeTable, runMigrations } from '@mnmal-ai/substrate-dataset-pg';
import type postgres from 'postgres';

export async function ensureRows(sql: ReturnType<typeof postgres>): Promise<void> {
  await runMigrations(sql);
}

/** True when this run built the `tables` layout (`SUBSTRATE_TEST_LAYOUT`). */
export const TABLES = (process.env.SUBSTRATE_TEST_LAYOUT ?? 'legacy') === 'tables';

type Pg = ReturnType<typeof postgres>;

/** A row as the recall suites seed it, raw: `body` is the whole stored row. */
export interface SeedRow {
  namespace: string;
  type: string;
  id: string;
  body: Record<string, unknown>;
  updatedAt?: Date | null;
  deletedAt?: Date | null;
}

/** `namespace`/`type`'s table on `tables`, created bare (no declared fields, so a body lands in `extra`). */
async function tableOf(sql: Pg, namespace: string, type: string): Promise<string> {
  const args = { namespace, type, fields: {}, newFields: 'column' as const };
  await ensureTypeTable(sql, { ...args, enforceUuidCheck: false, createOnly: true });
  const table = await loadTypeTable(sql, namespace, type);
  if (table === undefined) throw new Error(`no table for ${namespace}/${type}`);
  return table.from;
}

/** The type tables of `namespace` (all of them when undefined), optionally one type's. */
async function tablesOf(sql: Pg, namespace?: string, type?: string): Promise<string[]> {
  const rows = await sql<Array<{ table_name: string }>>`
    SELECT table_name FROM substrate_type_tables
    WHERE (${namespace ?? null}::text IS NULL OR namespace = ${namespace ?? null})
      AND (${type ?? null}::text IS NULL OR type = ${type ?? null})`;
  return rows.map((r) => `"${r.table_name.replace(/"/g, '""')}"`);
}

/**
 * Upserts `rows`: into `rows` on the old layouts, else into each type's table
 * with the body as `extra`. A conflict replaces the body, and `updated_at` and
 * `deleted_at` when the row gives them.
 */
export async function putRows(sql: Pg, rows: SeedRow[]): Promise<void> {
  for (const r of rows) {
    const times = {
      ...(r.updatedAt !== undefined ? { updated_at: r.updatedAt } : {}),
      ...(r.deletedAt !== undefined ? { deleted_at: r.deletedAt } : {})
    };
    const body = sql.json(r.body as postgres.JSONValue);
    const row = TABLES
      ? { id: r.id, extra: body, ...times }
      : { namespace: r.namespace, type: r.type, id: r.id, body, ...times };
    const set = Object.keys(row)
      .filter((k) => !['namespace', 'type', 'id'].includes(k))
      .map((k) => `${k} = EXCLUDED.${k}`)
      .join(', ');
    const [into, key] = TABLES
      ? [await tableOf(sql, r.namespace, r.type), 'id']
      : ['rows', 'namespace, type, id'];
    await sql`INSERT INTO ${sql.unsafe(into)} ${sql(row)}
      ON CONFLICT (${sql.unsafe(key)}) DO UPDATE SET ${sql.unsafe(set)}`;
  }
}

/** Tombstones a row: `deleted_at = now()`. */
export async function tombstoneRow(sql: Pg, namespace: string, type: string, id: string) {
  if (!TABLES) {
    await sql`UPDATE rows SET deleted_at = now()
      WHERE namespace = ${namespace} AND type = ${type} AND id = ${id}`;
    return;
  }
  for (const t of await tablesOf(sql, namespace, type)) {
    await sql`UPDATE ${sql.unsafe(t)} SET deleted_at = now() WHERE id = ${id}`;
  }
}

/** Hard-deletes `namespace`'s rows, optionally of one type, optionally one row. */
export async function deleteRows(sql: Pg, namespace: string, type?: string, id?: string) {
  if (!TABLES) {
    await sql`DELETE FROM rows WHERE namespace = ${namespace}
      ${type === undefined ? sql`` : sql`AND type = ${type}`}
      ${id === undefined ? sql`` : sql`AND id = ${id}`}`;
    return;
  }
  for (const t of await tablesOf(sql, namespace, type)) {
    await sql`DELETE FROM ${sql.unsafe(t)} ${id === undefined ? sql`` : sql`WHERE id = ${id}`}`;
  }
}

/** Every row of every type: `TRUNCATE TABLE rows CASCADE` on the old layouts. */
export async function truncateRows(sql: Pg): Promise<void> {
  if (!TABLES) {
    await sql`TRUNCATE TABLE rows CASCADE`;
    return;
  }
  const tables = await tablesOf(sql);
  if (tables.length > 0) await sql.unsafe(`TRUNCATE TABLE ${tables.join(', ')}`);
}

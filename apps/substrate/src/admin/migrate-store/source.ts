/**
 * Read-only inventory of a migrate-store source. Every read runs in one
 * REPEATABLE READ, READ ONLY transaction, so the inventory is one snapshot and
 * nothing here can write to the source. It never runs migrations and never
 * goes through `assertServerVersion`: the source may be PG 17.
 */

import {
  assertStoreSchema,
  detectLayout,
  type StorageLayout,
  UUID_REGEX
} from '@mnmal-ai/substrate-dataset-pg';
import type { Sql } from 'postgres';

/** The ledger version of the opt-in UUID-format CHECKs (`SUBSTRATE_ENFORCE_UUID_CHECK`). */
export const UUID_CHECK_MIGRATION = '0002_uuid_format_check';

export interface SourceType {
  namespace: string;
  type: string;
  live: number;
  deleted: number;
  bytes: number;
}

export interface SourceInventory {
  serverVersionNum: number;
  layout: StorageLayout;
  appliedMigrations: string[];
  hasSeq: boolean;
  hasVisibleSeqs: boolean;
  types: SourceType[];
  /** The schema's ordinary tables, partitions of `rows` excluded. */
  tables: string[];
  /** Per table in `tables`: its non-generated columns, in attnum order. */
  columns: Record<string, string[]>;
  /** Per table in `tables`: `pg_table_size`, summed over partitions. Indexes are not counted. */
  tableBytes: Record<string, number>;
  /** Up to 20 ids per checked column (rows.id, short_ids.row_id, edges.from_id, edges.to_id) that fail the UUID shape. */
  nonUuidIds: { table: string; column: string; namespace: string; type: string; id: string }[];
  /** `atttypmod` of `embeddings.embedding`; null when absent or unconstrained. */
  vectorDims: number | null;
  /** Installed extensions, name to `extversion`. */
  extensions: Record<string, string>;
  /** Other client backends on this database; pg_stat_activity hides other roles' rows from a non-monitoring role. */
  otherSessions: number;
}

export async function inspectSource(sql: Sql): Promise<SourceInventory> {
  // Reads only. Every other connection the caller holds on this database, a target in the same database included,
  // counts toward `otherSessions`: pass a pool of one and subtract your own.
  const result = await sql.begin('isolation level repeatable read read only', async (tx) => {
    await assertStoreSchema(tx as unknown as Sql);
    const layout = await detectLayout(tx as unknown as Sql);
    if (layout === 'absent') throw new Error('the source schema holds no rows table');
    const [version] = await tx<
      { v: number }[]
    >`SELECT current_setting('server_version_num')::int AS v`;
    const [ledger] = await tx<
      { present: boolean }[]
    >`SELECT to_regclass('migrations') IS NOT NULL AS present`;
    const appliedMigrations = ledger?.present
      ? (await tx<{ version: string }[]>`SELECT version FROM migrations ORDER BY version`).map(
          (r) => r.version
        )
      : [];
    const tableRows = await tx<{ name: string; bytes: string }[]>`
      SELECT c.relname AS name,
             -- pg_partition_tree is empty for an ordinary table.
             (CASE WHEN c.relkind = 'p'
                   THEN (SELECT coalesce(sum(pg_table_size(t.relid)), 0) FROM pg_partition_tree(c.oid) t WHERE t.isleaf)
                   ELSE pg_table_size(c.oid) END)::text AS bytes
      FROM pg_class c
      WHERE c.relnamespace = current_schema()::regnamespace
        AND c.relkind IN ('r', 'p') AND NOT c.relispartition
      ORDER BY c.relname`;
    const colRows = await tx<{ table: string; col: string }[]>`
      SELECT c.relname AS "table", a.attname AS col
      FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
      WHERE c.relnamespace = current_schema()::regnamespace
        AND c.relkind IN ('r', 'p') AND NOT c.relispartition
        AND a.attnum > 0 AND NOT a.attisdropped AND a.attgenerated = ''
      ORDER BY c.relname, a.attnum`;
    const columns: Record<string, string[]> = {};
    for (const r of colRows) {
      const list = columns[r.table] ?? [];
      list.push(r.col);
      columns[r.table] = list;
    }
    const types = await tx<
      { namespace: string; type: string; live: string; deleted: string; bytes: string }[]
    >`
      SELECT namespace, type,
             count(*) FILTER (WHERE deleted_at IS NULL)::text AS live,
             count(*) FILTER (WHERE deleted_at IS NOT NULL)::text AS deleted,
             coalesce(sum(pg_column_size(r.*)), 0)::text AS bytes
      FROM rows r GROUP BY namespace, type ORDER BY namespace, type`;
    const nonUuid = (table: string, column: string, nsCol: string, typeCol: string) =>
      tx<{ namespace: string; type: string; id: string }[]>`
        SELECT ${tx(nsCol)} AS namespace, ${tx(typeCol)} AS type, ${tx(column)} AS id
        FROM ${tx(table)} WHERE ${tx(column)} !~ ${UUID_REGEX}
        ORDER BY 1, 2, 3 LIMIT 20`.then((rs) => rs.map((r) => ({ table, column, ...r })));
    const nonUuidIds = [
      ...(await nonUuid('rows', 'id', 'namespace', 'type')),
      ...(columns.short_ids ? await nonUuid('short_ids', 'row_id', 'namespace', 'type') : []),
      ...(columns.edges ? await nonUuid('edges', 'from_id', 'from_ns', 'from_type') : []),
      ...(columns.edges ? await nonUuid('edges', 'to_id', 'to_ns', 'to_type') : [])
    ];
    const [dims] = columns.embeddings
      ? await tx<{ dims: number }[]>`
          SELECT a.atttypmod AS dims FROM pg_attribute a
          WHERE a.attrelid = to_regclass('embeddings') AND a.attname = 'embedding' AND NOT a.attisdropped`
      : [];
    const extensions = await tx<
      { extname: string; extversion: string }[]
    >`SELECT extname, extversion FROM pg_extension ORDER BY extname`;
    const [others] = await tx<{ n: string }[]>`
      SELECT count(*)::text AS n FROM pg_stat_activity
      WHERE datname = current_database() AND pid <> pg_backend_pid() AND backend_type = 'client backend'`;
    return {
      serverVersionNum: version?.v ?? 0,
      layout,
      appliedMigrations,
      hasSeq: columns.rows?.includes('seq') ?? false,
      hasVisibleSeqs: columns.visible_seqs !== undefined,
      types: types.map((t) => ({
        ...t,
        live: Number(t.live),
        deleted: Number(t.deleted),
        bytes: Number(t.bytes)
      })),
      tables: tableRows.map((t) => t.name),
      columns,
      tableBytes: Object.fromEntries(tableRows.map((t) => [t.name, Number(t.bytes)])),
      nonUuidIds,
      // pgvector stores the dimension in atttypmod; -1 means unconstrained.
      vectorDims: dims !== undefined && dims.dims > 0 ? dims.dims : null,
      extensions: Object.fromEntries(extensions.map((e) => [e.extname, e.extversion])),
      otherSessions: Number(others?.n ?? 0)
    } satisfies SourceInventory;
  });
  return result;
}

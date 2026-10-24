/**
 * Partitions on the partitioned layout: `rows` is LIST(namespace), each
 * namespace partition is LIST(type) with a DEFAULT sub-partition. A row whose
 * namespace or type has no partition yet lands in the DEFAULT one level up;
 * `ensureTypeStorage` creates the partitions and moves those rows into them.
 *
 * Partitions are found by their bound in the catalog, never by name, because
 * folded names can collide. A move runs in one transaction that holds the
 * parent ACCESS EXCLUSIVE, so no reader or writer sees the rows twice or not
 * at all, and sets the moved rows' short ids aside and restores them, because
 * the FK from `short_ids` (the only table with one to `rows`) would cascade
 * the DELETE to them.
 */

import type { Sql, TransactionSql } from 'postgres';
import { hashedName, partitionName } from './layout.js';

const MAX_IDENTIFIER = 63;
/** lock_not_available (our NOWAIT), duplicate_table (a racing creator took the name), deadlock. */
const RETRYABLE = new Set(['55P03', '42P07', '40P01']);
const MAX_ATTEMPTS = 50;

type Handle = Sql | TransactionSql;

function ident(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** The bound text `pg_get_expr` prints for a one-value LIST partition, or DEFAULT. */
function boundText(value: string | null): string {
  return value === null ? 'DEFAULT' : `FOR VALUES IN ('${value.replace(/'/g, "''")}')`;
}

/** The partition of `parent` (current schema) whose bound is `value`, or DEFAULT for null. */
async function findPartition(
  sql: Handle,
  parent: string,
  value: string | null
): Promise<string | undefined> {
  const [row] = await sql<Array<{ relname: string }>>`
    SELECT c.relname FROM pg_inherits i
    JOIN pg_class c ON c.oid = i.inhrelid
    JOIN pg_class p ON p.oid = i.inhparent
    WHERE p.relname = ${parent} AND p.relnamespace = current_schema()::regnamespace
      AND pg_get_expr(c.relpartbound, c.oid) = ${boundText(value)}`;
  return row?.relname;
}

async function freeName(sql: Handle, preferred: string, seed: unknown): Promise<string> {
  for (const name of [preferred, hashedName(preferred, seed)]) {
    if (name.length > MAX_IDENTIFIER) continue;
    const taken = await sql`
      SELECT 1 FROM pg_class
      WHERE relname = ${name} AND relnamespace = current_schema()::regnamespace`;
    if (taken.length === 0) return name;
  }
  throw new Error(`no free partition name for '${preferred}'`);
}

interface Level {
  parent: string;
  column: 'namespace' | 'type';
  value: string;
  namespace: string;
  /** Advisory lock key serialising ensures of the same partition. */
  lockKey: string;
  preferredName: string;
  /** A namespace partition is itself LIST(type) with a DEFAULT. */
  subPartitioned: boolean;
}

/**
 * Creates the partition of `level.parent` for `level.value` unless one exists,
 * moving its rows out of the parent's DEFAULT. Returns the partition's name.
 */
async function attachPartition(tx: TransactionSql, level: Level): Promise<string> {
  const { parent, column, value } = level;
  await tx`SELECT pg_advisory_xact_lock(hashtext(${level.lockKey}))`;
  // Parent before child, as every query does. ACCESS EXCLUSIVE on the parent
  // stops readers and writers before they read its partition list, so none
  // plans against the list from before the move.
  if (parent !== 'rows') await tx.unsafe('LOCK TABLE ONLY rows IN ACCESS SHARE MODE');
  await tx.unsafe(`LOCK TABLE ONLY ${ident(parent)} IN ACCESS EXCLUSIVE MODE`);
  // ATTACH takes this to clone the short_ids FK. NOWAIT: waiting for it while
  // holding the parent could deadlock with a writer; the caller retries.
  await tx.unsafe('LOCK TABLE short_ids IN SHARE ROW EXCLUSIVE MODE NOWAIT');

  const existing = await findPartition(tx, parent, value);
  if (existing !== undefined) return existing;

  const seed = column === 'namespace' ? [value] : [level.namespace, value];
  const name = await freeName(tx, level.preferredName, seed);
  await tx.unsafe(
    `CREATE TABLE ${ident(name)} (LIKE rows INCLUDING DEFAULTS INCLUDING CONSTRAINTS)` +
      (level.subPartitioned ? ' PARTITION BY LIST (type)' : '')
  );
  if (level.subPartitioned) {
    const dflt = await freeName(tx, `${name}__default`, [level.namespace, null]);
    await tx.unsafe(`CREATE TABLE ${ident(dflt)} PARTITION OF ${ident(name)} DEFAULT`);
  }

  const source = await findPartition(tx, parent, null);
  if (source !== undefined) {
    const [cols] = await tx<Array<{ list: string | null }>>`
      SELECT string_agg(quote_ident(attname), ', ' ORDER BY attnum) AS list
      FROM pg_attribute
      WHERE attrelid = 'rows'::regclass AND attnum > 0 AND NOT attisdropped`;
    const list = cols?.list as string;
    const src = ident(source);
    await tx.unsafe(
      `CREATE TEMP TABLE substrate_moved_short_ids ON COMMIT DROP AS
         SELECT s.namespace, s.type, s.short_id, s.row_id FROM short_ids s
         JOIN ${src} r ON r.namespace = s.namespace AND r.type = s.type AND r.id = s.row_id
         WHERE r.${column} = $1`,
      [value]
    );
    // Removed here rather than left to the FK cascade, so the restore below
    // never duplicates one when the FK is absent. Restored after the ATTACH.
    await tx.unsafe(
      `DELETE FROM short_ids s USING substrate_moved_short_ids m
       WHERE s.namespace = m.namespace AND s.type = m.type AND s.short_id = m.short_id`
    );
    const copied = await tx.unsafe(
      `INSERT INTO ${ident(name)} (${list}) SELECT ${list} FROM ${src} WHERE ${column} = $1`,
      [value]
    );
    const deleted = await tx.unsafe(`DELETE FROM ${src} WHERE ${column} = $1`, [value]);
    if (copied.count !== deleted.count) {
      throw new Error(
        `partition move of ${column} '${value}' copied ${copied.count} rows but deleted ${deleted.count}`
      );
    }
  }

  await tx.unsafe(
    `ALTER TABLE ${ident(parent)} ATTACH PARTITION ${ident(name)} ${boundText(value)}`
  );

  if (source !== undefined) {
    await tx.unsafe(
      `INSERT INTO short_ids (namespace, type, short_id, row_id)
         SELECT namespace, type, short_id, row_id FROM substrate_moved_short_ids`
    );
    await tx.unsafe('DROP TABLE substrate_moved_short_ids');
  }
  return name;
}

async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const code = (err as { code?: unknown }).code;
      if (attempt >= MAX_ATTEMPTS || typeof code !== 'string' || !RETRYABLE.has(code)) throw err;
      const delay = Math.min(5 * 2 ** attempt, 200) * (0.5 + Math.random());
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

/**
 * Makes sure `namespace/type` has a partition of its own, creating the
 * namespace partition first if needed, and drains their rows out of the
 * DEFAULT partitions. Idempotent; without partitions to create it only reads
 * the catalog. Partitioned layout only.
 */
export async function ensureTypeStorage(sql: Sql, namespace: string, type: string): Promise<void> {
  let nsPart = await findPartition(sql, 'rows', namespace);
  if (nsPart !== undefined && (await findPartition(sql, nsPart, type)) !== undefined) return;

  if (nsPart === undefined) {
    nsPart = await withRetry(() =>
      sql.begin((tx) =>
        attachPartition(tx, {
          parent: 'rows',
          column: 'namespace',
          value: namespace,
          namespace,
          lockKey: `substrate-type-storage:${namespace}`,
          preferredName: partitionName(namespace),
          subPartitioned: true
        })
      )
    );
  }
  const parent = nsPart;
  await withRetry(() =>
    sql.begin((tx) =>
      attachPartition(tx, {
        parent,
        column: 'type',
        value: type,
        namespace,
        lockKey: `substrate-type-storage:${namespace}/${type}`,
        preferredName: partitionName(namespace, type),
        subPartitioned: false
      })
    )
  );
}

/** One line per (namespace, type) with rows in a DEFAULT partition. */
export async function storageWarnings(sql: Sql): Promise<string[]> {
  const defaults = await sql<Array<{ relname: string }>>`
    SELECT c.relname FROM pg_partition_tree('rows') t
    JOIN pg_class c ON c.oid = t.relid
    WHERE pg_get_expr(c.relpartbound, c.oid) = 'DEFAULT'
    ORDER BY c.relname`;
  const out: string[] = [];
  for (const { relname } of defaults) {
    const held = await sql.unsafe<Array<{ namespace: string; type: string; n: number }>>(
      `SELECT namespace, type, count(*)::int AS n FROM ${ident(relname)}
       GROUP BY namespace, type ORDER BY namespace, type`
    );
    for (const h of held) out.push(`${relname} holds ${h.n} rows of ${h.namespace}/${h.type}`);
  }
  return out;
}

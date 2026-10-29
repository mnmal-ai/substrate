/**
 * The migrate-store verification: compares the source and the copy per
 * (namespace, type) and, only when everything agrees, drops the in-progress
 * marker so `serve` will boot the target. Both sides are read in their own
 * REPEATABLE READ, READ ONLY transaction; nothing here writes to the source.
 *
 * Target rows the prepare step seeded and the source lacks (`keptSeeds`) are
 * subtracted from the target side before every comparison.
 *
 * Every set is fingerprinted as `count(*)` plus the sum of a 64-bit prefix of
 * each row's md5. That is independent of row order, of either cluster's
 * collation, and of any join separator, and it builds no string.
 */

import { MIGRATE_STORE_MARKER_TABLE } from '@mnmal-ai/substrate-dataset-pg';
import type { Sql } from 'postgres';
import type { BootedStore } from '../../serve/boot-store.js';
import { type CopyResult, type RowKey, registeredDataset, SEED } from './copy.js';

export interface VerifyOptions {
  keptSeeds: RowKey[];
  /** Types whose rows are expected in a DEFAULT partition (`CopyResult.defaulted`). */
  defaulted: CopyResult['defaulted'];
  /** The copied tables (the plan's, or `readCopyState().tables`); `rows`, `short_ids` and `edges` have their own checks. */
  tables: string[];
  /** Hash every row instead of a sample. */
  fullChecksum: boolean;
  /** Rows hashed per type when not `fullChecksum`. */
  sampleRows: number;
  partitionBudget: number;
  /** The target dataset's `storageReport`. */
  storageReport(opts: { partitionBudget: number }): Promise<{ warnings: string[] }>;
}

export interface VerifyResult {
  ok: boolean;
  mismatches: { check: string; namespace?: string; type?: string; detail: string }[];
}

interface Entry {
  check: string;
  namespace?: string;
  type?: string;
  /** Names the compared item within the check (a field, a table, a count's kind). */
  what: string;
  value: string;
}

const quote = (cols: string[]) => cols.map((c) => `"${c.replace(/"/g, '""')}"`).join(', ');

/** SQL for a set's fingerprint: its size and an order-independent sum of per-row hashes of `expr`. */
const fp = (expr: string) =>
  `count(*)::text || ' ' || coalesce(sum(('x' || substr(md5(${expr}), 1, 16))::bit(64)::bigint::numeric), 0)::text`;

/** The fingerprint of a set of ids, as `verifyStore` computes it. */
export async function fingerprint(sql: Sql, ids: string[]): Promise<string> {
  const [r] = await sql<{ f: string }[]>`
    SELECT ${sql.unsafe(fp('id'))} AS f FROM unnest(${ids}::text[]) AS id`;
  return (r as { f: string }).f;
}

export async function verifyStore(
  source: Sql,
  target: Sql,
  opts: VerifyOptions
): Promise<VerifyResult> {
  const readOnly = 'isolation level repeatable read read only';
  const src = await source.begin(readOnly, (tx) => snapshot(tx as unknown as Sql, [], null, opts));
  const tgt = await target.begin(readOnly, (tx) =>
    snapshot(tx as unknown as Sql, opts.keptSeeds, src, opts)
  );

  const mismatches: VerifyResult['mismatches'] = [];
  const keys = [...new Set([...src.entries.keys(), ...tgt.entries.keys()])].sort();
  for (const k of keys) {
    const a = src.entries.get(k);
    const b = tgt.entries.get(k);
    if (a?.value === b?.value) continue;
    const e = (a ?? b) as Entry;
    mismatches.push({
      check: e.check,
      ...(e.namespace !== undefined ? { namespace: e.namespace } : {}),
      ...(e.type !== undefined ? { type: e.type } : {}),
      detail: `${e.what}: source ${a?.value ?? 'absent'}, target ${b?.value ?? 'absent'}`
    });
  }

  const expected = new Set(opts.defaulted.map((d) => JSON.stringify([d.namespace, d.type])));
  for (const w of (await opts.storageReport({ partitionBudget: opts.partitionBudget })).warnings) {
    const m = /^\S+ holds \d+ rows of (.+)\/([^/]+)$/.exec(w);
    if (m !== null && expected.has(JSON.stringify([m[1], m[2]]))) continue;
    mismatches.push({
      check: 'storage',
      ...(m !== null ? { namespace: m[1] as string, type: m[2] as string } : {}),
      detail: w
    });
  }

  const ok = mismatches.length === 0;
  // Its own statement, last: only a target that passed every check boots under `serve`.
  if (ok) await target`DROP TABLE IF EXISTS ${target(MIGRATE_STORE_MARKER_TABLE)}`;
  return { ok, mismatches };
}

const COPY_MILESTONES = new Set(['copy:started', 'copy:phase1', 'copy:phase2', 'copy:done']);

/**
 * What a finished copy left behind, for a verification that has no
 * `CopyResult`: the kept seeds from the marker table, and the types the target
 * does not register (their rows sit in a DEFAULT partition), and the copied
 * tables, which are the marker's `copy:<table>` steps.
 */
export async function readCopyState(
  target: BootedStore
): Promise<Pick<CopyResult, 'keptSeeds' | 'defaulted'> & { tables: string[] }> {
  const sql = target.sql;
  if (sql === null) throw new Error('migrate-store verifies a postgres target only');
  const steps = await sql<{ step: string }[]>`
    SELECT step FROM ${sql(MIGRATE_STORE_MARKER_TABLE)}`.catch((err: { code?: string }) => {
    // A target with no marker table has no copy to verify; anything else is a real fault.
    if (err.code === '42P01') return [];
    throw err;
  });
  if (!steps.some((s) => s.step === 'copy:done')) {
    throw new Error(
      'the target has no completed migrate-store copy to verify (its in-progress marker is missing or the copy did not finish)'
    );
  }
  const keptSeeds = steps
    .filter((s) => s.step.startsWith(SEED))
    .map((s) => {
      const [namespace, type, id] = JSON.parse(s.step.slice(SEED.length)) as string[];
      return { namespace, type, id } as RowKey;
    })
    .sort((a, b) => (a.namespace + a.type + a.id).localeCompare(b.namespace + b.type + b.id));
  const pairs = await sql<
    { namespace: string; type: string }[]
  >`SELECT DISTINCT namespace, type FROM rows ORDER BY namespace, type`;
  const defaulted = pairs.filter(
    (p) => registeredDataset(target, p.namespace, p.type)?.ensureTypeStorage === undefined
  );
  const tables = steps
    .map((s) => s.step)
    .filter((s) => s.startsWith('copy:') && !COPY_MILESTONES.has(s))
    .map((s) => s.slice('copy:'.length))
    .sort();
  return { keptSeeds, defaulted, tables };
}

interface Snapshot {
  entries: Map<string, Entry>;
  /** Per checked table (`rows`, `edges` and the generic ones): its non-generated columns, by name. */
  columns: Map<string, string[]>;
}

/** Every comparable fact about one side, keyed so the two sides diff by key. `other` is the source's snapshot when this is the target. */
async function snapshot(
  tx: Sql,
  seeds: RowKey[],
  other: Snapshot | null,
  opts: VerifyOptions
): Promise<Snapshot> {
  // Two clusters may differ in these defaults, and they change how a row renders as text.
  await tx`SET LOCAL TimeZone = 'UTC'`;
  await tx`SET LOCAL DateStyle = 'ISO, YMD'`;
  await tx`SET LOCAL extra_float_digits = 3`;
  const entries = new Map<string, Entry>();
  const columns = new Map<string, string[]>();
  const add = (e: Entry) =>
    entries.set(`${e.check}\0${e.namespace ?? ''}\0${e.type ?? ''}\0${e.what}`, e);
  // Target rows the source cannot have: the kept seeds.
  const notSeed = (ns: string, ty: string, id: string) =>
    tx`(${tx(ns)}, ${tx(ty)}, ${tx(id)}) NOT IN (SELECT * FROM unnest(
      ${seeds.map((k) => k.namespace)}::text[], ${seeds.map((k) => k.type)}::text[], ${seeds.map((k) => k.id)}::text[]))`;
  // The table's columns both sides have, or null when this side lacks the table. A source lacking one
  // (seq) must not read as a mismatch, so the target hashes only the source's set.
  const colsOf = async (table: string): Promise<string[] | null> => {
    const have = await tx<{ col: string }[]>`
      SELECT a.attname AS col FROM pg_attribute a
      WHERE a.attrelid = to_regclass(${table}) AND a.attnum > 0 AND NOT a.attisdropped AND a.attgenerated = ''
      ORDER BY a.attname`;
    if (have.length === 0) return null;
    const theirs = other?.columns.get(table);
    const cols = have.map((c) => c.col).filter((c) => theirs === undefined || theirs.includes(c));
    columns.set(table, cols);
    return cols;
  };

  const counts = await tx<
    { namespace: string; type: string; live: string; deleted: string; ids: string }[]
  >`
    SELECT namespace, type,
           count(*) FILTER (WHERE deleted_at IS NULL)::text AS live,
           count(*) FILTER (WHERE deleted_at IS NOT NULL)::text AS deleted,
           ${tx.unsafe(fp('id'))} AS ids
    FROM rows WHERE ${notSeed('namespace', 'type', 'id')} GROUP BY namespace, type`;
  for (const r of counts) {
    const at = { namespace: r.namespace, type: r.type };
    add({ check: 'count', ...at, what: 'live rows', value: r.live });
    add({ check: 'count', ...at, what: 'deleted rows', value: r.deleted });
    add({ check: 'ids', ...at, what: 'id set', value: r.ids });
  }

  const shorts = await tx<{ namespace: string; type: string; f: string }[]>`
    SELECT namespace, type, ${tx.unsafe(fp('row(short_id, row_id)::text'))} AS f
    FROM short_ids WHERE ${notSeed('namespace', 'type', 'row_id')} GROUP BY namespace, type`;
  for (const r of shorts) {
    add({ check: 'short_ids', namespace: r.namespace, type: r.type, what: 'shortIds', value: r.f });
  }

  const edgeCols = await colsOf('edges');
  if (edgeCols !== null) {
    const edges = await tx<{ namespace: string; type: string; field: string; f: string }[]>`
      SELECT from_ns AS namespace, from_type AS type, field_name AS field,
             ${tx.unsafe(fp(`row(${quote(edgeCols)})::text`))} AS f
      FROM edges WHERE ${notSeed('from_ns', 'from_type', 'from_id')} GROUP BY from_ns, from_type, field_name`;
    for (const r of edges) {
      add({
        check: 'edges',
        namespace: r.namespace,
        type: r.type,
        what: `edges of ${r.field}`,
        value: r.f
      });
    }
  }

  const rowCols = (await colsOf('rows')) as string[];
  const limit = opts.fullChecksum ? 2147483647 : opts.sampleRows;
  // One bounded query per type, each on its own scope, so a partitioned store reads only that type's partition.
  // COLLATE "C" so both clusters pick the same rows whatever their locale.
  for (const { namespace, type } of counts) {
    const [r] = await tx<{ f: string }[]>`
      SELECT ${tx.unsafe(fp('h'))} AS f FROM (
        SELECT row(${tx.unsafe(quote(rowCols))})::text AS h FROM rows
        WHERE namespace = ${namespace} AND type = ${type} AND ${notSeed('namespace', 'type', 'id')}
        ORDER BY md5(id) COLLATE "C" LIMIT ${limit}) s`;
    add({ check: 'sample', namespace, type, what: 'content', value: String(r?.f) });
  }

  // Every other copied table: its full content, only for tables the source has.
  const skip = new Set(['rows', 'short_ids', 'edges']);
  for (const name of opts.tables.filter((t) => !skip.has(t))) {
    if (other !== null && !other.columns.has(name)) continue;
    const cols = await colsOf(name);
    if (cols === null) continue;
    const where = ['row_namespace', 'row_type', 'row_id'].every((c) => cols.includes(c))
      ? notSeed('row_namespace', 'row_type', 'row_id')
      : tx`true`;
    const [r] = await tx<{ f: string }[]>`
      SELECT ${tx.unsafe(fp(`row(${quote(cols)})::text`))} AS f FROM ${tx(name)} WHERE ${where}`;
    add({ check: 'table', what: name, value: String(r?.f) });
  }
  return { entries, columns };
}

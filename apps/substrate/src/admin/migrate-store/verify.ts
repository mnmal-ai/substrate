/**
 * The migrate-store verification: compares the source with its conversion
 * per (namespace, type) and, only when everything agrees and the target holds
 * every declared index, drops the in-progress marker so `serve` will boot the
 * target. Both sides are read in their own REPEATABLE READ, READ ONLY
 * transaction; nothing here writes to the source.
 *
 * Target rows the prepare step seeded and the source lacks (`keptSeeds`) are
 * subtracted from the target side before every comparison.
 *
 * Every set is fingerprinted as `count(*)` plus the sum of a 64-bit prefix of
 * each row's md5. That is independent of row order, of either cluster's
 * collation, and of any join separator, and it builds no string. Row content
 * is compared as the dataset reads it: the target's row as `decodeRow` builds
 * it, the source's body under the same read rule (an explicit null on a
 * declared column field reads absent), both as jsonb text, so a number's
 * stored text counts, plus every metadata column.
 */

import {
  loadTypeTable,
  MIGRATE_STORE_MARKER_TABLE,
  type TypeTable,
  typeTableRef
} from '@mnmal-ai/substrate-dataset-pg';
import type { Sql } from 'postgres';
import type { BootedStore } from '../../serve/boot-store.js';
import { registeredTypes } from '../../serve/wiring.js';
import { type CopyResult, type RowKey, registeredDataset, SEED } from './copy.js';

export interface VerifyOptions {
  keptSeeds: RowKey[];
  /** The copied tables (the plan's, or `readCopyState().tables`); `rows`, `short_ids` and `edges` have their own checks. */
  tables: string[];
  /** Hash every row instead of a sample. */
  fullChecksum: boolean;
  /** Rows hashed per type when not `fullChecksum`. */
  sampleRows: number;
  partitionBudget: number;
  /** The target dataset's `storageReport`. */
  storageReport(opts: { partitionBudget: number }): Promise<{ warnings: string[] }>;
  /** The declared indexes the target lacks or holds unusable ({@link missingIndexes}). */
  missingIndexes(): Promise<VerifyResult['missingIndexes']>;
}

export interface VerifyResult {
  ok: boolean;
  mismatches: { check: string; namespace?: string; type?: string; detail: string }[];
  /** Declared indexes (`<ns>/<Type>`, index name) not valid on the target; any fails verification. */
  missingIndexes: Array<{ type: string; index: string }>;
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

/**
 * The declared indexes of every registered type that are not valid on the
 * target: missing, invalid, building, failed, or built over a field that is
 * not yet in its column. `uniqueOnly` leaves out the non-unique ones, which
 * `--skip-index-build` defers to serve.
 */
export async function missingIndexes(
  target: BootedStore,
  uniqueOnly: boolean
): Promise<VerifyResult['missingIndexes']> {
  const out: VerifyResult['missingIndexes'] = [];
  for (const { ns, type, dataset } of registeredTypes(target.engine, target.datasets)) {
    const report = await dataset?.describeStorage?.(type);
    for (const i of report?.indexes ?? []) {
      if (i.state !== 'valid' && (i.unique || !uniqueOnly))
        out.push({ type: `${ns}/${type}`, index: i.name });
    }
  }
  return out;
}

export async function verifyStore(
  source: Sql,
  target: Sql,
  opts: VerifyOptions
): Promise<VerifyResult> {
  const readOnly = 'isolation level repeatable read read only';
  // The target's type tables first: they give the source its read rule.
  const types = await target.begin(readOnly, (tx) => typeTables(tx as unknown as Sql));
  const src = await source.begin(readOnly, (tx) =>
    snapshot(tx as unknown as Sql, 'source', [], null, opts, types)
  );
  const tgt = await target.begin(readOnly, (tx) =>
    snapshot(tx as unknown as Sql, 'target', opts.keptSeeds, src, opts, types)
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
  // Every declared field holds its values in its column.
  for (const [key, table] of types) {
    const [namespace, type] = [table.namespace, table.type];
    const unsettled = [
      ...table.pending.map((field) => ({ field, state: 'pending' })),
      ...table.columns().filter((c) => c.state === 'promoting')
    ];
    for (const f of unsettled) {
      mismatches.push({
        check: 'fields',
        namespace,
        type,
        detail: `field ${f.field} of ${key} is ${f.state}, so its values are not all in its column`
      });
    }
  }

  for (const w of (await opts.storageReport({ partitionBudget: opts.partitionBudget })).warnings) {
    mismatches.push({ check: 'storage', detail: w });
  }
  const missing = await opts.missingIndexes();

  const ok = mismatches.length === 0 && missing.length === 0;
  // Its own statement, last: only a target that passed every check boots under `serve`.
  if (ok) await target`DROP TABLE IF EXISTS ${target(MIGRATE_STORE_MARKER_TABLE)}`;
  return { ok, mismatches, missingIndexes: missing };
}

const COPY_MILESTONES = new Set(['copy:started', 'copy:phase1', 'copy:phase2', 'copy:done']);

/**
 * What a finished copy left behind, for a verification that has no
 * `CopyResult`: the kept seeds from the marker table, the types the target
 * does not register (their fields all sit in `extra`), and the copied tables,
 * which are the marker's `copy:<table>` steps.
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
  // Types with rows that nothing registers.
  const pairs = await sql<{ namespace: string; type: string }[]>`
    SELECT DISTINCT namespace, type FROM row_ids ORDER BY namespace, type`;
  const defaulted = pairs
    .filter((p) => registeredDataset(target, p.namespace, p.type) === undefined)
    .map((p) => `${p.namespace}/${p.type}`);
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

/** The target's type tables, by `<ns>/<Type>`. */
async function typeTables(tx: Sql): Promise<Map<string, TypeTable>> {
  const types = new Map<string, TypeTable>();
  const listed = await tx<{ namespace: string; type: string }[]>`
    SELECT namespace, type FROM substrate_type_tables ORDER BY namespace, type`;
  for (const { namespace, type } of listed) {
    const table = await loadTypeTable(tx, namespace, type);
    if (table !== undefined) types.set(`${namespace}/${type}`, table);
  }
  return types;
}

/** Each row's id with its versions: a row updated or deleted after the copy's snapshot changes it, wherever the sample falls. */
const VERSIONS = `id || E'\n' || coalesce(updated_at::text, '') || E'\n' || coalesce(deleted_at::text, '')`;

const META = `deleted_at::text, created_at::text, updated_at::text, created_by_kind, created_by_id, updated_by_kind, updated_by_id`;

/**
 * Every comparable fact about one side, keyed so the two sides diff by key.
 * `other` is the source's snapshot when this is the target; `types` are the
 * target's type tables, which give the source its read rule.
 */
async function snapshot(
  tx: Sql,
  side: 'source' | 'target',
  seeds: RowKey[],
  other: Snapshot | null,
  opts: VerifyOptions,
  types: Map<string, TypeTable>
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
  const seedIds = (ns: string, ty: string) =>
    seeds.filter((k) => k.namespace === ns && k.type === ty).map((k) => k.id);
  // The table's columns both sides have, or null when this side lacks the table. A table the
  // source lacks a column of must not read as a mismatch, so each side hashes only the shared set.
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

  // Per type: counts, the id set, and (target) the same id set as `row_ids` registers it.
  const limit = opts.fullChecksum ? Number.MAX_SAFE_INTEGER : opts.sampleRows;
  const counted: Array<{ namespace: string; type: string }> = [];
  if (side === 'source') {
    const counts = await tx<
      {
        namespace: string;
        type: string;
        live: string;
        deleted: string;
        ids: string;
        versions: string;
      }[]
    >`
      SELECT namespace, type,
             count(*) FILTER (WHERE deleted_at IS NULL)::text AS live,
             count(*) FILTER (WHERE deleted_at IS NOT NULL)::text AS deleted,
             ${tx.unsafe(fp('id'))} AS ids,
             ${tx.unsafe(fp(VERSIONS))} AS versions
      FROM rows GROUP BY namespace, type`;
    for (const r of counts) {
      const at = { namespace: r.namespace, type: r.type };
      add({ check: 'count', ...at, what: 'live rows', value: r.live });
      add({ check: 'count', ...at, what: 'deleted rows', value: r.deleted });
      add({ check: 'ids', ...at, what: 'id set', value: r.ids });
      add({ check: 'ids', ...at, what: 'registered ids (row_ids)', value: r.ids });
      add({
        check: 'versions',
        ...at,
        what: 'row versions (updated_at, deleted_at)',
        value: r.versions
      });
      counted.push(at);
    }
  } else {
    for (const table of types.values()) {
      const { namespace, type } = table;
      const skip = seedIds(namespace, type);
      const [r] = await tx.unsafe<
        { live: string; deleted: string; ids: string; versions: string }[]
      >(
        `SELECT count(*) FILTER (WHERE deleted_at IS NULL)::text AS live,
                count(*) FILTER (WHERE deleted_at IS NOT NULL)::text AS deleted,
                ${fp('id')} AS ids, ${fp(VERSIONS)} AS versions
         FROM ${table.from} WHERE NOT (id = ANY($1::text[]))`,
        [skip]
      );
      const at = { namespace, type };
      if (r !== undefined && Number(r.live) + Number(r.deleted) > 0) {
        add({ check: 'count', ...at, what: 'live rows', value: r.live });
        add({ check: 'count', ...at, what: 'deleted rows', value: r.deleted });
        add({ check: 'ids', ...at, what: 'id set', value: r.ids });
        add({
          check: 'versions',
          ...at,
          what: 'row versions (updated_at, deleted_at)',
          value: r.versions
        });
        counted.push(at);
      }
    }
    const registered = await tx<{ namespace: string; type: string; ids: string }[]>`
      SELECT namespace, type, ${tx.unsafe(fp('id'))} AS ids
      FROM row_ids WHERE ${notSeed('namespace', 'type', 'id')} GROUP BY namespace, type`;
    for (const r of registered) {
      add({
        check: 'ids',
        namespace: r.namespace,
        type: r.type,
        what: 'registered ids (row_ids)',
        value: r.ids
      });
    }
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

  // Row content (id first, so a swap between rows counts) as stored jsonb text, one bounded pass per type in md5(id) order: COLLATE "C" so
  // both clusters pick the same rows whatever their locale. jsonb text is canonical (sorted keys) and
  // keeps each number's text, so a number stored differently fails. The source hashes `seq` only
  // when it has one.
  const hasSeq =
    side === 'source'
      ? (await colsOf('rows'))?.includes('seq') === true
      : other?.columns.get('rows')?.includes('seq') !== false;
  const meta = `row(${META}, ${hasSeq ? 'seq::text' : 'NULL::text'})::text`;
  for (const { namespace, type } of counted) {
    let rows: string;
    let params: unknown[];
    if (side === 'source') {
      // The read rule: an explicit null on a declared column field reads absent.
      const table = types.get(`${namespace}/${type}`);
      const declared = [
        ...(table?.columns().filter((c) => c.state !== 'orphaned') ?? []).map((c) => c.field),
        ...(table?.pending ?? [])
      ];
      rows = `SELECT id || E'\n' || (SELECT coalesce(jsonb_object_agg(k, v), '{}'::jsonb) FROM jsonb_each(body) e(k, v)
                      WHERE NOT (v = 'null'::jsonb AND k = ANY($3::text[])))::text || E'\n' || ${meta} AS h
              FROM rows WHERE namespace = $1 AND type = $2 ORDER BY md5(id) COLLATE "C" LIMIT ${limit}`;
      params = [namespace, type, declared];
    } else {
      const ref = await typeTableRef(tx, namespace, type);
      if (ref === undefined) continue;
      rows = `SELECT x.id || E'\n' || ${ref.rowJson('x')}::text || E'\n' || ${meta} AS h FROM ${ref.from} x
              WHERE NOT (x.id = ANY($1::text[])) ORDER BY md5(x.id) COLLATE "C" LIMIT ${limit}`;
      params = [seedIds(namespace, type)];
    }
    const [r] = await tx.unsafe<{ f: string }[]>(
      `SELECT ${fp('h')} AS f FROM (${rows}) s`,
      params as never[]
    );
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

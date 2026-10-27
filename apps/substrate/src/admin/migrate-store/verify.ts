/**
 * The migrate-store verification: compares the source and the copy per
 * (namespace, type) and, only when everything agrees, drops the in-progress
 * marker so `serve` will boot the target. Both sides are read in their own
 * REPEATABLE READ, READ ONLY transaction; nothing here writes to the source.
 *
 * Target rows the prepare step seeded and the source lacks (`keptSeeds`) are
 * subtracted from the target side before every comparison.
 */

import { MIGRATE_STORE_MARKER_TABLE } from '@mnmal-ai/substrate-dataset-pg';
import type { Sql } from 'postgres';
import type { BootedStore } from '../../serve/boot-store.js';
import { type CopyResult, type RowKey, registeredDataset, SEED } from './copy.js';

export interface VerifyOptions {
  keptSeeds: RowKey[];
  /** Types whose rows are expected in a DEFAULT partition (`CopyResult.defaulted`). */
  defaulted: CopyResult['defaulted'];
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

/** Recall's tables and the expression that keys a row of each. */
const RECALL_KEYS: Record<string, string> = {
  embeddings: "row_namespace || '/' || row_type || '/' || row_id",
  lexical: "row_namespace || '/' || row_type || '/' || row_id",
  recall_clusters: 'id',
  recall_cluster_members: 'id'
};

export async function verifyStore(
  source: Sql,
  target: Sql,
  opts: VerifyOptions
): Promise<VerifyResult> {
  const readOnly = 'isolation level repeatable read read only';
  const src = await source.begin(readOnly, (tx) => snapshot(tx as unknown as Sql, [], null, opts));
  const tgt = await target.begin(readOnly, (tx) =>
    snapshot(tx as unknown as Sql, opts.keptSeeds, src.recallTables, opts, src.columns)
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

/**
 * What a finished copy left behind, for a verification that has no
 * `CopyResult`: the kept seeds from the marker table, and the types the target
 * does not register (their rows sit in a DEFAULT partition).
 */
export async function readCopyState(
  target: BootedStore
): Promise<Pick<CopyResult, 'keptSeeds' | 'defaulted'>> {
  const sql = target.sql;
  if (sql === null) throw new Error('migrate-store verifies a postgres target only');
  const steps = await sql<{ step: string }[]>`
    SELECT step FROM ${sql(MIGRATE_STORE_MARKER_TABLE)}`.catch(() => []);
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
  return { keptSeeds, defaulted };
}

/** Every comparable fact about one side, keyed so the two sides diff by key. */
async function snapshot(
  tx: Sql,
  seeds: RowKey[],
  recallFrom: string[] | null,
  opts: VerifyOptions,
  otherColumns?: string[]
): Promise<{ entries: Map<string, Entry>; recallTables: string[]; columns: string[] }> {
  const entries = new Map<string, Entry>();
  const add = (e: Entry) =>
    entries.set(`${e.check}\0${e.namespace ?? ''}\0${e.type ?? ''}\0${e.what}`, e);
  // Target rows the source cannot have: the kept seeds.
  const notSeed = (ns: string, ty: string, id: string) =>
    tx`(${tx(ns)}, ${tx(ty)}, ${tx(id)}) NOT IN (SELECT * FROM unnest(
      ${seeds.map((k) => k.namespace)}::text[], ${seeds.map((k) => k.type)}::text[], ${seeds.map((k) => k.id)}::text[]))`;

  const counts = await tx<
    { namespace: string; type: string; live: string; deleted: string; ids: string }[]
  >`
    SELECT namespace, type,
           count(*) FILTER (WHERE deleted_at IS NULL)::text AS live,
           count(*) FILTER (WHERE deleted_at IS NOT NULL)::text AS deleted,
           md5(string_agg(id, ',' ORDER BY id)) AS ids
    FROM rows WHERE ${notSeed('namespace', 'type', 'id')} GROUP BY namespace, type`;
  for (const r of counts) {
    const at = { namespace: r.namespace, type: r.type };
    add({ check: 'count', ...at, what: 'live rows', value: r.live });
    add({ check: 'count', ...at, what: 'deleted rows', value: r.deleted });
    add({ check: 'ids', ...at, what: 'id set hash', value: r.ids });
  }

  const shorts = await tx<{ namespace: string; type: string; n: string; h: string }[]>`
    SELECT namespace, type, count(*)::text AS n,
           md5(string_agg(short_id::text || ':' || row_id, ',' ORDER BY short_id, row_id)) AS h
    FROM short_ids WHERE ${notSeed('namespace', 'type', 'row_id')} GROUP BY namespace, type`;
  for (const r of shorts) {
    add({
      check: 'short_ids',
      namespace: r.namespace,
      type: r.type,
      what: 'shortIds',
      value: `${r.n} ${r.h}`
    });
  }

  const edges = await tx<
    { namespace: string; type: string; field: string; n: string; h: string }[]
  >`
    SELECT from_ns AS namespace, from_type AS type, field_name AS field, count(*)::text AS n,
           md5(string_agg(id::text || ':' || (deleted_at IS NOT NULL)::text, ',' ORDER BY id)) AS h
    FROM edges WHERE ${notSeed('from_ns', 'from_type', 'from_id')} GROUP BY from_ns, from_type, field_name`;
  for (const r of edges) {
    add({
      check: 'edges',
      namespace: r.namespace,
      type: r.type,
      what: `edges of ${r.field}`,
      value: `${r.n} ${r.h}`
    });
  }

  // Only columns both sides have: a source lacking one (seq) must not read as a mismatch.
  const have = (
    await tx<{ col: string }[]>`
      SELECT a.attname AS col FROM pg_attribute a
      WHERE a.attrelid = to_regclass('rows') AND a.attnum > 0 AND NOT a.attisdropped AND a.attgenerated = ''
      ORDER BY a.attname`
  ).map((c) => c.col);
  const columns = otherColumns === undefined ? have : have.filter((c) => otherColumns.includes(c));
  const limit = opts.fullChecksum ? 2147483647 : opts.sampleRows;
  // The target has every source column, so the source's own set is the common one.
  const sample = await tx<{ namespace: string; type: string; h: string }[]>`
    SELECT namespace, type, md5(string_agg(h, ',' ORDER BY id)) AS h FROM (
      SELECT namespace, type, id, md5(row(${tx(columns)})::text) AS h,
             row_number() OVER (PARTITION BY namespace, type ORDER BY md5(id)) AS rn
      FROM rows WHERE ${notSeed('namespace', 'type', 'id')}) s
    WHERE rn <= ${limit} GROUP BY namespace, type`;
  for (const r of sample) {
    add({
      check: 'sample',
      namespace: r.namespace,
      type: r.type,
      what: 'content hash',
      value: r.h
    });
  }

  const present = await tx<{ name: string }[]>`
    SELECT t AS name FROM unnest(${Object.keys(RECALL_KEYS)}::text[]) t WHERE to_regclass(t) IS NOT NULL`;
  const recallTables = recallFrom ?? present.map((p) => p.name);
  for (const name of recallTables) {
    const key = tx.unsafe(RECALL_KEYS[name] as string);
    if (!present.some((p) => p.name === name)) continue;
    const where =
      name === 'embeddings' || name === 'lexical'
        ? notSeed('row_namespace', 'row_type', 'row_id')
        : tx`true`;
    const [r] = await tx<{ n: string; h: string | null }[]>`
      SELECT count(*)::text AS n, md5(string_agg(${key}, ',' ORDER BY ${key})) AS h
      FROM ${tx(name)} WHERE ${where}`;
    add({ check: 'recall', what: name, value: `${r?.n} ${r?.h}` });
  }
  return { entries, recallTables, columns };
}

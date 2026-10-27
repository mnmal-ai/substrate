/**
 * The migrate-store copy: streams every planned table from one REPEATABLE
 * READ, READ ONLY source snapshot into a target `bootStore` prepared, with
 * `COPY … TO STDOUT` piped into `COPY … FROM STDIN`. Nothing here writes to
 * the source.
 *
 * Progress lives in the marker table on the target. A rerun after an
 * interruption restarts cleanly: it truncates the planned tables, keeps the
 * seed rows the first run recorded, and copies again.
 */

import { PassThrough, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { MIGRATE_STORE_MARKER_TABLE, seqName } from '@mnmal-ai/substrate-dataset-pg';
import type { Dataset } from '@mnmal-ai/substrate-types';
import type { PendingQuery, ReservedSql, Row, Sql } from 'postgres';
import type { BootedStore } from '../../serve/boot-store.js';
import type { CopyPlan, CopyPlanTable } from './preflight.js';
import { type ProgressEvent, RowCounter } from './progress.js';

export interface RowKey {
  namespace: string;
  type: string;
  id: string;
}

export interface CopyResult {
  tables: { name: string; rows: number; bytes: number; ms: number }[];
  /** Target rows the prepare step seeded that the source lacks; they stay. */
  keptSeeds: RowKey[];
  /** Source (namespace, type) pairs the target does not register; their rows sit in a DEFAULT partition. */
  defaulted: { namespace: string; type: string }[];
}

export interface CopyOptions {
  /** Rows between `onProgress` calls within a table. */
  batchRows: number;
  onProgress(e: ProgressEvent): void;
}

/** A source table or column with nowhere to go on the target. Thrown before any data moves. */
export class MigrateStoreColumnError extends Error {
  override readonly name = 'MigrateStoreColumnError';

  constructor(
    readonly table: string,
    readonly column: string | null
  ) {
    super(
      column === null
        ? `the target has no table "${table}" to copy into`
        : `the target's "${table}" has no column "${column}", which the source has`
    );
  }
}

const STARTED = 'copy:started';
const SEED = 'seed:';

export async function copyStore(
  source: Sql,
  target: BootedStore,
  plan: CopyPlan,
  opts: CopyOptions
): Promise<CopyResult> {
  const tsql = target.sql;
  if (tsql === null) throw new Error('migrate-store copies into a postgres target only');
  await tsql`CREATE TABLE IF NOT EXISTS ${tsql(MIGRATE_STORE_MARKER_TABLE)} (step text PRIMARY KEY, done_at timestamptz)`;
  const identity = await checkColumns(tsql, plan);

  const src = await source.reserve();
  let streaming = false;
  try {
    await src.unsafe('BEGIN ISOLATION LEVEL REPEATABLE READ, READ ONLY');
    await restartIfStarted(tsql, plan);
    const keptSeeds = await reconcileSeeds(src, tsql, target);
    const defaulted = await prepareStorage(src, target);

    const tables: CopyResult['tables'] = [];
    for (const t of plan.tables) {
      const start = performance.now();
      const counter = new RowCounter(t.name, opts.batchRows, opts.onProgress);
      streaming = true;
      await copyTable(src, tsql, t, identity.get(t.name) ?? [], counter);
      streaming = false;
      await markStep(tsql, `copy:${t.name}`);
      const done = { name: t.name, rows: counter.rows, bytes: counter.bytes };
      tables.push({ ...done, ms: Math.round(performance.now() - start) });
      opts.onProgress({ table: t.name, rows: done.rows, bytes: done.bytes, done: true });
    }

    await advanceSequences(tsql, identity);
    await markStep(tsql, 'copy:done');
    await src.unsafe('COMMIT');
    src.release();
    return { tables, keptSeeds, defaulted };
  } catch (err) {
    const released = src
      .unsafe('ROLLBACK')
      .catch(() => undefined)
      .then(() => src.release());
    // Mid-table, the ROLLBACK waits for the rest of the source table to drain; don't hold the error for it.
    if (!streaming) await released;
    throw err;
  }
}

/** Refuses a plan column the target lacks; returns each table's identity-always columns among the planned ones. */
async function checkColumns(tsql: Sql, plan: CopyPlan): Promise<Map<string, string[]>> {
  const names = plan.tables.map((t) => t.name);
  const rows = await tsql<{ table: string; col: string; ident: string }[]>`
    SELECT c.relname AS "table", a.attname AS col, a.attidentity AS ident
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema() AND c.relname = ANY(${names}::text[])
      AND c.relkind IN ('r', 'p') AND a.attnum > 0 AND NOT a.attisdropped AND a.attgenerated = ''`;
  const identity = new Map<string, string[]>();
  for (const t of plan.tables) {
    const cols = rows.filter((r) => r.table === t.name);
    if (cols.length === 0) throw new MigrateStoreColumnError(t.name, null);
    const have = new Set(cols.map((c) => c.col));
    const missing = t.columns.find((c) => !have.has(c));
    if (missing !== undefined) throw new MigrateStoreColumnError(t.name, missing);
    const always = cols.filter((c) => c.ident === 'a' && t.columns.includes(c.col));
    if (always.length > 0)
      identity.set(
        t.name,
        always.map((c) => c.col)
      );
  }
  return identity;
}

const keyOf = (r: RowKey) => JSON.stringify([r.namespace, r.type, r.id]);

/** `(namespace, type, id) IN (…)` over `keys`, as three bound arrays. */
function inKeys(sql: Sql | ReservedSql, keys: RowKey[]) {
  return sql`(namespace, type, id) IN (SELECT * FROM unnest(
    ${keys.map((k) => k.namespace)}::text[], ${keys.map((k) => k.type)}::text[], ${keys.map((k) => k.id)}::text[]))`;
}

/** After an interrupted run: empties every planned table but the seed rows that run recorded. */
async function restartIfStarted(tsql: Sql, plan: CopyPlan): Promise<void> {
  const marker = tsql(MIGRATE_STORE_MARKER_TABLE);
  const [started] = await tsql`SELECT 1 FROM ${marker} WHERE step = ${STARTED}`;
  if (started === undefined) return;
  const seeds = (
    await tsql<{ step: string }[]>`SELECT step FROM ${marker} WHERE starts_with(step, ${SEED})`
  ).map((r) => {
    const [namespace, type, id] = JSON.parse(r.step.slice(SEED.length)) as string[];
    return { namespace, type, id } as RowKey;
  });
  await tsql.begin(async (tx) => {
    const t = tx as unknown as Sql;
    await t`CREATE TEMP TABLE migrate_seed_rows ON COMMIT DROP AS SELECT * FROM rows WHERE ${inKeys(t, seeds)}`;
    await t`CREATE TEMP TABLE migrate_seed_short_ids ON COMMIT DROP AS
            SELECT s.* FROM short_ids s JOIN migrate_seed_rows r
              ON (r.namespace, r.type, r.id) = (s.namespace, s.type, s.row_id)`;
    await t`TRUNCATE ${t(plan.tables.map((p) => p.name))}`;
    await t`INSERT INTO rows SELECT * FROM migrate_seed_rows`;
    await t`INSERT INTO short_ids SELECT * FROM migrate_seed_short_ids`;
  });
}

/**
 * Deletes each target row the source also holds, so the source row replaces
 * it, and records the rest as seeds. Every row still on the target must be of
 * a type the target registers, as everything the prepare step writes is.
 */
async function reconcileSeeds(src: ReservedSql, tsql: Sql, target: BootedStore): Promise<RowKey[]> {
  const present = await tsql<
    RowKey[]
  >`SELECT namespace, type, id FROM rows ORDER BY namespace, type, id`;
  const inSource =
    present.length === 0
      ? []
      : await src<
          RowKey[]
        >`SELECT namespace, type, id FROM rows WHERE ${inKeys(src, [...present])}`;
  const replaced = new Set(inSource.map(keyOf));
  const kept = present
    .filter((r) => !replaced.has(keyOf(r)))
    .map(({ namespace, type, id }) => ({ namespace, type, id }));
  for (const r of kept) {
    if (registeredDataset(target, r.namespace, r.type) === undefined) {
      throw new Error(
        `target row ${r.namespace}/${r.type}/${r.id} is not one the prepare step wrote; refusing to copy alongside it`
      );
    }
  }
  const marker = tsql(MIGRATE_STORE_MARKER_TABLE);
  await tsql.begin(async (tx) => {
    const t = tx as unknown as Sql;
    if (inSource.length > 0) await t`DELETE FROM rows WHERE ${inKeys(t, [...inSource])}`;
    await t`DELETE FROM ${marker} WHERE starts_with(step, ${SEED}) OR starts_with(step, 'copy:')`;
    const steps = [STARTED, ...kept.map((k) => SEED + keyOf(k))];
    await t`INSERT INTO ${marker} ${t(steps.map((step) => ({ step, done_at: new Date() })))}`;
  });
  return kept;
}

function registeredDataset(target: BootedStore, ns: string, type: string): Dataset | undefined {
  // `has` first: `get` would allocate a dataset for a virtual namespace.
  if (!target.datasets.has(ns)) return undefined;
  if (target.engine.registryFor(ns)?.get(type)?.kind !== 'type') return undefined;
  return target.datasets.get(ns);
}

/** Gives every source type the target registers its partition, so its rows never pass through DEFAULT. */
async function prepareStorage(
  src: ReservedSql,
  target: BootedStore
): Promise<CopyResult['defaulted']> {
  const pairs = await src<
    { namespace: string; type: string }[]
  >`SELECT DISTINCT namespace, type FROM rows ORDER BY namespace, type`;
  const defaulted: CopyResult['defaulted'] = [];
  for (const { namespace, type } of pairs) {
    const dataset = registeredDataset(target, namespace, type);
    try {
      if (dataset?.ensureTypeStorage === undefined) throw new Error('not registered');
      await dataset.ensureTypeStorage(type, { indexes: 'unique' });
    } catch {
      // Boot already failed on a declared type's storage; a registry-only type drains out of DEFAULT on serve boot.
      defaulted.push({ namespace, type });
    }
  }
  return defaulted;
}

async function copyTable(
  src: ReservedSql,
  tsql: Sql,
  t: CopyPlanTable,
  identityCols: string[],
  counter: RowCounter
): Promise<void> {
  const out = await src`COPY (SELECT ${src(t.columns)} FROM ${src(t.name)}) TO STDOUT`.readable();
  // `out` stays out of the pipeline, which would destroy it on failure and leave the connection stuck in COPY OUT.
  const feed = new PassThrough();
  out.on('error', (err) => feed.destroy(err));
  out.pipe(feed);
  try {
    if (identityCols.length === 0) {
      await copyIn(tsql`COPY ${tsql(t.name)} (${tsql(t.columns)}) FROM STDIN`, feed, counter);
      return;
    }
    // COPY cannot override GENERATED ALWAYS, so stage the rows and INSERT … OVERRIDING SYSTEM VALUE.
    await tsql.begin(async (tx) => {
      const x = tx as unknown as Sql;
      const stage = x(`migrate_stage_${t.name}`);
      await x`CREATE TEMP TABLE ${stage} (LIKE ${x(t.name)} INCLUDING DEFAULTS) ON COMMIT DROP`;
      await copyIn(x`COPY ${stage} (${x(t.columns)}) FROM STDIN`, feed, counter);
      await x`INSERT INTO ${x(t.name)} (${x(t.columns)}) OVERRIDING SYSTEM VALUE SELECT ${x(t.columns)} FROM ${stage}`;
    });
  } catch (err) {
    // Discard the rest of the source table so the connection comes back for ROLLBACK.
    out.unpipe(feed);
    feed.destroy();
    out.resume();
    const detail = (err as { detail?: string }).detail;
    throw new Error(
      `copying ${t.name} failed: ${(err as Error).message}${detail ? ` (${detail})` : ''}`,
      { cause: err }
    );
  }
}

/**
 * Pipes `feed` through `counter` into a `COPY … FROM STDIN`. postgres.js 3.4.9
 * never finishes the writable when the server rejects the COPY, so the
 * query's own reject is raced as the failure signal.
 */
async function copyIn(
  query: PendingQuery<Row[]>,
  feed: Readable,
  counter: RowCounter
): Promise<void> {
  const q = query as unknown as { reject(err: unknown): void };
  const reject = q.reject;
  const failed = new Promise<never>((_, fail) => {
    q.reject = (err) => {
      fail(err);
      reject(err);
    };
  });
  failed.catch(() => undefined);
  const into = await query.writable();
  await Promise.race([pipeline(feed, counter, into), failed]);
}

/**
 * Moves every shortId sequence to the highest copied shortId of the
 * (namespace, type) pairs sharing its name, creating it if missing, and every
 * copied identity column's sequence to its column's maximum.
 */
async function advanceSequences(tsql: Sql, identity: Map<string, string[]>): Promise<void> {
  const maxes = await tsql<
    { namespace: string; type: string; max: string }[]
  >`SELECT namespace, type, max(short_id)::text AS max FROM short_ids GROUP BY namespace, type`;
  const byName = new Map<string, bigint>();
  for (const m of maxes) {
    const name = seqName(m.namespace, m.type);
    const max = BigInt(m.max);
    if ((byName.get(name) ?? 0n) < max) byName.set(name, max);
  }
  for (const [name, max] of byName) {
    await tsql`CREATE SEQUENCE IF NOT EXISTS ${tsql(name)}`;
    await tsql`SELECT setval(${`"${name}"`}::regclass, ${max.toString()}::bigint)`;
  }
  for (const [table, cols] of identity) {
    for (const col of cols) {
      await tsql`
        SELECT setval(pg_get_serial_sequence(quote_ident(${table}), ${col}), m)
        FROM (SELECT max(${tsql(col)}) AS m FROM ${tsql(table)}) s WHERE m IS NOT NULL`;
    }
  }
}

async function markStep(tsql: Sql, step: string): Promise<void> {
  await tsql`
    INSERT INTO ${tsql(MIGRATE_STORE_MARKER_TABLE)} (step, done_at) VALUES (${step}, now())
    ON CONFLICT (step) DO UPDATE SET done_at = excluded.done_at`;
}

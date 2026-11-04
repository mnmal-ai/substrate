/**
 * The migrate-store copy: converts a legacy or partitioned source into a
 * target `bootStore` prepared in the `tables` layout, all from one REPEATABLE
 * READ, READ ONLY source snapshot. `rows` is converted: each source type is
 * streamed with a cursor, in `batchRows` batches, into its type table by
 * `copyRows` (columns plus `extra`, ids into `row_ids`). Every other table
 * moves with `COPY … TO STDOUT` piped into `COPY … FROM STDIN`. Nothing here
 * writes to the source.
 *
 * Two phases around a re-boot, on one source snapshot. Phase 1 copies the
 * rows (and their shortIds) that declare storage: `_system`,
 * `_system_proposals` and every TypeProposal and FieldProposal. The second
 * boot replays those proposals as serve does, so every proposed type is
 * registered, with its table and declared fields, before phase 2 copies
 * everything else. A source type nothing declares gets a table with no
 * columns, so its fields all go to `extra`, and is reported `defaulted`.
 * Last, one promotion sweep moves the values of fields declared only by the
 * replay (phase 1 converted them into `extra`) into their columns.
 *
 * Progress lives in the marker table on the target. A rerun after an
 * interruption restarts cleanly: it empties the planned tables, keeps the
 * seed rows the first run recorded, and copies again.
 */

import { PassThrough, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  copyRows,
  ensureTypeTable,
  loadTypeTable,
  MIGRATE_STORE_MARKER_TABLE,
  type Misfit,
  parseSourceBody,
  type SourceRow,
  seqName,
  type TypeTable,
  UUID_CHECK_MIGRATION
} from '@mnmal-ai/substrate-dataset-pg';
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

/** The misfits listed per type, beside the full count. */
export const MISFITS_LISTED = 100;

export interface CopyResult {
  tables: { name: string; rows: number; bytes: number; ms: number }[];
  /** Target rows the prepare step seeded that the source lacks; they stay. */
  keptSeeds: RowKey[];
  /** `<ns>/<Type>` of the source types no target definition declares: every field of theirs is in `extra`. */
  defaulted: string[];
  /** Per `<ns>/<Type>`: values their declared column cannot hold, kept under `$raw`; the first {@link MISFITS_LISTED}. */
  misfits: Record<string, { count: number; first: Misfit[] }>;
  /** The second boot, its tables prepared. The caller closes it. */
  target: BootedStore;
}

export interface CopyOptions {
  /** Rows per converted batch, and between `onProgress` calls within a table. */
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

export const STARTED = 'copy:started';
export const SEED = 'seed:';

/** The `rows` / `short_ids` predicate phase 1 copies; phase 2 copies its complement. Both columns are NOT NULL. */
export const PHASE1_ROWS =
  "namespace IN ('_system', '_system_proposals') OR type IN ('TypeProposal', 'FieldProposal')";
const PHASED = new Set(['rows', 'short_ids']);
/** Converted rather than copied: the target has no `rows`. */
const CONVERTED = 'rows';

type Totals = { rows: number; bytes: number; ms: number };

export async function copyStore(
  source: Sql,
  boot: () => Promise<BootedStore>,
  plan: CopyPlan,
  opts: CopyOptions
): Promise<CopyResult> {
  let target = await boot();
  // The boot to close on failure; unset while none is open.
  let open: BootedStore | undefined = target;
  try {
    let tsql = sqlOf(target);
    await tsql`CREATE TABLE IF NOT EXISTS ${tsql(MIGRATE_STORE_MARKER_TABLE)} (step text PRIMARY KEY, done_at timestamptz)`;
    const identity = await checkColumns(tsql, plan);
    if (await restartIfStarted(tsql, plan)) {
      // The boot replayed the interrupted run's proposals and started index builds. Close (which ends
      // them) and boot fresh, now without those proposals, before taking the source snapshot, which
      // the builds would otherwise wait on in a same-database copy.
      open = undefined;
      await target.close();
      target = await boot();
      open = target;
      tsql = sqlOf(target);
    }

    const src = await source.reserve();
    let streaming = false;
    let snapshotOpen = true;
    try {
      await src.unsafe('BEGIN ISOLATION LEVEL REPEATABLE READ, READ ONLY');
      // Timestamps are read as text (microseconds kept), so in one unambiguous form whatever the source's settings.
      await src.unsafe("SET LOCAL DateStyle = 'ISO, YMD'");
      await src.unsafe("SET LOCAL TimeZone = 'UTC'");
      const keptSeeds = await reconcileSeeds(src, tsql, target);
      const rowsPlan = plan.tables.find((t) => t.name === CONVERTED);
      const misfits: CopyResult['misfits'] = {};

      const totals = new Map<string, Totals>();
      const copy = async (t: CopyPlanTable, filter: string | null, tables: TypeTables) => {
        const start = performance.now();
        const prev = totals.get(t.name) ?? { rows: 0, bytes: 0, ms: 0 };
        const counter = new RowCounter(t.name, opts.batchRows, opts.onProgress, prev);
        streaming = true;
        if (t.name === CONVERTED) {
          await convertRows(src, tsql, t, filter, tables, counter, opts.batchRows, misfits);
        } else {
          await copyTable(src, tsql, t, identity.get(t.name) ?? [], counter, filter);
        }
        streaming = false;
        totals.set(t.name, {
          rows: counter.rows,
          bytes: counter.bytes,
          ms: prev.ms + Math.round(performance.now() - start)
        });
      };

      const phase1 = await prepareTables(src, target, PHASE1_ROWS, false);
      for (const t of plan.tables.filter((p) => PHASED.has(p.name)))
        await copy(t, PHASE1_ROWS, phase1.tables);
      await markStep(tsql, 'copy:phase1');

      // Serve's own boot replays the copied proposals and prepares their types' storage.
      await snapshotRows(tsql);
      open = undefined;
      await target.close();
      target = await boot();
      open = target;
      tsql = sqlOf(target);
      await assertRebootWroteNothing(tsql);

      const phase2 = await prepareTables(src, target, null, true);
      const tables: CopyResult['tables'] = [];
      for (const t of plan.tables) {
        await copy(t, PHASED.has(t.name) ? `NOT (${PHASE1_ROWS})` : null, phase2.tables);
        await markStep(tsql, `copy:${t.name}`);
        const done = totals.get(t.name) as Totals;
        tables.push({ name: t.name, ...done });
        opts.onProgress({ table: t.name, rows: done.rows, bytes: done.bytes, done: true });
      }
      await markStep(tsql, 'copy:phase2');

      await advanceSequences(tsql, identity);
      // The snapshot ends first: the sweep's index builds (CONCURRENTLY) wait out every open
      // transaction, the source's too when it shares the target's database.
      await src.unsafe('COMMIT');
      snapshotOpen = false;
      src.release();
      if (rowsPlan !== undefined) await settleFields(target, opts.batchRows);
      await markStep(tsql, 'copy:done');
      return { tables, keptSeeds, defaulted: phase2.defaulted, misfits, target };
    } catch (err) {
      if (!snapshotOpen) throw err;
      const released = src
        .unsafe('ROLLBACK')
        .catch(() => undefined)
        .then(() => src.release())
        .catch(() => undefined);
      // Mid-table, the ROLLBACK waits for the rest of the source table to drain; don't hold the error for it.
      if (!streaming) await released;
      throw err;
    }
  } catch (err) {
    await open?.close().catch(() => undefined);
    throw err;
  }
}

function sqlOf(target: BootedStore): Sql {
  if (target.sql === null) throw new Error('migrate-store copies into a postgres target only');
  return target.sql;
}

const quoteIdent = (name: string) => `"${name.replace(/"/g, '""')}"`;

/** The target's type tables, each with its (quoted) relation. */
async function typeTablesOf(
  tsql: Sql
): Promise<Array<{ namespace: string; type: string; rel: string }>> {
  const rows = await tsql<Array<{ namespace: string; type: string; table_name: string }>>`
    SELECT namespace, type, table_name FROM substrate_type_tables ORDER BY namespace, type`;
  return rows.map((r) => ({ namespace: r.namespace, type: r.type, rel: quoteIdent(r.table_name) }));
}

/**
 * SQL over every target row: `(namespace, type, id, h)`, `h` an md5 of the
 * stored row with its null columns dropped, so a column added by a re-boot
 * changes no row's hash. `null` when there are no type tables.
 */
async function targetRowsSql(tsql: Sql): Promise<string | null> {
  const tables = await typeTablesOf(tsql);
  if (tables.length === 0) return null;
  const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;
  return tables
    .map(
      (t) =>
        `SELECT ${lit(t.namespace)}::text AS namespace, ${lit(t.type)}::text AS type, x.id, md5(jsonb_strip_nulls(to_jsonb(x))::text) AS h FROM ${t.rel} x`
    )
    .join(' UNION ALL ');
}

const SNAPSHOT = 'substrate_migrate_store_reboot_rows';

/** Records every target row's key and content hash, for `assertRebootWroteNothing`. */
async function snapshotRows(tsql: Sql): Promise<void> {
  await tsql`DROP TABLE IF EXISTS ${tsql(SNAPSHOT)}`;
  const all = await targetRowsSql(tsql);
  await tsql.unsafe(
    `CREATE UNLOGGED TABLE ${quoteIdent(SNAPSHOT)} AS ${all ?? 'SELECT NULL::text AS namespace, NULL::text AS type, NULL::text AS id, NULL::text AS h WHERE false'}`
  );
}

/** Refuses a re-boot that added, removed or changed a row, naming up to ten of each. */
async function assertRebootWroteNothing(tsql: Sql): Promise<void> {
  const all =
    (await targetRowsSql(tsql)) ??
    'SELECT NULL::text AS namespace, NULL::text AS type, NULL::text AS id, NULL::text AS h WHERE false';
  const diff = await tsql.unsafe<
    { change: string; namespace: string; type: string; id: string }[]
  >(`
    SELECT CASE WHEN s.id IS NULL THEN 'added' WHEN r.id IS NULL THEN 'removed' ELSE 'changed' END AS change,
           coalesce(r.namespace, s.namespace) AS namespace, coalesce(r.type, s.type) AS type,
           coalesce(r.id, s.id) AS id
    FROM (${all}) r
    FULL JOIN ${quoteIdent(SNAPSHOT)} s USING (namespace, type, id)
    WHERE s.id IS NULL OR r.id IS NULL OR r.h <> s.h
    ORDER BY 1, 2, 3, 4 LIMIT 30`);
  await tsql`DROP TABLE ${tsql(SNAPSHOT)}`;
  if (diff.length === 0) return;
  const named = ['added', 'changed', 'removed']
    .map((c) => {
      const rows = diff.filter((d) => d.change === c).slice(0, 10);
      return rows.length === 0
        ? ''
        : `${c}: ${rows.map((d) => `${d.namespace}/${d.type}/${d.id}`).join(', ')}`;
    })
    .filter((s) => s !== '')
    .join('; ');
  throw new Error(
    `the target's re-boot wrote rows the source does not have (${named}). ` +
      'The boot writes them because the source lacks them, usually the _system/AuditEvent of kind ' +
      "'bootstrap' that serve records on a store's first boot with keys. Boot the source once with " +
      'substrate serve so it records them itself, stop it, then rerun migrate-store, which restarts cleanly.'
  );
}

/** Refuses a plan column the target lacks; returns each table's identity-always columns among the planned ones. */
async function checkColumns(tsql: Sql, plan: CopyPlan): Promise<Map<string, string[]>> {
  const copied = plan.tables.filter((t) => t.name !== CONVERTED);
  const names = copied.map((t) => t.name);
  const rows = await tsql<{ table: string; col: string; ident: string }[]>`
    SELECT c.relname AS "table", a.attname AS col, a.attidentity AS ident
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema() AND c.relname = ANY(${names}::text[])
      AND c.relkind IN ('r', 'p') AND a.attnum > 0 AND NOT a.attisdropped AND a.attgenerated = ''`;
  const identity = new Map<string, string[]>();
  for (const t of copied) {
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

/**
 * Deletes target rows: those in `keys`, or (`except`) all but those. From each
 * type table and from `row_ids`, whose delete cascades to `short_ids`.
 */
async function deleteTargetRows(t: Sql, keys: RowKey[], except: boolean): Promise<void> {
  for (const table of await typeTablesOf(t)) {
    const ids = keys
      .filter((k) => k.namespace === table.namespace && k.type === table.type)
      .map((k) => k.id);
    if (!except && ids.length === 0) continue;
    await t.unsafe(`DELETE FROM ${table.rel} WHERE ${except ? 'NOT ' : ''}(id = ANY($1::text[]))`, [
      ids
    ]);
  }
  await t`DELETE FROM row_ids WHERE ${except ? t`NOT` : t``} ${inKeys(t, keys)}`;
}

/** After an interrupted run: empties every planned table but the seed rows that run recorded. True when it did. */
async function restartIfStarted(tsql: Sql, plan: CopyPlan): Promise<boolean> {
  const marker = tsql(MIGRATE_STORE_MARKER_TABLE);
  const [started] = await tsql`SELECT 1 FROM ${marker} WHERE step = ${STARTED}`;
  if (started === undefined) return false;
  const seeds = (
    await tsql<{ step: string }[]>`SELECT step FROM ${marker} WHERE starts_with(step, ${SEED})`
  ).map((r) => {
    const [namespace, type, id] = JSON.parse(r.step.slice(SEED.length)) as string[];
    return { namespace, type, id } as RowKey;
  });
  // DELETE rather than TRUNCATE on the type tables: the boot's replay may be building indexes on
  // them, and a TRUNCATE there races their catalog updates.
  const others = plan.tables.map((p) => p.name).filter((n) => !PHASED.has(n));
  await tsql.begin(async (tx) => {
    const t = tx as unknown as Sql;
    await deleteTargetRows(t, seeds, true);
    if (others.length > 0) await t`TRUNCATE ${t(others)}`;
  });
  return true;
}

/**
 * Deletes each target row the source also holds, so the source row replaces
 * it, and records the rest as seeds. Every row still on the target must be of
 * a type the target registers, as everything the prepare step writes is.
 */
async function reconcileSeeds(src: ReservedSql, tsql: Sql, target: BootedStore): Promise<RowKey[]> {
  const present = await tsql<
    RowKey[]
  >`SELECT namespace, type, id FROM row_ids ORDER BY namespace, type, id`;
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
    if (inSource.length > 0)
      await deleteTargetRows(
        t,
        inSource.map(({ namespace, type, id }) => ({ namespace, type, id })),
        false
      );
    await t`DELETE FROM ${marker} WHERE starts_with(step, ${SEED}) OR starts_with(step, 'copy:')`;
    const steps = [STARTED, ...kept.map((k) => SEED + keyOf(k))];
    await t`INSERT INTO ${marker} ${t(steps.map((step) => ({ step, done_at: new Date() })))}`;
  });
  return kept;
}

export function registeredDataset(
  target: BootedStore,
  ns: string,
  type: string
): Dataset | undefined {
  // `has` first: `get` would allocate a dataset for a virtual namespace.
  if (!target.datasets.has(ns)) return undefined;
  if (target.engine.registryFor(ns)?.get(type)?.kind !== 'type') return undefined;
  return target.datasets.get(ns);
}

/** Each source type's table descriptor, by `<ns>/<Type>`. */
type TypeTables = Map<string, TypeTable>;

/**
 * Gives every source type `filter` picks its table and returns their
 * descriptors: a registered type's through its dataset, with its declared
 * fields and unique indexes; any other's with no field columns (its fields
 * all go to `extra`), listed in `defaulted` when `report` is set.
 */
async function prepareTables(
  src: ReservedSql,
  target: BootedStore,
  filter: string | null,
  report: boolean
): Promise<{ tables: TypeTables; defaulted: string[] }> {
  const tsql = sqlOf(target);
  const where = filter === null ? src`` : src`WHERE ${src.unsafe(filter)}`;
  const pairs = await src<
    { namespace: string; type: string }[]
  >`SELECT DISTINCT namespace, type FROM rows ${where} ORDER BY namespace, type`;
  const tables: TypeTables = new Map();
  const defaulted: string[] = [];
  const [uuid] = await tsql<{ on: boolean }[]>`
    SELECT EXISTS (SELECT 1 FROM migrations WHERE version = ${UUID_CHECK_MIGRATION}) AS on`;
  for (const { namespace, type } of pairs) {
    const key = `${namespace}/${type}`;
    const dataset = registeredDataset(target, namespace, type);
    if (dataset === undefined && report) defaulted.push(key);
    try {
      if (dataset !== undefined) await dataset.ensureTypeStorage?.(type, { indexes: 'unique' });
      // A type nothing declares: a table with no field columns and, as nothing serves it, no indexes.
      else
        await ensureTypeTable(tsql, {
          namespace,
          type,
          fields: {},
          newFields: 'column',
          enforceUuidCheck: uuid?.on === true,
          createOnly: true
        });
    } catch (err) {
      throw new Error(`preparing storage for ${key} failed: ${(err as Error).message}`, {
        cause: err
      });
    }
    const table = await loadTypeTable(tsql, namespace, type);
    if (table === undefined) throw new Error(`preparing storage for ${key} made no table`);
    tables.set(key, table);
  }
  return { tables, defaulted };
}

/**
 * Converts the source rows `filter` picks, type by type, each streamed with a
 * cursor in `batchRows` batches into its type table. A row the table already
 * holds, or a refusal (a declared unique index), fails the copy loudly.
 */
async function convertRows(
  src: ReservedSql,
  tsql: Sql,
  t: CopyPlanTable,
  filter: string | null,
  tables: TypeTables,
  counter: RowCounter,
  batchRows: number,
  misfits: CopyResult['misfits']
): Promise<void> {
  const where = filter === null ? src`` : src`AND (${src.unsafe(filter)})`;
  // A store from before 0004_visible_seq has no seq.
  const seq = t.columns.includes('seq') ? src`seq::text` : src`NULL::text`;
  const pairs = await src<{ namespace: string; type: string }[]>`
    SELECT DISTINCT namespace, type FROM rows WHERE true ${where} ORDER BY namespace, type`;
  for (const { namespace, type } of pairs) {
    const key = `${namespace}/${type}`;
    const table = tables.get(key);
    if (table === undefined) throw new Error(`internal: no table prepared for ${key}`);
    // The body as text, parsed so no number changes its text (`parseSourceBody`).
    const cursor = src<Array<Omit<SourceRow, 'body'> & { body: string }>>`
      SELECT id, body::text AS body, deleted_at::text, created_at::text, updated_at::text,
             created_by_kind, created_by_id, updated_by_kind, updated_by_id,
             ${seq} AS seq
      FROM rows WHERE namespace = ${namespace} AND type = ${type} ${where}
      ORDER BY id`.cursor(batchRows);
    for await (const batch of cursor) {
      let result: Awaited<ReturnType<typeof copyRows>>;
      try {
        result = await copyRows(
          tsql,
          table,
          batch.map((r) => ({ ...r, body: parseSourceBody(r.body) }))
        );
      } catch (err) {
        throw rowsError(key, err);
      }
      if (result.inserted !== batch.length) {
        throw new Error(
          `copying rows failed: ${key}: ${batch.length - result.inserted} source row(s) were already on the target`
        );
      }
      if (result.misfits.length > 0) {
        const listed = misfits[key] ?? { count: 0, first: [] };
        listed.count += result.misfits.length;
        listed.first.push(...result.misfits.slice(0, MISFITS_LISTED - listed.first.length));
        misfits[key] = listed;
      }
      counter.add(
        batch.length,
        batch.reduce((n, r) => n + Buffer.byteLength(r.body), 0)
      );
    }
  }
}

/** A conversion failure as one line naming the type; a unique refusal names the declared index and the key. */
function rowsError(key: string, err: unknown): Error {
  const pg = err as { code?: unknown; constraint_name?: unknown; detail?: unknown };
  if (pg?.code === '23505' && typeof pg.constraint_name === 'string') {
    return new Error(
      `copying rows failed: ${key}: unique index ${pg.constraint_name} refuses a source row whose key ` +
        `another row already holds${typeof pg.detail === 'string' ? ` (${pg.detail})` : ''}. ` +
        'Resolve the duplicate in the source, then rerun migrate-store, which restarts cleanly.',
      { cause: err }
    );
  }
  const detail = typeof pg?.detail === 'string' ? ` (${pg.detail})` : '';
  return new Error(
    `copying rows failed: ${key}: ${(err as Error).message ?? String(err)}${detail}`,
    {
      cause: err
    }
  );
}

/**
 * One promotion sweep over the target: a field declared only once the re-boot
 * replayed its proposal had its phase-1 values converted into `extra`, so it
 * is `promoting` (or `pending`) until moved into its column. Fails loudly,
 * naming each field, when one is not promoted.
 */
async function settleFields(target: BootedStore, batchRows: number): Promise<void> {
  const events =
    (await target.dataset.promotePendingFields?.({ lockTimeoutMs: 60_000, batchRows })) ?? [];
  const stuck = events.filter((e) => e.kind !== 'promoted');
  if (stuck.length > 0) {
    throw new Error(
      `settling declared fields failed: ${stuck
        .map(
          (e) => `${e.namespace}/${e.type}.${e.field} ${e.kind}${e.error ? ` (${e.error})` : ''}`
        )
        .join('; ')}. Rerun migrate-store, which restarts cleanly.`
    );
  }
}

async function copyTable(
  src: ReservedSql,
  tsql: Sql,
  t: CopyPlanTable,
  identityCols: string[],
  counter: RowCounter,
  /** A constant predicate: COPY runs as a simple query, which takes no parameters. */
  filter: string | null
): Promise<void> {
  const where = filter === null ? src`` : src`WHERE ${src.unsafe(filter)}`;
  const out =
    await src`COPY (SELECT ${src(t.columns)} FROM ${src(t.name)} ${where}) TO STDOUT`.readable();
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

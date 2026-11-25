/** `PgDataset`'s index and storage administration: reconciling, reporting and dropping. */

import type {
  IndexDecl,
  IndexPlan,
  StorageReport,
  TypeStats,
  TypeStorageReport
} from '@mnmal-ai/substrate-types';
import type { ReservedSql, Sql } from 'postgres';
import {
  describeTypeIndexes,
  desiredIndexKeys,
  type HeldIndex,
  heldIndexes,
  IndexDropRefusedError,
  type IndexState,
  isEngineOwned,
  pendingIndexBuilds as pendingBuildsOf,
  reconcileTypeIndexes,
  typeIndexesOf,
  undeclaredIndexes
} from './index-reconciler.js';
import { ident } from './layout.js';
import { IndexLockAborted, withTableIndexLock } from './migrate.js';
import { cachedMisfitCount, countMisfits, freshMisfitCount } from './misfits.js';
import { indexArgs, type PgContext } from './pg-dataset-context.js';
import { fieldExprSql } from './pg-sql/primitives.js';
import { isTransientPromotionError, PROMOTION_FAILED_AFTER } from './promote.js';
import { loadTypeTable, typeTableOf } from './type-table.js';

/** An index whose build this process deferred, is running, or saw fail. */
interface DeferredBuild {
  state: 'pending' | 'building' | 'failed';
  /** `<namespace>/<type>`. */
  type: string;
  /** Why it failed: an error code, then a short reason. */
  error?: string;
  /** Why it is pending, when the disk guard refused it. */
  reason?: 'insufficient_disk';
}

/**
 * `N open index recommendation(s)` while the index advisor has any, else
 * nothing. Reads `_system/IndexRecommendation` from this schema's type table,
 * so a `_system` held elsewhere (memory) reports none.
 */
async function openRecommendations(sql: Sql): Promise<string[]> {
  const table = await loadTypeTable(sql, '_system', 'IndexRecommendation');
  const [row] =
    table === undefined
      ? []
      : await sql.unsafe<Array<{ n: number }>>(
          `SELECT count(*)::int AS n FROM ${table.from}
           WHERE deleted_at IS NULL AND ${fieldExprSql(table, 'state', 'text')} = 'open'`
        );
  const n = row?.n ?? 0;
  return n === 0
    ? []
    : [
        `${n} open index recommendation${n === 1 ? '' : 's'}: query _system/IndexRecommendation, then apply or dismiss each with propose_index`
      ];
}

/** Per pool, so every dataset on it reports what the others deferred. */
const deferredBuilds = new WeakMap<object, Map<string, DeferredBuild>>();

/**
 * `dropEngineIndex`'s bound on each lock wait. A request transaction ends in
 * well under this; one still open after it is a long export or a caller
 * waiting on the drop itself, and the drop holds the table's index-build lock
 * and two connections while it waits, so it gives up and the caller retries.
 */
const DROP_LOCK_TIMEOUT_MS = 10_000;

/**
 * DROP INDEX CONCURRENTLY `name` (of `where`, for messages) on `conn`, each
 * lock wait bounded by `timeoutMs`; a wait over it throws `index_drop_timeout`.
 */
async function dropIndexBounded(
  conn: ReservedSql,
  name: string,
  where: string,
  timeoutMs: number
): Promise<void> {
  const timeout = Math.max(1, Math.trunc(timeoutMs));
  try {
    await conn.unsafe(`SET lock_timeout = ${timeout}`);
    await conn.unsafe(`DROP INDEX CONCURRENTLY IF EXISTS ${ident(name)}`);
  } catch (err) {
    if ((err as { code?: unknown }).code !== '55P03') throw err;
    throw new IndexDropRefusedError(
      'index_drop_timeout',
      `dropping index ${name} on ${where} waited over ${timeout} ms on another transaction; retry once it ends`
    );
  } finally {
    await conn.unsafe('RESET lock_timeout');
  }
}

function deferredBuildsOf(ctx: PgContext): Map<string, DeferredBuild> {
  const builds = deferredBuilds.get(ctx.sql) ?? new Map<string, DeferredBuild>();
  deferredBuilds.set(ctx.sql, builds);
  return builds;
}

/** `ensureTypeStorage`'s index pass: reconciles, then records each state for the reports. */
export async function reconcileIndexes(
  ctx: PgContext,
  type: string,
  opts: { indexes?: 'all' | 'unique' | 'nonUnique'; signal?: AbortSignal }
): Promise<void> {
  const sql = ctx.sql as Sql;
  const builds = deferredBuildsOf(ctx);
  const qualified = `${ctx.namespace}/${type}`;
  const record = (s: IndexState): void => {
    if (s.state === 'pending' || s.state === 'failed') {
      builds.set(s.name, {
        state: s.state,
        type: qualified,
        ...(s.error !== undefined ? { error: s.error } : {}),
        ...(s.reason !== undefined ? { reason: s.reason } : {})
      });
    } else {
      builds.delete(s.name);
    }
  };
  let states: IndexState[];
  try {
    states = await reconcileTypeIndexes(sql, indexArgs(ctx, type, ctx.namespace), {
      only: opts.indexes ?? 'all',
      onBuild: (name) => builds.set(name, { state: 'building', type: qualified }),
      onState: record,
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
      ...(ctx.diskGuard !== undefined ? { diskGuard: ctx.diskGuard } : {})
    });
  } catch (err) {
    // Only the indexes this pass had not settled; one it settled keeps its state.
    const code = (err as { code?: unknown }).code;
    const reason = `${typeof code === 'string' ? code : 'error'}: ${
      (err instanceof Error ? err.message : String(err)).split('\n')[0]
    }`;
    for (const b of builds.values()) {
      if (b.type === qualified && b.state !== 'failed') {
        b.state = 'failed';
        b.error = reason;
        delete b.reason;
      }
    }
    throw err;
  }
  for (const s of states) {
    record(s);
    if (s.outcome === 'unchanged') continue;
    process.stdout.write(
      `[substrate] index ${s.name} on ${ctx.namespace}/${type}: ${s.outcome} (${s.state})\n`
    );
  }
}

/**
 * See `Dataset.fieldWarnings`. Store-wide; none before the store is migrated. Counts
 * only, since `/health` shows it unauthenticated: the named lines are in
 * `storageReport`, which is admin-gated.
 */
export async function fieldWarnings(ctx: PgContext): Promise<string[]> {
  if ((await ctx.layout()) === 'absent') return [];
  const lines = await fieldLines(ctx);
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  const pending = lines.filter((l) => l.state === 'pending').length;
  const failed = lines.filter((l) => l.failed).length;
  const orphaned = lines.filter((l) => l.state === 'orphaned').length;
  // Never scans on this (unauthenticated) path: the last count, if any.
  const misfits = (cachedMisfitCount(ctx.sql, () => countMisfits(ctx.sql as Sql)) ?? []).reduce(
    (n, m) => n + m.count,
    0
  );
  const parts = [
    ...(pending > 0
      ? [plural(pending, 'field pending promotion', 'fields pending promotion')]
      : []),
    ...(failed > 0 ? [plural(failed, 'promotion failed', 'promotions failed')] : []),
    ...(orphaned > 0 ? [plural(orphaned, 'field orphaned', 'fields orphaned')] : []),
    ...(misfits > 0 ? [plural(misfits, 'misfit kept under $raw', 'misfits kept under $raw')] : [])
  ];
  return parts.length === 0 ? [] : [`${parts.join('; ')} — see the storage report`];
}

/**
 * Each field an operator should know about, by name: a pending one, one
 * whose promotion failed (an error other than busy or stopped, or a busy or
 * stopped one {@link PROMOTION_FAILED_AFTER} attempts in a row), one busy
 * short of that, and an orphaned one.
 */
async function fieldLines(
  ctx: PgContext
): Promise<Array<{ state: string; failed: boolean; line: string }>> {
  const rows = await ctx.sql<
    Array<{
      namespace: string;
      type: string;
      field: string;
      state: string;
      attempts: number;
      last_error: string | null;
    }>
  >`
    SELECT namespace, type, field, state, attempts, last_error FROM substrate_type_fields
    WHERE state IN ('pending', 'orphaned')
       OR (state IN ('promoting', 'column') AND last_error IS NOT NULL)
    ORDER BY namespace COLLATE "C", type COLLATE "C", field COLLATE "C"`;
  return rows.map((r) => {
    const name = `${r.namespace}/${r.type}.${r.field}`;
    const failed =
      r.last_error !== null &&
      (!isTransientPromotionError(r.last_error) || r.attempts >= PROMOTION_FAILED_AFTER);
    const line = failed
      ? `${name} promotion failed (attempt ${r.attempts}): ${r.last_error}`
      : r.state === 'orphaned'
        ? `${name} is orphaned: no longer declared; values readable as extras`
        : r.state === 'pending'
          ? `${name} is pending: held in jsonb until promoted (attempt ${r.attempts})`
          : `${name} is ${(r.last_error ?? '').replace(/^(busy|stopped): /, (_, kind) => `${kind} (attempt ${r.attempts}): `)}, retried next sweep`;
    return { state: r.state, failed, line };
  });
}

/** Each index's catalog state, overridden by what this process knows of its build. */
function withBuilds(ctx: PgContext, states: IndexState[]): IndexState[] {
  const builds = deferredBuildsOf(ctx);
  return states.map((s) => {
    const build = builds.get(s.name);
    if (build === undefined) return s;
    // A catalog state carries no `error`.
    return {
      ...s,
      state: build.state,
      ...(build.error !== undefined ? { error: build.error } : {}),
      ...(build.reason !== undefined ? { reason: build.reason } : {})
    };
  });
}

/**
 * The type's non-unique indexes the next build pass would build or swap,
 * each with the disk guard's estimate. Empty when the store or the type's
 * storage does not exist yet. Changes nothing.
 */
export async function pendingIndexBuilds(
  ctx: PgContext,
  type: string
): Promise<Array<{ name: string; estimateBytes: number }>> {
  if ((await ctx.layout()) === 'absent') return [];
  const args = indexArgs(ctx, type, ctx.namespace);
  if ((await typeTableOf(ctx.sql, ctx.namespace, type)) === undefined) return [];
  return pendingBuildsOf(ctx.sql as Sql, args);
}

/**
 * See `Dataset.describeStorage`. Reads the catalog only, in a fixed number of
 * queries: the type's table, its indexes, and its `pending` and `orphaned`
 * fields, as the catalog records them.
 */
export async function describeStorage(ctx: PgContext, type: string): Promise<TypeStorageReport> {
  const sql = ctx.sql as Sql;
  const name =
    (await ctx.layout()) === 'absent' ? undefined : await typeTableOf(sql, ctx.namespace, type);
  const table = name === undefined ? undefined : await loadTypeTable(sql, ctx.namespace, type);
  if (name === undefined || table === undefined) {
    return { layout: 'tables', indexes: [], pending: [], orphaned: [] };
  }
  return {
    layout: 'tables',
    table: name,
    indexes: withBuilds(
      ctx,
      describeTypeIndexes(
        { ...indexArgs(ctx, type, ctx.namespace), table },
        await heldIndexes(sql, [name])
      )
    ),
    pending: [...table.pending],
    orphaned: [...table.orphaned]
  };
}

/**
 * See `Dataset.storageReport`. Spans every namespace of the database. Reads
 * the type tables and every index on them in one query each, so its cost
 * does not grow with the number of types.
 */
export async function storageReport(
  ctx: PgContext,
  opts: { partitionBudget: number }
): Promise<StorageReport> {
  const layout = await ctx.layout();
  const building = [...deferredBuildsOf(ctx)]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(
      ([name, b]) =>
        `index ${name} on ${b.type} is ${b.state}${b.error !== undefined ? ` (${b.error})` : ''}` +
        `${b.reason !== undefined ? ` (${b.reason})` : ''}: ` +
        'filters it would serve scan until it is valid'
    );
  if (ctx.diskGuard !== undefined && ctx.diskGuard.path === undefined) {
    building.push(
      'free-disk checks before index builds are off: set SUBSTRATE_INDEX_DISK_PATH to the database volume mount, or to off when the database has no local volume'
    );
  }
  if (layout === 'absent') return { layout: 'tables', warnings: building };
  const sql = ctx.sql as Sql;
  const info = await openRecommendations(sql);
  const warnings = [...building];
  const tables = await sql<Array<{ namespace: string; type: string; table: string }>>`
    SELECT namespace, type, table_name AS "table" FROM substrate_type_tables`;
  const held = await heldIndexes(
    sql,
    tables.map((t) => t.table)
  );
  const heldBy = Map.groupBy(held, (i) => i.table);
  for (const t of tables) {
    undeclared(ctx, warnings, info, t.namespace, t.type, heldBy.get(t.table) ?? []);
  }
  // A failed promotion is a fault; a pending or orphaned field is a state worth showing.
  for (const f of await fieldLines(ctx)) (f.failed ? warnings : info).push(f.line);
  for (const m of await freshMisfitCount(ctx.sql, () => countMisfits(sql))) {
    info.push(
      `${m.namespace}/${m.type}.${m.field} has ${m.count} misfit${m.count === 1 ? '' : 's'} kept under $raw: ` +
        'the column holds NULL for them, so its index does not serve them; write the field again or widen its vocabulary'
    );
  }
  if (tables.length > opts.partitionBudget) {
    warnings.push(
      `${tables.length} type tables exceed the budget of ${opts.partitionBudget}: move a namespace to its own instance behind a bridge`
    );
  }
  return { layout: 'tables', warnings, info };
}

/**
 * Notes, as info, each engine-owned index of a known type that its
 * declaration no longer asks for: the index advisor recommends its removal
 * on evidence, so it is not a fault. A type that cannot be checked warns.
 */
function undeclared(
  ctx: PgContext,
  warnings: string[],
  info: string[],
  ns: string,
  type: string,
  own: HeldIndex[]
): void {
  if (ctx.typeDefLookup === null) return;
  if (ctx.typeDefLookup(type, ns) === undefined) {
    for (const i of own) {
      if (!isEngineOwned(i)) continue;
      info.push(
        `orphaned index ${i.name} on ${ns}/${type}: no registered type owns it; ${i.unique ? 'it is unique, so drop it by hand' : 'a signed propose_index remove drops it'}`
      );
    }
    return;
  }
  try {
    for (const name of undeclaredIndexes(indexArgs(ctx, type, ns), own)) {
      info.push(
        `undeclared index ${name} on ${ns}/${type}: kept until a signed remove drops it (the index advisor recommends one when it goes unused)`
      );
    }
  } catch (err) {
    warnings.push(
      `indexes of ${ns}/${type} could not be checked: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/** See `Dataset.indexPlan`. */
export async function indexPlan(
  ctx: PgContext,
  type: string,
  namespace: string
): Promise<IndexPlan | undefined> {
  const def = ctx.typeDefLookup?.(type, namespace);
  if (def === undefined || (await ctx.layout()) === 'absent') return undefined;
  // An index over a field not yet `column` serves no read. Every walk read asks (its
  // plan diagnostics), so through the TableCache like the read itself.
  const table = await ctx.tableFor(type, namespace, true);
  return {
    indexes: desiredIndexKeys({
      ...indexArgs(ctx, type, namespace),
      ...(table !== undefined ? { table } : {})
    }),
    ...(def.expectedSize !== undefined ? { expectedSize: def.expectedSize } : {})
  };
}

/**
 * See `Dataset.dropEngineIndex`. Checks and drops under the table's index
 * build lock, so a reconcile cannot rebuild or swap the index in between.
 * Ownership is the reconciler's marker and generated name on an index of
 * this type (`typeIndexesOf`); the wanted set is the reconciler's own
 * (`desiredIndexKeys`), so only a leftover or a retracted declaration goes.
 * Refuses with `IndexDropRefusedError`.
 *
 * The drop waits for every transaction holding a lock on the table, and pg
 * cannot see a cycle through a caller that waits on this call, so each wait
 * is bounded by `lockTimeoutMs` (default `DROP_LOCK_TIMEOUT_MS`).
 */
export async function dropEngineIndex(
  ctx: PgContext,
  type: string,
  name: string,
  opts: { beforeDrop?: () => Promise<void>; lockTimeoutMs?: number } = {}
): Promise<void> {
  const layout = await ctx.layout();
  if (ctx.inTx) {
    throw new Error('PgDataset.dropEngineIndex cannot be called on a tx-bound instance');
  }
  const where = `${ctx.namespace}/${type}`;
  if (layout === 'absent') {
    throw new IndexDropRefusedError('unknown_index', `no index ${name} on ${where}`);
  }
  const sql = ctx.sql as Sql;
  const find = async () =>
    (await typeIndexesOf(sql, ctx.namespace, type)).find((i) => i.name === name);
  const seen = await find();
  if (seen === undefined) {
    throw new IndexDropRefusedError('unknown_index', `no index ${name} on ${where}`);
  }
  const conn = await sql.reserve();
  try {
    await withTableIndexLock(sql, conn, seen.table, undefined, async () => {
      // Again under the lock: a reconcile may have swapped or rebuilt it.
      const index = await find();
      if (index === undefined) {
        throw new IndexDropRefusedError('unknown_index', `no index ${name} on ${where}`);
      }
      if (!index.engineOwned) {
        throw new IndexDropRefusedError(
          'not_engine_owned',
          `index ${name} on ${where} was not created by substrate; drop it by hand if it must go`
        );
      }
      if (index.unique) {
        throw new IndexDropRefusedError(
          'unique_index',
          `index ${name} on ${where} is unique; retract its declaration instead`
        );
      }
      // Without a lookup the wanted set is unknown, so nothing is a leftover;
      // a type the lookup does not know is registered nowhere, so all of its
      // indexes are orphans and none is wanted.
      const lookup = ctx.typeDefLookup;
      const orphan = lookup !== null && lookup(type, ctx.namespace) === undefined;
      const desired =
        lookup === null ||
        (!orphan &&
          (name.endsWith('_base') ||
            desiredIndexKeys(indexArgs(ctx, type, ctx.namespace)).some((d) => d.name === name)));
      if (desired) {
        throw new IndexDropRefusedError(
          'still_desired',
          `index ${name} on ${where} is one the engine builds for this type; dropping it would only rebuild it`
        );
      }
      await opts.beforeDrop?.();
      await dropIndexBounded(conn, name, where, opts.lockTimeoutMs ?? DROP_LOCK_TIMEOUT_MS);
    });
  } finally {
    conn.release();
  }
}

/**
 * See `Dataset.dropNamespaceIndexes`. The engine-owned indexes on this
 * namespace's type tables, which a namespace drop empties but keeps. Unique
 * ones only when `opts.unique`.
 * Each table's under its index-build lock, CONCURRENTLY; the wait for that
 * lock and each lock wait of a drop are bounded by `lockTimeoutMs` (default
 * `DROP_LOCK_TIMEOUT_MS`), past which it throws `index_drop_timeout`.
 */
export async function dropNamespaceIndexes(
  ctx: PgContext,
  opts: { unique?: boolean; lockTimeoutMs?: number } = {}
): Promise<string[]> {
  if ((await ctx.layout()) === 'absent') return [];
  if (ctx.inTx) {
    throw new Error('PgDataset.dropNamespaceIndexes cannot be called on a tx-bound instance');
  }
  const sql = ctx.sql as Sql;
  const ns = ctx.namespace;
  const tables = (
    await sql<Array<{ table_name: string }>>`
      SELECT table_name FROM substrate_type_tables WHERE namespace = ${ns}`
  ).map((t) => t.table_name);
  const timeout = opts.lockTimeoutMs ?? DROP_LOCK_TIMEOUT_MS;
  const dropped: string[] = [];
  const conn = await sql.reserve();
  try {
    for (const table of tables) {
      try {
        await withTableIndexLock(sql, conn, table, AbortSignal.timeout(timeout), async () => {
          for (const i of await heldIndexes(conn, [table])) {
            if (!isEngineOwned(i) || (i.unique && opts.unique !== true)) continue;
            await dropIndexBounded(conn, i.name, ns, timeout);
            dropped.push(i.name);
          }
        });
      } catch (err) {
        if (!(err instanceof IndexLockAborted)) throw err;
        throw new IndexDropRefusedError(
          'index_drop_timeout',
          `the index-build lock of ${table} stayed held for over ${timeout} ms; indexes of ${ns} left in place`
        );
      }
    }
  } finally {
    conn.release();
  }
  return dropped;
}

/** See `Dataset.indexDeclarationOf`. */
export async function indexDeclarationOf(
  ctx: PgContext,
  type: string,
  name: string
): Promise<IndexDecl | undefined> {
  if ((await ctx.layout()) === 'absent') return undefined;
  const args = indexArgs(ctx, type, ctx.namespace);
  const others = new Set(desiredIndexKeys({ ...args, indexes: [] }).map((d) => d.name));
  return args.indexes.find((decl) =>
    desiredIndexKeys({ ...args, indexes: [decl] }).some(
      (d) => d.name === name && !others.has(d.name)
    )
  );
}

/**
 * See `Dataset.typeStats`. Spans every namespace of the database, in a fixed
 * number of queries: each type table's own statistics; `liveRows` is
 * `reltuples` (or `n_live_tup` before the first ANALYZE) and counts
 * tombstoned rows too.
 */
export async function typeStats(ctx: PgContext): Promise<TypeStats[]> {
  if ((await ctx.layout()) === 'absent') return [];
  const sql = ctx.sql as Sql;
  const toStats = (
    t: {
      namespace: string;
      type: string;
      table: string;
      liveRows: number;
      insertsTotal: number;
      updatesTotal: number;
      deletesTotal: number;
    },
    held: Awaited<ReturnType<typeof heldIndexes>>
  ): TypeStats => ({
    namespace: t.namespace,
    type: t.type,
    liveRows: Math.round(t.liveRows),
    insertsTotal: Math.round(t.insertsTotal),
    updatesTotal: Math.round(t.updatesTotal),
    deletesTotal: Math.round(t.deletesTotal),
    indexes: held
      .filter((i) => i.table === t.table)
      .map((i) => ({
        name: i.name,
        scans: i.scans,
        lastScanAt: i.lastScanAt,
        sizeBytes: i.sizeBytes,
        unique: i.unique,
        engineOwned: isEngineOwned(i)
      }))
  });
  const tables = await sql<
    Array<{
      namespace: string;
      type: string;
      table: string;
      liveRows: number;
      insertsTotal: number;
      updatesTotal: number;
      deletesTotal: number;
    }>
  >`
    SELECT t.namespace, t.type, t.table_name AS "table",
           (CASE WHEN c.reltuples >= 0 THEN c.reltuples ELSE COALESCE(s.n_live_tup, 0) END)::float8
             AS "liveRows",
           COALESCE(s.n_tup_ins, 0)::float8 AS "insertsTotal",
           COALESCE(s.n_tup_upd, 0)::float8 AS "updatesTotal",
           COALESCE(s.n_tup_del, 0)::float8 AS "deletesTotal"
    FROM substrate_type_tables t
    JOIN pg_class c ON c.relname = t.table_name AND c.relnamespace = current_schema()::regnamespace
    LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid`;
  const held = await heldIndexes(
    sql,
    tables.map((t) => t.table)
  );
  return tables.map((t) => toStats(t, held));
}

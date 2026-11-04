/**
 * Builds a type's indexes and keeps them matching their declaration.
 *
 * The desired set is a derived btree per crossRef (unless `indexed: false`)
 * and per `indexed: true` scalar, keyed (field, natural-order key, id), the
 * declared `indexes`, GIN `jsonb_path_ops` for `indexed: true` list and json
 * fields, and the engine's timestamp and tombstone indexes. All are on the
 * type's table, where a column field keys on its column.
 *
 * Each desired index is compared, by name, with what the catalog holds:
 * identical is kept; same table, uniqueness and key fields but a different
 * expression or predicate is swapped (built under a temporary name, the old one
 * dropped only once the new one is valid and ready, then renamed, so a unique
 * index is enforced throughout); anything else is refused. Definitions are
 * compared as pg deparses them: the desired ones are deparsed by building them
 * on an empty temp table first.
 *
 *
 * Builds run CONCURRENTLY, so never inside a transaction, and each under its
 * table's index-build lock, since two concurrent builds on one table deadlock.
 * A unique one is chosen under the migration lock, which serialises the choice
 * with migrations and other boots, but released before its duplicate check and
 * build; no build holds the migration lock, so a long build never holds up a
 * booting process. What still meets a build, unique or not, is DDL on
 * its table outside these locks: a kernel migration's ALTER or non-concurrent
 * CREATE INDEX on a type table waits for the build, and can deadlock with it, in
 * which case Postgres aborts one with 40P01 (a failed build is retried by the
 * next reconcile; a failed migration fails that boot).
 */

import { createHash } from 'node:crypto';
import type { FieldDef, IndexDecl, OrderedBy } from '@mnmal-ai/substrate-types';
import type { ReservedSql, Sql } from 'postgres';
import type { DiskGuard } from './disk-guard.js';
import { columnName, hashedName, ident, MAX_IDENTIFIER } from './layout.js';
import {
  abortableSleep,
  dropIndexIfInvalid,
  generatedIdentifier,
  IndexLockAborted,
  withMigrationLock,
  withTableIndexLock
} from './migrate.js';
import { indexExpressionSql, sqlStringLiteral } from './pg-sql/primitives.js';
import { columnKindOf, loadTypeTable, type TypeTable, typeTableOf } from './type-table.js';

export interface IndexState {
  name: string;
  fields: string[];
  unique: boolean;
  state: 'valid' | 'building' | 'pending' | 'invalid' | 'failed';
  outcome: 'created' | 'adopted' | 'swapped' | 'unchanged';
  /** Why a `failed` index failed: an error code, then a short reason. */
  error?: string;
  /** Why a `pending` index was not built: the disk guard refused it. */
  reason?: 'insufficient_disk';
}

/** A unique index was declared over values that are already duplicated among live rows. */
export class UniqueIndexDuplicatesError extends Error {
  readonly code = 'unique_index_duplicates';
  constructor(
    readonly namespace: string,
    readonly type: string,
    readonly fields: string[],
    readonly count: number,
    /** The declared index's name. */
    readonly index?: string
  ) {
    super(
      `unique index on ${namespace}/${type} (${fields.join(', ')}) was not built: ` +
        `${count} value(s) are held by more than one live row. Resolve them, then restart.`
    );
    this.name = 'UniqueIndexDuplicatesError';
  }
}

/** An index of the declared name exists with a definition the reconciler may not replace. */
export class IndexDefinitionConflictError extends Error {
  readonly code = 'index_definition_conflict';
  constructor(
    readonly indexName: string,
    readonly existing: string,
    readonly declared: string
  ) {
    super(
      `index ${indexName} exists with a different definition.\n  existing: ${existing}\n  declared: ${declared}`
    );
    this.name = 'IndexDefinitionConflictError';
  }
}

/** `PgDataset.dropEngineIndex` refused, and dropped nothing. */
export class IndexDropRefusedError extends Error {
  constructor(
    readonly code:
      | 'unknown_index'
      | 'not_engine_owned'
      | 'unique_index'
      | 'still_desired'
      | 'index_drop_timeout',
    message: string
  ) {
    super(message);
    this.name = 'IndexDropRefusedError';
  }
}

export interface ReconcileTypeIndexesArgs {
  namespace: string;
  type: string;
  fields: Record<string, FieldDef>;
  indexes: IndexDecl[];
  /** The type's natural order, which every derived index carries after its field. */
  orderedBy: OrderedBy;
  /** `'visible'` adds the `(seq, id)` index that serves reads in commit order. */
  ordering?: 'visible';
  /**
   * The type's table as the catalog records it. An index that
   * reads a field not in `column` state is then reported `pending`, and is not
   * among `desiredIndexKeys`: reads of such a field go through `extra` (or are
   * all in it), which the index cannot see.
   */
  table?: TypeTable;
}

interface Spec {
  name: string;
  fields: string[];
  unique: boolean;
  /** Everything after `ON <table> `: method, key columns, predicate. */
  tail: string;
  /** Key expressions, for the duplicate count. */
  keys: string[];
  predicate: string;
  /** A derived index, whose natural-order key may change and still swap. */
  derived?: true;
  /** The keys a read can use, by field name (metadata columns by their read name), in order. */
  order: Array<[string, 'asc' | 'desc']>;
  /** A declared `where` beyond `live`: the read must `eq` each field to its value. */
  only?: Record<string, boolean | null>;
  /** The type-table columns it reads: it waits, `pending`, while one is missing. */
  columns?: string[];
}

export interface ReconcileOptions {
  /**
   * Which indexes to reconcile. `unique` leaves the non-unique ones alone, reporting each non-unique index `valid` when the
   * catalog already holds it as declared and `pending` otherwise; `nonUnique`
   * is the rest. Default `all`.
   */
  only?: 'all' | 'unique' | 'nonUnique';
  /** Called with an index's name as its build starts. */
  onBuild?: (name: string) => void;
  /** Called with each non-unique index's state as soon as it is reconciled. */
  onState?: (state: IndexState) => void;
  /**
   * Cancels the non-unique work: a lock wait or an in-flight build, which
   * leaves an INVALID index the next reconcile drops. The rest is skipped.
   */
  signal?: AbortSignal;
  /** Checked before each non-unique build; a refusal leaves the index `pending` for the next pass. */
  diskGuard?: DiskGuard;
}

/**
 * The last failure logged per index, so a retry pass that fails the same way
 * stays quiet. shortcut: keyed by index name across schemas, process-wide.
 */
const lastLogged = new Map<string, string>();

/** Writes `text` unless `key` is what was last logged for index `name`. */
function logChanged(name: string, key: string, text: string): void {
  if (lastLogged.get(name) === key) return;
  lastLogged.set(name, key);
  process.stderr.write(text);
}

/** Pause after a non-unique build releases its table lock, so a polling waiter gets it. */
const YIELD_MS = 300;

/** Marks an index this reconciler built or adopted. */
const MARK = 'substrate: reconciled';
const BARE_NAME = /^[a-z_][a-z0-9_]*$/;

/**
 * Reconciles the type's indexes and reports each one. The type's table must
 * exist (`ensureTypeStorage`). Must not be called
 * while this session's pool already holds the migration lock on another
 * connection, since it waits for that lock.
 *
 * A unique index that needs work is chosen under the migration lock, which
 * serialises the choice with migrations and other boots, then checked for
 * duplicates and built under its table's index-build lock alone; a type whose
 * unique indexes are all as declared takes no migration lock. Non-unique indexes take
 * only the table's index-build lock (`withTableIndexLock`), one index at a
 * time, so a long build never holds up another process's migrations, nor its
 * unique builds on other tables. An index the catalog already holds as
 * declared takes no lock at all.
 */
export async function reconcileTypeIndexes(
  sql: Sql,
  args: ReconcileTypeIndexesArgs,
  opts: ReconcileOptions = {}
): Promise<IndexState[]> {
  const only = opts.only ?? 'all';
  if (args.table === undefined) {
    const table = await loadTypeTable(sql, args.namespace, args.type);
    if (table !== undefined) args = { ...args, table };
  }
  const all = desiredSpecs(args);
  const out: IndexState[] = [];
  const unique = all.filter((s) => s.unique);
  // The unique pass also reads the non-unique indexes' states, to report them.
  const first = only === 'unique' ? all : only === 'all' ? unique : [];
  if (first.length > 0) {
    const target = await targetTable(sql, args);
    const waiting = await waitingForColumns(sql, target, first);
    // A non-unique index not yet built is pending without being deparsed: its
    // columns may come from a kernel migration, which runs after this pass.
    // The pass reads states only, so it takes no lock.
    const { states, todo } = await reserved(sql, async (conn) => {
      const probed: Spec[] = [];
      for (const spec of first) {
        if (waiting.has(spec.name)) continue;
        if (spec.unique || (await describeIndex(conn, spec.name, 'current')) !== undefined) {
          probed.push(spec);
        }
      }
      const desired = await deparse(conn, probed, ident(target));
      const states: Array<IndexState | undefined> = [];
      const todo: Array<{ at: number; spec: Spec; d: Described }> = [];
      for (const spec of first) {
        const i = probed.indexOf(spec);
        if (i < 0) {
          states.push(indexState(spec, 'pending', 'unchanged'));
          continue;
        }
        const d = desired[i] as Described;
        const held = await heldAsDeclared(conn, target, spec, d);
        if (held === undefined && spec.unique) todo.push({ at: states.length, spec, d });
        states.push(held ?? (spec.unique ? undefined : indexState(spec, 'pending', 'unchanged')));
      }
      return { states, todo };
    });
    // The migration lock only decides what to build, so a build never holds up
    // another process's boot or migrations, nor unique builds on other tables.
    // The duplicate check and the build run under the table's index-build lock,
    // which keeps a second process off the same index: a duplicate a writer
    // adds between them fails the build, and the INVALID index it leaves is
    // dropped by the next reconcile (`reconcileOne`).
    const build =
      todo.length === 0
        ? []
        : await withMigrationLock(sql, async (conn) => {
            const left: typeof todo = [];
            for (const t of todo) {
              const held = await heldAsDeclared(conn, target, t.spec, t.d);
              if (held === undefined) left.push(t);
              else states[t.at] = held;
            }
            return left;
          });
    for (const t of build) {
      states[t.at] = await reserved(sql, (conn) =>
        withTableIndexLock(sql, conn, target, undefined, () =>
          reconcileOne(conn, args, target, t.spec, t.d, {})
        )
      );
    }
    out.push(...first.map((spec, i) => settled(args, spec, states[i] as IndexState)));
  }
  if (only !== 'unique') out.push(...(await reconcileNonUnique(sql, args, all, opts)));
  return out;
}

/** Runs `fn` on a connection reserved from `sql`, released after. */
async function reserved<T>(sql: Sql, fn: (conn: ReservedSql) => Promise<T>): Promise<T> {
  const conn = await sql.reserve();
  try {
    return await fn(conn);
  } finally {
    conn.release();
  }
}

/** Non-unique indexes, each under the table's index-build lock. */
async function reconcileNonUnique(
  sql: Sql,
  args: ReconcileTypeIndexesArgs,
  all: Spec[],
  opts: ReconcileOptions
): Promise<IndexState[]> {
  const specs = all.filter((s) => !s.unique);
  if (specs.length === 0) return [];
  const target = await targetTable(sql, args);
  const waiting = await waitingForColumns(sql, target, specs);
  const buildable = specs.filter((s) => !waiting.has(s.name));
  const conn = await sql.reserve();
  const out: IndexState[] = [];
  try {
    const desired = await deparse(conn, buildable, ident(target));
    for (const spec of specs) {
      if (waiting.has(spec.name)) {
        const state = indexState(spec, 'pending', 'unchanged');
        opts.onState?.(state);
        out.push(state);
        continue;
      }
      const d = desired[buildable.indexOf(spec)] as Described;
      let state = await heldAsDeclared(conn, target, spec, d);
      if (state === undefined) {
        try {
          state = await withTableIndexLock(sql, conn, target, opts.signal, () =>
            reconcileOne(conn, args, target, spec, d, opts)
          );
        } catch (err) {
          if (err instanceof IndexLockAborted) return out;
          // A non-unique index costs only speed, so a conflict fails it alone.
          if (!(err instanceof IndexDefinitionConflictError)) throw err;
          logChanged(spec.name, err.message, `${err.message}\n`);
          state = indexState(spec, 'failed', 'unchanged', conflictReason(err));
        }
        await abortableSleep(YIELD_MS, opts.signal);
      }
      if (state.state === 'valid') lastLogged.delete(spec.name);
      state = settled(args, spec, state);
      opts.onState?.(state);
      out.push(state);
      if (opts.signal?.aborted === true) return out;
    }
    return out;
  } finally {
    conn.release();
  }
}

function indexState(
  spec: Spec,
  state: IndexState['state'],
  outcome: IndexState['outcome'],
  error?: string
): IndexState {
  return {
    name: spec.name,
    fields: spec.fields,
    unique: spec.unique,
    state,
    outcome,
    ...(error !== undefined ? { error } : {})
  };
}

const conflictReason = (err: IndexDefinitionConflictError): string =>
  `${err.code}: ${err.indexName} exists with a different definition; drop or rename it`;

/**
 * `valid`, unchanged, when the catalog holds `spec` exactly as declared,
 * valid, marked, and with no swap leftover: nothing to do, so no lock.
 * Otherwise undefined.
 */
async function heldAsDeclared(
  conn: Sql,
  target: string,
  spec: Spec,
  desired: Described
): Promise<IndexState | undefined> {
  const named = await describeIndex(conn, spec.name, 'current');
  if (
    named === undefined ||
    named.table !== target ||
    named.def !== desired.def ||
    !named.valid ||
    !named.ready ||
    !named.marked
  ) {
    return undefined;
  }
  if ((await describeIndex(conn, swapNameFor(spec.name), 'current')) !== undefined)
    return undefined;
  return indexState(spec, 'valid', 'unchanged');
}

/**
 * Each index the type should have, as the catalog rows `held` (the indexes on
 * its table) show it. Builds nothing and queries nothing. An index `held`
 * lacks is `failed`, as a build that has not succeeded is.
 */
export function describeTypeIndexes(
  args: ReconcileTypeIndexesArgs,
  held: HeldIndex[]
): IndexState[] {
  const byName = new Map(held.map((i) => [i.name, i]));
  return desiredSpecs(args).map((spec) => {
    const held = byName.get(spec.name);
    // Not built while its field is unsettled is waiting, not a failed build.
    const state = held === undefined && unsettled(args, spec) ? 'pending' : stateFrom(held);
    return settled(args, spec, indexState(spec, state, 'unchanged'));
  });
}

/**
 * Whether `spec` reads a field `args.table` records in a state other than
 * `column` (`pending`, `promoting`, `orphaned`): its index, built or not,
 * serves none of that field's reads, and a unique one does not see the
 * field's values still in `extra`. A column the catalog does not record is
 * taken as settled.
 */
function unsettled(args: ReconcileTypeIndexesArgs, spec: Spec): boolean {
  const table = args.table;
  if (table === undefined || spec.columns === undefined) return false;
  const pending = new Set(table.pending.map((f) => columnName(f)));
  const states = new Map(table.columns().map((c) => [c.column, c.state]));
  return spec.columns.some((c) => pending.has(c) || (states.get(c) ?? 'column') !== 'column');
}

/**
 * A `valid` `state` reported `pending` while `spec` is `unsettled`: built, but
 * its field still reads through `extra` (Task 13's sweep settles it).
 */
function settled(args: ReconcileTypeIndexesArgs, spec: Spec, state: IndexState): IndexState {
  return state.state === 'valid' && unsettled(args, spec) ? { ...state, state: 'pending' } : state;
}

/** A catalog index's state; one that is not there is `failed`, as a build that has not succeeded is. */
const stateFrom = (d: { valid: boolean; ready: boolean } | undefined): IndexState['state'] =>
  d === undefined ? 'failed' : d.valid && d.ready ? 'valid' : d.ready ? 'building' : 'invalid';

/**
 * Engine-owned indexes of the type (`held`: its indexes, by `belongsToType`)
 * that its declaration no longer asks for. They are reported, never dropped:
 * removing an index is the operator's call.
 */
export function undeclaredIndexes(args: ReconcileTypeIndexesArgs, held: HeldIndex[]): string[] {
  const desired = new Set(desiredSpecs(args).map((s) => s.name));
  return held
    .filter((i) => isEngineOwned(i) && !desired.has(i.name))
    .map((i) => i.name)
    .sort();
}

/** Each index that serves the type's reads, with the keys a read can use, in order. */
export function desiredIndexKeys(args: ReconcileTypeIndexesArgs): Array<{
  name: string;
  keys: Array<[string, 'asc' | 'desc']>;
  unique: boolean;
  only?: Record<string, boolean | null>;
}> {
  // An index over an unsettled field serves none of its reads (`args.table`).
  return desiredSpecs(args)
    .filter((s) => !unsettled(args, s))
    .map((s) => ({
      name: s.name,
      keys: s.order,
      unique: s.unique,
      ...(s.only !== undefined ? { only: s.only } : {})
    }));
}

/** An index on the table a type's rows live in, with its usage statistics. */
export interface HeldIndex {
  table: string;
  name: string;
  unique: boolean;
  /** Carries the reconciler's comment marker. */
  marked: boolean;
  valid: boolean;
  ready: boolean;
  /** `pg_get_expr` of the predicate, or null for a full index. */
  predicate: string | null;
  /** The index's `pg_class.reltuples`: for a partial index, the rows under its predicate; -1 unknown. */
  reltuples: number;
  scans: number;
  /** `pg_stat_user_indexes.last_idx_scan` (ISO), null when never scanned since the last reset. */
  lastScanAt: string | null;
  sizeBytes: number;
}

/** Every index on `tables` (current schema), with its scan count and size. */
export async function heldIndexes(sql: Sql, tables: string[]): Promise<HeldIndex[]> {
  return sql<HeldIndex[]>`
    SELECT t.relname AS "table", c.relname AS name, i.indisunique AS "unique",
           obj_description(i.indexrelid, 'pg_class') IS NOT DISTINCT FROM ${MARK} AS marked,
           i.indisvalid AS valid, i.indisready AS ready,
           pg_get_expr(i.indpred, i.indrelid) AS predicate,
           c.reltuples::float8 AS reltuples,
           COALESCE(s.idx_scan, 0)::float8 AS scans,
           to_char(s.last_idx_scan AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "lastScanAt",
           pg_relation_size(i.indexrelid)::float8 AS "sizeBytes"
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
    JOIN pg_class t ON t.oid = i.indrelid
    LEFT JOIN pg_stat_user_indexes s ON s.indexrelid = i.indexrelid
    WHERE t.relnamespace = current_schema()::regnamespace AND t.relname = ANY(${tables})
    ORDER BY c.relname`;
}

/** The name tail `generatedIdentifier` gives every engine index, whatever truncated its head. */
const ENGINE_SUFFIX = /_[0-9a-f]{8}_(idx|uniq|gin|base)$/;

/** Built or adopted by the reconciler: its comment marker and an engine-generated name. */
export const isEngineOwned = (index: HeldIndex): boolean =>
  index.marked && ENGINE_SUFFIX.test(index.name);

/**
 * Every index on `namespace`/`type`'s table, each flagged whether the engine
 * owns it. `[]` when the type has no table yet.
 */
export async function typeIndexesOf(
  sql: Sql,
  namespace: string,
  type: string
): Promise<Array<HeldIndex & { engineOwned: boolean }>> {
  const table = await typeTableOf(sql, namespace, type);
  if (table === undefined) return [];
  return (await heldIndexes(sql, [table])).map((i) => ({ ...i, engineOwned: isEngineOwned(i) }));
}

async function targetTable(sql: Sql, args: ReconcileTypeIndexesArgs): Promise<string> {
  const table = await typeTableOf(sql, args.namespace, args.type);
  if (table === undefined) {
    throw new Error(
      `${args.namespace}/${args.type} has no table; call ensureTypeStorage before reconciling its indexes`
    );
  }
  return table;
}

/**
 * The names of `specs` reading a column `target` lacks: a `pending` field's,
 * until the promotion sweep adds it.
 */
async function waitingForColumns(sql: Sql, target: string, specs: Spec[]): Promise<Set<string>> {
  if (!specs.some((s) => (s.columns ?? []).length > 0)) return new Set();
  const held = new Set(
    (
      await sql<Array<{ name: string }>>`
        SELECT attname AS name FROM pg_attribute
        WHERE attrelid = to_regclass(${ident(target)}) AND attnum > 0 AND NOT attisdropped`
    ).map((r) => r.name)
  );
  return new Set(
    specs.filter((s) => (s.columns ?? []).some((c) => !held.has(c))).map((s) => s.name)
  );
}

/** The column a declared column field keys and filters on; else undefined. */
function typedColumn(field: string, def: FieldDef | undefined): string | undefined {
  return def !== undefined && columnKindOf(def) !== undefined ? columnName(field) : undefined;
}

/** Metadata columns an index may key on, by the name reads use: plain columns, as natural order keys them. */
const METADATA_COLUMNS: Readonly<Record<string, string>> = {
  createdAt: 'created_at',
  updatedAt: 'updated_at',
  seq: 'seq'
};

// The metadata column shadows a body field of the same name, in orderBy and where alike.
const metadataColumn = (field: string): string | undefined =>
  Object.hasOwn(METADATA_COLUMNS, field) ? METADATA_COLUMNS[field] : undefined;

function keyExpr(field: string, def: FieldDef | undefined): string {
  const column = metadataColumn(field);
  if (column !== undefined) return column;
  // Whatever the field's state: a `promoting` one reads through `extraWins`,
  // which this index serves once the sweep has made it `column`. Text and
  // enum columns are "C" already.
  const typed = typedColumn(field, def);
  if (typed !== undefined) return ident(typed);
  if (def?.kind === 'crossRef') return indexExpressionSql('text', field, undefined, 'extra');
  if (def?.kind === 'scalar' && def.type !== 'json') {
    return indexExpressionSql(
      def.type === 'number' ? 'number' : def.type === 'date' ? 'date' : 'text',
      field,
      undefined,
      'extra'
    );
  }
  throw new Error(
    `field '${field}' is not a declared scalar or crossRef field and cannot be indexed`
  );
}

function desiredSpecs(args: ReconcileTypeIndexesArgs): Spec[] {
  const { namespace, type, fields } = args;
  /** The type-table columns `names` read. */
  const columnsOf = (names: string[]): string[] =>
    names.flatMap((f) => typedColumn(f, fields[f]) ?? []);
  const live = 'deleted_at IS NULL';
  const specs: Spec[] = [];
  // A non-unique btree ends with `id`, so it serves the `id` that ends every
  // ORDER BY as well as the filter. `withoutId` leaves it out, for name hashing.
  // `natural` is a derived index's natural-order key, after the declared ones.
  const btree = (
    decl: IndexDecl,
    name: string,
    withoutId = false,
    natural?: string,
    naturalKey?: [string, 'asc' | 'desc']
  ): Spec => {
    const cols = decl.fields.map((f) => (typeof f === 'string' ? { field: f, dir: 'asc' } : f));
    const keys = cols.map((c) => keyExpr(c.field, fields[c.field]));
    const reads = columnsOf(
      cols.map((c) => c.field).filter((f) => metadataColumn(f) === undefined)
    );
    let predicate = live;
    if (decl.where !== undefined && decl.where !== 'live') {
      reads.push(...columnsOf(Object.keys(decl.where)));
      // Exactly the compiler's `eq` for a boolean or null operand, which it inlines.
      for (const [f, v] of Object.entries(decl.where)) {
        const typed = typedColumn(f, fields[f]);
        const column = typed !== undefined ? ident(typed) : undefined;
        if (v !== null && typeof v !== 'boolean') {
          throw new Error(`index predicate on '${f}' must be a boolean or null`);
        }
        const def = fields[f];
        const isBoolean = def?.kind === 'scalar' && def.type === 'boolean';
        if (v !== null && !isBoolean) {
          throw new Error(
            `index predicate '${f}: ${v}' compares a boolean, but '${f}' is not a boolean field`
          );
        }
        const lhs = column ?? indexExpressionSql('text', f, undefined, 'extra');
        predicate +=
          v === null
            ? ` AND ${lhs} IS NULL`
            : column !== undefined
              ? ` AND ${column} = ${v ? 'TRUE' : 'FALSE'}`
              : ` AND ${lhs} = ${v ? "'true'" : "'false'"}`;
      }
    }
    const colSql = keys.map((k, i) => `(${k})${cols[i]?.dir === 'desc' ? ' DESC NULLS LAST' : ''}`);
    if (natural !== undefined) colSql.push(natural);
    if (naturalKey !== undefined && metadataColumn(naturalKey[0]) === undefined) {
      reads.push(...columnsOf([naturalKey[0]]));
    }
    if (decl.unique !== true && !withoutId) colSql.push('id');
    return {
      name,
      fields: cols.map((c) => c.field),
      unique: decl.unique === true,
      tail: `USING btree (${colSql.join(', ')}) WHERE ${predicate}`,
      keys,
      predicate,
      ...(decl.where !== undefined && decl.where !== 'live' ? { only: { ...decl.where } } : {}),
      ...(reads.length > 0 ? { columns: [...new Set(reads)] } : {}),
      order: [
        ...cols.map((c): [string, 'asc' | 'desc'] => [c.field, c.dir === 'desc' ? 'desc' : 'asc']),
        ...(naturalKey !== undefined ? [naturalKey] : [])
      ]
    };
  };

  // A derived btree is (field, natural key, id), so a filter on the field
  // reads in natural order with no Sort; on the natural-order field itself it
  // is (field DIR, id).
  const [natField, natDir] = Object.entries(args.orderedBy)[0] ?? ['createdAt', 'desc'];
  const natKey = metadataColumn(natField) ?? `(${keyExpr(natField, fields[natField])})`;
  const natural = `${natKey}${natDir === 'desc' ? ' DESC NULLS LAST' : ''}`;
  for (const [field, def] of Object.entries(fields)) {
    const wanted =
      def.kind === 'crossRef'
        ? def.indexed !== false
        : def.kind === 'scalar' && def.type !== 'json' && def.indexed === true;
    if (!wanted) continue;
    const own = field === natField;
    specs.push({
      ...btree(
        { fields: [{ field, dir: own ? natDir : 'asc' }] },
        generatedIdentifier(namespace, type, field, 'idx'),
        false,
        own ? undefined : natural,
        own ? undefined : [natField, natDir]
      ),
      derived: true
    });
  }
  for (const [field, def] of Object.entries(fields)) {
    if (def.kind === 'struct' || def.indexed !== true) continue;
    if (def.kind === 'list' || (def.kind === 'scalar' && def.type === 'json')) {
      specs.push({
        name: generatedIdentifier(namespace, type, field, 'gin'),
        fields: [field],
        unique: false,
        tail: `USING gin ((extra -> ${sqlStringLiteral(field)}) jsonb_path_ops) WHERE ${live}`,
        keys: [],
        predicate: live,
        order: []
      });
    }
  }
  const base = (column: string, tail: string, order: Spec['order'] = []): Spec => ({
    name: generatedIdentifier(namespace, type, column, 'base'),
    fields: [],
    unique: false,
    tail,
    keys: [],
    predicate: live,
    order
  });
  specs.push(
    base('created_at', `USING btree (created_at DESC NULLS LAST, id) WHERE ${live}`, [
      ['createdAt', 'desc']
    ]),
    base('updated_at', `USING btree (updated_at DESC NULLS LAST, id) WHERE ${live}`, [
      ['updatedAt', 'desc']
    ]),
    base('deleted_at', 'USING btree (deleted_at) WHERE deleted_at IS NOT NULL')
  );
  if (args.ordering === 'visible') {
    specs.push({
      name: generatedIdentifier(namespace, type, 'seq', 'base'),
      fields: [],
      unique: false,
      tail: `USING btree (seq, id) WHERE ${live}`,
      keys: [],
      predicate: live,
      order: [['seq', 'asc']]
    });
  }
  for (const decl of args.indexes) {
    // An unnamed, plain one-field declaration on a crossRef is served by its
    // derived index (a crossRef never sorts, so `(f, id)` would add nothing).
    const only = decl.fields.length === 1 ? decl.fields[0] : undefined;
    const onlyField =
      typeof only === 'string' ? only : only?.dir === 'asc' ? only.field : undefined;
    if (
      decl.name === undefined &&
      decl.unique !== true &&
      (decl.where === undefined || decl.where === 'live') &&
      onlyField !== undefined &&
      fields[onlyField]?.kind === 'crossRef' &&
      specs.some((s) => s.derived === true && s.fields[0] === onlyField)
    ) {
      continue;
    }
    const keys = decl.fields.map((f) => (typeof f === 'string' ? f : f.field)).join('_');
    const suffix = decl.unique === true ? 'uniq' : 'idx';
    let name = decl.name ?? generatedIdentifier(namespace, type, keys, suffix);
    if (decl.name === undefined) {
      // An unnamed declaration that differs from the implicit index of the same
      // generated name takes a hash of its own definition, so both are built.
      const spec = btree(decl, name);
      const implicit = specs.find((s) => s.name === name);
      if (implicit !== undefined && createSql(implicit, 'rows') !== createSql(spec, 'rows')) {
        const hash = createHash('sha256')
          .update(`${spec.unique}|${btree(decl, name, true).tail}`)
          .digest('hex')
          .slice(0, 6);
        name = generatedIdentifier(namespace, type, `${keys}_${hash}`, suffix);
      }
    }
    if (!BARE_NAME.test(name) || name.length > MAX_IDENTIFIER) {
      throw new Error(`index name '${name}' must be a lower-snake identifier of at most 63 bytes`);
    }
    specs.push(btree(decl, name));
  }

  // An implicit index and a declaration may describe the same index.
  const byName = new Map<string, Spec>();
  for (const spec of specs) {
    const seen = byName.get(spec.name);
    if (seen === undefined) byName.set(spec.name, spec);
    else if (createSql(seen, 'rows') !== createSql(spec, 'rows')) {
      throw new IndexDefinitionConflictError(
        spec.name,
        createSql(seen, 'rows'),
        createSql(spec, 'rows')
      );
    }
  }
  return [...byName.values()];
}

function createSql(spec: Spec, table: string, name = spec.name, concurrently = false): string {
  return (
    `CREATE ${spec.unique ? 'UNIQUE ' : ''}INDEX ${concurrently ? 'CONCURRENTLY ' : ''}` +
    `${name} ON ${ident(table)} ${spec.tail}`
  );
}

interface Described {
  /** `pg_get_indexdef` without the index name and table. */
  def: string;
  table: string;
  unique: boolean;
  valid: boolean;
  ready: boolean;
  predicate: string | null;
  /** Per key column, the body field names it reads (or its text, e.g. a column name, when it reads none). */
  keyFields: string[];
  marked: boolean;
}

interface CatalogRow {
  def: string;
  table: string;
  unique: boolean;
  valid: boolean;
  ready: boolean;
  predicate: string | null;
  cols: string[];
  comment: string | null;
}

function described(row: CatalogRow): Described {
  return {
    def: row.def.replace(/^(CREATE (?:UNIQUE )?INDEX) \S+ ON \S+ /, '$1 '),
    table: row.table,
    unique: row.unique,
    valid: row.valid,
    ready: row.ready,
    predicate: row.predicate,
    keyFields: row.cols.map((c) => {
      const lits = [...c.matchAll(/->>? '((?:[^']|'')*)'::text/g)].map((m) =>
        (m[1] as string).replace(/''/g, "'")
      );
      return lits.length > 0 ? lits.join(' ') : c;
    }),
    marked: row.comment === MARK
  };
}

async function describeIndex(
  sql: Sql,
  name: string,
  schema: 'current' | 'temp'
): Promise<Described | undefined> {
  const [row] = await sql<CatalogRow[]>`
    SELECT pg_get_indexdef(i.indexrelid) AS def, t.relname AS table,
           i.indisunique AS unique, i.indisvalid AS valid, i.indisready AS ready,
           pg_get_expr(i.indpred, i.indrelid) AS predicate,
           ARRAY(SELECT pg_get_indexdef(i.indexrelid, k, true)
                 FROM generate_series(1, i.indnkeyatts) k ORDER BY k) AS cols,
           obj_description(i.indexrelid, 'pg_class') AS comment
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
    JOIN pg_class t ON t.oid = i.indrelid
    WHERE c.relname = ${name}
      AND c.relnamespace = ${schema === 'temp' ? sql`pg_my_temp_schema()` : sql`current_schema()::regnamespace`}`;
  return row === undefined ? undefined : described(row);
}

/** Each spec as pg deparses it, built on an empty temp copy of `like` and rolled back. */
async function deparse(conn: Sql, specs: Spec[], like: string): Promise<Described[]> {
  await conn.unsafe('BEGIN');
  try {
    await conn.unsafe(`CREATE TEMP TABLE substrate_index_probe (LIKE ${like})`);
    const out: Described[] = [];
    for (const [i, spec] of specs.entries()) {
      const name = `substrate_index_probe_${i}`;
      await conn.unsafe(createSql(spec, 'substrate_index_probe', name));
      out.push((await describeIndex(conn, name, 'temp')) as Described);
    }
    return out;
  } finally {
    await conn.unsafe('ROLLBACK');
  }
}

/** `<name>__swap`, hashed to fit 63 bytes when needed. */
function swapNameFor(name: string): string {
  const plain = `${name}__swap`;
  if (plain.length <= MAX_IDENTIFIER) return plain;
  return `${hashedName(name, name, MAX_IDENTIFIER - '__swap'.length)}__swap`;
}

async function stateOf(conn: Sql, name: string): Promise<IndexState['state']> {
  return stateFrom(await describeIndex(conn, name, 'current'));
}

async function reconcileOne(
  conn: Sql,
  args: ReconcileTypeIndexesArgs,
  target: string,
  spec: Spec,
  desired: Described,
  opts: ReconcileOptions
): Promise<IndexState> {
  const report = (state: IndexState['state'], outcome: IndexState['outcome']): IndexState =>
    indexState(spec, state, outcome);
  // Only a non-unique index's work is cancelled; a unique one must finish.
  const signal = spec.unique ? undefined : opts.signal;
  const swapName = swapNameFor(spec.name);
  // A failed concurrent build leaves an INVALID index, never to be adopted.
  await dropIndexIfInvalid(conn, spec.name);
  await dropIndexIfInvalid(conn, swapName);

  const named = await describeIndex(conn, spec.name, 'current');
  const leftover = await describeIndex(conn, swapName, 'current');
  const identical = (d: Described | undefined): boolean =>
    d !== undefined && d.table === target && d.def === desired.def;

  if (identical(named)) {
    // `named` enforces what is declared, so a leftover is redundant.
    if (leftover !== undefined) await dropConcurrently(conn, swapName, signal);
    if (named?.marked === true) return report('valid', 'unchanged');
    await mark(conn, spec.name);
    return report('valid', 'adopted');
  }

  // A valid __swap with no index under the name is what an interrupted swap
  // leaves, and it may be the only thing enforcing uniqueness, so it counts as
  // the existing index and is dropped only once its replacement is valid.
  const existing = named ?? leftover;
  if (existing === undefined) {
    const built = await build(conn, args, target, spec, spec.name, opts);
    if (built !== undefined) return built;
    await mark(conn, spec.name);
    return report(await stateOf(conn, spec.name), 'created');
  }

  // Key columns are identified by field name, so an `extra`-keyed index on a
  // field that has its column since swaps onto the column rather than
  // conflicting. A non-unique index's trailing `id` is not part of the
  // identity, so one without it swaps.
  const fieldOf = new Map(
    Object.entries(args.fields).flatMap(([field, def]): Array<[string, string]> => {
      const typed = typedColumn(field, def);
      return typed === undefined ? [] : [[typed, field]];
    })
  );
  const keyIdentity = (d: Described): string[] => {
    const keys = d.keyFields.map((k) => fieldOf.get(k) ?? k);
    if (!d.unique && keys.length > 1 && keys.at(-1) === 'id') keys.pop();
    return keys;
  };
  // A derived index is identified by its field alone, so a change of natural
  // order (or the shape before it carried one) swaps rather than conflicting.
  const have = keyIdentity(existing);
  const want = keyIdentity(desired);
  const n = spec.fields.length;
  const sameKeys =
    spec.derived === true
      ? have.length <= n + 1 && have.slice(0, n).join('\n') === want.slice(0, n).join('\n')
      : have.join('\n') === want.join('\n');
  // Swappable when only the expression text or the predicate differs.
  if (!(existing.table === target && existing.unique === desired.unique && sameKeys)) {
    throw new IndexDefinitionConflictError(
      spec.name,
      existing.def.replace(
        /^(CREATE (?:UNIQUE )?INDEX) /,
        `$1 ${named === undefined ? swapName : spec.name} ON ${existing.table} `
      ),
      createSql(spec, target)
    );
  }

  if (named === undefined) {
    if (identical(leftover)) {
      await conn.unsafe(`ALTER INDEX ${swapName} RENAME TO ${spec.name}`);
    } else {
      const built = await build(conn, args, target, spec, spec.name, opts);
      if (built !== undefined) return built;
      await dropConcurrently(conn, swapName, signal);
    }
    await mark(conn, spec.name);
    return report(await stateOf(conn, spec.name), 'swapped');
  }

  // A leftover identical to the declaration was built by an earlier run that
  // stopped before the drop. It is valid and ready: an invalid one was dropped
  // above, and no build can be in flight under this table's index-build lock.
  if (!identical(leftover)) {
    // `named` keeps enforcing while the stale leftover goes.
    if (leftover !== undefined) await dropConcurrently(conn, swapName, signal);
    const built = await build(conn, args, target, spec, swapName, opts);
    if (built !== undefined) return built;
  }
  // A successful CREATE INDEX CONCURRENTLY returns only once the index is
  // valid and ready, so the old one can go.
  await dropConcurrently(conn, spec.name, signal);
  await conn.unsafe(`ALTER INDEX ${swapName} RENAME TO ${spec.name}`);
  await mark(conn, spec.name);
  return report(await stateOf(conn, spec.name), 'swapped');
}

/**
 * Builds `spec` as `name` CONCURRENTLY, refusing a unique one over duplicate
 * live values. Returns `failed` when a non-unique build fails or is cancelled
 * through `opts.signal`, which costs only a scan until the next reconcile
 * drops the INVALID leftover and retries it, and `pending` when the disk
 * guard refuses it; a unique one throws.
 */
async function build(
  conn: Sql,
  args: ReconcileTypeIndexesArgs,
  target: string,
  spec: Spec,
  name: string,
  opts: ReconcileOptions
): Promise<IndexState | undefined> {
  if (spec.unique) await assertNoDuplicates(conn, args, target, spec);
  if (!spec.unique && opts.diskGuard !== undefined) {
    const need = await buildEstimate(conn, target, spec.name);
    const verdict = await opts.diskGuard.check(need);
    if (!verdict.ok) {
      logChanged(
        spec.name,
        'insufficient_disk',
        `index ${name} on ${target} was not built and will be retried: ${verdict.freeBytes} bytes free, ` +
          `${verdict.needBytes} needed (estimate plus margin)\n`
      );
      return { ...indexState(spec, 'pending', 'unchanged'), reason: 'insufficient_disk' };
    }
  }
  opts.onBuild?.(spec.name);
  // No lock_timeout: CONCURRENTLY takes SHARE UPDATE EXCLUSIVE, which a
  // queued request holds against DDL and VACUUM only, never readers or
  // writers, so waiting stalls nobody; a timeout would only leave an
  // INVALID index behind. The same holds for DROP INDEX CONCURRENTLY and
  // for ALTER INDEX RENAME and COMMENT ON INDEX, which take that lock on
  // the index alone.
  try {
    await cancellable(
      conn,
      createSql(spec, target, name, true),
      spec.unique ? undefined : opts.signal
    );
    return undefined;
  } catch (err) {
    if (spec.unique) throw err;
    const message = err instanceof Error ? err.message : String(err);
    logChanged(
      spec.name,
      `build_failed: ${message}`,
      `index ${name} on ${target} failed to build and will be retried: ${message}\n`
    );
    return indexState(spec, 'failed', 'unchanged', `build_failed: ${message}`);
  }
}

/**
 * The type's non-unique indexes a reconcile would build or swap (not held
 * exactly as declared), each with the disk guard's estimate for its build.
 * Changes nothing; the type's storage must exist.
 */
export async function pendingIndexBuilds(
  sql: Sql,
  args: ReconcileTypeIndexesArgs
): Promise<Array<{ name: string; estimateBytes: number }>> {
  const all = desiredSpecs(args).filter((s) => !s.unique);
  if (all.length === 0) return [];
  const target = await targetTable(sql, args);
  // One that waits for a column cannot be built yet, so it is no build to plan for.
  const waiting = await waitingForColumns(sql, target, all);
  const specs = all.filter((s) => !waiting.has(s.name));
  if (specs.length === 0) return [];
  const conn = await sql.reserve();
  try {
    const desired = await deparse(conn, specs, ident(target));
    const out: Array<{ name: string; estimateBytes: number }> = [];
    for (const [i, spec] of specs.entries()) {
      if ((await heldAsDeclared(conn, target, spec, desired[i] as Described)) !== undefined) {
        continue;
      }
      out.push({ name: spec.name, estimateBytes: await buildEstimate(conn, target, spec.name) });
    }
    return out;
  } finally {
    conn.release();
  }
}

/**
 * Bytes a build of index `name` on `target` may take: the index it replaces (under
 * its name or as a `__swap` leftover), else 30% of the table.
 */
async function buildEstimate(conn: Sql, target: string, name: string): Promise<number> {
  const [row] = await conn<Array<{ n: string }>>`
    SELECT COALESCE(
      pg_relation_size(to_regclass(${name})),
      pg_relation_size(to_regclass(${swapNameFor(name)})),
      (pg_table_size(to_regclass(${ident(target)})) * 0.3)::bigint,
      0)::text AS n`;
  return Number(row?.n ?? 0);
}

/** Runs `text` on `conn`, cancelling it in flight when `signal` aborts. */
async function cancellable(
  conn: Sql,
  text: string,
  signal: AbortSignal | undefined
): Promise<void> {
  const query = conn.unsafe(text);
  // Typed void, but returns the cancel request's promise, which may reject.
  const cancel = (): void => {
    Promise.resolve(query.cancel() as unknown).catch(() => undefined);
  };
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    if (signal?.aborted === true) cancel();
    await query;
  } finally {
    signal?.removeEventListener('abort', cancel);
  }
}

async function dropConcurrently(conn: Sql, name: string, signal?: AbortSignal): Promise<void> {
  await cancellable(conn, `DROP INDEX CONCURRENTLY IF EXISTS ${name}`, signal);
}

async function mark(conn: Sql, name: string): Promise<void> {
  await conn.unsafe(`COMMENT ON INDEX ${name} IS '${MARK}'`);
}

async function assertNoDuplicates(
  conn: Sql,
  args: ReconcileTypeIndexesArgs,
  target: string,
  spec: Spec
): Promise<void> {
  // A row missing any key never conflicts in a unique index, so it is not counted.
  const present = spec.keys.map((k) => ` AND (${k}) IS NOT NULL`).join('');
  const [row] = await conn.unsafe<Array<{ n: number }>>(
    `SELECT count(*)::int AS n FROM (
       SELECT 1 FROM ${ident(target)} WHERE ${spec.predicate}${present}
       GROUP BY ${spec.keys.map((k) => `(${k})`).join(', ')} HAVING count(*) > 1) d`
  );
  const count = row?.n ?? 0;
  if (count > 0)
    throw new UniqueIndexDuplicatesError(args.namespace, args.type, spec.fields, count, spec.name);
}

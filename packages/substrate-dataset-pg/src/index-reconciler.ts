/**
 * Builds a type's indexes and keeps them matching their declaration.
 *
 * The desired set is, in both layouts, a derived btree per crossRef (unless
 * `indexed: false`) and per `indexed: true` scalar, keyed (field, natural-order
 * key, id), and the declared `indexes`. The partitioned layout adds GIN
 * `jsonb_path_ops` for `indexed: true` list and json fields and the engine's
 * timestamp and tombstone indexes. Partitioned indexes are on the type's
 * partition; legacy ones are partial indexes on `rows` scoped to the type.
 *
 * Each desired index is compared, by name, with what the catalog holds:
 * identical is kept; same table, uniqueness and key fields but a different
 * expression or predicate is swapped (built under a temporary name, the old one
 * dropped only once the new one is valid and ready, then renamed, so a unique
 * index is enforced throughout); anything else is refused. Definitions are
 * compared as pg deparses them: the desired ones are deparsed by building them
 * on an empty temp table first.
 *
 * Every index is partial, and the planner ignores a partial index's
 * expression statistics, so each body-keyed key expression also gets an
 * expression statistics object on the same table (`_stat`), marked as this
 * type's. One whose expression is no longer indexed is dropped.
 *
 * Builds run CONCURRENTLY, so never inside a transaction, and each under its
 * table's index-build lock, since two concurrent builds on one table deadlock.
 * Unique ones also hold the migration lock, which serialises them with
 * migrations and other boots; non-unique ones do not, so a long build never
 * holds up a booting process. What still meets a non-unique build is DDL on
 * its table outside these locks: a kernel migration's ALTER or non-concurrent
 * CREATE INDEX on `rows` waits for the build, and can deadlock with it, in
 * which case Postgres aborts one with 40P01 (a failed build is retried by the
 * next reconcile; a failed migration fails that boot).
 */

import { createHash } from 'node:crypto';
import type { FieldDef, IndexDecl, OrderedBy } from '@mnmal-ai/substrate-types';
import type { Sql } from 'postgres';
import { MAX_IDENTIFIER, type StorageLayout } from './layout.js';
import {
  abortableSleep,
  dropIndexIfInvalid,
  generatedIdentifier,
  IndexLockAborted,
  withMigrationLock,
  withTableIndexLock
} from './migrate.js';
import {
  indexExpressionSql,
  type PromotedBodyColumnMap,
  resolvePromotedColumns,
  sqlStringLiteral
} from './pg-sql/primitives.js';
import { findPartition, ident } from './type-storage.js';

export interface IndexState {
  name: string;
  fields: string[];
  unique: boolean;
  state: 'valid' | 'building' | 'pending' | 'invalid' | 'failed';
  outcome: 'created' | 'adopted' | 'swapped' | 'unchanged';
  /** Why a `failed` index failed: an error code, then a short reason. */
  error?: string;
}

/** A unique index was declared over values that are already duplicated among live rows. */
export class UniqueIndexDuplicatesError extends Error {
  readonly code = 'unique_index_duplicates';
  constructor(
    readonly namespace: string,
    readonly type: string,
    readonly fields: string[],
    readonly count: number
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

export interface ReconcileTypeIndexesArgs {
  namespace: string;
  type: string;
  layout: StorageLayout;
  fields: Record<string, FieldDef>;
  indexes: IndexDecl[];
  /** The type's natural order, which every derived index carries after its field. */
  orderedBy: OrderedBy;
  /** The namespace's promoted columns: a promoted field indexes on its column, as the compiler filters on it. */
  promotedColumns?: PromotedBodyColumnMap;
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
}

export interface ReconcileOptions {
  /**
   * Which indexes to reconcile. `unique` leaves the non-unique ones and the
   * statistics objects alone, reporting each non-unique index `valid` when the
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
}

/** Pause after a non-unique build releases its table lock, so a polling waiter gets it. */
const YIELD_MS = 300;

/** Marks an index this reconciler built or adopted. */
const MARK = 'substrate: reconciled';
const BARE_NAME = /^[a-z_][a-z0-9_]*$/;

/**
 * Reconciles the type's indexes and reports each one. On the partitioned layout
 * the type's partition must exist (`ensureTypeStorage`). Must not be called
 * while this session's pool already holds the migration lock on another
 * connection, since it waits for that lock.
 *
 * Unique indexes reconcile under the migration lock, which serialises them
 * with migrations and other boots. Non-unique indexes and statistics take
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
  const all = desiredSpecs(args);
  const out: IndexState[] = [];
  const unique = all.filter((s) => s.unique);
  // The unique pass also reads the non-unique indexes' states, to report them.
  const first = only === 'unique' ? all : only === 'all' ? unique : [];
  if (first.length > 0) {
    const target = await targetTable(sql, args);
    out.push(
      ...(await withMigrationLock(sql, async (conn) => {
        const desired = await deparse(conn, first);
        const states: IndexState[] = [];
        for (const [i, spec] of first.entries()) {
          const d = desired[i] as Described;
          const held = await heldAsDeclared(conn, target, spec, d);
          states.push(
            held !== undefined
              ? held
              : spec.unique
                ? await withTableIndexLock(sql, conn, target, undefined, () =>
                    reconcileOne(conn, args, target, spec, d, {})
                  )
                : indexState(spec, 'pending', 'unchanged')
          );
        }
        return states;
      }))
    );
  }
  if (only !== 'unique') out.push(...(await reconcileNonUnique(sql, args, all, opts)));
  return out;
}

/** Non-unique indexes, then statistics, each under the table's index-build lock. */
async function reconcileNonUnique(
  sql: Sql,
  args: ReconcileTypeIndexesArgs,
  all: Spec[],
  opts: ReconcileOptions
): Promise<IndexState[]> {
  const specs = all.filter((s) => !s.unique);
  if (specs.length === 0 && (await heldStatistics(sql, args).catch(() => [])).length === 0) {
    return [];
  }
  const target = await targetTable(sql, args);
  const conn = await sql.reserve();
  const out: IndexState[] = [];
  try {
    const desired = await deparse(conn, specs);
    for (const [i, spec] of specs.entries()) {
      const d = desired[i] as Described;
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
          process.stderr.write(`${err.message}\n`);
          state = indexState(spec, 'failed', 'unchanged', conflictReason(err));
        }
        await abortableSleep(YIELD_MS, opts.signal);
      }
      opts.onState?.(state);
      out.push(state);
      if (opts.signal?.aborted === true) return out;
    }
    try {
      await withTableIndexLock(sql, conn, target, opts.signal, () =>
        reconcileStatistics(conn, args, target, all, opts.signal)
      );
    } catch (err) {
      if (!(err instanceof IndexLockAborted)) throw err;
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

export interface StatisticsOutcome {
  created: string[];
  dropped: string[];
  analyzed: boolean;
}

/** Reconciles only the type's expression statistics objects, as `reconcileTypeIndexes` does. */
export async function reconcileTypeStatistics(
  sql: Sql,
  args: ReconcileTypeIndexesArgs
): Promise<StatisticsOutcome> {
  const specs = desiredSpecs(args);
  const target = await targetTable(sql, args);
  const conn = await sql.reserve();
  try {
    return await withTableIndexLock(sql, conn, target, undefined, () =>
      reconcileStatistics(conn, args, target, specs)
    );
  } finally {
    conn.release();
  }
}

/** Marks a statistics object as this type's, so another type's never matches. */
const statMark = (args: ReconcileTypeIndexesArgs): string =>
  `substrate: statistics of ${JSON.stringify([args.namespace, args.type])}`;
const STAT_NAME = /_[0-9a-f]{8}_stat$/;

/** One per body-keyed key expression; a promoted column has column statistics already. */
function desiredStatistics(
  args: ReconcileTypeIndexesArgs,
  specs: Array<Pick<Spec, 'fields' | 'keys'>>
): Array<{ name: string; expr: string }> {
  const promoted = args.promotedColumns ?? {};
  const byField = new Map<string, { name: string; expr: string }>();
  for (const spec of specs) {
    for (const [i, expr] of spec.keys.entries()) {
      const field = spec.fields[i] as string;
      if (Object.hasOwn(promoted, field) || byField.has(field)) continue;
      // The expression is in the name, so a changed one is a new object and the old one goes.
      const hash = createHash('sha256').update(expr).digest('hex').slice(0, 6);
      byField.set(field, {
        name: generatedIdentifier(args.namespace, args.type, `${field}_${hash}`, 'stat'),
        expr
      });
    }
  }
  return [...byField.values()];
}

/** The statistics objects marked as this type's, on any table, with the table each is on. */
async function heldStatistics(
  sql: Sql,
  args: ReconcileTypeIndexesArgs
): Promise<Array<{ name: string; table: string }>> {
  const rows = await sql<Array<{ name: string; table: string }>>`
    SELECT s.stxname AS name, t.relname AS table FROM pg_statistic_ext s
    JOIN pg_class t ON t.oid = s.stxrelid
    WHERE s.stxnamespace = current_schema()::regnamespace
      AND obj_description(s.oid, 'pg_statistic_ext') = ${statMark(args)}`;
  return rows.filter((r) => STAT_NAME.test(r.name));
}

async function reconcileStatistics(
  conn: Sql,
  args: ReconcileTypeIndexesArgs,
  target: string,
  specs: Spec[],
  signal?: AbortSignal
): Promise<StatisticsOutcome> {
  const out: StatisticsOutcome = { created: [], dropped: [], analyzed: false };
  // Statistics only steer the planner, so no step here fails the reconcile: a
  // failed one is logged and retried by the next reconcile.
  const attempt = async (what: string, run: () => Promise<unknown>): Promise<boolean> => {
    try {
      await run();
      return true;
    } catch (err) {
      process.stderr.write(
        `statistics ${what} on ${target} failed and will be retried: ` +
          `${err instanceof Error ? err.message : String(err)}\n`
      );
      return false;
    }
  };
  let marked: Array<{ name: string; table: string }> = [];
  // Statistics follow every field index still held, declared or left over
  // (indexes are never dropped here), so estimates hold until it is removed.
  const leftovers: Array<Pick<Spec, 'fields' | 'keys'>> = [];
  const found = await attempt('lookup', async () => {
    marked = await heldStatistics(conn, args);
    const held = new Set((await indexesOn(conn, target)).map((i) => i.name));
    for (const [field, def] of Object.entries(args.fields)) {
      const isBtree = def.kind === 'crossRef' || (def.kind === 'scalar' && def.type !== 'json');
      if (isBtree && held.has(generatedIdentifier(args.namespace, args.type, field, 'idx'))) {
        leftovers.push({
          fields: [field],
          keys: [keyExpr(field, def, args.promotedColumns ?? {})]
        });
      }
    }
  });
  if (!found) return out;
  const desired = desiredStatistics(args, [...specs, ...leftovers]);
  const wanted = new Set(desired.map((d) => d.name));
  const held: string[] = [];
  for (const { name, table } of marked) {
    if (wanted.has(name) && table === target) {
      held.push(name);
      continue;
    }
    if (!BARE_NAME.test(name)) {
      process.stderr.write(
        `statistics ${name} on ${table} is not a generated name; left in place\n`
      );
      continue;
    }
    if (
      await attempt(`${name} drop`, () => conn.unsafe(`DROP STATISTICS IF EXISTS ${ident(name)}`))
    ) {
      out.dropped.push(name);
    }
  }
  // shortcut: on the legacy layout the object is on the shared `rows`, so its
  // statistics cover every type's rows; per-type ones need the partitioned layout.
  for (const { name, expr } of desired) {
    if (held.includes(name)) continue;
    // One transaction, so an object is never left unmarked, which would hide it
    // from the drop above. No IF NOT EXISTS: an object of the name that is not
    // marked as this type's fails here rather than being claimed.
    const created = await attempt(`${name} create`, async () => {
      await conn.unsafe('BEGIN');
      try {
        await conn.unsafe(`CREATE STATISTICS ${ident(name)} ON (${expr}) FROM ${ident(target)}`);
        await conn.unsafe(
          `COMMENT ON STATISTICS ${ident(name)} IS ${sqlStringLiteral(statMark(args))}`
        );
        await conn.unsafe('COMMIT');
      } catch (err) {
        await conn.unsafe('ROLLBACK');
        throw err;
      }
    });
    if (created) out.created.push(name);
  }
  // A new object holds nothing until the table is analysed, and one whose
  // ANALYZE failed still holds nothing (a null `null_frac`; an empty table
  // never fills it, so its cheap ANALYZE repeats until it has rows).
  // shortcut: on legacy each type that gains an object analyses the whole
  // shared `rows` under its index-build lock, up to one sampled ANALYZE per type
  // on the first boot after upgrade; coalesce to one per boot pass if deploy
  // time matters.
  await attempt('analyze', async () => {
    const pending =
      out.created.length > 0 ||
      (held.length > 0 &&
        (
          await conn`
            SELECT 1 FROM pg_stats_ext_exprs
            WHERE statistics_schemaname = current_schema()
              AND statistics_name = ANY(${held}) AND null_frac IS NULL
            LIMIT 1`
        ).length > 0);
    if (!pending) return;
    await cancellable(conn, `ANALYZE ${ident(target)}`, signal);
    out.analyzed = true;
  });
  return out;
}

export interface CatalogIndex {
  name: string;
  valid: boolean;
  ready: boolean;
}

/** The indexes on `table` (current schema). */
export async function indexesOn(sql: Sql, table: string): Promise<CatalogIndex[]> {
  return sql<CatalogIndex[]>`
    SELECT c.relname AS name, i.indisvalid AS valid, i.indisready AS ready
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
    JOIN pg_class t ON t.oid = i.indrelid
    WHERE t.relname = ${table} AND t.relnamespace = current_schema()::regnamespace`;
}

/**
 * Each index the type should have, as the catalog rows `held` (the indexes on
 * its table) show it. Builds nothing and queries nothing. An index `held`
 * lacks is `failed`, as a build that has not succeeded is.
 */
export function describeTypeIndexes(
  args: ReconcileTypeIndexesArgs,
  held: CatalogIndex[]
): IndexState[] {
  const byName = new Map(held.map((i) => [i.name, i]));
  return desiredSpecs(args).map((spec) => {
    const found = byName.get(spec.name);
    const state: IndexState['state'] =
      found === undefined
        ? 'failed'
        : found.valid && found.ready
          ? 'valid'
          : found.ready
            ? 'building'
            : 'invalid';
    return {
      name: spec.name,
      fields: spec.fields,
      unique: spec.unique,
      state,
      outcome: 'unchanged'
    };
  });
}

const fold = (s: string): string => s.toLowerCase().replace(/[^a-z0-9_]/g, '_');

/**
 * Engine-named indexes among `heldNames` (the indexes on the type's partition)
 * that its declaration no longer asks for. They are reported, never dropped:
 * removing an index is the operator's call. Partitioned layout only.
 */
export function undeclaredIndexes(args: ReconcileTypeIndexesArgs, heldNames: string[]): string[] {
  if (args.layout !== 'partitioned') return [];
  const desired = new Set(desiredSpecs(args).map((s) => s.name));
  const prefix = `rows_${fold(args.namespace)}_${fold(args.type)}_`;
  return heldNames
    .filter(
      (n) => n.startsWith(prefix) && /_[0-9a-f]{8}_(idx|uniq|gin|base)$/.test(n) && !desired.has(n)
    )
    .sort();
}

async function targetTable(sql: Sql, args: ReconcileTypeIndexesArgs): Promise<string> {
  if (args.layout === 'legacy') return 'rows';
  const nsPart = await findPartition(sql, 'rows', args.namespace);
  const part = nsPart === undefined ? undefined : await findPartition(sql, nsPart, args.type);
  if (part === undefined) {
    throw new Error(
      `${args.namespace}/${args.type} has no partition; call ensureTypeStorage before reconciling its indexes`
    );
  }
  return part;
}

function keyExpr(
  field: string,
  def: FieldDef | undefined,
  promoted: PromotedBodyColumnMap
): string {
  // A bare column name, validated by `resolvePromotedColumns` in `desiredSpecs`.
  // Text keys under "C", as the compiler compares promoted text in every operator.
  const meta = Object.hasOwn(promoted, field) ? promoted[field] : undefined;
  if (meta !== undefined) return meta.kind === 'text' ? `${meta.column} COLLATE "C"` : meta.column;
  if (def?.kind === 'crossRef') return indexExpressionSql('text', field);
  if (def?.kind === 'scalar' && def.type !== 'json') {
    return indexExpressionSql(
      def.type === 'number' ? 'number' : def.type === 'date' ? 'date' : 'text',
      field
    );
  }
  throw new Error(
    `field '${field}' is not a declared scalar or crossRef field and cannot be indexed`
  );
}

function desiredSpecs(args: ReconcileTypeIndexesArgs): Spec[] {
  const { namespace, type, layout, fields } = args;
  const promoted = args.promotedColumns ?? {};
  resolvePromotedColumns(promoted);
  const live =
    layout === 'legacy'
      ? `namespace = ${sqlStringLiteral(namespace)} AND type = ${sqlStringLiteral(type)} AND deleted_at IS NULL`
      : 'deleted_at IS NULL';
  const specs: Spec[] = [];
  // A non-unique btree ends with `id`, so it serves the `id` that ends every
  // ORDER BY as well as the filter. `withoutId` leaves it out, for name hashing.
  // `natural` is a derived index's natural-order key, after the declared ones.
  const btree = (decl: IndexDecl, name: string, withoutId = false, natural?: string): Spec => {
    const cols = decl.fields.map((f) => (typeof f === 'string' ? { field: f, dir: 'asc' } : f));
    const keys = cols.map((c) => keyExpr(c.field, fields[c.field], promoted));
    let predicate = live;
    if (decl.where !== undefined && decl.where !== 'live') {
      // Exactly the compiler's `eq` for a boolean or null operand, which it inlines.
      for (const [f, v] of Object.entries(decl.where)) {
        const meta = Object.hasOwn(promoted, f) ? promoted[f] : undefined;
        const column = meta?.column;
        if (v !== null && typeof v !== 'boolean') {
          throw new Error(`index predicate on '${f}' must be a boolean or null`);
        }
        const def = fields[f];
        const isBoolean =
          meta !== undefined
            ? meta.kind === 'boolean'
            : def?.kind === 'scalar' && def.type === 'boolean';
        if (v !== null && !isBoolean) {
          throw new Error(
            `index predicate '${f}: ${v}' compares a boolean, but '${f}' is not a boolean field`
          );
        }
        const lhs = column ?? indexExpressionSql('text', f);
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
    if (decl.unique !== true && !withoutId) colSql.push('id');
    return {
      name,
      fields: cols.map((c) => c.field),
      unique: decl.unique === true,
      tail: `USING btree (${colSql.join(', ')}) WHERE ${predicate}`,
      keys,
      predicate
    };
  };

  // A derived btree is (field, natural key, id), so a filter on the field
  // reads in natural order with no Sort; on the natural-order field itself it
  // is (field DIR, id). Both layouts: on legacy it is partial on `rows`.
  const [natField, natDir] = Object.entries(args.orderedBy)[0] ?? ['createdAt', 'desc'];
  const natKey =
    natField === 'createdAt'
      ? 'created_at'
      : natField === 'updatedAt'
        ? 'updated_at'
        : `(${keyExpr(natField, fields[natField], promoted)})`;
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
        own ? undefined : natural
      ),
      derived: true
    });
  }
  if (layout === 'partitioned') {
    for (const [field, def] of Object.entries(fields)) {
      if (def.kind === 'struct' || def.indexed !== true) continue;
      if (def.kind === 'list' || (def.kind === 'scalar' && def.type === 'json')) {
        specs.push({
          name: generatedIdentifier(namespace, type, field, 'gin'),
          fields: [field],
          unique: false,
          tail: `USING gin ((body -> ${sqlStringLiteral(field)}) jsonb_path_ops) WHERE ${live}`,
          keys: [],
          predicate: live
        });
      }
    }
    const base = (column: string, tail: string): Spec => ({
      name: generatedIdentifier(namespace, type, column, 'base'),
      fields: [],
      unique: false,
      tail,
      keys: [],
      predicate: live
    });
    specs.push(
      base('created_at', `USING btree (created_at DESC NULLS LAST, id) WHERE ${live}`),
      base('updated_at', `USING btree (updated_at DESC NULLS LAST, id) WHERE ${live}`),
      base('deleted_at', 'USING btree (deleted_at) WHERE deleted_at IS NOT NULL')
    );
  }
  for (const decl of args.indexes) {
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

/** Each spec as pg deparses it, built on an empty temp copy of `rows` and rolled back. */
async function deparse(conn: Sql, specs: Spec[]): Promise<Described[]> {
  await conn.unsafe('BEGIN');
  try {
    await conn.unsafe('CREATE TEMP TABLE substrate_index_probe (LIKE rows)');
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
  const hash = createHash('sha256').update(name).digest('hex').slice(0, 8);
  return `${name.slice(0, MAX_IDENTIFIER - '__swap'.length - hash.length - 1)}_${hash}__swap`;
}

async function stateOf(conn: Sql, name: string): Promise<IndexState['state']> {
  const d = await describeIndex(conn, name, 'current');
  return d === undefined
    ? 'failed'
    : d.valid && d.ready
      ? 'valid'
      : d.ready
        ? 'building'
        : 'invalid';
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
  const failed = (reason: string): IndexState => indexState(spec, 'failed', 'unchanged', reason);
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
    if (built !== undefined) return failed(built);
    await mark(conn, spec.name);
    return report(await stateOf(conn, spec.name), 'created');
  }

  // Key columns are identified by field name, so a body-keyed index on a
  // field promoted since swaps onto the column rather than conflicting. A
  // non-unique index's trailing `id` is not part of the identity, so one
  // without it swaps.
  const fieldOf = new Map(
    Object.entries(args.promotedColumns ?? {}).map(([field, meta]) => [meta.column, field])
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
      if (built !== undefined) return failed(built);
      await dropConcurrently(conn, swapName, signal);
    }
    await mark(conn, spec.name);
    return report(await stateOf(conn, spec.name), 'swapped');
  }

  if (identical(leftover)) {
    // Built by an earlier run that stopped before the drop; it is used only
    // once valid and ready.
    let ready = leftover?.valid === true && leftover.ready;
    for (let i = 0; !ready; i++) {
      if (i >= 100) {
        throw new Error(`index ${swapName} did not become valid; ${spec.name} left in place`);
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
      const again = await describeIndex(conn, swapName, 'current');
      ready = again?.valid === true && again.ready;
    }
  } else {
    // `named` keeps enforcing while the stale leftover goes.
    if (leftover !== undefined) await dropConcurrently(conn, swapName, signal);
    const built = await build(conn, args, target, spec, swapName, opts);
    if (built !== undefined) return failed(built);
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
 * live values. Returns the reason when a non-unique build fails or is
 * cancelled through `opts.signal`, which costs only a scan until the next
 * reconcile drops the INVALID leftover and retries it; a unique one throws.
 */
async function build(
  conn: Sql,
  args: ReconcileTypeIndexesArgs,
  target: string,
  spec: Spec,
  name: string,
  opts: ReconcileOptions
): Promise<string | undefined> {
  if (spec.unique) await assertNoDuplicates(conn, args, target, spec);
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
    process.stderr.write(
      `index ${name} on ${target} failed to build and will be retried: ${message}\n`
    );
    return `build_failed: ${message}`;
  }
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
    throw new UniqueIndexDuplicatesError(args.namespace, args.type, spec.fields, count);
}

/**
 * The `tables` layout's per-type storage: one table per type, a typed column
 * for each declared scalar or crossRef field, and `extra jsonb` for the rest.
 * The catalog records each type's table (`substrate_type_tables`) and each
 * column field's state (`substrate_type_fields`):
 *
 * - `column`: the field has its column;
 * - `pending`: no column yet, so its values live in `extra` until the
 *   promotion sweep adds one;
 * - `promoting`: the column exists, and values are still moving out of `extra`;
 * - `orphaned`: the field is no longer declared. Its column is kept, and its
 *   values stay readable as undeclared extras.
 */

import { type FieldDef, isColumnField } from '@mnmal-ai/substrate-types';
import type { Sql, TransactionSql } from 'postgres';
import {
  cachedLayout,
  columnName,
  hashedName,
  ident,
  MAX_IDENTIFIER,
  typeTableName
} from './layout.js';
import {
  columnSql,
  type Fragment,
  fieldExprSql,
  qualifier,
  sqlStringLiteral,
  utcTextSql
} from './pg-sql/primitives.js';
import { extraWins, RAW_KEY } from './row-codec.js';
import type { PgHandle } from './tx-scope.js';
import { UUID_REGEX } from './uuid-check.js';
import { GUARDED_ATTEMPTS, guardedRead } from './write-rows.js';

export type ColumnKind = 'text' | 'enum' | 'number' | 'date' | 'boolean' | 'crossRef';

/**
 * The column kind of a field, or `undefined` when it has no column (json, list,
 * struct, and readonly scalars such as `shortId`). Defined only where
 * `isColumnField` holds, so the two never disagree.
 */
export function columnKindOf(def: FieldDef): ColumnKind | undefined {
  if (!isColumnField(def)) return undefined;
  if (def.kind === 'crossRef') return 'crossRef';
  if (def.kind === 'scalar' && def.type !== 'json') {
    if (def.type === 'string') return def.enum !== undefined ? 'enum' : 'text';
    return def.type;
  }
  throw new Error(`internal: isColumnField admitted a ${def.kind} field with no column kind`);
}

/**
 * Text and enum columns are `"C"`, so compares and sorts are byte order, as
 * memory's. A crossRef column has `id`'s collation (the database default), so a
 * walk joins `far.id = near.f_x` (and `far.f_x = near.id`) bare, and an index
 * on either side serves it; it is ordered under `"C"` where it sorts.
 */
export const PG_TYPE: Readonly<Record<ColumnKind, string>> = {
  text: 'text COLLATE "C"',
  enum: 'text COLLATE "C"',
  crossRef: 'text',
  number: 'double precision',
  date: 'timestamptz',
  boolean: 'boolean'
};

export interface TypedColumn {
  field: string;
  column: string;
  kind: ColumnKind;
  state: 'column' | 'promoting' | 'orphaned';
  vocab?: readonly string[];
}

export interface TypeTable {
  namespace: string;
  type: string;
  /** The table, as a quoted identifier. */
  from: string;
  /** The jsonb column holding every field without a column of its own. */
  jsonb: 'extra';
  column(field: string): TypedColumn | undefined;
  columns(): readonly TypedColumn[];
  /** Declared fields whose values live in `extra` until they get a column. */
  pending: readonly string[];
  orphaned: readonly string[];
  /**
   * The catalog version this descriptor was loaded at (bigint text). Every
   * write checks it in its own statement (`guardCte`), so one built from a
   * stale descriptor writes nothing and is rebuilt.
   */
  version: string;
}

/**
 * A type that has no table yet: an empty relation with
 * a type table's fixed columns, so a read of it compiles and finds nothing.
 */
export function absentTypeTable(namespace: string, type: string): TypeTable {
  return {
    namespace,
    type,
    from: "(SELECT NULL::text AS id, NULL::timestamptz AS deleted_at, NULL::timestamptz AS created_at, NULL::timestamptz AS updated_at, NULL::text AS created_by_kind, NULL::text AS created_by_id, NULL::text AS updated_by_kind, NULL::text AS updated_by_id, NULL::bigint AS seq, '{}'::jsonb AS extra WHERE false)",
    jsonb: 'extra',
    column: () => undefined,
    columns: () => [],
    pending: [],
    orphaned: [],
    version: '0'
  };
}

/**
 * Where a reader outside `PgDataset` (recall) finds `namespace`/`type`'s rows,
 * as SQL over a caller's alias of `from`.
 */
export interface TypeTableRef {
  /** The type's table, quoted. */
  from: string;
  /** The row as `dataset.read` returns it (`decodeRow`'s, built in SQL). */
  rowJson(alias: string): string;
  /** A top-level field as the text `rowJson(alias) ->> field` gives, which a row filter compares. */
  text(alias: string, field: string): string;
  /** A top-level field as the jsonb `rowJson(alias) -> field` gives. */
  json(alias: string, field: string): string;
}

/**
 * The {@link TypeTableRef} of `namespace`/`type`, or `undefined` when it has no
 * rows to read: no table yet, or no store schema at all. The layout is cached
 * per handle ({@link cachedLayout}), and the descriptor in the pool's
 * {@link TableCache}, which `PgDataset` shares; a hit makes no query.
 */
export async function typeTableRef(
  sql: PgHandle,
  namespace: string,
  type: string
): Promise<TypeTableRef | undefined> {
  // Boot refuses an old layout, so anything but `tables` has no type tables to read.
  const table = await refTable(sql, namespace, type);
  return table === undefined ? undefined : refOf(table);
}

async function refTable(
  sql: PgHandle,
  namespace: string,
  type: string
): Promise<TypeTable | undefined> {
  if ((await cachedLayout(sql as Sql)) !== 'tables') return undefined;
  return cachedTypeTable(sql, namespace, type);
}

const refOf = (table: TypeTable): TypeTableRef => ({
  from: table.from,
  rowJson: (alias) => rowJsonSql(table, alias),
  text: (alias, field) => `(${fieldExprSql(table, field, 'json', alias)} #>> '{}')`,
  json: (alias, field) => fieldExprSql(table, field, 'json', alias)
});

/**
 * Reads through `namespace`/`type`'s {@link TypeTableRef} under the read
 * guard, as `PgDataset.read` does: `run` builds its statement from `ref` and
 * runs it wrapped by `guard` (on `sql`, or a transaction of it). A statement
 * built from a descriptor the catalog has moved past (a field promoted
 * meanwhile) is dropped from the cache, rebuilt and run again, up to
 * {@link GUARDED_ATTEMPTS} in all; then it throws. `[]` when the type has no
 * table. The guard's own row is dropped: `key` is a column null only there.
 */
export async function guardedRefRead<R extends object>(
  sql: PgHandle,
  namespace: string,
  type: string,
  run: (
    ref: TypeTableRef,
    guard: (q: Sql | TransactionSql, statement: Fragment) => Fragment
  ) => Promise<readonly R[]>,
  key: keyof R
): Promise<R[]> {
  for (let attempt = 1; ; attempt++) {
    const table = await refTable(sql, namespace, type);
    if (table === undefined) return [];
    const entry = { namespace, type, version: table.version };
    const rows = (await run(refOf(table), (q, statement) =>
      guardedRead(q, [entry], statement)
    )) as ReadonlyArray<R & { guard_ok?: boolean }>;
    if (rows[0]?.guard_ok === true) return rows.filter((r) => r[key] != null);
    if (attempt >= GUARDED_ATTEMPTS) {
      throw new Error(
        `${namespace}/${type}: its catalog changed on each of ${GUARDED_ATTEMPTS} attempts at a read`
      );
    }
    dropTableCache(tableCacheFor(sql), `${namespace}/${type}`);
  }
}

/**
 * A pool's type-table descriptors. A
 * `substrate_catalog` notification (sent by `ensureTypeTable` on any change,
 * delivered at commit) drops its type's entry, and a (re)connect of the
 * listener drops them all, since notifications may have been missed.
 */
export interface TableCache {
  /** The pool, which LISTENs on a connection of its own. */
  sql: PgHandle;
  /** `null` is a cached miss: the type has no table yet. */
  tables: Map<string, TypeTable | null>;
  /** Bumped on each drop; a load notes it at its start (see {@link mayCache}). */
  gen: number;
  /** Each key's last drop's `gen`, so a load is refused only for a drop of its own key. */
  dropped: Map<string, number>;
  /** The last full clear's `gen`. */
  cleared: number;
  /** True once listening; false when LISTEN failed, and then nothing is cached. */
  listening?: Promise<boolean>;
  /** After a failed LISTEN, when the next call may try again. */
  listenRetryAt?: number;
  /** Only `true` is kept: the migration can be applied while this process runs, never unapplied. */
  uuidCheck?: true;
}

/** One cache per pool. */
const tableCaches = new WeakMap<object, TableCache>();

/** The pool's {@link TableCache}, shared by every `PgDataset` and `typeTableRef` on it. */
export function tableCacheFor(sql: PgHandle): TableCache {
  let cache = tableCaches.get(sql);
  if (cache === undefined) {
    cache = { sql, tables: new Map(), gen: 0, dropped: new Map(), cleared: 0 };
    tableCaches.set(sql, cache);
  }
  return cache;
}

/** Drops `key`'s entry, or every entry; returns the new `gen`. */
export function dropTableCache(cache: TableCache, key?: string): number {
  const gen = ++cache.gen;
  if (key === undefined) {
    cache.tables.clear();
    cache.cleared = gen;
  } else {
    cache.tables.delete(key);
    cache.dropped.set(key, gen);
  }
  return gen;
}

/**
 * Whether a load of `key` begun at `gen` may be cached: neither `key` nor the
 * whole cache was dropped since. A negative `gen` never may.
 */
export function mayCache(cache: TableCache, key: string, gen: number): boolean {
  return gen >= 0 && cache.cleared <= gen && (cache.dropped.get(key) ?? 0) <= gen;
}

/** How long after a failed LISTEN the next call tries again. */
export const LISTEN_RETRY_MS = 30_000;

/** Starts the pool's catalog LISTEN once; resolves false when it cannot, retried after {@link LISTEN_RETRY_MS}. */
export function listenTableCache(cache: TableCache): Promise<boolean> {
  const drop = (key?: string) => {
    dropTableCache(cache, key);
  };
  // Only a pool can LISTEN (on a connection of its own); on any other handle nothing is cached.
  const pool = cache.sql as Partial<Sql>;
  if (cache.listenRetryAt !== undefined && Date.now() >= cache.listenRetryAt) {
    delete cache.listenRetryAt;
    delete cache.listening;
  }
  cache.listening ??=
    typeof pool.listen !== 'function'
      ? Promise.resolve(false)
      : pool
          .listen(
            'substrate_catalog',
            (key) => drop(key),
            () => drop()
          )
          .then(
            () => true,
            (err: unknown) => {
              // Uncached until a retry succeeds: every read pays a catalog query.
              console.warn(
                `substrate-dataset-pg: LISTEN substrate_catalog failed, type tables uncached; retrying in ${LISTEN_RETRY_MS / 1000}s: ${err instanceof Error ? err.message : String(err)}`
              );
              // postgres.js forgets a refused channel with no other listeners, so the retry LISTENs afresh.
              cache.listenRetryAt = Date.now() + LISTEN_RETRY_MS;
              return false;
            }
          );
  return cache.listening;
}

/**
 * `namespace`/`type`'s descriptor through the pool's {@link TableCache}, as
 * `PgDataset` reads it outside a transaction: a hit, a miss included, makes no
 * query; a load that raced a notification is not cached.
 */
async function cachedTypeTable(
  sql: PgHandle,
  namespace: string,
  type: string
): Promise<TypeTable | undefined> {
  const cache = tableCacheFor(sql);
  const key = `${namespace}/${type}`;
  const listening = await listenTableCache(cache);
  const hit = cache.tables.get(key);
  if (hit !== undefined) return hit ?? undefined;
  const gen = cache.gen;
  const table = await loadTypeTable(sql, namespace, type);
  if (listening && mayCache(cache, key, gen)) cache.tables.set(key, table ?? null);
  return table;
}

/**
 * Runs `fn` in a transaction under `namespace`/`type`'s type-table lock, the
 * one a first write's CREATE takes, but only while the type still has no table;
 * `undefined`, running nothing, once it has one. So what `fn` does on "no
 * table" cannot interleave with that type's first write.
 */
export async function whileNoTypeTable<T>(
  sql: Sql,
  namespace: string,
  type: string,
  fn: (tx: TransactionSql) => Promise<T>
): Promise<T | undefined> {
  return (await sql.begin(async (tx) => {
    await lockTypeTable(tx, namespace, type);
    if ((await typeTableOf(tx, namespace, type)) !== undefined) return undefined;
    return fn(tx);
  })) as T | undefined;
}

/** pg's argument limit is 100, so `jsonb_build_object` takes at most 50 pairs. */
const MAX_PAIRS = 50;

/**
 * `decodeRow` in SQL: the non-null columns, then `extra` but `$raw` and the
 * `column`-state fields' keys, less a `promoting` or `pending` field whose
 * `extra` value is null (it reads absent, column and all), then `$raw` over all.
 * Only the columns' object is stripped of nulls: a null in `extra`, or nested
 * in a json value, is the row's.
 */
function rowJsonSql(table: TypeTable, alias: string): string {
  const q = qualifier(alias);
  const lit = sqlStringLiteral;
  const columns = table.columns();
  const pairs = columns.map((c) => {
    const col = columnSql(c, alias);
    return `${lit(c.field)}, ${c.kind === 'date' ? utcTextSql(col, 'MS') : col}`;
  });
  const objects: string[] = [];
  for (let i = 0; i < pairs.length; i += MAX_PAIRS) {
    objects.push(
      `jsonb_strip_nulls(jsonb_build_object(${pairs.slice(i, i + MAX_PAIRS).join(', ')}))`
    );
  }
  const fromColumns = objects.length === 0 ? "'{}'::jsonb" : objects.join(' || ');
  const dropped = [RAW_KEY, ...columns.filter((c) => !extraWins(c)).map((c) => c.field)];
  let row = `(${fromColumns} || (${q}extra - ARRAY[${dropped.map(lit).join(', ')}]::text[]))`;
  const nullable = [
    ...columns.filter((c) => c.state === 'promoting').map((c) => c.field),
    ...table.pending
  ];
  if (nullable.length > 0) {
    const absent = nullable.map(
      (f) => `CASE WHEN ${q}extra -> ${lit(f)} = 'null'::jsonb THEN ${lit(f)} END`
    );
    row = `(${row} - ARRAY[${absent.join(', ')}]::text[])`;
  }
  return `(${row} || COALESCE(${q}extra -> ${lit(RAW_KEY)}, '{}'::jsonb))`;
}

type FieldState = 'pending' | TypedColumn['state'];

interface CatalogRow {
  field: string;
  column_name: string;
  kind: ColumnKind;
  state: FieldState;
  vocab: string[] | null;
}

/** The name (unquoted) of `namespace`/`type`'s table, or `undefined` when it has none yet. */
export async function typeTableOf(
  sql: PgHandle,
  namespace: string,
  type: string
): Promise<string | undefined> {
  const [table] = await sql<Array<{ table_name: string }>>`
    SELECT table_name FROM substrate_type_tables WHERE namespace = ${namespace} AND type = ${type}`;
  return table?.table_name;
}

/** The type table of `namespace`/`type`, or `undefined` when it has none yet. */
export async function loadTypeTable(
  sql: PgHandle,
  namespace: string,
  type: string
): Promise<TypeTable | undefined> {
  // The version is read before the fields, so a descriptor is never labelled
  // newer than its fields: a move committing in between only costs a retry.
  const [table] = await sql<Array<{ table_name: string; version: string }>>`
    SELECT table_name, version FROM substrate_type_tables WHERE namespace = ${namespace} AND type = ${type}`;
  if (table === undefined) return undefined;
  const tableName = table.table_name;
  const rows = await catalogOf(sql, namespace, type);
  const columns: TypedColumn[] = [];
  for (const r of rows) {
    if (r.state === 'pending') continue;
    columns.push({
      field: r.field,
      column: r.column_name,
      kind: r.kind,
      state: r.state,
      ...(r.vocab === null ? {} : { vocab: r.vocab })
    });
  }
  const byField = new Map(columns.map((c) => [c.field, c]));
  return {
    namespace,
    type,
    from: ident(tableName),
    jsonb: 'extra',
    column: (field) => byField.get(field),
    columns: () => columns,
    pending: rows.filter((r) => r.state === 'pending').map((r) => r.field),
    orphaned: columns.filter((c) => c.state === 'orphaned').map((c) => c.field),
    version: table.version
  };
}

function catalogOf(sql: PgHandle, namespace: string, type: string): Promise<CatalogRow[]> {
  return sql<CatalogRow[]>`
    SELECT field, column_name, kind, state, vocab FROM substrate_type_fields
    WHERE namespace = ${namespace} AND type = ${type}
    ORDER BY field COLLATE "C"`;
}

/** A declared field's column kind changed; its column cannot hold the new kind. */
export class FieldKindChangedError extends Error {
  override readonly name = 'FieldKindChangedError';

  constructor(
    readonly namespace: string,
    readonly type: string,
    readonly field: string,
    readonly from: ColumnKind,
    readonly to: ColumnKind
  ) {
    super(
      `${namespace}/${type}.${field} changed from ${from} to ${to}, which its column cannot hold. ` +
        'Write an explicit migration that converts or drops the column, then boot.'
    );
  }
}

export interface TypeTableChange {
  created: boolean;
  /** Fields that got a column: `column` in a CREATE, `promoting` when added to an existing table. */
  added: string[];
  /** Fields newly recorded `pending`. */
  pending: string[];
  /** Fields newly recorded `orphaned`. */
  orphaned: string[];
}

export interface EnsureTypeTableArgs {
  namespace: string;
  type: string;
  fields: Record<string, FieldDef>;
  /** What a declared field without a column gets: its column now, or `pending` for the sweep. */
  newFields: 'column' | 'pending';
  enforceUuidCheck: boolean;
  /**
   * Create the table when it is missing, and otherwise change nothing: for a
   * caller that does not know the type's fields, whose empty `fields` would
   * otherwise orphan every column.
   */
  createOnly?: boolean;
}

/** How long one ADD COLUMN or CHECK change may queue writers behind its lock. */
const LOCK_TIMEOUT = '2s';

/**
 * Brings `namespace`/`type`'s table and catalog rows in line with `fields`,
 * under the type's advisory lock, and notifies `substrate_catalog` when
 * anything changed. Given a transaction, it runs in it; a lock timeout rolls
 * back only its own step, so the caller's transaction survives.
 */
export async function ensureTypeTable(
  sql: PgHandle,
  args: EnsureTypeTableArgs
): Promise<TypeTableChange> {
  if ('savepoint' in sql) return ensureIn(sql, args);
  return (sql as Sql).begin((tx) => ensureIn(tx, args)) as Promise<TypeTableChange>;
}

async function ensureIn(tx: TransactionSql, args: EnsureTypeTableArgs): Promise<TypeTableChange> {
  const { namespace, type, fields, newFields } = args;
  await lockTypeTable(tx, namespace, type);
  const declared = new Map<string, { kind: ColumnKind; vocab: readonly string[] | undefined }>();
  for (const [field, def] of Object.entries(fields)) {
    const kind = columnKindOf(def);
    if (kind !== undefined) declared.set(field, { kind, vocab: vocabOf(def) });
  }
  const change: TypeTableChange = { created: false, added: [], pending: [], orphaned: [] };
  let changed = false;

  const record = (field: string, kind: ColumnKind, state: FieldState, vocab?: readonly string[]) =>
    tx`INSERT INTO substrate_type_fields (namespace, type, field, column_name, kind, state, vocab)
       VALUES (${namespace}, ${type}, ${field}, ${columnName(field)}, ${kind}, ${state},
               ${vocab === undefined ? null : [...vocab]})`;
  const setState = (field: string, state: FieldState) =>
    tx`UPDATE substrate_type_fields SET state = ${state}
       WHERE namespace = ${namespace} AND type = ${type} AND field = ${field}`;

  const [existing] = await tx<Array<{ table_name: string }>>`
    SELECT table_name FROM substrate_type_tables WHERE namespace = ${namespace} AND type = ${type}`;
  if (existing === undefined) {
    const table = await freeTableName(tx, namespace, type);
    await tx.unsafe(createTableSql(table, declared, args.enforceUuidCheck));
    await tx`INSERT INTO substrate_type_tables (namespace, type, table_name)
             VALUES (${namespace}, ${type}, ${table})`;
    for (const [field, { kind, vocab }] of declared) await record(field, kind, 'column', vocab);
    change.created = true;
  } else if (args.createOnly !== true) {
    const table = ident(existing.table_name);
    const catalog = new Map((await catalogOf(tx, namespace, type)).map((r) => [r.field, r]));
    // A column added to an existing table starts `promoting`, empty or not: a
    // writer whose cached table predates it puts the field's value in `extra`,
    // which `extraWins` keeps readable until the sweep moves it (Task 13). Only
    // a table's first CREATE declares fields `column` outright.
    for (const [field, { kind, vocab }] of declared) {
      const row = catalog.get(field);
      if (row === undefined) {
        const clauses = addColumnClauses(columnName(field), kind, vocab);
        const added =
          newFields === 'column' && (await ddl(tx, `ALTER TABLE ${table} ${clauses.join(', ')}`));
        await record(field, kind, added ? 'promoting' : 'pending', vocab);
        (added ? change.added : change.pending).push(field);
        continue;
      }
      if (row.kind !== kind) {
        throw new FieldKindChangedError(namespace, type, field, row.kind, kind);
      }
      if (row.state === 'orphaned') {
        // Declared again: values written meanwhile sit in `extra`, so the sweep moves them back.
        await setState(field, 'promoting');
        changed = true;
      }
      const widened = widen(row.vocab, vocab);
      if (widened !== undefined) {
        // On a lock timeout the old vocabulary stays recorded, and the next boot retries.
        const applied =
          row.state === 'pending' ||
          (await ddl(
            tx,
            `ALTER TABLE ${table} ${enumCheckClauses(row.column_name, widened).join(', ')}`
          ));
        if (applied) {
          await tx`UPDATE substrate_type_fields SET vocab = ${[...widened]}
                   WHERE namespace = ${namespace} AND type = ${type} AND field = ${field}`;
          // Values held in `$raw` that the new vocabulary admits belong in the
          // column: back through `promoting`, so the sweep's backfill moves them.
          if (row.state === 'column') await setState(field, 'promoting');
          changed = true;
        }
      }
    }
    for (const row of catalog.values()) {
      if (declared.has(row.field) || row.state === 'orphaned') continue;
      if (row.state === 'pending') {
        // It never had a column; its values in `extra` are plain undeclared extras now.
        await tx`DELETE FROM substrate_type_fields
                 WHERE namespace = ${namespace} AND type = ${type} AND field = ${row.field}`;
        changed = true;
        continue;
      }
      await setState(row.field, 'orphaned');
      change.orphaned.push(row.field);
    }
  }

  if (
    changed ||
    change.created ||
    change.added.length + change.pending.length + change.orphaned.length > 0
  ) {
    await catalogChanged(tx, namespace, type);
  }
  return change;
}

function vocabOf(def: FieldDef): readonly string[] | undefined {
  return def.kind === 'scalar' ? def.enum : undefined;
}

/**
 * The recorded vocabulary with `declared`'s new values appended, or undefined
 * when it already holds them all. Only ever widens: a value dropped from the
 * declaration stays recorded and in the CHECK, because pg re-checks a CHECK on
 * every UPDATE of a row, so a narrowed one would refuse any update of a row
 * still holding the dropped value. The codec admits a recorded value to the
 * column, so such a row reads and filters as written.
 */
function widen(
  recorded: readonly string[] | null,
  declared: readonly string[] | undefined
): string[] | undefined {
  const have = recorded ?? [];
  const added = (declared ?? []).filter((v) => !have.includes(v));
  return added.length === 0 ? undefined : [...have, ...added];
}

/**
 * `typeTableName`, or a hashed variant when another relation holds that name.
 * Two types can fold to one clean name (`a__b`/`c` and `a`/`b__c`); a lock on
 * the name makes the second creator see the first's table and take the hash.
 */
async function freeTableName(tx: TransactionSql, namespace: string, type: string): Promise<string> {
  const preferred = typeTableName(namespace, type);
  await tx`SELECT pg_advisory_xact_lock(hashtext(
    current_schema() || ':substrate-type-table-name:' || ${preferred}))`;
  const taken = await tx`
    SELECT 1 FROM pg_class
    WHERE relname = ${preferred} AND relnamespace = current_schema()::regnamespace`;
  return taken.length === 0 ? preferred : hashedName(preferred, [namespace, type]);
}

const kindCheck = (column: string): string =>
  `CHECK (${column} IS NULL OR ${column} IN ('agent','user','system'))`;

function createTableSql(
  table: string,
  declared: ReadonlyMap<string, { kind: ColumnKind; vocab: readonly string[] | undefined }>,
  enforceUuidCheck: boolean
): string {
  const parts = [
    'id text PRIMARY KEY',
    'deleted_at timestamptz NULL',
    'created_at timestamptz NULL',
    'updated_at timestamptz NULL',
    `created_by_kind text NULL ${kindCheck('created_by_kind')}`,
    'created_by_id text NULL',
    `updated_by_kind text NULL ${kindCheck('updated_by_kind')}`,
    'updated_by_id text NULL',
    'seq bigint NULL',
    "extra jsonb NOT NULL DEFAULT '{}'"
  ];
  for (const [field, { kind, vocab }] of declared) {
    const column = columnName(field);
    parts.push(`${ident(column)} ${PG_TYPE[kind]}`);
    if (kind === 'enum') {
      parts.push(`CONSTRAINT ${ident(enumCheckName(column))} ${enumCheck(column, vocab)}`);
    }
  }
  if (enforceUuidCheck) parts.push(`CONSTRAINT id_uuid_format CHECK (id ~ '${UUID_REGEX}')`);
  return `CREATE TABLE ${ident(table)} (\n  ${parts.join(',\n  ')}\n)`;
}

function enumCheckName(column: string): string {
  const name = `${column}_check`;
  return name.length <= MAX_IDENTIFIER ? name : hashedName(name, column);
}

function enumCheck(column: string, vocab: readonly string[] | undefined): string {
  const c = ident(column);
  const values = (vocab ?? []).map(sqlStringLiteral);
  return values.length === 0
    ? `CHECK (${c} IS NULL)`
    : `CHECK (${c} IS NULL OR ${c} IN (${values.join(', ')}))`;
}

/** Replaces `column`'s enum CHECK; NOT VALID, so it takes no scan under the table lock. */
function enumCheckClauses(column: string, vocab: readonly string[] | undefined): string[] {
  const name = ident(enumCheckName(column));
  return [
    `DROP CONSTRAINT IF EXISTS ${name}`,
    `ADD CONSTRAINT ${name} ${enumCheck(column, vocab)} NOT VALID`
  ];
}

/**
 * Gives `namespace`/`type`'s `pending` field `field` its column (step 1 of a
 * promotion) and records it `promoting`, under the type's advisory lock.
 * `busy` when the table's lock stayed held past `lockTimeoutMs`; `skipped`
 * when the field is no longer `pending` (another sweep, or a boot, got there).
 */
export async function addPendingColumn(
  sql: Sql,
  namespace: string,
  type: string,
  field: string,
  lockTimeoutMs: number
): Promise<'added' | 'busy' | 'skipped'> {
  const timeout = `${Math.max(1, Math.floor(lockTimeoutMs))}ms`;
  try {
    return (await sql.begin(async (tx) => {
      // The type lock's wait is bounded too: an in-transaction first write (F18) holds it to its commit.
      await tx.unsafe(`SET LOCAL lock_timeout = '${timeout}'`);
      await lockTypeTable(tx, namespace, type);
      const [table] = await tx<Array<{ table_name: string }>>`
        SELECT table_name FROM substrate_type_tables WHERE namespace = ${namespace} AND type = ${type}`;
      const row = (await catalogOf(tx, namespace, type)).find((r) => r.field === field);
      if (table === undefined || row?.state !== 'pending') return 'skipped';
      const clauses = addColumnClauses(row.column_name, row.kind, row.vocab ?? undefined);
      if (
        !(await ddl(tx, `ALTER TABLE ${ident(table.table_name)} ${clauses.join(', ')}`, timeout))
      ) {
        return 'busy';
      }
      await tx`UPDATE substrate_type_fields SET state = 'promoting'
               WHERE namespace = ${namespace} AND type = ${type} AND field = ${field}`;
      await catalogChanged(tx, namespace, type);
      return 'added';
    })) as 'added' | 'busy' | 'skipped';
  } catch (err) {
    if ((err as { code?: unknown }).code === '55P03') return 'busy';
    throw err;
  }
}

/**
 * Moves `field` from state `from` to `to`, under the type's advisory lock, and
 * notifies. False, changing nothing, when the field is no longer in `from`: a
 * boot orphaned or redeclared it meanwhile, and that boot's state stands.
 *
 * The table is locked SHARE first, which holds off new writes until this
 * commits. So a write that passed its version check before the move commits
 * before it (and the straggler pass after the move sees it), and one after
 * sees the new version. The lock is never queued for: every write to the
 * type would queue behind it. It is tried NOWAIT under a savepoint, with a
 * short backoff, until `lockTimeoutMs` runs out; then 55P03 is thrown and the
 * field stays `from`. With `queue` (a store with no writers, as migrate-store's
 * target) it is waited for under `lock_timeout` instead, which also has a
 * blocking autovacuum cancelled, which a NOWAIT never does.
 */
export async function moveFieldState(
  sql: Sql,
  namespace: string,
  type: string,
  field: string,
  from: FieldState,
  to: FieldState,
  lockTimeoutMs = 2000,
  queue = false
): Promise<boolean> {
  return (await sql.begin(async (tx) => {
    await tx.unsafe(`SET LOCAL lock_timeout = '${Math.max(1, Math.floor(lockTimeoutMs))}ms'`);
    await lockTypeTable(tx, namespace, type);
    const [table] = await tx<Array<{ table_name: string }>>`
      SELECT table_name FROM substrate_type_tables WHERE namespace = ${namespace} AND type = ${type}`;
    if (table === undefined) return false;
    const lock = `LOCK TABLE ${ident(table.table_name)} IN SHARE MODE`;
    if (queue) await tx.unsafe(lock);
    else await pollLock(tx, `${lock} NOWAIT`, lockTimeoutMs);
    const moved = await tx`UPDATE substrate_type_fields SET state = ${to}
      WHERE namespace = ${namespace} AND type = ${type} AND field = ${field} AND state = ${from}
      RETURNING 1`;
    if (moved.length === 0) return false;
    await catalogChanged(tx, namespace, type);
    return true;
  })) as boolean;
}

/** Runs `nowait`, a NOWAIT lock, under a savepoint until it is granted or `ms` runs out (55P03). */
async function pollLock(tx: TransactionSql, nowait: string, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  for (let backoff = 10; ; backoff = Math.min(backoff * 2, 200)) {
    try {
      await tx.savepoint((sp) => sp.unsafe(nowait));
      return;
    } catch (err) {
      const left = deadline - Date.now();
      if ((err as { code?: unknown }).code !== '55P03' || left <= 0) throw err;
      await new Promise((r) => setTimeout(r, Math.min(backoff, left)));
    }
  }
}

/**
 * Bumps the type's catalog version and notifies `substrate_catalog`, in the
 * transaction that changed its catalog rows: the version makes a write through
 * a descriptor loaded before the change refuse itself, the notification drops
 * that descriptor from every listening pool's cache.
 */
async function catalogChanged(tx: TransactionSql, namespace: string, type: string): Promise<void> {
  await tx`UPDATE substrate_type_tables SET version = version + 1
           WHERE namespace = ${namespace} AND type = ${type}`;
  await tx`SELECT pg_notify('substrate_catalog', ${`${namespace}/${type}`})`;
}

/** The type's advisory lock, which every change to its table and catalog rows takes. */
async function lockTypeTable(tx: TransactionSql, namespace: string, type: string): Promise<void> {
  await tx`SELECT pg_advisory_xact_lock(hashtext(
    current_schema() || ':substrate-type-table:' || ${namespace} || '/' || ${type}))`;
}

/** The ALTER TABLE clauses giving `column` its type, and its CHECK when it is an enum. */
function addColumnClauses(
  column: string,
  kind: ColumnKind,
  vocab: readonly string[] | undefined
): string[] {
  return [
    `ADD COLUMN IF NOT EXISTS ${ident(column)} ${PG_TYPE[kind]}`,
    ...(kind === 'enum' ? enumCheckClauses(column, vocab) : [])
  ];
}

/**
 * Runs one DDL statement in a savepoint under a short lock_timeout. False when
 * the lock was busy (55P03): the savepoint is rolled back, so an enclosing
 * transaction survives. lock_timeout is then put back as it was, because a
 * SET LOCAL outlives RELEASE SAVEPOINT.
 */
async function ddl(
  tx: TransactionSql,
  statement: string,
  lockTimeout = LOCK_TIMEOUT
): Promise<boolean> {
  const [prior] = await tx<Array<{ v: string }>>`SELECT current_setting('lock_timeout') AS v`;
  try {
    await tx.savepoint(async (sp) => {
      await sp.unsafe(`SET LOCAL lock_timeout = '${lockTimeout}'`);
      await sp.unsafe(statement);
    });
    return true;
  } catch (err) {
    if ((err as { code?: unknown }).code !== '55P03') throw err;
    return false;
  } finally {
    await tx`SELECT set_config('lock_timeout', ${prior?.v ?? '0'}, true)`;
  }
}

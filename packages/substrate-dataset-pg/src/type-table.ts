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
 *
 * `rowsTypeTable` describes the old layouts' `rows` in the same shape, so the
 * SQL builders take one descriptor whatever the layout.
 */

import { type FieldDef, isColumnField } from '@mnmal-ai/substrate-types';
import type { Sql, TransactionSql } from 'postgres';
import { columnName, hashedName, MAX_IDENTIFIER, typeTableName } from './layout.js';
import { type PromotedColumnLookup, qualifier, sqlStringLiteral } from './pg-sql/primitives.js';
import type { PgHandle } from './tx-scope.js';
import { ident } from './type-storage.js';
import { UUID_REGEX } from './uuid-check.js';

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

const PG_TYPE: Readonly<Record<ColumnKind, string>> = {
  text: 'text COLLATE "C"',
  enum: 'text COLLATE "C"',
  crossRef: 'text COLLATE "C"',
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
  /** The table, as a quoted identifier (`rows` on the old layouts). */
  from: string;
  jsonb: 'body' | 'extra';
  /** The namespace/type predicate on `rows`; `null` on a type's own table. */
  scope(alias?: string): string | null;
  column(field: string): TypedColumn | undefined;
  columns(): readonly TypedColumn[];
  /** Declared fields whose values live in `extra` until they get a column. */
  pending: readonly string[];
  orphaned: readonly string[];
  /** The old layouts' promoted body columns; set only by `rowsTypeTable`. */
  promoted?: PromotedColumnLookup;
}

/** `rows` on the old layouts: every field in `body`, apart from `promoted` ones. */
export function rowsTypeTable(
  namespace: string,
  type: string,
  promoted: PromotedColumnLookup
): TypeTable {
  return {
    namespace,
    type,
    from: 'rows',
    jsonb: 'body',
    scope: (alias) => {
      const q = qualifier(alias);
      return `${q}namespace = ${sqlStringLiteral(namespace)} AND ${q}type = ${sqlStringLiteral(type)}`;
    },
    column: () => undefined,
    columns: () => [],
    pending: [],
    orphaned: [],
    promoted
  };
}

type FieldState = 'pending' | TypedColumn['state'];

interface CatalogRow {
  field: string;
  column_name: string;
  kind: ColumnKind;
  state: FieldState;
  vocab: string[] | null;
}

/** The type table of `namespace`/`type`, or `undefined` when it has none yet. */
export async function loadTypeTable(
  sql: PgHandle,
  namespace: string,
  type: string
): Promise<TypeTable | undefined> {
  const [table] = await sql<Array<{ table_name: string }>>`
    SELECT table_name FROM substrate_type_tables WHERE namespace = ${namespace} AND type = ${type}`;
  if (table === undefined) return undefined;
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
    from: ident(table.table_name),
    jsonb: 'extra',
    scope: () => null,
    column: (field) => byField.get(field),
    columns: () => columns,
    pending: rows.filter((r) => r.state === 'pending').map((r) => r.field),
    orphaned: columns.filter((c) => c.state === 'orphaned').map((c) => c.field)
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
  /** Fields that got a column. */
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
  await tx`SELECT pg_advisory_xact_lock(hashtext(
    current_schema() || ':substrate-type-table:' || ${namespace} || '/' || ${type}))`;
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
               ${vocab === undefined ? null : tx.array([...vocab])})`;
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
  } else {
    const table = ident(existing.table_name);
    const catalog = new Map((await catalogOf(tx, namespace, type)).map((r) => [r.field, r]));
    for (const [field, { kind, vocab }] of declared) {
      const row = catalog.get(field);
      if (row === undefined) {
        const column = columnName(field);
        const clauses = [
          `ADD COLUMN IF NOT EXISTS ${ident(column)} ${PG_TYPE[kind]}`,
          ...(kind === 'enum' ? enumCheckClauses(column, vocab) : [])
        ];
        const added =
          newFields === 'column' && (await ddl(tx, `ALTER TABLE ${table} ${clauses.join(', ')}`));
        await record(field, kind, added ? 'column' : 'pending', vocab);
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
      if (!sameVocab(row.vocab, vocab)) {
        // On a lock timeout the old vocabulary stays recorded, and the next boot retries.
        const applied =
          row.state === 'pending' ||
          (await ddl(
            tx,
            `ALTER TABLE ${table} ${enumCheckClauses(row.column_name, vocab).join(', ')}`
          ));
        if (applied) {
          await tx`UPDATE substrate_type_fields
                   SET vocab = ${vocab === undefined ? null : tx.array([...vocab])}
                   WHERE namespace = ${namespace} AND type = ${type} AND field = ${field}`;
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
    await tx`SELECT pg_notify('substrate_catalog', ${`${namespace}/${type}`})`;
  }
  return change;
}

function vocabOf(def: FieldDef): readonly string[] | undefined {
  return def.kind === 'scalar' ? def.enum : undefined;
}

/** Order-insensitive: a reordered enum checks the same values. */
function sameVocab(a: readonly string[] | null, b: readonly string[] | undefined): boolean {
  const key = (v: readonly string[] | null | undefined) =>
    JSON.stringify(v == null ? null : [...v].sort());
  return key(a) === key(b);
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
 * Runs one DDL statement in a savepoint under a short lock_timeout. False when
 * the lock was busy (55P03): the savepoint is rolled back, so an enclosing
 * transaction survives. lock_timeout is then put back as it was, because a
 * SET LOCAL outlives RELEASE SAVEPOINT.
 */
async function ddl(tx: TransactionSql, statement: string): Promise<boolean> {
  const [prior] = await tx<Array<{ v: string }>>`SELECT current_setting('lock_timeout') AS v`;
  try {
    await tx.savepoint(async (sp) => {
      await sp.unsafe(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT}'`);
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

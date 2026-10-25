/**
 * Builds a type's indexes and keeps them matching their declaration.
 *
 * The desired set is, on the partitioned layout, every `indexed: true` field
 * (btree on the compiler's expression, or GIN `jsonb_path_ops` for list and
 * json fields), the engine's timestamp and tombstone indexes, and the declared
 * `indexes`, all on the type's partition. On the legacy layout it is only the
 * declared `indexes`, as partial indexes on `rows` scoped to the type.
 *
 * Each desired index is compared, by name, with what the catalog holds:
 * identical is kept; same table, uniqueness and key fields but a different
 * expression or predicate is swapped (built under a temporary name, the old one
 * dropped only once the new one is valid and ready, then renamed, so a unique
 * index is enforced throughout); anything else is refused. Definitions are
 * compared as pg deparses them: the desired ones are deparsed by building them
 * on an empty temp table first.
 *
 * Builds run CONCURRENTLY, so never inside a transaction, and under the
 * migration lock, which serialises them with migrations and other boots.
 */

import { createHash } from 'node:crypto';
import type { FieldDef, IndexDecl } from '@mnmal-ai/substrate-types';
import type { Sql } from 'postgres';
import { MAX_IDENTIFIER, type StorageLayout } from './layout.js';
import { dropIndexIfInvalid, generatedIdentifier, withMigrationLock } from './migrate.js';
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
  state: 'valid' | 'building' | 'invalid' | 'failed';
  outcome: 'created' | 'adopted' | 'swapped' | 'unchanged';
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
}

/** Marks an index this reconciler built or adopted. */
const MARK = 'substrate: reconciled';
const BARE_NAME = /^[a-z_][a-z0-9_]*$/;

/**
 * Reconciles the type's indexes and reports each one. On the partitioned layout
 * the type's partition must exist (`ensureTypeStorage`). Must not be called
 * while this session's pool already holds the migration lock on another
 * connection, since it waits for that lock.
 */
export async function reconcileTypeIndexes(
  sql: Sql,
  args: ReconcileTypeIndexesArgs
): Promise<IndexState[]> {
  const specs = desiredSpecs(args);
  if (specs.length === 0) return [];
  const target = await targetTable(sql, args);
  return withMigrationLock(sql, async (conn) => {
    const desired = await deparse(conn, specs);
    const out: IndexState[] = [];
    for (const [i, spec] of specs.entries()) {
      out.push(await reconcileOne(conn, args, target, spec, desired[i] as Described));
    }
    return out;
  });
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
  const btree = (decl: IndexDecl, name: string, withoutId = false): Spec => {
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
      } else {
        // Dates are read newest first, which a backward scan of an ASC index
        // cannot serve: it would put NULLs first, and orderBy puts them last.
        const dir = def.kind === 'scalar' && def.type === 'date' ? 'desc' : 'asc';
        specs.push(
          btree({ fields: [{ field, dir }] }, generatedIdentifier(namespace, type, field, 'idx'))
        );
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
  desired: Described
): Promise<IndexState> {
  const report = (state: IndexState['state'], outcome: IndexState['outcome']): IndexState => ({
    name: spec.name,
    fields: spec.fields,
    unique: spec.unique,
    state,
    outcome
  });
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
    if (leftover !== undefined) await dropConcurrently(conn, swapName);
    if (named?.marked === true) return report('valid', 'unchanged');
    await mark(conn, spec.name);
    return report('valid', 'adopted');
  }

  // A valid __swap with no index under the name is what an interrupted swap
  // leaves, and it may be the only thing enforcing uniqueness, so it counts as
  // the existing index and is dropped only once its replacement is valid.
  const existing = named ?? leftover;
  if (existing === undefined) {
    const built = await build(conn, args, target, spec, spec.name);
    if (built !== undefined) return report(built, 'unchanged');
    await mark(conn, spec.name);
    return report(await stateOf(conn, spec.name), 'created');
  }

  // Key columns are identified by field name, so a body-keyed index on a
  // field promoted since swaps onto the column rather than conflicting. A
  // trailing `id` is not part of the identity, so an index without it swaps.
  const fieldOf = new Map(
    Object.entries(args.promotedColumns ?? {}).map(([field, meta]) => [meta.column, field])
  );
  const keyIdentity = (d: Described): string => {
    const keys = d.keyFields.map((k) => fieldOf.get(k) ?? k);
    if (keys.length > 1 && keys.at(-1) === 'id') keys.pop();
    return keys.join('\n');
  };
  // Swappable when only the expression text or the predicate differs.
  if (
    !(
      existing.table === target &&
      existing.unique === desired.unique &&
      keyIdentity(existing) === keyIdentity(desired)
    )
  ) {
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
      const built = await build(conn, args, target, spec, spec.name);
      if (built !== undefined) return report(built, 'unchanged');
      await dropConcurrently(conn, swapName);
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
    if (leftover !== undefined) await dropConcurrently(conn, swapName);
    const built = await build(conn, args, target, spec, swapName);
    if (built !== undefined) return report(built, 'unchanged');
  }
  // A successful CREATE INDEX CONCURRENTLY returns only once the index is
  // valid and ready, so the old one can go.
  await dropConcurrently(conn, spec.name);
  await conn.unsafe(`ALTER INDEX ${swapName} RENAME TO ${spec.name}`);
  await mark(conn, spec.name);
  return report(await stateOf(conn, spec.name), 'swapped');
}

/**
 * Builds `spec` as `name` CONCURRENTLY, refusing a unique one over duplicate
 * live values. Returns `'failed'` when a non-unique build fails, which costs
 * only a scan until the next reconcile retries it; a unique one throws.
 */
async function build(
  conn: Sql,
  args: ReconcileTypeIndexesArgs,
  target: string,
  spec: Spec,
  name: string
): Promise<'failed' | undefined> {
  if (spec.unique) await assertNoDuplicates(conn, args, target, spec);
  // No lock_timeout: CONCURRENTLY takes SHARE UPDATE EXCLUSIVE, which a
  // queued request holds against DDL and VACUUM only, never readers or
  // writers, so waiting stalls nobody; a timeout would only leave an
  // INVALID index behind. The same holds for DROP INDEX CONCURRENTLY and
  // for ALTER INDEX RENAME and COMMENT ON INDEX, which take that lock on
  // the index alone.
  try {
    await conn.unsafe(createSql(spec, target, name, true));
    return undefined;
  } catch (err) {
    if (spec.unique) throw err;
    process.stderr.write(
      `index ${name} on ${target} failed to build and will be retried: ` +
        `${err instanceof Error ? err.message : String(err)}\n`
    );
    return 'failed';
  }
}

async function dropConcurrently(conn: Sql, name: string): Promise<void> {
  await conn.unsafe(`DROP INDEX CONCURRENTLY IF EXISTS ${name}`);
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

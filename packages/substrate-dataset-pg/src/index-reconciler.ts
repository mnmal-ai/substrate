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
 * identical is kept; same table, uniqueness, key fields and predicate but a
 * different definition is swapped (built under a temporary name, the old one
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
import { indexExpressionSql, sqlStringLiteral } from './pg-sql/primitives.js';
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

/**
 * An index of the declared name exists with a definition the reconciler may
 * not replace. `name` is that index's name, as the error contract states.
 */
export class IndexDefinitionConflictError extends Error {
  readonly code = 'index_definition_conflict';
  constructor(
    override readonly name: string,
    readonly existing: string,
    readonly declared: string
  ) {
    super(
      `index ${name} exists with a different definition.\n  existing: ${existing}\n  declared: ${declared}`
    );
  }
}

export interface ReconcileTypeIndexesArgs {
  namespace: string;
  type: string;
  layout: StorageLayout;
  fields: Record<string, FieldDef>;
  indexes: IndexDecl[];
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

function keyExpr(field: string, def: FieldDef | undefined): string {
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
  const live =
    layout === 'legacy'
      ? `namespace = ${sqlStringLiteral(namespace)} AND type = ${sqlStringLiteral(type)} AND deleted_at IS NULL`
      : 'deleted_at IS NULL';
  const specs: Spec[] = [];
  const btree = (decl: IndexDecl, name: string): Spec => {
    const cols = decl.fields.map((f) => (typeof f === 'string' ? { field: f, dir: 'asc' } : f));
    const keys = cols.map((c) => keyExpr(c.field, fields[c.field]));
    let predicate = live;
    if (decl.where !== undefined && decl.where !== 'live') {
      for (const [f, v] of Object.entries(decl.where)) {
        const def = fields[f];
        predicate +=
          v === null
            ? ` AND ${keyExpr(f, def)} IS NULL`
            : typeof v === 'number'
              ? ` AND ${indexExpressionSql('number', f)} = ${v}`
              : ` AND ${indexExpressionSql('text', f)} = ${sqlStringLiteral(String(v))}`;
      }
    }
    const colSql = keys.map((k, i) => `(${k})${cols[i]?.dir === 'desc' ? ' DESC NULLS LAST' : ''}`);
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
        specs.push(btree({ fields: [field] }, generatedIdentifier(namespace, type, field, 'idx')));
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
      base('created_at', `USING btree (created_at DESC NULLS LAST) WHERE ${live}`),
      base('updated_at', `USING btree (updated_at DESC NULLS LAST) WHERE ${live}`),
      base('deleted_at', 'USING btree (deleted_at) WHERE deleted_at IS NOT NULL')
    );
  }
  for (const decl of args.indexes) {
    const keyNames = decl.fields.map((f) => (typeof f === 'string' ? f : f.field));
    const name =
      decl.name ??
      generatedIdentifier(
        namespace,
        type,
        keyNames.join('_'),
        decl.unique === true ? 'uniq' : 'idx'
      );
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
  /** Per key column, the body fields it reads (or its text when it reads none). */
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
      const lits = [...c.matchAll(/->>? ('(?:[^']|'')*')::text/g)].map((m) => m[1]);
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

  const existing = await describeIndex(conn, spec.name, 'current');
  const identical = (d: Described | undefined): boolean =>
    d !== undefined && d.table === target && d.def === desired.def;

  if (identical(existing)) {
    if (existing?.marked === true) return report('valid', 'unchanged');
    await mark(conn, spec.name);
    return report('valid', 'adopted');
  }

  const swapping = existing !== undefined;
  if (
    swapping &&
    !(
      existing.table === target &&
      existing.unique === desired.unique &&
      existing.predicate === desired.predicate &&
      existing.keyFields.join('\n') === desired.keyFields.join('\n')
    )
  ) {
    throw new IndexDefinitionConflictError(
      spec.name,
      existing.def.replace(/^(CREATE (?:UNIQUE )?INDEX) /, `$1 ${spec.name} ON ${existing.table} `),
      createSql(spec, target)
    );
  }

  // A valid build left under the temporary name by an interrupted swap is
  // reused when it is what is declared, and dropped otherwise.
  const leftover = await describeIndex(conn, swapName, 'current');
  const reuse = identical(leftover);
  if (leftover !== undefined && !reuse) {
    await conn.unsafe(`DROP INDEX CONCURRENTLY IF EXISTS ${swapName}`);
  }

  if (!reuse) {
    const buildName = swapping ? swapName : spec.name;
    if (spec.unique) await assertNoDuplicates(conn, args, target, spec);
    // No lock_timeout: CONCURRENTLY takes SHARE UPDATE EXCLUSIVE, which a
    // queued request holds against DDL and VACUUM only, never readers or
    // writers, so waiting stalls nobody; a timeout would only leave an
    // INVALID index behind. The same holds for DROP INDEX CONCURRENTLY and
    // for ALTER INDEX RENAME and COMMENT ON INDEX, which take that lock on
    // the index alone.
    try {
      await conn.unsafe(createSql(spec, target, buildName, true));
    } catch (err) {
      // A unique index that cannot be built fails the boot; any other index
      // only costs a scan until the next reconcile retries it.
      if (spec.unique) throw err;
      process.stderr.write(
        `index ${buildName} on ${target} failed to build and will be retried: ` +
          `${err instanceof Error ? err.message : String(err)}\n`
      );
      return report('failed', swapping ? 'swapped' : 'created');
    }
  }

  if (!swapping) {
    if (reuse) await conn.unsafe(`ALTER INDEX ${swapName} RENAME TO ${spec.name}`);
    await mark(conn, spec.name);
    return report(await stateOf(conn, spec.name), reuse ? 'swapped' : 'created');
  }

  // The old index keeps enforcing until the new one is valid and ready.
  for (let i = 0; ; i++) {
    const built = await describeIndex(conn, swapName, 'current');
    if (built?.valid === true && built.ready) break;
    if (i >= 100)
      throw new Error(`index ${swapName} did not become valid; ${spec.name} left in place`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await conn.unsafe(`DROP INDEX CONCURRENTLY IF EXISTS ${spec.name}`);
  await conn.unsafe(`ALTER INDEX ${swapName} RENAME TO ${spec.name}`);
  await mark(conn, spec.name);
  return report(await stateOf(conn, spec.name), 'swapped');
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

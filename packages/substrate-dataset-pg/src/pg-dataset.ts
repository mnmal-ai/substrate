/**
 * PgDataset — PostgreSQL-backed reference implementation of Dataset.
 * Spec: §4.5, §5.2.
 *
 * One instance per namespace; each type's rows live in a table of their own
 * (`type-table.ts`), keyed by id. The caller owns the `postgres` Sql
 * connection — this class never opens or closes pools.
 *
 * Reserved field policy (mirrors MemoryDataset):
 *   - `_deletedAt` is managed exclusively by tombstone() / purge().
 *   - write() strips `_deletedAt` (including explicit null) from inputs before
 *     persisting; the column is the only source of truth on read.
 *   - updateField() with fieldName === '_deletedAt' throws ReservedField.
 *
 * Id-type preservation: `Id` is `string | number`. The PK column is `text`
 * (so we can coerce either shape through one column), but the *original*
 * runtime type is mirrored inside `extra.id` during write() and read back out
 * on read() — this keeps numeric ids round-tripping as numbers.
 *
 * Filter contract (§5.2): where / orderBy / cursor are translated to SQL via
 * postgres.js tagged templates — every caller-supplied value goes through
 * parameterised interpolation. Never string-concatenate user input into the
 * clause; that's the one SQL-injection surface in this file.
 */

import {
  applyExtensionResultMeta,
  decodeCursor,
  type ExtensionOpResultMeta,
  encodeCursor,
  fieldRequested,
  fullBuiltinOperators,
  preResolveExtensionOperatorsDetailed
} from '@mnmal-ai/substrate-filter';
import type {
  ActorIdentity,
  ConditionalUpdateResult,
  Dataset,
  DeleteResult,
  DropResult,
  FieldDef,
  FilterCapabilities,
  FilterWriteOptions,
  FilterWriteResult,
  Id,
  IndexDecl,
  IndexPlan,
  OrderedBy,
  PromotionEvent,
  ReadParams,
  ReadResult,
  Row,
  RowMetadata,
  StorageReport,
  TxScopeHandles,
  TypeStats,
  TypeStorageReport,
  UpdateFieldRef,
  WhereClause,
  WriteOptions,
  WriteResult,
  WriteRow
} from '@mnmal-ai/substrate-types';
import {
  assertNoRepeatedIds,
  filterTooBroad,
  isColumnField,
  naturalOrderOf,
  QUERY_TIMEOUT,
  ResolverFrameError
} from '@mnmal-ai/substrate-types';
import type { MaybeRow, PendingQuery, ReservedSql, Sql, TransactionSql } from 'postgres';
import { withPgAdvisoryLock } from './advisory-lock.js';
import type { DiskGuard } from './disk-guard.js';
import { NamespaceMismatch, ReservedField } from './errors.js';
import {
  describeTypeIndexes,
  desiredIndexKeys,
  type HeldIndex,
  heldIndexes,
  IndexDropRefusedError,
  type IndexState,
  isEngineOwned,
  pendingIndexBuilds,
  type ReconcileTypeIndexesArgs,
  reconcileTypeIndexes,
  typeIndexesOf,
  undeclaredIndexes
} from './index-reconciler.js';
import { detectLayout, ident, type StorageLayout } from './layout.js';
import { IndexLockAborted, UnsupportedStoreLayoutError, withTableIndexLock } from './migrate.js';
import type { PgEdgesStore } from './pg-edges-store.js';
import { PgShortIdStore, parseShortId } from './pg-short-id-store.js';
import {
  buildFrameAggregate,
  buildFrameCount,
  buildWalkAgg,
  buildWalkProjection,
  prepareWindows
} from './pg-sql/aggregate.js';
import { fieldExprSql, sqlStringLiteral } from './pg-sql/primitives.js';
import {
  buildDerive,
  prepareSharedPicks,
  tableLookup,
  walkScope,
  walkTypes,
  whereUsesWalks,
  withCtes
} from './pg-sql/walk.js';
import {
  assembleRowMetadata,
  type BodyOrderByCast,
  buildCursorCompare,
  buildCursorNullTail,
  buildOrderBy,
  buildProjectedOrderBy,
  buildRowProjection,
  buildSortKeyProjection,
  buildWhere,
  combineAnd,
  conditionalMatchFragment,
  type Fragment,
  idToText,
  normalizeOrderBy,
  resolveBodyOrderByCast,
  whereReferencesField
} from './pg-sql.js';
import {
  isTransientPromotionError,
  PROMOTION_FAILED_AFTER,
  promotePendingFields
} from './promote.js';
import { decodeRow, encodeRow, RAW_KEY } from './row-codec.js';
import { type PgHandle, txScopeIdFor } from './tx-scope.js';
import {
  absentTypeTable,
  dropTableCache,
  ensureTypeTable,
  listenTableCache,
  loadTypeTable,
  mayCache,
  type TableCache,
  type TypeTable,
  tableCacheFor,
  typeTableOf
} from './type-table.js';
import { UUID_CHECK_MIGRATION } from './uuid-check.js';
import {
  assertReadCommitted,
  GUARDED_ATTEMPTS,
  guardCte,
  guardedRead,
  guardedRows,
  inputCte,
  mergeAssignments,
  type ReadGuardEntry,
  type RowToWrite,
  returnedRowSql,
  setList,
  shortIdJoinSql,
  writeRowsStatement
} from './write-rows.js';

// The pool-owned instance holds `Sql`; tx-scoped instances hold the
// `TransactionSql` from `sql.begin(fn)`. Only `Sql` exposes `begin`, so that
// access is gated behind `#inTx`.

/**
 * Returns the declared FieldDef for a type's field, or undefined when unknown
 * (body-key sorts then fall back to text compare). Lets the SQL builders cast
 * body values by declared kind, so `count` sorts 2 before 10 — see
 * `resolveBodyOrderByCast`.
 */
export type FieldDefLookup = (type: string, field: string) => FieldDef | undefined;

/**
 * A type's declared fields and indexes, or undefined when the type is unknown.
 * Called with the asking dataset's namespace, so a `forNamespace` clone that
 * inherits the lookup resolves its own types.
 */
export type TypeDefLookup = (
  type: string,
  namespace: string
) =>
  | {
      fields: Record<string, FieldDef>;
      indexes?: IndexDecl[];
      orderedBy?: OrderedBy;
      ordering?: 'visible';
      expectedSize?: 'small' | 'large';
    }
  | undefined;

export interface PgDatasetOptions {
  namespace: string;
  sql: Sql;
  /**
   * Optional sibling `PgEdgesStore` to enlist into this dataset's substrate
   * transactions. When supplied, MUST share the same `Sql` pool (verified
   * via `txScopeId === txScopeIdFor(sql)`); the dataset throws on
   * construction otherwise.
   *
   * When supplied, `withScopedTransaction` yields a tx-bound edges store
   * on the same `TransactionSql` as the tx-bound datasets. When omitted, it
   * yields `edges: null` and the engine runs edge ops in a separate tx.
   */
  edgesStore?: PgEdgesStore;
  /**
   * Optional field-def lookup so orderBy + cursor compares on body fields can
   * cast to the declared scalar pg type (numeric / timestamptz / boolean)
   * instead of falling back to lexicographic text compare. When omitted, every
   * body-key orderBy compares as text.
   *
   * A cast sort cannot use an index on the uncast `(body ->> 'field')`
   * expression; it needs a matching cast expression index.
   */
  fieldDefLookup?: FieldDefLookup;
  /**
   * The namespace's type definitions, which `ensureTypeStorage` builds the
   * type's indexes from. Without it only the engine's own indexes are built.
   */
  typeDefLookup?: TypeDefLookup;
  /**
   * Checked before each non-unique index build `ensureTypeStorage` runs; a
   * refused build stays `pending` (`insufficient_disk`) until a later pass.
   * Without one nothing is checked. With one that has no path, nothing is
   * checked either, and `storageReport` says so.
   */
  diskGuard?: DiskGuard;
  /**
   * The statement timeout a walk read runs under, in ms (default
   * `WALK_STATEMENT_TIMEOUT_MS`). A read it cancels is refused as
   * `query_timeout`.
   */
  statementTimeoutMs?: number;
}

interface InternalPgSubstrateDatasetOptions {
  namespace: string;
  sql: PgHandle;
  inTx: boolean;
  /**
   * Tx-bound instances reuse the root's txScopeId so one substrate never
   * advertises two ids. The public constructor derives it from the Sql.
   */
  txScopeId?: string;
  edgesStore?: PgEdgesStore;
  fieldDefLookup?: FieldDefLookup;
  /** Shared with the instance this one was derived from. */
  layoutCache?: LayoutCache;
  typeDefLookup?: TypeDefLookup;
  diskGuard?: DiskGuard;
  statementTimeoutMs?: number;
  /** The pool's type-table cache, shared with the instance this one was derived from. */
  tableCache?: TableCache;
  /** The enclosing transaction's tables, which enter `tableCache` on commit only. */
  txTables?: TxTables;
}

/**
 * The tables a transaction loaded or created, each with the cache generation
 * it was loaded at. They enter the pool's cache when the transaction commits,
 * so a rolled-back CREATE or ALTER is never cached (F18).
 */
/**
 * A transaction's descriptors. `snapshot`: loaded for a non-READ COMMITTED
 * transaction's own snapshot (`null`: no table there), which never reaches
 * the pool's cache.
 */
type TxTables = Map<string, { table: TypeTable | null; gen: number; snapshot?: true }>;

/**
 * Marks every descriptor a transaction loaded `snapshot` unless it ran READ
 * COMMITTED: under REPEATABLE READ or SERIALIZABLE a load (a miss included)
 * shows the transaction's snapshot, which can predate a catalog change whose
 * notification has already landed, so it must not reach the pool's cache.
 * Asks only when something would be cached.
 */
async function snapshotUnlessReadCommitted(tx: TransactionSql, txTables: TxTables): Promise<void> {
  const entries = [...txTables.values()].filter((e) => e.snapshot !== true && e.gen >= 0);
  if (entries.length === 0) return;
  const [row] = await tx<
    Array<{ iso: string }>
  >`SELECT current_setting('transaction_isolation') AS iso`;
  if (row?.iso === 'read committed') return;
  for (const e of entries) e.snapshot = true;
}

/** {@link preResolveExtensionOperatorsDetailed}, as a read's attempts share it. */
type ResolveWhere = typeof preResolveExtensionOperatorsDetailed;

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

/** The store's layout once migrated, shared by an instance and every clone of it. */
interface LayoutCache {
  layout?: StorageLayout;
}

const RESERVED_DELETED_AT = '_deletedAt';

/** The `updatedBy` a write without an actor stamps. */
const ANONYMOUS: ActorIdentity = { kind: 'system', id: 'anonymous' };

/** A written row as {@link guardedRows} returns it: `id` null on the row carrying `ok` alone. */
type GuardedRecord = TableRowRecord & { ok: boolean; iso: string };

/** A read whose statement found one of its tables past the version it was built for. */
class StaleRead {
  constructor(
    readonly types: readonly string[],
    /** The transaction's isolation level, as the statement saw it. */
    readonly iso: string
  ) {}
}

/** A type-table row as returned for `decodeRow`: `extra` and its columns. */
type TableRowRecord = {
  id: string;
  extra: Record<string, unknown>;
  deleted_at: Date | null;
  /** From short_ids; null when no binding exists. */
  short_id: number | null;
  // Row-metadata columns. NULL for legacy rows.
  created_at: Date | null;
  updated_at: Date | null;
  created_by_kind: string | null;
  created_by_id: string | null;
  updated_by_kind: string | null;
  updated_by_id: string | null;
  /** bigint as a string; null off visible-order types. */
  seq: string | null;
};

/**
 * `dropEngineIndex`'s bound on each lock wait. A request transaction ends in
 * well under this; one still open after it is a long export or a caller
 * waiting on the drop itself, and the drop holds the table's index-build lock
 * and two connections while it waits, so it gives up and the caller retries.
 */
const DROP_LOCK_TIMEOUT_MS = 10_000;

/** Rows per `purgeTombstonedRows` statement. A test seam, not exported from the package. */
export const purgeBatch = { size: 10_000 };

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

export class PgDataset implements Dataset {
  readonly namespace: string;
  // Full builtin operator set — everything the validator recognises.
  readonly capabilities: FilterCapabilities = {
    operators: fullBuiltinOperators(),
    orderBy: true,
    cursor: true,
    walks: true
  };

  readonly txScopeId: string;

  readonly #sql: PgHandle;
  readonly #inTx: boolean;
  readonly #shortIds: PgShortIdStore;
  readonly #edgesStore: PgEdgesStore | null;
  /** Stored so tx-bound and forNamespace clones inherit it. */
  readonly #fieldDefLookup: FieldDefLookup | null;
  readonly #layoutCache: LayoutCache;
  readonly #typeDefLookup: TypeDefLookup | null;
  readonly #diskGuard: DiskGuard | undefined;
  readonly #statementTimeoutMs: number;
  readonly #tableCache: TableCache;
  readonly #txTables: TxTables | null;

  constructor(options: PgDatasetOptions | InternalPgSubstrateDatasetOptions) {
    this.namespace = options.namespace;
    this.#sql = options.sql;
    // `inTx` is only set via the internal options shape; the public
    // constructor always produces a non-tx instance.
    this.#inTx = 'inTx' in options ? options.inTx : false;
    // Tx-bound datasets inherit their parent's txScopeId.
    const explicit = 'txScopeId' in options ? options.txScopeId : undefined;
    this.txScopeId = explicit ?? txScopeIdFor(options.sql);
    this.#shortIds = new PgShortIdStore(this.#sql);
    // An edges store from a different Sql pool cannot share a transaction.
    const edgesOpt = options.edgesStore;
    if (edgesOpt !== undefined && edgesOpt.txScopeId !== this.txScopeId) {
      throw new Error(
        `PgDataset: edgesStore txScopeId '${edgesOpt.txScopeId}' does not match dataset txScopeId '${this.txScopeId}' — both must wrap the same Sql pool`
      );
    }
    this.#edgesStore = edgesOpt ?? null;
    this.#fieldDefLookup = options.fieldDefLookup ?? null;
    this.#layoutCache = ('layoutCache' in options ? options.layoutCache : undefined) ?? {};
    this.#typeDefLookup = options.typeDefLookup ?? null;
    this.#diskGuard = options.diskGuard;
    this.#statementTimeoutMs = options.statementTimeoutMs ?? WALK_STATEMENT_TIMEOUT_MS;
    this.#tableCache =
      ('tableCache' in options ? options.tableCache : undefined) ?? tableCacheFor(options.sql);
    this.#txTables = ('txTables' in options ? options.txTables : undefined) ?? null;
  }

  /**
   * `type`'s table, or undefined when it has none yet (or the store is not
   * migrated). Cached per pool (see `TableCache`); inside a transaction, in
   * the transaction's own map until it commits. `read` marks a read path, which
   * trusts a cached miss inside a transaction too.
   */
  async #tableFor(
    type: string,
    namespace = this.namespace,
    read = false
  ): Promise<TypeTable | undefined> {
    if ((await this.#layout()) === 'absent') return undefined;
    const key = `${namespace}/${type}`;
    const local = this.#txTables?.get(key);
    // A miss this transaction recorded binds its writes only when read through its snapshot.
    if (local !== undefined && (local.table !== null || read || local.snapshot === true)) {
      return local.table ?? undefined;
    }
    const cache = this.#tableCache;
    const listening = await this.#listen();
    const hit = cache.tables.get(key);
    // A write does not trust a cached miss inside a transaction: a
    // check-then-write there must see a table another transaction has just
    // committed, before its notification lands. A read trusts it, as outside one.
    if (hit !== undefined && (hit !== null || read || !this.#inTx)) return hit ?? undefined;
    const gen = cache.gen;
    const table = await loadTypeTable(this.#sql, namespace, type);
    // A miss is cached too, so a never-written type reads without a catalog
    // query; its creation's notification drops it, as it drops a table.
    this.#remember(key, table ?? null, gen, listening);
    return table;
  }

  /** {@link #tableFor}, creating the type's table when it has none (first write). */
  async #writeTable(type: string): Promise<TypeTable> {
    const found = await this.#tableFor(type);
    if (found !== undefined) return found;
    let gen = this.#tableCache.gen;
    const def = this.#typeDefLookup?.(type, this.namespace);
    const args = {
      namespace: this.namespace,
      type,
      fields: def?.fields ?? {},
      newFields: 'column' as const,
      enforceUuidCheck: await this.#uuidCheck(),
      // Create a missing table, never reconcile one: this miss may be stale,
      // and this process's def older than the one the table was made from.
      createOnly: true
    };
    // In a caller's transaction the DDL joins it under a savepoint (F18), so a
    // failure there leaves the caller's transaction usable. Its type-table
    // advisory lock is then held until that transaction ends, so two
    // transactions making first writes of two new types in opposite orders can
    // deadlock; pg detects it (40P01) and aborts one. By F18's design.
    const key = `${this.namespace}/${type}`;
    if (this.#inTx) {
      await (this.#sql as TransactionSql).savepoint((sp) => ensureTypeTable(sp, args));
    } else {
      await ensureTypeTable(this.#sql, args);
      // Committed: a cached miss must not outlive it until the notification
      // lands, nor be cached again by a read whose catalog lookup began before
      // the commit, which the new generation refuses.
      gen = dropTableCache(this.#tableCache, key);
    }
    const table = await loadTypeTable(this.#sql, this.namespace, type);
    if (table === undefined) throw new Error(`internal: ${this.namespace}/${type} has no table`);
    this.#remember(key, table, gen, await this.#listen());
    return table;
  }

  /** Caches `table` (`null`: none yet); inside a transaction in its own map, until it commits. */
  #remember(key: string, table: TypeTable | null, gen: number, listening: boolean): void {
    if (this.#inTx) {
      // -1 never matches, so a table loaded without a listener never enters the cache.
      this.#txTables?.set(key, { table, gen: listening ? gen : -1 });
    } else if (listening && mayCache(this.#tableCache, key, gen)) {
      this.#tableCache.tables.set(key, table);
    }
  }

  /**
   * Runs `write`, a statement built for `table` that answers
   * {@link guardedRows}, and returns its rows with the table they were
   * written through. Built from a stale descriptor it writes nothing: the
   * descriptor is dropped, reloaded and the write rebuilt and run again, up to
   * {@link GUARDED_ATTEMPTS} in all (a sweep promoting several fields bumps the
   * version once per step). Then it throws, so a write is never silently
   * misplaced; outside READ COMMITTED it throws at once.
   */
  async #guarded<R extends { ok: boolean; iso: string; id: string | null }>(
    type: string,
    table: TypeTable,
    write: (table: TypeTable) => Promise<R[]>
  ): Promise<{ table: TypeTable; records: R[] }> {
    let current = table;
    for (let attempt = 1; ; attempt++) {
      const records = await write(current);
      if (records[0]?.ok === true) {
        return { table: current, records: records.filter((r) => r.id !== null) };
      }
      assertReadCommitted(records[0], `${this.namespace}/${type}`);
      if (attempt >= GUARDED_ATTEMPTS) {
        throw new Error(
          `${this.namespace}/${type}: its catalog changed on each of ${GUARDED_ATTEMPTS} attempts at a write; nothing was written`
        );
      }
      this.#forget(type);
      const fresh = await this.#tableFor(type);
      if (fresh === undefined) throw new Error(`internal: ${this.namespace}/${type} has no table`);
      current = fresh;
    }
  }

  /** Drops `type`'s descriptor from the transaction's map and the pool's cache. */
  #forget(type: string): void {
    const key = `${this.namespace}/${type}`;
    this.#txTables?.delete(key);
    dropTableCache(this.#tableCache, key);
  }

  /** Starts the pool's catalog LISTEN; resolves false when it cannot (see `listenTableCache`). */
  #listen(): Promise<boolean> {
    return listenTableCache(this.#tableCache);
  }

  /** Whether new type tables take the opt-in UUID CHECK: the store applied that migration. */
  async #uuidCheck(): Promise<boolean> {
    const cache = this.#tableCache;
    if (cache.uuidCheck === undefined) {
      const [row] = await this.#sql<Array<{ on: boolean }>>`
        SELECT EXISTS (SELECT 1 FROM migrations WHERE version = ${UUID_CHECK_MIGRATION}) AS on`;
      if (row?.on === true) cache.uuidCheck = true;
    }
    return cache.uuidCheck === true;
  }

  /**
   * Moves a committed transaction's tables into the pool's cache, unless a
   * notification intervened; then drops the entry, which may be a miss the
   * transaction's own create made stale.
   */
  #commitTables(txTables: TxTables): void {
    const cache = this.#tableCache;
    for (const [key, { table, gen, snapshot }] of txTables) {
      if (snapshot === true) continue;
      if (mayCache(cache, key, gen)) cache.tables.set(key, table);
      else cache.tables.delete(key);
    }
  }

  /**
   * Reads rows of `type` per the §5.2 filter contract (where / orderBy /
   * cursor / limit). Every value is bound through a parameterised slot.
   *
   * The walk grammar (spec 2026-10-24-typed-edge-walks §3) runs in a
   * transaction under a `SET LOCAL` statement timeout, since pg has no walk
   * evaluation budget. Other reads are unchanged.
   */
  async read(type: string, params: ReadParams): Promise<ReadResult> {
    if (!usesWalkGrammar(params)) {
      try {
        return await this.#read(type, params, false);
      } catch (err) {
        // A role- or database-level statement_timeout: its value is not known here.
        throw this.#queryTimeout(type, err, params.signal) ?? err;
      }
    }
    if (!this.#inTx) return this.withTransaction((tx) => tx.read(type, params));
    // LOCAL, so it ends with the transaction (the caller's included), and only
    // ever lowers: a shorter timeout already in effect stays. `setting` is ms.
    const ms = String(this.#statementTimeoutMs);
    let lowered = false;
    try {
      // A row comes back only when this set_config lowered the timeout.
      const set = await cancellable(
        this.#sql`
        SELECT set_config('statement_timeout', ${ms}, true) FROM pg_settings
        WHERE name = 'statement_timeout' AND (setting::bigint = 0 OR setting::bigint > ${ms}::bigint)`,
        params.signal
      );
      lowered = set.length > 0;
      return await this.#read(type, params, true);
    } catch (err) {
      throw (
        this.#queryTimeout(
          type,
          err,
          params.signal,
          lowered ? this.#statementTimeoutMs : undefined
        ) ?? err
      );
    }
  }

  /**
   * A statement-timeout cancel (57014) as `query_timeout`, else null.
   * `cancellable` already swaps a caller's abort for its reason, and the
   * signal check keeps one that races the cancel an abort. 57014 also covers an
   * operator's cancel, so the message does not claim a timeout. `timeoutMs` is
   * omitted when the limit is not known to be substrate's own.
   */
  #queryTimeout(
    type: string,
    err: unknown,
    signal: AbortSignal | undefined,
    timeoutMs?: number
  ): ResolverFrameError | null {
    if ((err as { code?: unknown } | null)?.code !== '57014' || signal?.aborted === true) {
      return null;
    }
    return new ResolverFrameError(
      QUERY_TIMEOUT,
      `${this.namespace}/${type}: the read was cancelled by the server (statement timeout or cancel)` +
        (timeoutMs !== undefined ? `; the limit is ${timeoutMs} ms` : ''),
      timeoutMs !== undefined ? { timeoutMs } : undefined
    );
  }

  /**
   * {@link #readOnce}, run again with fresh descriptors while its statement
   * finds a table it decodes past the version it was built for (a field moved
   * out of `extra` since), up to {@link GUARDED_ATTEMPTS} in all; then throws.
   * The where's extension operators resolve once, on the first attempt that
   * needs them, so a retry repeats no kNN lookup or embedding.
   */
  async #read(type: string, params: ReadParams, walks: boolean): Promise<ReadResult> {
    let resolved: ReturnType<typeof preResolveExtensionOperatorsDetailed> | undefined;
    const resolveOnce: ResolveWhere = (where, ctx) => {
      resolved ??= preResolveExtensionOperatorsDetailed(where, ctx);
      return resolved;
    };
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.#readOnce(type, params, walks, resolveOnce);
      } catch (err) {
        if (!(err instanceof StaleRead)) throw err;
        if (attempt >= GUARDED_ATTEMPTS) {
          throw new Error(
            `${this.namespace}/${type}: its catalog changed on each of ${GUARDED_ATTEMPTS} attempts at a read`
          );
        }
        if (this.#inTx && err.iso !== 'read committed') {
          // The pool's descriptor is newer than this transaction's snapshot, and
          // right for every other reader: read through the snapshot's own instead.
          for (const t of err.types) {
            const table = await loadTypeTable(this.#sql, this.namespace, t);
            this.#txTables?.set(`${this.namespace}/${t}`, {
              table: table ?? null,
              gen: -1,
              snapshot: true
            });
          }
        } else {
          for (const t of err.types) this.#forget(t);
        }
      }
    }
  }

  async #readOnce(
    type: string,
    params: ReadParams,
    walks: boolean,
    resolveWhere: ResolveWhere
  ): Promise<ReadResult> {
    const sql = this.#sql;
    const includeDeleted = params.includeDeleted === true;

    const limit =
      typeof params.limit === 'number' && Number.isFinite(params.limit) && params.limit >= 0
        ? Math.floor(params.limit)
        : undefined;

    params.signal?.throwIfAborted();
    // Fast path: limit === 0 returns empty without hitting the db. A count or
    // whole-result aggregate still answers, as memory's does.
    const wholeResult = params.count === true || params.aggregate !== undefined;
    if (limit === 0 && !wholeResult) return { rows: [], hasMore: false };

    const idList: string[] = [];
    let hasIdFilter = false;
    if (params.id !== undefined) {
      idList.push(idToText(params.id));
      hasIdFilter = true;
    }
    if (params.ids !== undefined) {
      for (const id of params.ids) idList.push(idToText(id));
      hasIdFilter = true;
    }

    // The compiler cannot await, so the seed's and every far type's table is
    // loaded first (F19). A type with no table yet reads as an empty one.
    const lookup = this.#fieldDefLookup;
    const fieldDef = (t: string, f: string) => lookup?.(t, f);
    const types = [...(walks ? walkTypes(params, type, fieldDef) : [type])];
    const loaded = await Promise.all(types.map((t) => this.#tableFor(t, this.namespace, true)));
    const tableFor = tableLookup(
      loaded.map((t, i) => t ?? absentTypeTable(this.namespace, types[i] as string))
    );
    const table = tableFor(type);
    // Each statement checks every descriptor it decodes through (M3); an
    // unmigrated store has no catalog to check, and no table to read.
    const guard: ReadGuardEntry[] | null =
      (await this.#layout()) === 'absent'
        ? null
        : types.map((t, i) => ({
            namespace: this.namespace,
            type: t,
            version: loaded[i]?.version ?? null
          }));
    /** `statement`'s rows, but those of a stale read, which throw {@link StaleRead}; `key` is non-null on a real row. */
    const run = async <R extends object>(statement: Fragment, key: keyof R): Promise<R[]> => {
      if (guard === null) return (await cancellable(statement, params.signal)) as unknown as R[];
      const out = await cancellable(guardedRead(sql, guard, statement), params.signal);
      if (out[0]?.guard_ok !== true) throw new StaleRead(types, String(out[0]?.guard_iso));
      return out.filter((r) => r[key as string] !== null) as unknown as R[];
    };

    // Build WHERE fragment incrementally. Use table alias `r` to avoid
    // ambiguity with the short_ids alias `s`.
    const clauses: Fragment[] = [];
    if (hasIdFilter) clauses.push(sql`r.id = ANY(${idList})`);
    if (!includeDeleted) clauses.push(sql`r.deleted_at IS NULL`);
    // Maps a body field's declared kind to the cast applied to its extraction,
    // for both sorting and WHERE. Null when no lookup is wired or the field is
    // undeclared; the builders then infer from the operand.
    const bodyCastFor = this.#castFor(type);

    // Extension-operator side-channel (relevance order, score/vector), applied
    // to the final page below.
    let extMeta: ExtensionOpResultMeta | null = null;
    // One scope per statement, so walk aliases stay unique across where and projection.
    const scope = walks ? walkScope(this.namespace, type, 'r', fieldDef, tableFor) : undefined;
    if (scope !== undefined) {
      // As the plan advisor's `leads`: a full index, the crossRef first, `key` next.
      scope.indexDir = (t, crossRef, key) =>
        desiredIndexKeys(this.#indexArgs(t, this.namespace)).find(
          (i) => i.only === undefined && i.keys[0]?.[0] === crossRef && i.keys[1]?.[0] === key
        )?.keys[1]?.[1];
    }
    const frameAggs = params.agg;
    if (scope !== undefined && frameAggs !== undefined) {
      // shortcut: each `_agg.<name>` reference recomputes its subquery; a
      // LATERAL computed once per seed row would share it, if it ever costs.
      scope.aggValue = (name) => {
        const spec = Object.hasOwn(frameAggs, name) ? frameAggs[name] : undefined;
        if (spec === undefined) throw new Error(`internal: '_agg.${name}' names no frame _agg`);
        return buildWalkAgg(sql, spec, table, scope).value;
      };
    }
    // #1815: shared forms, registered once the where's extension operators
    // are resolved, so their seed filters compile. Joined to the page.
    let windowJoins = sql``;
    // The pick CTEs' LEFT JOINs, which the statement reading the where carries.
    let pickJoins = sql``;
    if (params.where !== undefined) {
      // Resolves extension operators (e.g. embeddingSimilar) to `id IN [...]`
      // clauses before the synchronous SQL builder runs.
      const detailed = await resolveWhere(params.where, {
        namespace: this.namespace,
        type,
        k: limit,
        ...(fieldRequested(params.fields, '_vector') ? { returnVector: true } : {})
      });
      extMeta = detailed.meta;
      if (scope !== undefined) {
        const resolved = { ...params, where: detailed.where };
        const base = { clauses: [...clauses], ids: hasIdFilter };
        // A frame `_agg` window read by every seed is one group-by pass.
        windowJoins = prepareWindows(sql, resolved, base, bodyCastFor, table, scope, (t, field) =>
          desiredIndexKeys(this.#indexArgs(t, this.namespace)).some(
            (i) => i.only === undefined && i.keys[0]?.[0] === field
          )
        );
        // A pick many seeds share through one hub is computed once per hub.
        pickJoins = prepareSharedPicks(sql, resolved, base, bodyCastFor, table, scope);
      }
      const whereFragment = buildWhere(sql, detailed.where, bodyCastFor, table, scope);
      if (whereFragment !== null) clauses.push(whereFragment);
    }

    // A count or whole-result aggregate returns no rows, and ignores any cursor.
    if (wholeResult && scope !== undefined) {
      const matched = combineAnd(sql, clauses);
      if (params.count === true) {
        const [row] = await run<{ n: number }>(
          sql`${withCtes(sql, scope)}${buildFrameCount(sql, matched, scope, pickJoins)}`,
          'n'
        );
        return { rows: [], hasMore: false, count: row?.n ?? 0 };
      }
      const aggregate = params.aggregate ?? {};
      const statement = buildFrameAggregate(sql, aggregate, params.bucket, matched, limit, scope);
      const groups = (
        await run<{ g: Record<string, unknown> }>(sql`${withCtes(sql, scope)}${statement}`, 'g')
      ).map((x) => x.g);
      // Only buckets are cut: memory's single group ignores limit.
      const truncated = params.bucket !== undefined && limit !== undefined && groups.length > limit;
      return {
        rows: [],
        hasMore: false,
        groups: truncated ? groups.slice(0, limit) : groups,
        ...(truncated ? { truncated: true } : {})
      };
    }

    const orderBy = normalizeOrderBy(params.orderBy);

    const orderByCastFor = bodyCastFor;
    // A filter or sort on shortId needs `s.short_id` per candidate, so it
    // joins before LIMIT (see `page` below).
    const joinShortIds =
      whereReferencesField(params.where, 'shortId') || orderBy.some(([f]) => f === 'shortId');

    // A `$<name>` key sorts by its `params.derive` entry. A leading one, which
    // every matched row needs, is computed once per row as a column of a fenced
    // subquery the page reads as `r`, so ORDER BY, the cursor compare and the
    // projected sort key share it. A later one is inlined: an index on the lead
    // then computes it only for the rows it reads.
    // shortcut: with the shortId join the where reads `s`, so there the
    // expression is inlined at each use; fence that join too if it ever costs.
    const derive = params.derive;
    const derivedExpr = (field: string): Fragment | undefined => {
      const name = field.slice(1);
      if (scope === undefined || derive === undefined || !field.startsWith('$')) return undefined;
      const spec = Object.hasOwn(derive, name) ? derive[name] : undefined;
      return spec === undefined ? undefined : buildDerive(sql, name, spec, scope);
    };
    const lead = orderBy[0]?.[0] ?? 'id';
    const fenced = joinShortIds ? undefined : derivedExpr(lead);
    const derivedFor = (field: string): Fragment | undefined =>
      fenced !== undefined && field === lead ? sql`r.__derive_0` : derivedExpr(field);
    // OFFSET 0 keeps the subquery from being flattened back into one evaluation per use.
    const rel = sql.unsafe(table.from);
    const from =
      fenced === undefined
        ? sql`${rel} r${pickJoins}${windowJoins}`
        : sql`(SELECT r.*, ${fenced} AS __derive_0 FROM ${rel} r${pickJoins} WHERE ${combineAnd(sql, clauses)} OFFSET 0) r${windowJoins}`;
    const ctes = withCtes(sql, scope);
    const base = fenced === undefined ? clauses : [];

    // Cursor: a tuple-compare clause so the page starts strictly after the
    // cursor's (orderBy-values, id) tuple. It matches only non-null leading
    // values when the cursor's is non-null; `tailSql` then selects the null
    // tail that sorts after them, read only if the first query falls short.
    let whereSql = combineAnd(sql, base);
    let tailSql: Fragment | null = null;
    if (params.cursor !== undefined && params.cursor !== '') {
      const cursor = decodeCursor(params.cursor, orderBy);
      const cursorFragment = buildCursorCompare(
        sql,
        orderBy,
        cursor.orderByValues,
        cursor.id,
        orderByCastFor,
        table,
        derivedFor
      );
      const tail = buildCursorNullTail(
        sql,
        orderBy,
        cursor.orderByValues,
        orderByCastFor,
        table,
        derivedFor
      );
      if (tail !== null) tailSql = combineAnd(sql, [...base, tail]);
      if (cursorFragment !== null) whereSql = combineAnd(sql, [...base, cursorFragment]);
    }
    const orderBySql = buildOrderBy(sql, orderBy, orderByCastFor, table, derivedFor, 'r');

    // Fetch one extra row to determine hasMore without a count query.
    const fetchLimit = limit !== undefined ? limit + 1 : undefined;

    // Ships only the requested top-level body keys when `fields` is given,
    // else the full body.
    // Walk selections ride in the body, so `materialize` lifts them to the row.
    const walkProjection =
      scope === undefined
        ? null
        : buildWalkProjection(sql, frameAggs, params.nested ?? {}, table, scope);
    const rowProjection = buildRowProjection(sql, table, params.fields, 'r', walkProjection);

    // Projects each sort key so the cursor value comes from the same
    // expression that sorted. A promoted field sorts on its column but
    // materializes from the body; if those disagree, a body-derived cursor
    // value repeats the same page forever.
    const { fragment: sortKeyProjection, aliases: sortKeyAliases } = buildSortKeyProjection(
      sql,
      orderBy,
      bodyCastFor,
      table,
      derivedFor
    );

    // With `joinShortIds`, short_ids joins before LIMIT. Otherwise the page
    // query runs alone, with nothing parallel-restricted in it, and short_ids
    // is probed once per row it returns: the LIMIT keeps the lateral lookup
    // from being flattened into a join that a generic plan may hash over the
    // type's whole short_ids. short_ids_row_uniq_idx makes either form match
    // at most one row. The outer ORDER BY restores the page order over the
    // projected sort keys. A type table's row carries no namespace or type, so
    // its own are selected as literals.
    const owner = sql.unsafe(
      `${sqlStringLiteral(this.namespace)}::text AS namespace, ${sqlStringLiteral(type)}::text AS type`
    );
    const ownerOn = sql.unsafe(
      `s.namespace = ${sqlStringLiteral(this.namespace)} AND s.type = ${sqlStringLiteral(type)}`
    );
    // Inlined so a generic plan costs the page at its real size rather than
    // guessing 10% of the type, which favours a parallel full sort over an
    // index. Safe to inline: `n` derives from `limit`, which is validated and
    // floored above, and `BigInt()` throws on a non-integer.
    const inlineLimit = (n: number | undefined): Fragment =>
      n !== undefined ? sql.unsafe(`LIMIT ${BigInt(n)}`) : sql``;
    // One page query: phase 1 with the cursor compare, or the null tail.
    const statement = (where: Fragment, n: number | undefined) =>
      joinShortIds
        ? sql`
          SELECT r.id, ${rowProjection}, r.deleted_at, s.short_id,
                 r.created_at, r.updated_at,
                 r.created_by_kind, r.created_by_id,
                 r.updated_by_kind, r.updated_by_id, r.seq${sortKeyProjection}
          FROM ${from}
          LEFT JOIN short_ids s
            ON ${ownerOn}
           AND s.row_id = r.id
          WHERE ${where}
          ${orderBySql}
          ${n !== undefined ? sql`LIMIT ${n}` : sql``}
        `
        : sql`
          SELECT p.*, s.short_id
          FROM (
            SELECT r.id, ${rowProjection}, r.deleted_at,
                   r.created_at, r.updated_at,
                   r.created_by_kind, r.created_by_id,
                   r.updated_by_kind, r.updated_by_id, r.seq,
                   ${owner}${sortKeyProjection}
            FROM ${from}
            WHERE ${where}
            ${orderBySql}
            ${inlineLimit(n)}
          ) p
          LEFT JOIN LATERAL (
            SELECT s.short_id FROM short_ids s
            WHERE s.namespace = p.namespace AND s.type = p.type AND s.row_id = p.id
            LIMIT 1
          ) s ON true
          ${buildProjectedOrderBy(sql, orderBy, sortKeyAliases, orderByCastFor, table, 'p')}
        `;
    // The CTEs ride in front only when there are any, so a plain read's text
    // is exactly what it was (callers and tests key on its leading SELECT).
    const page = (where: Fragment, n: number | undefined) =>
      scope?.ctes === undefined || scope.ctes.length === 0
        ? statement(where, n)
        : sql`${ctes}${statement(where, n)}`;

    // Both queries read the same snapshot only inside a REPEATABLE READ or
    // SERIALIZABLE transaction; elsewhere each sees its own.
    let rows = await run<TableRowRecord>(page(whereSql, fetchLimit), 'id');
    if (tailSql !== null && (fetchLimit === undefined || rows.length < fetchLimit)) {
      // A row whose lead turned null after the first query would come back
      // twice; excluding it in SQL keeps the look-ahead row, and so `hasMore`.
      // The residual anomaly is a skip: a row that left the tail in between.
      const unseen = sql`r.id <> ALL(${rows.map((r) => r.id)})`;
      // The full `fetchLimit`, sliced here, so the tail has one statement text
      // per shape rather than one per remaining count.
      // It recomputes the read's CTEs (#1815): a CTE lives for one statement,
      // and the tail runs only when a cursor reaches the null-keyed rows.
      const tail = await run<TableRowRecord>(
        page(combineAnd(sql, [tailSql, unseen]), fetchLimit),
        'id'
      );
      // concat, not push(...): an unlimited tail can exceed the argument limit.
      rows = rows.concat(fetchLimit === undefined ? tail : tail.slice(0, fetchLimit - rows.length));
    }

    const fields = this.#typeDefLookup?.(type, this.namespace)?.fields;
    const materialised = rows.map((r) => this.materialize(r, fields, table, params.fields));
    let hasMore = false;
    let sliced = materialised;
    if (limit !== undefined && materialised.length > limit) {
      hasMore = true;
      sliced = materialised.slice(0, limit);
    }

    const out: ReadResult = { rows: sliced, hasMore };
    const last = sliced[sliced.length - 1];
    // `materialised` is `rows.map(...)`, so index i of one is index i of the
    // other — the raw record is where the projected sort keys live.
    const lastRaw = rows[sliced.length - 1] as Record<string, unknown> | undefined;
    if (hasMore && last !== undefined) {
      out.nextCursor = encodeCursor({
        // Read from the projected `__sort_<n>` keys, never the materialized
        // row, which carries only what the caller projected.
        orderByValues: orderBy
          .filter(([f]) => f !== 'id')
          .map(([field]) => {
            const alias = sortKeyAliases.get(field);
            return alias === undefined ? null : (lastRaw?.[alias] ?? null);
          }),
        id: last.id,
        order: orderBy
      });
    }

    // Relevance reorder applies only when the caller gave no orderBy; test
    // params.orderBy, since the normalized one always has an id tiebreaker.
    if (extMeta !== null) {
      out.rows = applyExtensionResultMeta(out.rows, extMeta, {
        hasExplicitOrderBy: params.orderBy !== undefined && params.orderBy.length > 0,
        fields: params.fields
      });
    }
    return out;
  }

  /**
   * Upsert `rows`. A row without an `id` gets one from the database's
   * `uuidv7()`, returned in `ids` in input order. Limits of a v7 id: it is
   * never a happened-before signal; ids sort in creation order only within one
   * connection (across connections within a millisecond, and for
   * client-supplied ids, order is arbitrary); it reveals its creation time;
   * and deciding who won (last-writer-wins, `conditionalUpdate`) uses the
   * database's transaction time or a per-row version, never the id.
   *
   * A supplied id repeated in one batch: under `insertOnly` the first
   * occurrence lands and the rest are skipped; otherwise the batch is refused.
   *
   * On an `ordering: 'visible'` type each inserted row gets the next `seq`,
   * consecutive in input order, under a per-type transaction lock held until
   * commit, so seq order is commit order. A row that already exists keeps its
   * seq, and one `insertOnly` skips gets none.
   */
  async write(type: string, rows: WriteRow[], options?: WriteOptions): Promise<WriteResult> {
    if (rows.length === 0) return { written: 0, ids: [], rows: [] };
    if (options?.insertOnly !== true) assertNoRepeatedIds(type, rows);

    const visible = this.#typeDefLookup?.(type, this.namespace)?.ordering === 'visible';
    // The seq lock must be held to commit, so it needs a transaction to live in.
    if (visible && !this.#inTx) {
      return this.withTransaction((tx) => tx.write(type, rows, options));
    }

    const table = await this.#writeTable(type);
    const sql = this.#sql;
    if (visible) {
      await sql`SELECT pg_advisory_xact_lock(hashtext('substrate-visible-seq:' || current_schema() || ':' || ${this.namespace} || '/' || ${type}))`;
    }
    return this.#writeRows(type, table, rows, visible, options);
  }

  /** `write` on a type table: one statement whatever the batch size (F41). */
  async #writeRows(
    type: string,
    table: TypeTable,
    rows: WriteRow[],
    visible: boolean,
    options: WriteOptions | undefined
  ): Promise<WriteResult> {
    const sanitised = rows.map((row) => {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(row)) {
        if (k === RESERVED_DELETED_AT || k === '_metadata') continue;
        if (k === 'id' && v == null) continue;
        out[k] = v;
      }
      return out;
    });
    const written = await this.#guarded(type, table, async (t) => {
      const encoded: RowToWrite[] = rows.map((row, k) => ({
        ...encodeRow(t, sanitised[k] as Record<string, unknown>),
        id: row.id == null ? null : idToText(row.id),
        ...(row._metadata != null ? { metadata: row._metadata as RowMetadata } : {})
      }));
      return (await this.#sql`${writeRowsStatement(this.#sql, t, encoded, {
        insertOnly: options?.insertOnly === true,
        visibleOrder: visible,
        metadata: 'stamp',
        actor: options?.identity ?? null,
        ...(options?.now !== undefined ? { now: options.now } : {})
      })}`.catch((err: unknown) => {
        throw this.#uniqueViolation(type, err);
      })) as unknown as GuardedRecord[];
    });
    const fields = this.#typeDefLookup?.(type, this.namespace)?.fields;
    const merged = written.records.map((r) => this.materialize(r, fields, written.table));
    return { written: merged.length, ids: merged.map((r) => r.id), rows: merged };
  }

  async tombstone(type: string, ids: Id[]): Promise<DeleteResult> {
    if (ids.length === 0) return { deleted: 0, ids: [] };
    const table = await this.#tableFor(type);
    if (table === undefined) return { deleted: 0, ids: [] };

    const textIds = ids.map(idToText);
    const rel = this.#sql.unsafe(table.from);

    // Only stamp rows that are not already tombstoned — tombstone is terminal
    // and must preserve the original timestamp on a second call. The rows are
    // locked in id order first, as patchRows locks, so overlapping concurrent
    // tombstones queue instead of deadlocking.
    const rows = await this.#sql<{ id: string; body: Record<string, unknown> }[]>`
      WITH locked AS MATERIALIZED (
        SELECT count(*) AS n FROM (
          SELECT r.id FROM ${rel} r
          WHERE r.id = ANY(${textIds})
            AND r.deleted_at IS NULL
          ORDER BY r.id
          FOR NO KEY UPDATE OF r
        ) x
      )
      UPDATE ${rel} r
      SET deleted_at = now()
      FROM locked
      WHERE r.id = ANY(${textIds})
        AND r.deleted_at IS NULL
      RETURNING r.id, r.extra AS body
    `;

    const stamped: Id[] = rows.map((r) => this.extractOriginalId(r.id, r.body));
    return { deleted: stamped.length, ids: stamped };
  }

  /** On a type table, `deleted` also leaves `row_ids`, and `short_ids` cascade from there. */
  async purge(type: string, ids: Id[]): Promise<DeleteResult> {
    if (ids.length === 0) return { deleted: 0, ids: [] };
    const table = await this.#tableFor(type);
    if (table === undefined) return { deleted: 0, ids: [] };

    const textIds = ids.map(idToText);
    const sql = this.#sql;
    const rows = await sql<{ id: string; body: Record<string, unknown> }[]>`
      WITH d AS (
        DELETE FROM ${sql.unsafe(table.from)} WHERE id = ANY(${textIds}) RETURNING id, extra AS body
      ), reg AS (
        DELETE FROM row_ids
        WHERE namespace = ${this.namespace} AND type = ${type} AND id IN (SELECT id FROM d)
      )
      SELECT id, body FROM d`;

    const removed: Id[] = rows.map((r) => this.extractOriginalId(r.id, r.body));
    return { deleted: removed.length, ids: removed };
  }

  /**
   * Hard-deletes tombstoned rows whose `deleted_at` is older than `olderThan`,
   * across ALL namespaces (the table is substrate-shared). Called by the sweep
   * loop. Returns the number of rows deleted.
   *
   * Each type table is swept in one pass, a window of {@link purgeBatch} ids
   * per statement in id order, and a swept row leaves `row_ids` in the same
   * statement, its short id cascading.
   */
  async purgeTombstonedRows(opts: { olderThan: Date }): Promise<{ deleted: number }> {
    const sql = this.#sql;
    let deleted = 0;
    const tables = await sql<Array<{ namespace: string; type: string; table_name: string }>>`
      SELECT namespace, type, table_name FROM substrate_type_tables`;
    for (const t of tables) {
      const table = sql.unsafe(ident(t.table_name));
      // Walk the primary key a window at a time: deleted_at has no index, so a
      // filtered LIMIT would rescan the table from its start on every batch.
      let last = '';
      for (;;) {
        // The predicate is on the DELETE itself, so a row restored meanwhile stays.
        const [row] = await sql<Array<{ n: number; scanned: number; last: string | null }>>`
          WITH w AS (
            SELECT id FROM ${table} WHERE id > ${last} ORDER BY id LIMIT ${purgeBatch.size}
          ), d AS (
            DELETE FROM ${table}
            WHERE id IN (SELECT id FROM w)
              AND deleted_at IS NOT NULL AND deleted_at < ${opts.olderThan}
            RETURNING id
          ), reg AS (
            DELETE FROM row_ids
            WHERE namespace = ${t.namespace} AND type = ${t.type} AND id IN (SELECT id FROM d)
          )
          SELECT (SELECT count(*)::int FROM d) AS n,
                 (SELECT count(*)::int FROM w) AS scanned,
                 (SELECT max(id) FROM w) AS last`;
        deleted += row?.n ?? 0;
        if (row === undefined || row.scanned < purgeBatch.size || row.last === null) break;
        last = row.last;
      }
    }
    return { deleted };
  }

  /**
   * Hard-delete every row for `type` in this namespace, including tombstoned
   * rows (`deleted_at IS NOT NULL`). Short-id mappings for that type are
   * removed in the same logical operation. Both deletes run through `this.#sql`
   * so they participate in any surrounding `withTransaction` boundary. A type
   * table is emptied, not dropped.
   */
  async dropType(type: string): Promise<DropResult> {
    const table = await this.#tableFor(type);
    // First, so the count is not lost to the cascade from row_ids.
    const shortIdsDeleted = await this.#shortIds.dropType(this.namespace, type);
    const rowsDeleted = table === undefined ? 0 : await this.#emptyTable(type, table.from);
    return { rowsDeleted, shortIdsDeleted };
  }

  /** Deletes every row of `type`'s table `from` and its `row_ids`; the count of rows. */
  async #emptyTable(type: string, from: string): Promise<number> {
    const [row] = await this.#sql<Array<{ n: number }>>`
      WITH d AS (DELETE FROM ${this.#sql.unsafe(from)} RETURNING id),
      reg AS (DELETE FROM row_ids WHERE namespace = ${this.namespace} AND type = ${type})
      SELECT count(*)::int AS n FROM d`;
    return row?.n ?? 0;
  }

  /**
   * Hard-delete every row across all types in this namespace, including
   * tombstoned rows. Short-id mappings for all types are removed too.
   */
  async dropNamespace(): Promise<DropResult> {
    const shortIdsDeleted = await this.#shortIds.dropNamespace(this.namespace);
    const tables = await this.#sql<Array<{ type: string; table_name: string }>>`
      SELECT type, table_name FROM substrate_type_tables WHERE namespace = ${this.namespace}`;
    let rowsDeleted = 0;
    for (const t of tables) rowsDeleted += await this.#emptyTable(t.type, ident(t.table_name));
    await this.#sql`DELETE FROM row_ids WHERE namespace = ${this.namespace}`;
    return { rowsDeleted, shortIdsDeleted };
  }

  /**
   * Compare-and-update (spec §5.12): merges `updates` into the live row only
   * if every `match` field equals its expected value. Returns `matched` and
   * the updated row.
   *
   * One `UPDATE ... WHERE <pk> AND <match>`, so the row lock makes exactly one
   * of N concurrent callers match. `_deletedAt` and `id` are dropped from
   * `updates`.
   */
  async conditionalUpdate(
    type: string,
    id: Id,
    match: Record<string, unknown>,
    updates: Record<string, unknown>,
    actor?: ActorIdentity,
    now?: Date
  ): Promise<ConditionalUpdateResult> {
    const sql = this.#sql;
    const sanitisedUpdates: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(updates)) {
      if (k === RESERVED_DELETED_AT) continue;
      if (k === 'id') continue;
      sanitisedUpdates[k] = v;
    }
    const table = await this.#tableFor(type);
    if (table === undefined) return { matched: false, row: null };

    const matchSql = (t: TypeTable) => {
      const clauses = Object.entries(match).map(([field, expected]) =>
        conditionalMatchFragment(sql, field, expected, t)
      );
      return clauses.length === 0 ? sql`TRUE` : combineAnd(sql, clauses);
    };
    const stamp = sql`updated_at = ${now === undefined ? sql`now()` : sql`${now}`},
      updated_by_kind = ${(actor ?? ANONYMOUS).kind}, updated_by_id = ${(actor ?? ANONYMOUS).id}`;
    const [row] = await this.#patchTable(
      type,
      table,
      [{ id: idToText(id), patch: sanitisedUpdates }],
      stamp,
      matchSql,
      true
    );
    return row === undefined ? { matched: false, row: null } : { matched: true, row };
  }

  async updateField(ref: UpdateFieldRef, fieldName: string, value: unknown): Promise<void> {
    // Validation order (spec §4.5): namespace → reserved → missing.
    if (ref.ns !== undefined && ref.ns !== this.namespace) {
      throw new NamespaceMismatch(this.namespace, ref.ns);
    }
    if (fieldName === RESERVED_DELETED_AT) {
      throw new ReservedField(fieldName);
    }

    const table = await this.#tableFor(ref.type);
    if (table === undefined) return;

    // _metadata lives only in the dedicated columns, which is where
    // materialize() reads it; writing it to the body would never be read.
    if (fieldName === '_metadata') {
      const meta = value as RowMetadata | null | undefined;
      await this.#sql`
        UPDATE ${this.#sql.unsafe(table.from)}
        SET created_at      = ${meta?.createdAt ?? null},
            updated_at      = ${meta?.updatedAt ?? null},
            created_by_kind = ${meta?.createdBy?.kind ?? null},
            created_by_id   = ${meta?.createdBy?.id ?? null},
            updated_by_kind = ${meta?.updatedBy?.kind ?? null},
            updated_by_id   = ${meta?.updatedBy?.id ?? null}
        WHERE id = ${idToText(ref.id)}
      `;
      return;
    }
    // No metadata stamp, and a tombstoned row is set too.
    await this.#patchTable(
      ref.type,
      table,
      [{ id: idToText(ref.id), patch: { [fieldName]: value ?? null } }],
      null,
      null,
      false
    );
  }

  /**
   * `sql.begin`-backed atomicity. Spec §5.3 / G1.
   *
   * Nested calls flatten: postgres.js's `begin` inside a `begin` would create
   * a savepoint (inner rolls back independently of outer), which is stricter
   * than the G1 contract promises. To match the memory impl — where an inner
   * throw tears down outer writes too — we detect the re-entry via `#inTx`
   * and skip the nested begin entirely. The inner throw then propagates to
   * the outer `sql.begin`, which rolls back the whole thing.
   */
  async withTransaction<T>(fn: (tx: Dataset) => Promise<T>): Promise<T> {
    if (this.#inTx) return fn(this);

    // Cast is sound: the public constructor accepts `Sql`, so `this.#sql`
    // outside a tx is always `Sql` — only the internal tx-scoped instance
    // holds a `TransactionSql`, and that path enters the `#inTx` branch.
    const rootSql = this.#sql as Sql;
    const txTables: TxTables = new Map();
    const out = (await rootSql.begin<T>(async (txSql) => {
      const txDataset = new PgDataset({
        namespace: this.namespace,
        sql: txSql,
        inTx: true,
        txScopeId: this.txScopeId,
        ...(this.#fieldDefLookup !== null ? { fieldDefLookup: this.#fieldDefLookup } : {}),
        layoutCache: this.#layoutCache,
        statementTimeoutMs: this.#statementTimeoutMs,
        ...(this.#typeDefLookup !== null ? { typeDefLookup: this.#typeDefLookup } : {}),
        tableCache: this.#tableCache,
        txTables
      });
      const result = await fn(txDataset);
      await snapshotUnlessReadCommitted(txSql, txTables);
      return result;
      // postgres.js's begin<T> wraps the return in UnwrapPromiseArray; for
      // our `Promise<T>`-returning fn it collapses to `T`.
    })) as T;
    this.#commitTables(txTables);
    return out;
  }

  /**
   * Runs `fn` in one pg transaction with a tx-bound dataset per requested
   * namespace (and the edges store, when wired), all on one `TransactionSql`.
   * A throw rolls back every namespace. Spec §5.3.
   *
   * Nested calls flatten onto the current transaction rather than opening a
   * savepoint.
   */
  async withScopedTransaction<T>(
    namespaces: ReadonlyArray<string>,
    fn: (handles: TxScopeHandles) => Promise<T>
  ): Promise<T> {
    const txTables: TxTables = this.#txTables ?? new Map();
    const buildHandles = (handle: PgHandle): TxScopeHandles => {
      const datasets = new Map<string, Dataset>();
      for (const ns of namespaces) {
        datasets.set(
          ns,
          new PgDataset({
            namespace: ns,
            sql: handle,
            inTx: true,
            txScopeId: this.txScopeId,
            // Propagate the edges store reference so nested withTransaction
            // calls (flattened) retain the same enlistment behaviour.
            ...(this.#edgesStore !== null ? { edgesStore: this.#edgesStore } : {}),
            ...(this.#fieldDefLookup !== null ? { fieldDefLookup: this.#fieldDefLookup } : {}),
            layoutCache: this.#layoutCache,
            statementTimeoutMs: this.#statementTimeoutMs,
            ...(this.#typeDefLookup !== null ? { typeDefLookup: this.#typeDefLookup } : {}),
            tableCache: this.#tableCache,
            txTables
          })
        );
      }
      // Edge mutations during `fn` share this pg transaction.
      const edges = this.#edgesStore !== null ? this.#edgesStore._enlistInTx(handle) : null;
      return { datasets, edges };
    };

    if (this.#inTx) return fn(buildHandles(this.#sql));

    const rootSql = this.#sql as Sql;
    const out = (await rootSql.begin<T>(async (txSql) => {
      const result = await fn(buildHandles(txSql));
      await snapshotUnlessReadCommitted(txSql, txTables);
      return result;
    })) as T;
    this.#commitTables(txTables);
    return out;
  }

  /**
   * See `Dataset.withAdvisoryLock`. Excludes every session on the
   * same schema, across processes. On a tx-bound instance the lock is
   * `pg_advisory_xact_lock` on the transaction's own connection, held until
   * it commits or rolls back: a session lock would need a second connection
   * beside the open transaction.
   */
  async withAdvisoryLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    if (!this.#inTx) return withPgAdvisoryLock(this.#sql as Sql, key, fn);
    await this.#sql`SELECT pg_advisory_xact_lock(hashtext(current_schema() || ':' || ${key}))`;
    return fn();
  }

  async allocateShortId(type: string): Promise<number> {
    return this.#shortIds.allocateUnbound(this.namespace, type);
  }

  async bindShortId(type: string, shortId: number, rowId: string): Promise<void> {
    await this.#shortIds.bind(this.namespace, type, shortId, rowId);
  }

  async resolveShortId(type: string, shortId: number): Promise<string | null> {
    return this.#shortIds.resolveShortId(this.namespace, type, shortId);
  }

  async allocateShortIds(type: string, count: number): Promise<number[]> {
    return this.#shortIds.allocateUnboundMany(this.namespace, type, count);
  }

  async bindShortIds(
    type: string,
    pairs: ReadonlyArray<{ shortId: number; rowId: string }>
  ): Promise<void> {
    await this.#shortIds.bindMany(this.namespace, type, pairs);
  }

  async resolveShortIds(
    type: string,
    shortIds: readonly number[]
  ): Promise<ReadonlyMap<number, string>> {
    const out = new Map<number, string>();
    // A non-integer cannot be bound, so it resolves to nothing, as in memory;
    // it must not reach the bigint cast, which would throw.
    const valid = [...new Set(shortIds)].filter(Number.isSafeInteger);
    if (valid.length === 0) return out;
    const table = await this.#tableFor(type, this.namespace, true);
    if (table === undefined) return out;
    // One statement: the ids go in as one array, and the join to the type's
    // table keeps live rows only, so a tombstoned or purged row's id never resolves.
    const records = await this.#sql<Array<{ short_id: string; row_id: string }>>`
      SELECT s.short_id, s.row_id
      FROM unnest(${valid.map(String)}::bigint[]) AS q(short_id)
      JOIN short_ids s
        ON s.namespace = ${this.namespace}::text AND s.type = ${type}::text AND s.short_id = q.short_id
      JOIN ${this.#sql.unsafe(table.from)} r
        ON r.id = s.row_id
       AND r.deleted_at IS NULL
    `;
    for (const r of records) out.set(parseShortId(r.short_id), r.row_id);
    return out;
  }

  async patchRows(
    type: string,
    patches: ReadonlyArray<{ id: Id; patch: Record<string, unknown> }>,
    actor: ActorIdentity | null,
    now: Date
  ): Promise<Array<Row | null>> {
    if (patches.length === 0) return [];
    const sql = this.#sql;
    // A repeated id folds into one patch, later keys winning: UPDATE ... FROM
    // applies one source row per target row, so duplicates must not reach it.
    const folded = new Map<string, Record<string, unknown>>();
    for (const p of patches) {
      const merged = { ...folded.get(idToText(p.id)) };
      for (const [k, v] of Object.entries(p.patch)) {
        if (k !== RESERVED_DELETED_AT && k !== 'id') merged[k] = v;
      }
      folded.set(idToText(p.id), merged);
    }
    const ids = [...folded.keys()];
    const table = await this.#tableFor(type);
    if (table === undefined) return patches.map(() => null);
    const updatedBy = actor ?? ANONYMOUS;
    const rows = await this.#patchTable(
      type,
      table,
      ids.map((id) => ({ id, patch: folded.get(id) ?? {} })),
      sql`updated_at = ${now}::timestamptz, updated_by_kind = ${updatedBy.kind}::text,
          updated_by_id = ${updatedBy.id}::text`,
      null,
      true
    );
    const byId = new Map(rows.map((r) => [idToText(r.id), r]));
    return patches.map((p) => byId.get(idToText(p.id)) ?? null);
  }

  /**
   * Merges each patch into its row of type table `table` in one statement, by
   * `applyPatch`'s rule, and returns the rows it changed. `stamp` adds SET
   * items; `match` must also hold on the stored row. `live`: only live rows,
   * locked in id order first, so overlapping concurrent batches queue instead
   * of deadlocking.
   */
  async #patchTable(
    type: string,
    table: TypeTable,
    patches: ReadonlyArray<{ id: string; patch: Record<string, unknown> }>,
    stamp: Fragment | null,
    match: ((table: TypeTable) => Fragment) | null,
    live: boolean
  ): Promise<Row[]> {
    const ids = patches.map((p) => p.id);
    const written = await this.#guarded(type, table, (t) =>
      this.#patchStatement(type, t, patches, ids, stamp, match?.(t) ?? null, live)
    );
    const fields = this.#typeDefLookup?.(type, this.namespace)?.fields;
    return written.records.map((r) => this.materialize(r, fields, written.table));
  }

  /** {@link #patchTable}'s one statement, built for `table`. */
  async #patchStatement(
    type: string,
    table: TypeTable,
    patches: ReadonlyArray<{ id: string; patch: Record<string, unknown> }>,
    ids: string[],
    stamp: Fragment | null,
    match: Fragment | null,
    live: boolean
  ): Promise<GuardedRecord[]> {
    const sql = this.#sql;
    const rel = sql.unsafe(table.from);
    const encoded = patches.map((p) => ({ ...encodeRow(table, p.patch), id: p.id }));
    // Gated on the guard, so a refused (stale) patch locks no row (M7).
    const locked = live
      ? sql`,
      locked AS MATERIALIZED (
        SELECT count(*) AS n FROM (
          SELECT t.id FROM ${rel} t
          WHERE t.id = ANY(${ids}::text[]) AND t.deleted_at IS NULL AND (SELECT ok FROM guard)
          ORDER BY t.id
          FOR NO KEY UPDATE OF t
        ) x
      )`
      : sql``;
    return (await sql`
      WITH ${inputCte(sql, table, encoded)}${locked},
      updated AS (
        UPDATE ${rel} t
        SET ${sql.unsafe(setList(mergeAssignments(table, 't', 'i')))}${stamp === null ? sql`` : sql`, ${stamp}`}
        FROM input i${live ? sql`, locked` : sql``}
        WHERE t.id = i.rid${live ? sql` AND t.deleted_at IS NULL` : sql``}${match === null ? sql`` : sql` AND ${match}`}
        RETURNING t.*
      )
      ${guardedRows(sql, sql`SELECT ${returnedRowSql(sql, table, 'u')} FROM updated u ${sql.unsafe(shortIdJoinSql(table, 'u.id'))}`)}
    `.catch((err: unknown) => {
      throw this.#uniqueViolation(type, err);
    })) as unknown as GuardedRecord[];
  }

  async updateWhere(
    type: string,
    where: WhereClause,
    set: Record<string, unknown>,
    opts: FilterWriteOptions
  ): Promise<FilterWriteResult> {
    const sql = this.#sql;
    const patch: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(set)) {
      if (k !== RESERVED_DELETED_AT && k !== 'id') patch[k] = v;
    }
    const table = await this.#tableFor(type);
    if (table === undefined) return { count: 0, ids: [], rows: [] };
    const updatedBy: ActorIdentity = opts.actor ?? ANONYMOUS;
    const stamp = sql`updated_at = ${opts.now ?? new Date()}::timestamptz,
            updated_by_kind = ${updatedBy.kind}::text,
            updated_by_id = ${updatedBy.id}::text`;
    // One input row, which every matched row merges.
    const build = (t: TypeTable) => ({
      input: inputCte(sql, t, [{ ...encodeRow(t, patch), id: '' }]),
      assign: sql`${sql.unsafe(setList(mergeAssignments(t, 'r', 'i')))}, ${stamp}`
    });
    return this.#filterWrite(type, where, opts.maxMatch, build, false, table).catch(
      (err: unknown) => {
        // A set onto a declared unique index's values: refused as `patchRows` refuses it.
        throw this.#uniqueViolation(type, err);
      }
    );
  }

  async deleteWhere(
    type: string,
    where: WhereClause,
    opts: FilterWriteOptions
  ): Promise<FilterWriteResult> {
    const table = await this.#tableFor(type);
    if (table === undefined) return { count: 0, ids: [], rows: [] };
    const assign = this.#sql`deleted_at = now()`;
    return this.#filterWrite(
      type,
      where,
      opts.maxMatch,
      () => ({ input: null, assign }),
      true,
      table
    );
  }

  /**
   * One statement: `m` locks up to `maxMatch + 1` live matches, `u` writes
   * them only when there are at most `maxMatch`, re-testing `where` on each,
   * and the outer select always returns one row carrying `count(m)`, so a
   * too-broad filter tells from zero matches. Under READ COMMITTED a row a
   * concurrent writer changed is re-tested on its new version after the lock
   * (`FOR UPDATE`), so one moved out of the filter is neither locked nor
   * written. Locks are taken in id order, so overlapping filter writes queue
   * rather than deadlock. `preImage` returns the rows without the write's
   * `deleted_at`. `build` gives, for the table the write is built for, the
   * SET list and the CTE `assign` reads as `i` (when it reads one). A stale
   * table's guard matches nothing, and the write is rebuilt (`#guarded`).
   */
  async #filterWrite(
    type: string,
    where: WhereClause,
    maxMatch: number,
    build: (table: TypeTable) => { input: Fragment | null; assign: Fragment },
    preImage: boolean,
    table: TypeTable
  ): Promise<FilterWriteResult> {
    // k as memory's read passes it: the match limit.
    const { where: resolved } = await preResolveExtensionOperatorsDetailed(where, {
      namespace: this.namespace,
      type,
      k: maxMatch + 1
    });
    // shortId lives on the sidecar, so a where that reads it joins short_ids, as `read` does.
    const joinShortIds = whereReferencesField(resolved, 'shortId');
    const fields = this.#typeDefLookup?.(type, this.namespace)?.fields;
    const written = await this.#guarded(type, table, async (t) => {
      const { input, assign } = build(t);
      const records = await this.#filterStatement(
        t,
        resolved,
        joinShortIds,
        maxMatch,
        input,
        assign
      );
      const head = records[0];
      if (head?.ok === true && head.matched > maxMatch) {
        throw filterTooBroad(this.namespace, type, maxMatch);
      }
      return records;
    });
    const rows = written.records.map((r) => {
      const row = this.materialize(r, fields, written.table);
      if (preImage) delete row._deletedAt;
      return row;
    });
    return { count: rows.length, ids: rows.map((r) => r.id), rows };
  }

  /** {@link #filterWrite}'s one statement, built for `table`. */
  async #filterStatement(
    table: TypeTable,
    resolved: WhereClause,
    joinShortIds: boolean,
    maxMatch: number,
    input: Fragment | null,
    assign: Fragment
  ): Promise<Array<GuardedRecord & { matched: number }>> {
    const sql = this.#sql;
    const filter = buildWhere(sql, resolved, this.#castFor(table.type), table) ?? sql`true`;
    const rel = sql.unsafe(table.from);
    // The UPDATE target cannot appear in a FROM join's ON, so the sidecar joins on m.
    const sidecar = (id: string) => (joinShortIds ? sql.unsafe(shortIdJoinSql(table, id)) : sql``);
    return (await sql`
      WITH ${input ?? guardCte(sql, table)},
      m AS (
        SELECT r.id AS mid FROM ${rel} r ${sidecar('r.id')}
        WHERE (SELECT ok FROM guard) AND ${filter} AND r.deleted_at IS NULL
        ORDER BY r.id
        LIMIT ${maxMatch + 1}
        FOR UPDATE OF r
      ),
      u AS (
        UPDATE ${rel} r SET ${assign}
        FROM m ${sidecar('m.mid')}${input === null ? sql`` : sql`, input i`}
        WHERE r.id = m.mid
          AND (SELECT count(*) FROM m) <= ${maxMatch}
          AND ${filter} AND r.deleted_at IS NULL
        RETURNING r.*
      )
      SELECT g.ok, (SELECT count(*) FROM m)::int AS matched, ${returnedRowSql(sql, table, 'u')}
      FROM guard g
      LEFT JOIN u ON true
      ${sql.unsafe(shortIdJoinSql(table, 'u.id'))}
    `) as unknown as Array<GuardedRecord & { matched: number }>;
  }

  /** A body field's declared kind as the cast its extraction takes; null when undeclared. */
  #castFor(type: string): (field: string) => BodyOrderByCast | null {
    return (field) =>
      this.#fieldDefLookup === null
        ? null
        : resolveBodyOrderByCast(this.#fieldDefLookup(type, field));
  }

  async getShortIdForRow(type: string, rowId: string): Promise<number | null> {
    return this.#shortIds.getShortIdForRow(this.namespace, type, rowId);
  }

  forNamespace(namespace: string): Dataset {
    if (this.#inTx) {
      throw new Error('PgDataset.forNamespace cannot be called on a tx-bound instance');
    }
    return new PgDataset({
      namespace,
      sql: this.#sql as Sql,
      inTx: false,
      ...(this.#edgesStore !== null ? { edgesStore: this.#edgesStore } : {}),
      ...(this.#fieldDefLookup !== null ? { fieldDefLookup: this.#fieldDefLookup } : {}),
      layoutCache: this.#layoutCache,
      statementTimeoutMs: this.#statementTimeoutMs,
      ...(this.#typeDefLookup !== null ? { typeDefLookup: this.#typeDefLookup } : {}),
      ...(this.#diskGuard !== undefined ? { diskGuard: this.#diskGuard } : {}),
      tableCache: this.#tableCache
    });
  }

  /**
   * `tables` once the store is migrated, else `'absent'`, which is not cached.
   * An old layout's `rows` is refused, as boot refuses it.
   */
  async #layout(): Promise<StorageLayout | 'absent'> {
    if (this.#layoutCache.layout !== undefined) return this.#layoutCache.layout;
    const layout = await detectLayout(this.#sql as Sql);
    if (layout === 'legacy' || layout === 'partitioned') {
      throw new UnsupportedStoreLayoutError(layout);
    }
    if (layout !== 'absent') this.#layoutCache.layout = layout;
    return layout;
  }

  /**
   * See `Dataset.ensureTypeStorage`. Brings the type's table in line with its
   * declared fields (`ensureTypeTable`; a new field gets its column, or
   * `pending` under `newFields: 'pending'`), then reconciles its indexes on
   * it, and returns the fields that went `pending` in this call (F12). An
   * index reading a pending field's column waits, `pending`, until the column
   * exists. Index builds run CONCURRENTLY, outside any transaction, so a
   * tx-bound instance refuses. Logs each index it created, adopted or
   * swapped, and records each one left pending, building or failed for
   * `describeStorage` and `storageReport`.
   */
  async ensureTypeStorage(
    type: string,
    opts: {
      indexes?: 'all' | 'unique' | 'nonUnique';
      signal?: AbortSignal;
      newFields?: 'column' | 'pending';
    } = {}
  ): Promise<{ pending: string[] }> {
    const layout = await this.#layout();
    if (layout === 'absent') return { pending: [] };
    if (this.#inTx) {
      throw new Error('PgDataset.ensureTypeStorage cannot be called on a tx-bound instance');
    }
    const sql = this.#sql as Sql;
    const def = this.#typeDefLookup?.(type, this.namespace);
    const change = await ensureTypeTable(sql, {
      namespace: this.namespace,
      type,
      fields: def?.fields ?? {},
      newFields: opts.newFields ?? 'column',
      enforceUuidCheck: await this.#uuidCheck(),
      // A dataset that does not know the type (an admin tool, bootstrap) may
      // create its table but never changes its declarations: `{}` would
      // orphan every column.
      createOnly: def === undefined
    });
    // Committed: drop the cached table now rather than when the notification lands.
    dropTableCache(this.#tableCache, `${this.namespace}/${type}`);
    await this.#reconcileIndexes(type, opts);
    return { pending: change.pending };
  }

  /** `ensureTypeStorage`'s index pass: reconciles, then records each state for the reports. */
  async #reconcileIndexes(
    type: string,
    opts: { indexes?: 'all' | 'unique' | 'nonUnique'; signal?: AbortSignal }
  ): Promise<void> {
    const sql = this.#sql as Sql;
    const builds = this.#deferredBuilds();
    const qualified = `${this.namespace}/${type}`;
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
      states = await reconcileTypeIndexes(sql, this.#indexArgs(type, this.namespace), {
        only: opts.indexes ?? 'all',
        onBuild: (name) => builds.set(name, { state: 'building', type: qualified }),
        onState: record,
        ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
        ...(this.#diskGuard !== undefined ? { diskGuard: this.#diskGuard } : {})
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
        `[substrate] index ${s.name} on ${this.namespace}/${type}: ${s.outcome} (${s.state})\n`
      );
    }
  }

  /**
   * See `Dataset.promotePendingFields`. Store-wide; `[]` before the store is
   * migrated. Each field's
   * indexes are reconciled through its namespace's view of this dataset, so a
   * declared index waiting on the new column is built.
   */
  async promotePendingFields(opts: {
    lockTimeoutMs: number;
    batchRows: number;
    signal?: AbortSignal;
    /** Only this namespace's fields. */
    namespace?: string;
    retryConflicts?: boolean;
    noWriters?: boolean;
  }): Promise<PromotionEvent[]> {
    if ((await this.#layout()) === 'absent') return [];
    if (this.#inTx) {
      throw new Error('PgDataset.promotePendingFields cannot be called on a tx-bound instance');
    }
    const signal = opts.signal;
    return promotePendingFields(this.#sql as Sql, {
      ...opts,
      reconcile: async (namespace, type) => {
        const view =
          namespace === this.namespace ? this : (this.forNamespace(namespace) as PgDataset);
        await view.#reconcileIndexes(type, signal !== undefined ? { signal } : {});
      }
    });
  }

  /**
   * See `Dataset.fieldWarnings`. Store-wide; none before the store is migrated. Counts
   * only, since `/health` shows it unauthenticated: the named lines are in
   * `storageReport`, which is admin-gated.
   */
  async fieldWarnings(): Promise<string[]> {
    if ((await this.#layout()) === 'absent') return [];
    const lines = await this.#fieldLines();
    const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
    const pending = lines.filter((l) => l.state === 'pending').length;
    const failed = lines.filter((l) => l.failed).length;
    const orphaned = lines.filter((l) => l.state === 'orphaned').length;
    const parts = [
      ...(pending > 0
        ? [plural(pending, 'field pending promotion', 'fields pending promotion')]
        : []),
      ...(failed > 0 ? [plural(failed, 'promotion failed', 'promotions failed')] : []),
      ...(orphaned > 0 ? [plural(orphaned, 'field orphaned', 'fields orphaned')] : [])
    ];
    return parts.length === 0 ? [] : [`${parts.join('; ')} — see the storage report`];
  }

  /**
   * Each field an operator should know about, by name: a pending one, one
   * whose promotion failed (an error other than busy or stopped, or a busy or
   * stopped one {@link PROMOTION_FAILED_AFTER} attempts in a row), one busy
   * short of that, and an orphaned one.
   */
  async #fieldLines(): Promise<Array<{ state: string; failed: boolean; line: string }>> {
    const rows = await this.#sql<
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

  #deferredBuilds(): Map<string, DeferredBuild> {
    const builds = deferredBuilds.get(this.#sql) ?? new Map<string, DeferredBuild>();
    deferredBuilds.set(this.#sql, builds);
    return builds;
  }

  /** Each index's catalog state, overridden by what this process knows of its build. */
  #withBuilds(states: IndexState[]): IndexState[] {
    const builds = this.#deferredBuilds();
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
   * A write's error as the caller should see it: a declared unique index's
   * conflict (23505) becomes `unique_violation` naming the index and its
   * fields; anything else is returned unchanged.
   */
  #uniqueViolation(type: string, err: unknown): unknown {
    const pgErr = err as { code?: unknown; constraint_name?: unknown };
    if (pgErr?.code !== '23505' || typeof pgErr.constraint_name !== 'string') return err;
    const index = pgErr.constraint_name;
    // No query: the failed statement may have aborted this transaction.
    const declared = desiredIndexKeys(this.#indexArgs(type, this.namespace)).find(
      (d) => d.name === index
    );
    const fields = declared?.keys.map(([field]) => field) ?? [];
    return new ResolverFrameError(
      'unique_violation',
      `${this.namespace}/${type}: a row already holds these values for unique index ${index}` +
        (fields.length > 0 ? ` (${fields.join(', ')})` : ''),
      { index, fields }
    );
  }

  #indexArgs(type: string, namespace: string): ReconcileTypeIndexesArgs {
    const def = this.#typeDefLookup?.(type, namespace);
    return {
      namespace,
      type,
      fields: def?.fields ?? {},
      indexes: def?.indexes ?? [],
      orderedBy: naturalOrderOf(def ?? {}),
      ...(def?.ordering !== undefined ? { ordering: def.ordering } : {})
    };
  }

  /**
   * The type's non-unique indexes the next build pass would build or swap,
   * each with the disk guard's estimate. Empty when the store or the type's
   * storage does not exist yet. Changes nothing.
   */
  async pendingIndexBuilds(type: string): Promise<Array<{ name: string; estimateBytes: number }>> {
    if ((await this.#layout()) === 'absent') return [];
    const args = this.#indexArgs(type, this.namespace);
    if ((await typeTableOf(this.#sql, this.namespace, type)) === undefined) return [];
    return pendingIndexBuilds(this.#sql as Sql, args);
  }

  /**
   * See `Dataset.describeStorage`. Reads the catalog only, in a fixed number of
   * queries: the type's table, its indexes, and its `pending` and `orphaned`
   * fields, as the catalog records them.
   */
  async describeStorage(type: string): Promise<TypeStorageReport> {
    const sql = this.#sql as Sql;
    const name =
      (await this.#layout()) === 'absent'
        ? undefined
        : await typeTableOf(sql, this.namespace, type);
    const table = name === undefined ? undefined : await loadTypeTable(sql, this.namespace, type);
    if (name === undefined || table === undefined) {
      return { layout: 'tables', indexes: [], pending: [], orphaned: [] };
    }
    return {
      layout: 'tables',
      table: name,
      indexes: this.#withBuilds(
        describeTypeIndexes(
          { ...this.#indexArgs(type, this.namespace), table },
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
  async storageReport(opts: { partitionBudget: number }): Promise<StorageReport> {
    const layout = await this.#layout();
    const building = [...this.#deferredBuilds()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(
        ([name, b]) =>
          `index ${name} on ${b.type} is ${b.state}${b.error !== undefined ? ` (${b.error})` : ''}` +
          `${b.reason !== undefined ? ` (${b.reason})` : ''}: ` +
          'filters it would serve scan until it is valid'
      );
    if (this.#diskGuard !== undefined && this.#diskGuard.path === undefined) {
      building.push(
        'free-disk checks before index builds are off: set SUBSTRATE_INDEX_DISK_PATH to the database volume mount, or to off when the database has no local volume'
      );
    }
    if (layout === 'absent') return { layout: 'tables', warnings: building };
    const sql = this.#sql as Sql;
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
      this.#undeclared(warnings, info, t.namespace, t.type, heldBy.get(t.table) ?? []);
    }
    // A failed promotion is a fault; a pending or orphaned field is a state worth showing.
    for (const f of await this.#fieldLines()) (f.failed ? warnings : info).push(f.line);
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
  #undeclared(
    warnings: string[],
    info: string[],
    ns: string,
    type: string,
    own: HeldIndex[]
  ): void {
    if (this.#typeDefLookup === null) return;
    if (this.#typeDefLookup(type, ns) === undefined) {
      for (const i of own) {
        if (!isEngineOwned(i)) continue;
        info.push(
          `orphaned index ${i.name} on ${ns}/${type}: no registered type owns it; ${i.unique ? 'it is unique, so drop it by hand' : 'a signed propose_index remove drops it'}`
        );
      }
      return;
    }
    try {
      for (const name of undeclaredIndexes(this.#indexArgs(type, ns), own)) {
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
  async indexPlan(type: string, namespace: string): Promise<IndexPlan | undefined> {
    const def = this.#typeDefLookup?.(type, namespace);
    if (def === undefined || (await this.#layout()) === 'absent') return undefined;
    // An index over a field not yet `column` serves no read. Every walk read asks (its
    // plan diagnostics), so through the TableCache like the read itself.
    const table = await this.#tableFor(type, namespace, true);
    return {
      indexes: desiredIndexKeys({
        ...this.#indexArgs(type, namespace),
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
  async dropEngineIndex(
    type: string,
    name: string,
    opts: { beforeDrop?: () => Promise<void>; lockTimeoutMs?: number } = {}
  ): Promise<void> {
    const layout = await this.#layout();
    if (this.#inTx) {
      throw new Error('PgDataset.dropEngineIndex cannot be called on a tx-bound instance');
    }
    const where = `${this.namespace}/${type}`;
    if (layout === 'absent') {
      throw new IndexDropRefusedError('unknown_index', `no index ${name} on ${where}`);
    }
    const sql = this.#sql as Sql;
    const find = async () =>
      (await typeIndexesOf(sql, this.namespace, type)).find((i) => i.name === name);
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
        const lookup = this.#typeDefLookup;
        const orphan = lookup !== null && lookup(type, this.namespace) === undefined;
        const desired =
          lookup === null ||
          (!orphan &&
            (name.endsWith('_base') ||
              desiredIndexKeys(this.#indexArgs(type, this.namespace)).some(
                (d) => d.name === name
              )));
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
  async dropNamespaceIndexes(
    opts: { unique?: boolean; lockTimeoutMs?: number } = {}
  ): Promise<string[]> {
    if ((await this.#layout()) === 'absent') return [];
    if (this.#inTx) {
      throw new Error('PgDataset.dropNamespaceIndexes cannot be called on a tx-bound instance');
    }
    const sql = this.#sql as Sql;
    const ns = this.namespace;
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
  async indexDeclarationOf(type: string, name: string): Promise<IndexDecl | undefined> {
    if ((await this.#layout()) === 'absent') return undefined;
    const args = this.#indexArgs(type, this.namespace);
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
  async typeStats(): Promise<TypeStats[]> {
    if ((await this.#layout()) === 'absent') return [];
    const sql = this.#sql as Sql;
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

  /**
   * `fields` is the type's, which the caller looks up once however many rows it
   * builds. The row is decoded first; `requested`, a read's `fields`, then
   * trims the `$raw` entries `decodeRow` overlays, since the projection keeps
   * `$raw` whole.
   */
  private materialize(
    record: TableRowRecord,
    fields: Record<string, FieldDef> | undefined,
    table: TypeTable,
    requested?: ReadParams['fields']
  ): Row {
    const body = decodeRow(table, record);
    const raw = (record.extra as Record<string, unknown> | null)?.[RAW_KEY];
    if (requested !== undefined && raw !== null && typeof raw === 'object') {
      for (const k of Object.keys(raw)) if (!Object.hasOwn(requested, k)) delete body[k];
    }
    // Prefer the body.id (preserves number vs string at write time) over the
    // text PK column when present.
    const originalId = this.extractOriginalId(record.id, body);

    const out: Row = { id: originalId };
    for (const [k, v] of Object.entries(body)) {
      if (k === 'id') continue;
      if (k === RESERVED_DELETED_AT) continue; // defensive — should never appear in body
      if (k === '_metadata') continue; // defensive — stripped on write, but guard on read too
      // A null on a declared scalar or crossRef reads back absent, as on memory.
      if (v === null && fields !== undefined && Object.hasOwn(fields, k)) {
        const def = fields[k];
        if (def !== undefined && isColumnField(def)) continue;
      }
      out[k] = v;
    }
    if (record.deleted_at !== null) {
      out._deletedAt = record.deleted_at;
    }
    if (record.short_id !== null && record.short_id !== undefined) {
      // postgres.js returns bigint columns as strings; coerce to JS number.
      // shortId values fit safely in Number (52-bit integer range).
      out.shortId = Number(record.short_id);
    }

    const meta = assembleRowMetadata(record);
    if (meta !== undefined) out._metadata = meta;

    if (requested === undefined) return out;
    // The decoded row is in column order; a projection answers in its own (#1861),
    // as memory and the transports do. `id` leads unless the request places it.
    const ordered: Row = Object.hasOwn(requested, 'id') ? ({} as Row) : { id: out.id };
    for (const k of Object.keys(requested)) if (Object.hasOwn(out, k)) ordered[k] = out[k];
    return Object.assign(ordered, out);
  }

  private extractOriginalId(textId: string, body: Record<string, unknown>): Id {
    const bodyId = body.id;
    if (typeof bodyId === 'number' || typeof bodyId === 'string') return bodyId;
    return textId;
  }
}

/** The statement timeout a walk read runs under, in milliseconds, unless a shorter one is set. */
export const WALK_STATEMENT_TIMEOUT_MS = 30_000;

/** The walk-only params a read actually uses: `count: true`, and each non-empty object. */
function walkParams(params: ReadParams): string[] {
  const used = (['aggregate', 'bucket', 'derive', 'agg', 'nested'] as const).filter((k) => {
    const v = params[k];
    return typeof v === 'object' && v !== null && Object.keys(v).length > 0;
  });
  return params.count === true ? ['count', ...used] : used;
}

/** True when a read uses the walk grammar: in its where, or a walk-only param. */
function usesWalkGrammar(params: ReadParams): boolean {
  return whereUsesWalks(params.where) || walkParams(params).length > 0;
}

/** Awaits `query`, cancelling the statement in flight when `signal` aborts. */
async function cancellable<T extends readonly MaybeRow[]>(
  query: PendingQuery<T>,
  signal: AbortSignal | undefined
): Promise<T> {
  // Typed void, but returns the cancel request's promise, which may reject.
  const cancel = (): void => {
    Promise.resolve(query.cancel() as unknown).catch(() => undefined);
  };
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    if (signal?.aborted === true) cancel();
    return await query;
  } catch (err) {
    // pg reports its own cancel as 57014; surface the caller's reason instead.
    if (signal?.aborted === true) signal.throwIfAborted();
    throw err;
  } finally {
    signal?.removeEventListener('abort', cancel);
  }
}

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
  fullBuiltinOperators,
  preResolveExtensionOperatorsDetailed
} from '@mnmal-ai/substrate-filter';
import type {
  ActorIdentity,
  ConditionalUpdateResult,
  Dataset,
  DeleteResult,
  DropResult,
  FilterCapabilities,
  FilterWriteOptions,
  FilterWriteResult,
  Id,
  IndexDecl,
  IndexPlan,
  PoolStats,
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
  isBatchElementError,
  ResolverFrameError,
  STORE_BUSY,
  WRITE_CONFLICT
} from '@mnmal-ai/substrate-types';
import type { Sql, TransactionSql } from 'postgres';
import { withPgAdvisoryLock } from './advisory-lock.js';
import type { DiskGuard } from './disk-guard.js';
import { NamespaceMismatch, queryTimeoutError, ReservedField } from './errors.js';
import { detectLayout, ident, type StorageLayout } from './layout.js';
import { UnsupportedStoreLayoutError } from './migrate.js';
import type { FieldDefLookup, TypeDefLookup } from './pg-dataset-context.js';
import { type PgContext, uniqueViolation } from './pg-dataset-context.js';
import {
  cancellable,
  type ResolveWhere,
  readOnce,
  StaleRead,
  usesWalkGrammar
} from './pg-dataset-read.js';
import {
  ANONYMOUS,
  extractOriginalId,
  type GuardedRecord,
  materialize,
  RESERVED_DELETED_AT
} from './pg-dataset-row.js';
import {
  describeStorage,
  dropEngineIndex,
  dropNamespaceIndexes,
  fieldWarnings,
  indexDeclarationOf,
  indexPlan,
  pendingIndexBuilds,
  reconcileIndexes,
  storageReport,
  typeStats
} from './pg-dataset-storage.js';
import { filterWrite, patchTable } from './pg-dataset-writes.js';
import type { PgEdgesStore } from './pg-edges-store.js';
import { PgShortIdStore, parseShortId } from './pg-short-id-store.js';
import { combineAnd, conditionalMatchFragment, idToText } from './pg-sql.js';
import { promotePendingFields } from './promote.js';
import { encodeRow } from './row-codec.js';
import { type PgHandle, txScopeIdFor } from './tx-scope.js';
import {
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

export type { FieldDefLookup, TypeDefLookup } from './pg-dataset-context.js';

import {
  assertReadCommitted,
  GUARDED_ATTEMPTS,
  guardedRows,
  inputCte,
  mergeAssignments,
  type RowToWrite,
  setList,
  writeRowsStatement
} from './write-rows.js';

// The pool-owned instance holds `Sql`; tx-scoped instances hold the
// `TransactionSql` from `sql.begin(fn)`. Only `Sql` exposes `begin`, so that
// access is gated behind `#inTx`.

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
   * The field definitions of any namespace. `forNamespace(ns)` hands the clone
   * `fieldDefLookupFor(ns)`, so a handle on another namespace casts by its own
   * definitions rather than this handle's. Without it a clone inherits
   * `fieldDefLookup`, which answers for this handle's namespace only.
   */
  fieldDefLookupFor?: (namespace: string) => FieldDefLookup;
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
  fieldDefLookupFor?: (namespace: string) => FieldDefLookup;
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

/** The store's layout once migrated, shared by an instance and every clone of it. */
interface LayoutCache {
  layout?: StorageLayout;
}

/** Rows per `purgeTombstonedRows` statement. A test seam, not exported from the package. */
export const purgeBatch = { size: 10_000 };

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
  /** Every handle on one pool can walk into the others: the pool's {@link txScopeId}. */
  readonly walkStoreId: string;

  readonly #sql: PgHandle;
  readonly #inTx: boolean;
  readonly #shortIds: PgShortIdStore;
  readonly #edgesStore: PgEdgesStore | null;
  /** This handle's own lookup; a clone for another namespace inherits it only when no `fieldDefLookupFor` is given. */
  readonly #fieldDefLookup: FieldDefLookup | null;
  readonly #fieldDefLookupFor: ((namespace: string) => FieldDefLookup) | null;
  readonly #layoutCache: LayoutCache;
  readonly #typeDefLookup: TypeDefLookup | null;
  readonly #diskGuard: DiskGuard | undefined;
  readonly #statementTimeoutMs: number;
  readonly #tableCache: TableCache;
  readonly #txTables: TxTables | null;
  readonly #ctx: PgContext;

  constructor(options: PgDatasetOptions | InternalPgSubstrateDatasetOptions) {
    this.namespace = options.namespace;
    this.#sql = options.sql;
    // `inTx` is only set via the internal options shape; the public
    // constructor always produces a non-tx instance.
    this.#inTx = 'inTx' in options ? options.inTx : false;
    // Tx-bound datasets inherit their parent's txScopeId.
    const explicit = 'txScopeId' in options ? options.txScopeId : undefined;
    this.txScopeId = explicit ?? txScopeIdFor(options.sql);
    this.walkStoreId = this.txScopeId;
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
    this.#fieldDefLookupFor = options.fieldDefLookupFor ?? null;
    this.#layoutCache = ('layoutCache' in options ? options.layoutCache : undefined) ?? {};
    this.#typeDefLookup = options.typeDefLookup ?? null;
    this.#diskGuard = options.diskGuard;
    this.#statementTimeoutMs = options.statementTimeoutMs ?? WALK_STATEMENT_TIMEOUT_MS;
    this.#tableCache =
      ('tableCache' in options ? options.tableCache : undefined) ?? tableCacheFor(options.sql);
    this.#txTables = ('txTables' in options ? options.txTables : undefined) ?? null;
    this.#ctx = {
      namespace: this.namespace,
      sql: this.#sql,
      inTx: this.#inTx,
      fieldDefLookup: this.#fieldDefLookup,
      fieldDefLookupFor: this.#fieldDefLookupFor,
      typeDefLookup: this.#typeDefLookup,
      diskGuard: this.#diskGuard,
      layout: () => this.#layout(),
      tableFor: (type, namespace, read) => this.#tableFor(type, namespace, read),
      guarded: (type, table, write) => this.#guarded(type, table, write)
    };
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

  /** Drops `namespace`/`type`'s descriptor from the transaction's map and the pool's cache. */
  #forget(type: string, namespace = this.namespace): void {
    const key = `${namespace}/${type}`;
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
        throw (
          queryTimeoutError(`${this.namespace}/${type}`, err, params.signal) ??
          storeBusy(err) ??
          err
        );
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
        queryTimeoutError(
          `${this.namespace}/${type}`,
          err,
          params.signal,
          lowered ? this.#statementTimeoutMs : undefined
        ) ??
        storeBusy(err) ??
        err
      );
    }
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
        return await readOnce(this.#ctx, type, params, walks, resolveOnce);
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
            const table = await loadTypeTable(this.#sql, t.ns, t.type);
            this.#txTables?.set(`${t.ns}/${t.type}`, {
              table: table ?? null,
              gen: -1,
              snapshot: true
            });
          }
        } else {
          for (const t of err.types) this.#forget(t.type, t.ns);
        }
      }
    }
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

    // Held to commit, so `hasRowsLocked` waits for this write. A write outside a
    // transaction is the store's own (the engine writes in one), and skips it.
    if (this.#inTx) {
      await this.#sql`SELECT pg_advisory_xact_lock_shared(hashtext(
        'substrate-type-rows:' || current_schema() || ':' || ${this.namespace} || '/' || ${type}))`;
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
        throw uniqueViolation(this.#ctx, type, err);
      })) as unknown as GuardedRecord[];
    });
    const fields = this.#typeDefLookup?.(type, this.namespace)?.fields;
    const merged = written.records.map((r) => materialize(r, fields, written.table));
    return { written: merged.length, ids: merged.map((r) => r.id), rows: merged };
  }

  async lockShared(type: string, ids: Id[]): Promise<void> {
    await this.#lockRows(type, ids, 'FOR SHARE OF r');
  }

  async lockForUpdate(type: string, ids: Id[]): Promise<void> {
    // A check relies on this lock, so refuse where it would protect nothing.
    if (!this.#inTx) throw new Error('PgDataset.lockForUpdate needs a transaction');
    await this.#lockRows(type, ids, 'FOR NO KEY UPDATE OF r');
  }

  /**
   * See `Dataset.hasRowsLocked`. Holds the type's rows lock alone, which a
   * write inside a transaction holds shared until it commits. The lock is
   * tried rather than queued for, as `moveFieldState` tries its own: a queued
   * request would hold up every later write of the type. The table is looked
   * up past the cache, which may not yet know of one just committed.
   */
  async hasRowsLocked(type: string, namespace = this.namespace): Promise<boolean | undefined> {
    if (!this.#inTx) throw new Error('PgDataset.hasRowsLocked needs a transaction');
    if ((await this.#layout()) === 'absent') {
      throw new Error('PgDataset.hasRowsLocked: the store is not migrated');
    }
    const tx = this.#sql as TransactionSql;
    const deadline = Date.now() + ROWS_LOCK_TRY_MS;
    for (let backoff = 10; ; backoff = Math.min(backoff * 2, 200)) {
      const [held] = await tx<Array<{ ok: boolean }>>`SELECT pg_try_advisory_xact_lock(hashtext(
        'substrate-type-rows:' || current_schema() || ':' || ${namespace} || '/' || ${type})) AS ok`;
      if (held?.ok === true) break;
      const left = deadline - Date.now();
      if (left <= 0) return undefined;
      await new Promise((r) => setTimeout(r, Math.min(backoff, left)));
    }
    const name = await typeTableOf(tx, namespace, type);
    if (name === undefined) return false;
    return (await tx.unsafe(`SELECT 1 FROM ${ident(name)} LIMIT 1`)).length > 0;
  }

  /** Locks the live rows among `ids` until the transaction ends; outside one, nothing. */
  async #lockRows(
    type: string,
    ids: Id[],
    strength: 'FOR SHARE OF r' | 'FOR NO KEY UPDATE OF r'
  ): Promise<void> {
    if (!this.#inTx || ids.length === 0) return;
    const table = await this.#tableFor(type);
    if (table === undefined) return;
    // In id order, as tombstone and patchRows lock, so overlapping lockers,
    // writers and deleters queue rather than deadlock.
    await this.#sql`
      SELECT 1 FROM ${this.#sql.unsafe(table.from)} r
      WHERE r.id = ANY(${ids.map(idToText)}) AND r.deleted_at IS NULL
      ORDER BY r.id
      ${this.#sql.unsafe(strength)}
    `;
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

    const stamped: Id[] = rows.map((r) => extractOriginalId(r.id, r.body));
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

    const removed: Id[] = rows.map((r) => extractOriginalId(r.id, r.body));
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
    const [row] = await patchTable(
      this.#ctx,
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
    await patchTable(
      this.#ctx,
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
    const out = (await busyAware(
      rootSql.begin<T>(async (txSql) => {
        const txDataset = new PgDataset({
          namespace: this.namespace,
          sql: txSql,
          inTx: true,
          txScopeId: this.txScopeId,
          ...this.#fieldDefOptions(this.namespace),
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
      })
    )) as T;
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
            ...this.#fieldDefOptions(ns),
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
    const out = (await busyAware(
      rootSql.begin<T>(async (txSql) => {
        const result = await fn(buildHandles(txSql));
        await snapshotUnlessReadCommitted(txSql, txTables);
        return result;
      })
    )) as T;
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
    // Not a read path: a crossRef check resolves through it before its write,
    // so inside a transaction it re-checks a cached miss, as a write does.
    const table = await this.#tableFor(type);
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
    const rows = await patchTable(
      this.#ctx,
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
    const build = (t: TypeTable) => {
      const rows = [{ ...encodeRow(t, patch), id: '' }];
      return {
        input: inputCte(sql, t, rows),
        assign: sql`${sql.unsafe(setList(mergeAssignments(t, 'r', 'i', rows)))}, ${stamp}`
      };
    };
    return filterWrite(this.#ctx, type, where, opts.maxMatch, build, false, table).catch(
      (err: unknown) => {
        // A set onto a declared unique index's values: refused as `patchRows` refuses it.
        throw uniqueViolation(this.#ctx, type, err);
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
    return filterWrite(
      this.#ctx,
      type,
      where,
      opts.maxMatch,
      () => ({ input: null, assign }),
      true,
      table
    );
  }

  /**
   * The field-definition options for a handle on `ns`: this handle's own lookup
   * for its own namespace (or when no factory is given), the factory's answer
   * for any other. The factory is always passed on.
   */
  #fieldDefOptions(
    ns: string
  ): Pick<InternalPgSubstrateDatasetOptions, 'fieldDefLookup' | 'fieldDefLookupFor'> {
    const factory = this.#fieldDefLookupFor;
    const lookup = factory === null || ns === this.namespace ? this.#fieldDefLookup : factory(ns);
    return {
      ...(lookup !== null ? { fieldDefLookup: lookup } : {}),
      ...(factory !== null ? { fieldDefLookupFor: factory } : {})
    };
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
      ...this.#fieldDefOptions(namespace),
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
    await reconcileIndexes(this.#ctx, type, opts);
    return { pending: change.pending };
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
        await reconcileIndexes(view.#ctx, type, signal !== undefined ? { signal } : {});
      }
    });
  }

  /** See `Dataset.poolStats`. Read on the root dataset; outside a transaction `#sql` is the pool. */
  poolStats(): PoolStats {
    const { connections, opening, idle, leased, waiting } = (this.#sql as Sql).stats;
    return { connections, opening, idle, leased, waiting };
  }

  /** See `Dataset.fieldWarnings`. */
  fieldWarnings(): Promise<string[]> {
    return fieldWarnings(this.#ctx);
  }

  /** The type's non-unique indexes the next build pass would build or swap. */
  pendingIndexBuilds(type: string): Promise<Array<{ name: string; estimateBytes: number }>> {
    return pendingIndexBuilds(this.#ctx, type);
  }

  /** See `Dataset.describeStorage`. */
  describeStorage(type: string): Promise<TypeStorageReport> {
    return describeStorage(this.#ctx, type);
  }

  /** See `Dataset.storageReport`. */
  storageReport(opts: { partitionBudget: number }): Promise<StorageReport> {
    return storageReport(this.#ctx, opts);
  }

  /** See `Dataset.indexPlan`. */
  indexPlan(type: string, namespace: string): Promise<IndexPlan | undefined> {
    return indexPlan(this.#ctx, type, namespace);
  }

  /** See `Dataset.dropEngineIndex`. */
  dropEngineIndex(
    type: string,
    name: string,
    opts: { beforeDrop?: () => Promise<void>; lockTimeoutMs?: number } = {}
  ): Promise<void> {
    return dropEngineIndex(this.#ctx, type, name, opts);
  }

  /** See `Dataset.dropNamespaceIndexes`. */
  dropNamespaceIndexes(opts: { unique?: boolean; lockTimeoutMs?: number } = {}): Promise<string[]> {
    return dropNamespaceIndexes(this.#ctx, opts);
  }

  /** See `Dataset.indexDeclarationOf`. */
  indexDeclarationOf(type: string, name: string): Promise<IndexDecl | undefined> {
    return indexDeclarationOf(this.#ctx, type, name);
  }

  /** See `Dataset.typeStats`. */
  typeStats(): Promise<TypeStats[]> {
    return typeStats(this.#ctx);
  }
}

/** The statement timeout a walk read runs under, in milliseconds, unless a shorter one is set. */
export const WALK_STATEMENT_TIMEOUT_MS = 30_000;

/** How long `hasRowsLocked` tries for a type's rows lock before answering undefined. */
const ROWS_LOCK_TRY_MS = 2000;

/**
 * The driver's `QUEUE_TIMEOUT` (no pooled connection came free within
 * `queue_timeout`) as `store_busy`, else null. The request never reached
 * Postgres, so a retry is safe.
 */
function storeBusy(err: unknown): ResolverFrameError | null {
  if ((err as { code?: unknown } | null)?.code !== 'QUEUE_TIMEOUT') return null;
  return new ResolverFrameError(
    STORE_BUSY,
    'the store is busy: no database connection came free in time; retry shortly'
  );
}

/**
 * Postgres aborting the transaction to break a deadlock (40P01) or a
 * serialization conflict (40001) as `write_conflict`, else null; thrown
 * directly or as a batch element's cause. The transaction rolled back, so a
 * retry is safe.
 */
function writeConflict(err: unknown): ResolverFrameError | null {
  const cause = isBatchElementError(err) ? err.cause : err;
  const code = (cause as { code?: unknown } | null)?.code;
  if (code !== '40P01' && code !== '40001') return null;
  return new ResolverFrameError(
    WRITE_CONFLICT,
    'the write conflicted with a concurrent write and was rolled back; retry it'
  );
}

/** Awaits a transaction, rethrowing a `QUEUE_TIMEOUT` as `store_busy` and an abort by Postgres as `write_conflict`. */
async function busyAware<T>(p: Promise<T>): Promise<T> {
  try {
    return await p;
  } catch (err) {
    throw storeBusy(err) ?? writeConflict(err) ?? err;
  }
}

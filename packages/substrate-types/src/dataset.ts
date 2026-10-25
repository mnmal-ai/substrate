/**
 * Storage abstraction. Spec: §4.5, §5.2.
 *
 * `Dataset` is bound to exactly one namespace at construction time.
 * `DatasetRegistry` maps namespace → dataset; the engine routes by namespace.
 *
 * Reserved field: `_deletedAt` is managed exclusively by `tombstone()` and
 * `purge()`. `updateField` rejects writes to it with `ReservedField`; `write`
 * sanitises any caller-supplied `_deletedAt` from input rows.
 *
 * Filter contract (§5.2): `read(...)` returns a paged `ReadResult` rather than
 * a bare `Row[]`. Callers surface `rows`; `nextCursor`/`hasMore` drive the
 * envelope's `_pagination` block.
 */

import type { ActorIdentity, Id, Row } from './core.js';
import type { EdgesStore } from './edge.js';

/**
 * Handles yielded by `Dataset.withScopedTransaction`. Contains the
 * tx-bound dataset for every requested namespace plus (optionally) a
 * tx-bound edges store enlisted into the same substrate transaction.
 * See `withScopedTransaction` JSDoc for the `edges` contract.
 */
export interface TxScopeHandles {
  datasets: Map<string, Dataset>;
  edges: EdgesStore | null;
}

// ---------------------------------------------------------------------------
// Filter contract (spec §5.2)
//
// Per-kind operator allowlists live in `@mnmal-ai/substrate-filter`
// (`builtin-operators.ts`); do not add type-level copies here.
// ---------------------------------------------------------------------------

/**
 * A leaf predicate on a single field. At most one operator per call-site is
 * used in practice (e.g. `{ age: { gt: 18 } }`), but the shape admits several
 * operators so `{ age: { gte: 10, lt: 100 } }` can express a half-open range
 * without the caller reaching for an explicit `AND`. Semantics: the leaf
 * matches when EVERY specified operator matches (implicit AND within a leaf).
 *
 * `eq`/`neq` accept `null` to address IS NULL / IS NOT NULL semantics at the
 * substrate layer — the validator enforces `null` only on those two operators.
 */
export interface FieldPredicate {
  // number / date operators (also reused as string `eq`/`neq`/`in`/`nin`)
  eq?: number | string | boolean | Date | null;
  neq?: number | string | boolean | Date | null;
  gt?: number | string | Date;
  gte?: number | string | Date;
  lt?: number | string | Date;
  lte?: number | string | Date;
  between?: [number | string | Date, number | string | Date];
  in?: Array<number | string | boolean | Date>;
  nin?: Array<number | string | boolean | Date>;

  // string-only operators
  contains?: string;
  startsWith?: string;
  endsWith?: string;

  // list-only operator: element membership. Operand is a single element matched
  // against the list field's declared element type (`FieldDefList.of`).
  has?: number | string | boolean | Date | null;

  // Json fields only: the keys to walk inside the json value.
  // Operators beside it apply to the value found there, type-strictly.
  path?: string[];
}

/**
 * A where clause is either a logical combinator OR a map of field names to
 * predicates / nested where clauses (for struct fields). Field names and the
 * three combinator keys (AND/OR/NOT) share a namespace — `AND`/`OR`/`NOT` are
 * reserved and must not collide with field names declared in any type.
 */
export type WhereClause =
  | { AND: WhereClause[] }
  | { OR: WhereClause[] }
  | { NOT: WhereClause }
  | { [field: string]: FieldPredicate | WhereClause | unknown };

/**
 * OrderBy clause. One entry per field, direction per field. Engine appends an
 * implicit `{ id: 'asc' }` when callers omit `id` as the final tie-breaker — a
 * deterministic tie-break is what makes cursor pagination stable across pages.
 */
export interface OrderByClause {
  [field: string]: 'asc' | 'desc';
}

export interface ReadParams {
  id?: Id;
  ids?: Id[];
  includeDeleted?: boolean;
  where?: WhereClause;
  orderBy?: OrderByClause[];
  limit?: number;
  /**
   * Opaque cursor produced by a prior `read()` call. Base64url-encoded JSON
   * (server-built, server-consumed). Callers should treat it as a black box.
   */
  cursor?: string;
  /**
   * Admin-gated escape hatch for filtering on unindexed fields. Absent → the
   * validator rejects filters on any `indexed: false` field. Policies can pin
   * this to admin identities.
   */
  _allowTableScan?: boolean;
  /**
   * Optional caller-supplied projection hint. Substrates MAY use this to
   * narrow the body keys they materialise from storage — e.g. PgDataset
   * builds a `jsonb_build_object(...)` projection over only the requested
   * top-level body keys, saving wire + parse bandwidth.
   *
   * When present, ONLY top-level entries are honoured (the value can be `true`
   * or a nested FieldInput-shaped object — the substrate treats both as
   * "include this key"). Nested projection inside JSONB sub-trees is intentionally
   * out of scope; the pack codec already prunes deeper. Row-metadata-style keys
   * (`_metadata`, `shortId`, `_deletedAt`, `id`) are populated from dedicated
   * columns regardless of `fields` and never need to be included here.
   *
   * When absent, substrates return the full body, for raw `dataset.read()`
   * callers (sweep, compose registry, migration scripts) that don't know which
   * body keys they'll need downstream.
   *
   * Substrates MAY ignore this hint — it's a perf optimisation, not a contract.
   * Memory dataset, for instance, has no wire to save and ignores it.
   */
  fields?: { [field: string]: true | unknown };
}

/**
 * Paged result of a `read()` call. `rows` is always present; `nextCursor` is
 * present iff `hasMore` is `true` and the current page is non-empty.
 */
export interface ReadResult {
  rows: Row[];
  nextCursor?: string;
  hasMore: boolean;
}

export interface WriteResult {
  written: number;
  ids: Id[];
  /**
   * Merged rows after upsert — substrates populate this with the post-merge
   * row state so autoCRUD update can skip its post-read. Order
   * matches `ids` (one entry per input row). Substrates that can't compute
   * the merged shape cheaply may emit input rows verbatim; consumers must
   * not rely on body keys absent from the input being filled in.
   */
  rows: Row[];
}

/**
 * Optional 3rd-arg to `dataset.write` / `tx.write`. When the incoming row's
 * `_metadata` is absent, the substrate auto-fills it from these hints:
 *   - `now` → both `createdAt` and `updatedAt` (defaults to `new Date()`)
 *   - `identity` → both `createdBy` and `updatedBy` (defaults to `null`)
 *
 * On upsert collision, `created_*` columns preserve existing values (immutability);
 * `updated_*` columns adopt the new values (bump intent). Engine path
 * (`autocrud-create`/`autocrud-update`) constructs full `_metadata` itself —
 * this auto-fill is purely a safety net for raw-write bypass paths.
 */
export interface WriteOptions {
  readonly identity?: ActorIdentity;
  readonly now?: Date;
  /**
   * Insert only: a row whose id already exists (live or tombstoned) is left
   * untouched and omitted from the result's `ids` and `rows`. The existence
   * check and the insert are one atomic step.
   */
  readonly insertOnly?: boolean;
}

export interface DeleteResult {
  deleted: number;
  ids: Id[];
}

export interface DropResult {
  /** Number of rows physically removed. */
  rowsDeleted: number;
  /** Number of short-id allocations physically removed. */
  shortIdsDeleted: number;
}

/**
 * Dataset-declared filter capabilities. §5.2 capability negotiation: the engine
 * validates every where-clause leaf against `operators[fieldKind]` and rejects
 * ops the dataset can't execute rather than returning a silently wrong result.
 */
export type FieldKind =
  | 'scalar.number'
  | 'scalar.string'
  | 'scalar.boolean'
  | 'scalar.date'
  | 'scalar.json'
  | 'crossRef'
  | 'list';

export interface FilterCapabilities {
  operators: Record<FieldKind, string[]>;
  /** Does the dataset honour `orderBy`? */
  orderBy: boolean;
  /** Does the dataset honour cursor-based pagination? */
  cursor: boolean;
}

export interface UpdateFieldRef {
  ns?: string;
  type: string;
  id: Id;
}

/**
 * Outcome of a `conditionalUpdate` call (spec §5.12 Phase 2 / Dispatch B).
 *
 * `matched: true` when the row existed AND every key in `match` equalled the
 * row's stored value at the moment of the update — the substrate applied
 * `updates` and returned the merged row. `matched: false` when the row was
 * missing or at least one match condition failed; in both cases no write landed
 * and `row` is `null`.
 */
export interface ConditionalUpdateResult {
  matched: boolean;
  row: Row | null;
}

export interface Dataset {
  readonly namespace: string;
  /**
   * Stable identifier for the storage substrate this dataset wraps. Two
   * datasets share a substrate when their `txScopeId` values are `===`
   * — they can participate in a single transaction via the engine's
   * substrate-coalescing path (spec §5.3, enabling cross-namespace G1
   * batched mutations when all frames target the same substrate).
   *
   * Convention:
   * - pg: derived from the `postgres.Sql` pool reference identity. All
   *   `PgDataset` instances constructed against the same `sql`
   *   handle share one `txScopeId`.
   * - memory: unique per `MemoryDataset` instance by default (each
   *   instance owns its own `Map`). Test harnesses that want shared-
   *   memory semantics can opt in via an explicit constructor option.
   *
   * Datasets with different `txScopeId` values CANNOT participate in a
   * single transaction — the engine refuses mixed-substrate batched
   * mutates with `cross_tx_scope_refused`.
   */
  readonly txScopeId: string;
  read(type: string, params: ReadParams): Promise<ReadResult>;
  write(type: string, rows: Row[], options?: WriteOptions): Promise<WriteResult>;
  tombstone(type: string, ids: Id[]): Promise<DeleteResult>;
  purge(type: string, ids: Id[]): Promise<DeleteResult>;
  /**
   * Physically delete every row of `type` within this dataset's namespace,
   * plus every short-id allocation for that type. Ignores `_deletedAt` /
   * `archived` state — drop is hard-delete regardless of row status.
   *
   * MUST run inside a caller-supplied `withTransaction` if atomicity with
   * edge cleanup / audit emission is required. When called standalone,
   * implementations MUST still execute the row-delete + short-id-delete as
   * a single atomic step against the substrate.
   *
   * Returns the exact counts physically removed. If the type has no rows,
   * returns zeros without error.
   *
   * Storage-level primitive: operates on any (namespace, type) rows present
   * in storage regardless of whether the type is currently known to the
   * engine's registry.
   */
  dropType(type: string): Promise<DropResult>;
  /**
   * Physically delete every row AND short-id for `this.namespace`, across
   * every type. Equivalent to calling `dropType` for each distinct type
   * seen in storage, but substrate impls SHOULD use a single bulk DELETE
   * where available (pg: `DELETE FROM rows WHERE namespace = $1`).
   *
   * Same atomicity rules as `dropType`. Same "ignores archived state".
   */
  dropNamespace(): Promise<DropResult>;
  updateField(ref: UpdateFieldRef, fieldName: string, value: unknown): Promise<void>;
  /**
   * Atomic compare-and-update by PK. If the row `(type, id)` exists AND every
   * `(field, value)` pair in `match` equals the stored row's field, apply the
   * `updates` map and return `{ matched: true, row: mergedRow }`. Otherwise
   * write nothing and return `{ matched: false, row: null }`.
   *
   * Semantics:
   *   - Equality is strict (`===`) for scalars; `Date` compares by
   *     `.getTime()`; `null` matches only a stored `null` (including
   *     intentionally-null fields set via `updateField`), never an absent field.
   *   - A missing row fails the match even when `match` is empty — the
   *     operation is "update this existing row if predicate holds".
   *   - `updates` is merged onto the stored row the same way `write()` upserts
   *     merge: each key overwrites; omitted keys are preserved. `_deletedAt`
   *     is reserved and silently skipped (matches `write()`'s sanitisation).
   *   - The whole check+write is atomic against other dataset operations.
   *     Implementations MUST NOT yield between the predicate test and the
   *     write. Pg uses `UPDATE ... WHERE <match> RETURNING *` inside the
   *     caller's enclosing `withTransaction`; memory runs the whole body
   *     synchronously within the `async` microtask.
   *
   * Motivating use case: the `_system` register route consumes a one-shot
   * invite — the invite row's `consumedAt` must transition from `null` to a
   * timestamp exactly once, even under concurrent registrations.
   *
   * Metadata: a successful match unconditionally bumps `updatedAt` to `now`
   * (a server-set `now()` when omitted) and stamps `updatedBy` with the supplied `actor` (or
   * a `{ kind: 'system', id: 'anonymous' }` sentinel when omitted) — same
   * semantics as `write()`'s upsert path, so recency-ranked recall sees the
   * change. `createdAt` / `createdBy` are preserved.
   */
  conditionalUpdate(
    type: string,
    id: Id,
    match: Record<string, unknown>,
    updates: Record<string, unknown>,
    actor?: ActorIdentity,
    now?: Date
  ): Promise<ConditionalUpdateResult>;
  readonly capabilities: FilterCapabilities;
  /**
   * Run `fn` while holding a mutual-exclusion lock named `key`, waiting until
   * it is free. Excludes every other holder of the same key on this substrate:
   * pg holds a session advisory lock, so the exclusion spans processes sharing
   * the database; memory excludes holders on this dataset instance only.
   * Released when `fn` settles, whether it resolves or throws, except on a
   * pg tx-bound dataset, where it is held until the transaction ends so the
   * next holder sees what this one committed. Not re-entrant:
   * re-acquiring a held key inside `fn` waits forever.
   *
   * OPTIONAL. Callers feature-detect and fall back to a process-local lock.
   *
   * @returns whatever `fn` resolves to
   * @throws whatever `fn` throws, after the lock is released
   */
  withAdvisoryLock?<T>(key: string, fn: () => Promise<T>): Promise<T>;
  /**
   * Prepare dedicated storage for `type` in this namespace, moving any rows
   * already written for it there. Idempotent, and safe beside concurrent
   * reads and writes: no row is lost, duplicated or seen twice. That holds for
   * READ COMMITTED readers; a REPEATABLE READ snapshot taken before the move
   * can miss the moved rows. Also builds the type's indexes, including its
   * declared `indexes`, and throws when a unique one cannot be built.
   *
   * `indexes` picks which: `unique` builds only the unique ones and leaves the
   * rest `pending`, for a later `nonUnique` call to build. `signal` cancels an
   * in-flight non-unique build, which the next call retries. Default `all`.
   *
   * OPTIONAL. Backends without per-type storage omit it.
   */
  ensureTypeStorage?(
    type: string,
    opts?: { indexes?: 'all' | 'unique' | 'nonUnique'; signal?: AbortSignal }
  ): Promise<void>;
  /**
   * Where `type`'s rows live and how its declared indexes stand, read from the
   * catalog without building anything.
   *
   * OPTIONAL. Backends without per-type storage omit it.
   */
  describeStorage?(type: string): Promise<TypeStorageReport>;
  /**
   * The database-wide storage layout and what an operator should look at:
   * rows parked in DEFAULT partitions, indexes and CHECK constraints on the
   * `rows` parent, engine-named indexes no longer declared, indexes this
   * process has yet to build or failed to build, and a partition count over
   * `partitionBudget`. Never changes anything.
   *
   * OPTIONAL. Backends without per-type storage omit it.
   */
  storageReport?(opts: { partitionBudget: number }): Promise<StorageReport>;
  /**
   * Execute `fn` atomically. All ops performed on the `tx` argument run inside
   * one substrate transaction. If `fn` throws or returns a rejected promise,
   * every mutation inside the callback rolls back. If `fn` resolves, the
   * transaction commits and the resolved value is returned.
   *
   * Scope rules:
   * - `tx.namespace === this.namespace`
   * - Calls on the outer dataset (`this`) inside `fn` bypass the transaction
   *   and are NOT rolled back on failure — this is a caller bug; implementations
   *   MUST NOT attempt to guard against it. All ops inside `fn` MUST go through
   *   `tx`.
   * - Nested `tx.withTransaction(...)` is implementation-defined. The reference
   *   impls (memory, pg) flatten nested calls into the outermost transaction
   *   (no savepoints).
   */
  withTransaction<T>(fn: (tx: Dataset) => Promise<T>): Promise<T>;

  /**
   * Engine-only. Open a substrate-level transaction spanning multiple
   * namespaces on the same substrate, and invoke `fn` with a handles object
   * containing tx-bound datasets + (optionally) a tx-bound `EdgesStore`.
   * Called by the engine's mutate path (spec §5.3) for both single-ns and
   * cross-ns frames — the engine calls with `[ns]` for the single-ns case.
   *
   * `namespaces` is the full set of namespaces the engine will dispatch
   * frames to inside the tx. Implementations MUST return a tx-bound
   * dataset for every requested namespace in `handles.datasets`; missing
   * entries are a programming error on the caller side.
   *
   * `handles.edges` contract:
   * - `non-null` when the implementation can enlist a shared `EdgesStore`
   *   into the same substrate tx (e.g. pg where the `PgEdgesStore` is wired
   *   in via constructor and shares the `Sql`). The engine routes edge
   *   mutations through this handle — true cross-store atomicity for
   *   row + edge within one frame.
   * - `null` when the implementation can't enlist (e.g. memory datasets
   *   where edges live in a separate Map). The engine falls back to
   *   running edge ops in a nested independent tx and accepts the
   *   visibility-ordering quirk documented in `autocrud-delete.ts`.
   *
   * Scope rules mirror `withTransaction`:
   * - All ops on values from `handles.datasets.get(ns)` and `handles.edges`
   *   run in the same tx.
   * - Ops on the outer dataset (`this`) inside `fn` bypass the tx — caller
   *   bug; implementations do not guard.
   * - A throw or rejection inside `fn` rolls back every mutation across
   *   every namespace + edges in the tx.
   *
   * OPTIONAL. Implementations that can't coalesce cross-namespace writes
   * into one substrate transaction omit this method — the engine falls
   * back to refusing cross-namespace batches with `cross_tx_scope_refused`
   * (and loses edge-enlist for single-ns).
   */
  withScopedTransaction?<T>(
    namespaces: ReadonlyArray<string>,
    fn: (handles: TxScopeHandles) => Promise<T>
  ): Promise<T>;

  /**
   * Allocate the next short id for the given type within this dataset's
   * namespace. Monotonic per (namespace, type). Does NOT record any
   * row-id mapping — call `bindShortId` after the row is written.
   *
   * The implementation may use the dataset's current tx handle so the
   * sequence advance rolls back on tx rollback (postgres sequences
   * actually never roll back, but the surrounding tx semantics match
   * what callers expect).
   */
  allocateShortId(type: string): Promise<number>;

  /**
   * Record the (shortId → rowId) pairing after the row is written.
   * Called by autoCRUD create immediately after the dataset write()
   * returns the new row id. Safe to call within the enclosing tx.
   */
  bindShortId(type: string, shortId: number, rowId: string): Promise<void>;

  /**
   * Resolve a short id to the underlying row id, or null if no such short
   * id exists for this (namespace, type). Does not join `rows` —
   * callers chain their own `read()` after resolution.
   */
  resolveShortId(type: string, shortId: number): Promise<string | null>;

  /**
   * Inverse of `resolveShortId` — look up the short id assigned to a
   * given row id. Returns null if no sidecar entry exists (e.g. rows written
   * before short ids were allocated).
   */
  getShortIdForRow(type: string, rowId: string): Promise<number | null>;

  /**
   * Spawn a sibling dataset bound to the same backing store but scoped to
   * a different namespace. Used by `compose()` to auto-allocate per-namespace
   * datasets when a coordinator plugin claims a namespace the operator hasn't
   * mapped explicitly.
   *
   * Substrate semantics:
   * - Pg: returns a new `PgDataset` sharing this dataset's `sql` pool +
   *   `edgesStore`. The returned dataset has the SAME `txScopeId` (so it
   *   can participate in cross-namespace batched mutations on the shared pool).
   * - Memory: returns a new `MemoryDataset` with its own backing `Map`
   *   per the default convention (each instance owns its own substrate). The
   *   returned dataset has a NEW `txScopeId` — it cannot share a transaction
   *   with the caller. Test harnesses that need shared-memory semantics across
   *   namespaces should construct each `MemoryDataset` explicitly with
   *   the relevant constructor option.
   *
   * Idempotency note: callers SHOULD NOT call `forNamespace(this.namespace)`;
   * the resulting object's identity is implementation-defined. Use this only
   * to derive datasets for *different* namespaces.
   */
  forNamespace(namespace: string): Dataset;
}

export interface DatasetRegistry {
  get(ns: string): Dataset | undefined;
  has(ns: string): boolean;
  set(ns: string, dataset: Dataset): void;

  /**
   * Observe namespace lifecycle events (§6.4). Fires when a namespace is
   * disposed — explicit unregister or substrate-signalled loss (memory-backed
   * restart). Returns a disposer that unsubscribes when invoked.
   *
   * Optional: registries over persistent substrates (pg) never lose namespaces
   * at runtime and can omit this surface entirely. Consumers MUST feature-
   * detect before subscribing.
   */
  onNamespaceLost?(listener: (ns: string) => void): () => void;

  /**
   * Explicitly drop `ns` from the registry and fire `onNamespaceLost`
   * listeners synchronously. Disposing an unregistered namespace is a silent
   * no-op — keeps graceful-shutdown replays idempotent.
   *
   * Optional: same rationale as `onNamespaceLost`.
   */
  dispose?(ns: string): void;
}

/**
 * One declared index of a type and its state: as the catalog holds it, or,
 * while this process defers or runs its build, `pending`, `building` or
 * `failed`. Filters on an index that is not `valid` scan.
 */
export interface TypeIndexState {
  name: string;
  fields: string[];
  unique: boolean;
  state: 'valid' | 'building' | 'pending' | 'invalid' | 'failed';
  outcome: 'created' | 'adopted' | 'swapped' | 'unchanged';
}

/** Where a type's rows live: `partition` is set on the partitioned layout once the type has one. */
export interface TypeStorageReport {
  layout: 'legacy' | 'partitioned';
  partition?: string;
  indexes: TypeIndexState[];
}

export interface StorageReport {
  /** `unknown` when the report itself failed. */
  layout: 'legacy' | 'partitioned' | 'unknown';
  warnings: string[];
}

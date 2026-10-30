/**
 * MemoryDataset — in-memory reference implementation of Dataset.
 * Spec: §4.5, §5.2.
 *
 * One instance per namespace. Rows keyed by (type, id).
 *
 * Reserved field policy:
 *   - `_deletedAt` is managed exclusively by tombstone() / purge().
 *   - write() sanitises `_deletedAt` (including explicit null) out of inputs.
 *   - updateField() with fieldName === '_deletedAt' throws ReservedField.
 *
 * Filter contract (§5.2): `read()` honours `where` + `orderBy` + `cursor` in
 * addition to the id/ids/includeDeleted/limit short-circuit. Filter evaluation
 * is in-memory; there's no indexing, so every filter is a scan.
 */

import { randomUUID } from 'node:crypto';
import {
  applyExtensionResultMeta,
  asSortValue,
  assertWhereHonourable,
  compareFilterValues,
  decodeCursor,
  type ExtensionOpResultMeta,
  encodeCursor,
  evaluateWhere,
  type FieldDefOf,
  fieldRequested,
  fullBuiltinOperators,
  getFieldValue,
  isDateField,
  preResolveExtensionOperatorsDetailed,
  type WalkContext
} from '@mnmal-ai/substrate-filter';
import type {
  ActorIdentity,
  ConditionalUpdateResult,
  Dataset,
  DeleteResult,
  DropResult,
  FieldDef,
  FilterCapabilities,
  Id,
  OrderByClause,
  ReadParams,
  ReadResult,
  Row,
  RowMetadata,
  UpdateFieldRef,
  WhereClause,
  WriteOptions,
  WriteResult,
  WriteRow
} from '@mnmal-ai/substrate-types';
import { assertNoRepeatedIds, createKeyedMutex } from '@mnmal-ai/substrate-types';
import { NamespaceMismatch, ReservedField } from './errors.js';
import { MemoryShortIdStore, type ShortIdBucketSnapshot } from './memory-short-id-store.js';
import { uuidv7 } from './uuidv7.js';

export interface MemoryDatasetOptions {
  namespace: string;
  /**
   * Substrate identity. Each `MemoryDataset` instance owns its own
   * `Map` storage, so by default instances are distinct substrates. Tests
   * that want cross-namespace batched mutates in memory can construct
   * multiple instances with the same explicit `txScopeId`, but must
   * also share the underlying `store` and `shortIds` state themselves —
   * the memory dataset does NOT coordinate storage across instances
   * that happen to share a txScopeId string. This knob exists mainly
   * so the engine can exercise the cross-substrate refusal path in
   * tests without spinning up pg.
   */
  txScopeId?: string;
  /**
   * The namespace's field declarations. Lets `date` fields filter and sort as
   * instants, as the pg dataset's lookup does; without it they compare as text.
   */
  fieldDefLookup?: (type: string, field: string) => FieldDef | undefined;
  /**
   * The namespace's type definitions; a type declared `ordering: 'visible'`
   * gets `_metadata.seq` on insert, as the pg dataset's lookup does.
   */
  typeDefLookup?: (type: string, namespace: string) => { ordering?: 'visible' } | undefined;
}

const RESERVED_DELETED_AT = '_deletedAt';

/**
 * Merge incoming `_metadata` into existing per-field. `created*` are immutable
 * post-creation: existing wins on collision (matches the pg upsert COALESCE
 * order). `updated*` adopt incoming values (bump intent), falling back to
 * existing when incoming is null.
 */
function mergeRowMetadata(existing: RowMetadata | undefined, incoming: RowMetadata): RowMetadata {
  if (existing === undefined) return withoutSeq(incoming);
  return {
    createdAt: existing.createdAt ?? incoming.createdAt,
    updatedAt: incoming.updatedAt ?? existing.updatedAt,
    createdBy: existing.createdBy ?? incoming.createdBy,
    updatedBy: incoming.updatedBy ?? existing.updatedBy,
    // seq is assigned on insert only; a caller never sets or changes it.
    ...(existing.seq !== undefined ? { seq: existing.seq } : {})
  };
}

function withoutSeq(meta: RowMetadata): RowMetadata {
  if (meta.seq === undefined) return meta;
  const { seq: _seq, ...rest } = meta;
  return rest;
}

export class MemoryDataset implements Dataset {
  readonly namespace: string;
  readonly txScopeId: string;
  readonly #fieldDefLookup: MemoryDatasetOptions['fieldDefLookup'];
  // TS-private, not `#`: write() must work through a Proxy, as `store` does.
  private readonly typeDefLookup: MemoryDatasetOptions['typeDefLookup'];
  /** Last seq assigned per visible-order type; never decreases, as pg's `visible_seqs`. */
  private seqs = new Map<string, number>();
  // Full builtin operator set — everything the validator recognises. A
  // deliberate narrowing would override per kind here and fail the
  // allowlist-parity test loudly.
  readonly capabilities: FilterCapabilities = {
    operators: fullBuiltinOperators(),
    orderBy: true,
    cursor: true
  };

  readonly #advisoryLocks = createKeyedMutex();

  /** See `Dataset.withAdvisoryLock`. Excludes holders on this instance. */
  withAdvisoryLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    return this.#advisoryLocks(key, fn);
  }

  // type → (id → row)
  private store: Map<string, Map<Id, Row>> = new Map();

  // Per-instance short-id allocator. Shared with tx-scoped calls because
  // withTransaction passes `this` directly — sequence advances persist even on
  // rollback, matching pg sequence semantics.
  private shortIds = new MemoryShortIdStore();

  // Guards nested `withTransaction` calls from taking a second snapshot.
  // Flatten-nested is the G1 semantic (savepoints are out of scope) — the
  // outermost tx owns the rollback point.
  #inTx = false;

  // Undo log for shortId bindings made inside the outermost tx. Non-null
  // while a tx is open; rows pushed by bindShortId; replayed through
  // MemoryShortIdStore._unbind on rollback. Counter advances are NOT logged —
  // burned shortIds stay burned (pg SEQUENCE semantics).
  #shortIdUndo: Array<{ type: string; shortId: number; rowId: string }> | null = null;

  // Undo log for entire bucket drops made inside a tx (dropType / dropNamespace).
  // Each entry captures the pre-drop snapshot so rollback can restore it.
  // Non-null while a tx is open; null otherwise.
  #shortIdDropUndo: Array<{ type: string; snapshot: ShortIdBucketSnapshot }> | null = null;

  constructor(options: MemoryDatasetOptions) {
    this.namespace = options.namespace;
    this.txScopeId = options.txScopeId ?? `mem:${randomUUID()}`;
    this.#fieldDefLookup = options.fieldDefLookup;
    this.typeDefLookup = options.typeDefLookup;
  }

  private bucket(type: string): Map<Id, Row> {
    let b = this.store.get(type);
    if (!b) {
      b = new Map();
      this.store.set(type, b);
    }
    return b;
  }

  async read(type: string, params: ReadParams): Promise<ReadResult> {
    // Refuse an unhonourable predicate BEFORE anything can short-circuit to an
    // empty page. `evaluateWhere` throws only once it is reached PER ROW, so an
    // unknown type, an empty bucket, or a fully-tombstoned one would otherwise
    // answer `[]` with the filter never examined. Runs on the raw clause so it
    // sits ahead of the unknown-type return.
    if (params.where !== undefined) assertWhereHonourable(params.where);

    const b = this.store.get(type);
    if (!b) return { rows: [], hasMore: false };

    const includeDeleted = params.includeDeleted === true;
    const lookup = this.#fieldDefLookup;
    const fieldDefOf: FieldDefOf = (field) => lookup?.(type, field);

    const idFilter = new Set<Id>();
    let hasIdFilter = false;
    if (params.id !== undefined) {
      idFilter.add(params.id);
      hasIdFilter = true;
    }
    if (params.ids !== undefined) {
      for (const id of params.ids) idFilter.add(id);
      hasIdFilter = true;
    }

    const limit =
      typeof params.limit === 'number' && Number.isFinite(params.limit) && params.limit >= 0
        ? Math.floor(params.limit)
        : undefined;

    // Pre-resolve registered extension operators (parity with the pg
    // dataset): each hit is executed and substituted as an `id IN [...]`
    // clause, since the synchronous evaluator would otherwise exclude every
    // row. The side-channel meta (relevance order + score/vector) is kept so
    // the final page can be reordered + stitched below.
    let extMeta: ExtensionOpResultMeta | null = null;
    let resolvedWhere: WhereClause | undefined;
    if (params.where !== undefined) {
      const detailed = await preResolveExtensionOperatorsDetailed(params.where, {
        namespace: this.namespace,
        type,
        k: limit,
        ...(fieldRequested(params.fields, '_vector') ? { returnVector: true } : {})
      });
      resolvedWhere = detailed.where;
      extMeta = detailed.meta;
    }

    // Collect the candidate pool (tombstone filter + id filter + where).
    // shortId is stored directly on each row at bindShortId time, so reads
    // return rows without any per-row spread allocation.
    const pool: Row[] = [];
    const walk = this.walkContext(type);

    // Short-circuit on id-filter: iterate only the requested ids via Map.get
    // rather than scanning the full bucket.
    const candidates: Iterable<Row> = hasIdFilter
      ? (function* () {
          for (const id of idFilter) {
            const row = b.get(id);
            if (row !== undefined) yield row;
          }
        })()
      : b.values();
    for (const row of candidates) {
      if (!includeDeleted && row._deletedAt != null) continue;
      if (
        resolvedWhere !== undefined &&
        !evaluateWhere(row, resolvedWhere, fieldDefOf, { ...walk, seed: row })
      ) {
        continue;
      }
      pool.push(row);
    }

    // OrderBy — always append implicit `{ id: 'asc' }` as final tie-breaker so
    // the cursor tuple is deterministic. If the caller supplied orderBy on id
    // explicitly we honour it and skip the append.
    const orderBy = normalizeOrderBy(params.orderBy);
    pool.sort((a, b2) => compareByClauses(a, b2, orderBy, fieldDefOf));

    // Cursor: drop rows up to and including the cursor tuple.
    let startIdx = 0;
    if (params.cursor !== undefined && params.cursor !== '') {
      const cursor = decodeCursor(params.cursor, orderBy);
      startIdx = findCursorStart(pool, orderBy, cursor.orderByValues, cursor.id, fieldDefOf);
    }

    // Apply limit. We fetch one extra row to detect `hasMore` without an extra
    // query — same trick the pg dataset uses.
    let hasMore = false;
    let slice: Row[];
    if (limit === undefined) {
      slice = pool.slice(startIdx);
    } else if (limit === 0) {
      slice = [];
    } else {
      const end = startIdx + limit + 1;
      const probe = pool.slice(startIdx, end);
      hasMore = probe.length > limit;
      slice = hasMore ? probe.slice(0, limit) : probe;
    }

    const out: ReadResult = { rows: slice, hasMore };
    // nextCursor is derived from the DATASET-ordered slice (the sorted pool),
    // before any relevance reorder — cursor pagination must keep dataset
    // order between pages.
    const last = slice[slice.length - 1];
    if (hasMore && last !== undefined) {
      out.nextCursor = encodeCursor({
        orderByValues: orderBy.map(([field]) => getFieldValue(last, field)),
        id: last.id,
        order: orderBy
      });
    }

    // Apply the extension-operator side-channel to the final page —
    // relevance reorder (only when the CALLER supplied no orderBy; the
    // normalized `orderBy` always carries an implicit id tiebreaker, so test
    // params.orderBy directly) + _score/_vector stitching when projected.
    if (extMeta !== null) {
      out.rows = applyExtensionResultMeta(out.rows, extMeta, {
        hasExplicitOrderBy: params.orderBy !== undefined && params.orderBy.length > 0,
        fields: params.fields
      });
    }
    return out;
  }

  /**
   * Walks over this namespace's live rows, for one read. Neighbours follow the
   * row body's crossRef value (spec 2026-10-24-typed-edge-walks §1), indexed
   * per (type, field) on first use.
   */
  private walkContext(type: string): Omit<WalkContext, 'seed'> {
    const lookup = this.#fieldDefLookup;
    const index = new Map<string, Map<unknown, Row[]>>();
    const live = (r: Row | undefined) => (r === undefined || r._deletedAt != null ? undefined : r);
    return {
      type,
      bindings: new Map(),
      fieldDefOf: (t) => (field) => lookup?.(t, field),
      get: (t, id) => live(this.store.get(t)?.get(id)),
      neighbours: (t, field, id) => {
        const key = `${t}\0${field}`;
        let byValue = index.get(key);
        if (byValue === undefined) {
          byValue = new Map();
          for (const r of this.store.get(t)?.values() ?? []) {
            if (r._deletedAt != null || !Object.hasOwn(r, field)) continue;
            const list = byValue.get(r[field]);
            if (list === undefined) byValue.set(r[field], [r]);
            else list.push(r);
          }
          index.set(key, byValue);
        }
        return byValue.get(id) ?? [];
      }
    };
  }

  async write(type: string, rows: WriteRow[], options?: WriteOptions): Promise<WriteResult> {
    if (options?.insertOnly !== true) assertNoRepeatedIds(type, rows);
    const b = this.bucket(type);
    const ids: Id[] = [];
    const merged: Row[] = [];
    const fallbackNow = (options?.now ?? new Date()).toISOString();
    const fallbackActor = options?.identity ?? null;
    // Writes here are serial, so assignment order is commit order.
    const visible = this.typeDefLookup?.(type, this.namespace)?.ordering === 'visible';

    for (const input of rows) {
      // An id-less row gets a v7 UUID (see uuidv7.ts for its limits).
      const row: Row = { ...input, id: input.id ?? uuidv7() };

      // Auto-fill _metadata when the caller didn't supply one. Engine path
      // (autocrud-create/update) always supplies _metadata itself; this branch
      // fires only for raw-write bypass paths (/register, bootstrap, sweep,
      // tests).
      let rowToWrite: Row = row;
      if (row._metadata === undefined) {
        const autoMeta: RowMetadata = {
          createdAt: fallbackNow,
          updatedAt: fallbackNow,
          createdBy: fallbackActor,
          updatedBy: fallbackActor
        };
        rowToWrite = { ...row, _metadata: autoMeta };
      }

      const existing = b.get(row.id);
      if (existing && options?.insertOnly === true) continue;

      // Strip _deletedAt from the INPUT before merging. In-progress writes
      // cannot revive a tombstone under any shape (including explicit null).
      const sanitised: Row = { id: rowToWrite.id };
      for (const [k, v] of Object.entries(rowToWrite)) {
        if (k === RESERVED_DELETED_AT) continue;
        if (k === 'id') continue;
        sanitised[k] = v;
      }

      let landed: Row;
      if (existing) {
        // Upsert merge — preserve existing _deletedAt (and any other existing
        // fields not overridden by the new row).
        landed = { ...existing, ...sanitised, id: rowToWrite.id };
        // Per-field merge for _metadata to match pg's COALESCE-per-column
        // semantics. An autoCRUD update passes partial _metadata
        // (updatedAt + updatedBy + null createdAt/createdBy) and relies on
        // this merge to preserve immutable fields without a pre-read.
        const incomingMeta = sanitised._metadata as RowMetadata | undefined;
        if (incomingMeta !== undefined) {
          const existingMeta = existing._metadata as RowMetadata | undefined;
          landed._metadata = mergeRowMetadata(existingMeta, incomingMeta);
        }
        b.set(rowToWrite.id, landed);
      } else {
        landed = sanitised;
        const meta = landed._metadata as RowMetadata | undefined;
        if (meta !== undefined) landed._metadata = withoutSeq(meta);
        if (visible) {
          const seq = (this.seqs.get(type) ?? 0) + 1;
          this.seqs.set(type, seq);
          landed._metadata = { ...(landed._metadata as RowMetadata), seq };
        }
        b.set(rowToWrite.id, landed);
      }
      ids.push(row.id);
      // Push a defensive copy so callers can't mutate the stored row through
      // the WriteResult. shortId is already present on `landed` for update
      // paths (bindShortId writes it onto the stored row; the upsert merge
      // above preserves it via `{ ...existing, ...sanitised }`). For create
      // paths shortId is bound after write, so it is absent here — the
      // autoCRUD create resolver merges it into its own returned shape.
      merged.push({ ...landed });
    }

    return { written: ids.length, ids, rows: merged };
  }

  async tombstone(type: string, ids: Id[]): Promise<DeleteResult> {
    const b = this.store.get(type);
    if (!b) return { deleted: 0, ids: [] };

    const stampedIds: Id[] = [];
    const now = new Date();

    for (const id of ids) {
      const row = b.get(id);
      if (!row) continue; // silent no-op for nonexistent
      if (row._deletedAt != null) continue; // terminal — preserve original
      row._deletedAt = now;
      stampedIds.push(id);
    }

    return { deleted: stampedIds.length, ids: stampedIds };
  }

  async purge(type: string, ids: Id[]): Promise<DeleteResult> {
    const b = this.store.get(type);
    if (!b) return { deleted: 0, ids: [] };

    const removed: Id[] = [];
    for (const id of ids) {
      if (b.delete(id)) removed.push(id);
    }

    return { deleted: removed.length, ids: removed };
  }

  async dropType(type: string): Promise<DropResult> {
    const typeStore = this.store.get(type);
    const rowsDeleted = typeStore?.size ?? 0;
    this.store.delete(type);

    // Snapshot-and-delete the short-id bucket. Returns [] when absent.
    const shortIdSnapshot = this.shortIds._snapshotAndDeleteBucket(this.namespace, type);
    const shortIdsDeleted = shortIdSnapshot.entries.length;

    // Inside an open tx, record the bucket snapshot so rollback can restore it.
    // The row-level restore is handled by the snapshot in withTransaction.
    this.#shortIdDropUndo?.push({ type, snapshot: shortIdSnapshot });

    return { rowsDeleted, shortIdsDeleted };
  }

  async dropNamespace(): Promise<DropResult> {
    let rowsDeleted = 0;
    let shortIdsDeleted = 0;
    for (const type of Array.from(this.store.keys())) {
      const r = await this.dropType(type);
      rowsDeleted += r.rowsDeleted;
      shortIdsDeleted += r.shortIdsDeleted;
    }
    return { rowsDeleted, shortIdsDeleted };
  }

  /**
   * Compare-and-update. Spec §5.12 Phase 2 / Dispatch B.
   *
   * The whole method body runs synchronously within a single async microtask —
   * there are no awaited reads against the store — so the check-then-write
   * pair is atomic with respect to every other operation on this dataset
   * instance. This is the mechanism that makes the `_system` invite-consumption
   * flow race-safe even on the in-memory substrate, where `withTransaction`
   * does not serialise concurrent callers.
   */
  async conditionalUpdate(
    type: string,
    id: Id,
    match: Record<string, unknown>,
    updates: Record<string, unknown>,
    actor?: ActorIdentity,
    now?: Date
  ): Promise<ConditionalUpdateResult> {
    const b = this.store.get(type);
    if (!b) return { matched: false, row: null };
    const row = b.get(id);
    // A tombstoned row never matches, as on pg: a deleted invite must not consume.
    if (!row || row._deletedAt != null) return { matched: false, row: null };
    for (const [k, expected] of Object.entries(match)) {
      if (!conditionalMatchEq(row[k], expected)) return { matched: false, row: null };
    }
    // Mutate the row in-place to match the `write()` upsert contract — nested
    // `_deletedAt` writes are silently stripped so callers can't use this path
    // to revive a tombstone.
    for (const [k, v] of Object.entries(updates)) {
      if (k === RESERVED_DELETED_AT) continue;
      if (k === 'id') continue;
      row[k] = v;
    }
    // Bump _metadata.updatedAt + updatedBy so rows mutated through this path
    // don't drift out of recency-ranked recall. Preserve createdAt
    // and createdBy. `_metadata` is replaced with a fresh struct (not mutated
    // in-place) so the returned row diverges from the stored row safely.
    const prior = row._metadata as RowMetadata | undefined;
    const updatedBy: ActorIdentity = actor ?? { kind: 'system', id: 'anonymous' };
    const meta: RowMetadata = {
      createdAt: prior?.createdAt ?? null,
      createdBy: prior?.createdBy ?? null,
      updatedAt: (now ?? new Date()).toISOString(),
      updatedBy,
      ...(prior?.seq !== undefined ? { seq: prior.seq } : {})
    };
    row._metadata = meta;
    return { matched: true, row: { ...row } };
  }

  async updateField(ref: UpdateFieldRef, fieldName: string, value: unknown): Promise<void> {
    // Validation order (spec §4.5): namespace → reserved → missing.
    if (ref.ns !== undefined && ref.ns !== this.namespace) {
      throw new NamespaceMismatch(this.namespace, ref.ns);
    }
    if (fieldName === RESERVED_DELETED_AT) {
      throw new ReservedField(fieldName);
    }

    const b = this.store.get(ref.type);
    if (!b) return; // silent no-op
    const row = b.get(ref.id);
    if (!row) return; // silent no-op

    // seq is the dataset's, never the caller's, as on pg where it has its own column.
    const seq = (row._metadata as RowMetadata | undefined)?.seq;
    row[fieldName] = value;
    if (fieldName === '_metadata' && (value != null || seq !== undefined)) {
      // A null clears the columns, as pg's UPDATE does, but not seq.
      const meta = withoutSeq(
        (value ?? {
          createdAt: null,
          updatedAt: null,
          createdBy: null,
          updatedBy: null
        }) as RowMetadata
      );
      row._metadata = seq !== undefined ? { ...meta, seq } : meta;
    }
  }

  /**
   * Snapshot-and-restore atomicity. Spec §5.3 / G1.
   *
   * All ops inside `fn` go through `this` — the memory dataset has a single
   * `store` reference, so routing the tx view back to `this` is safe. On throw,
   * we swap `store` back to the pre-tx snapshot.
   *
   * Row clone depth: two levels (buckets, then rows). A row's nested fields
   * (e.g. `row.tags`) are NOT deep-cloned — callers that mutate nested
   * structures inside a tx and then throw will observe stale references after
   * rollback. G1 operates on flat rows.
   */
  async withTransaction<T>(fn: (tx: Dataset) => Promise<T>): Promise<T> {
    if (this.#inTx) {
      // Flatten: re-entered from a nested call; the outermost tx owns the
      // snapshot and therefore the rollback point. A throw here propagates,
      // which unwinds to the outer withTransaction and triggers its restore.
      return fn(this);
    }

    const snapshot = new Map<string, Map<Id, Row>>();
    for (const [type, bucket] of this.store.entries()) {
      const cloned = new Map<Id, Row>();
      for (const [id, r] of bucket.entries()) cloned.set(id, { ...r });
      snapshot.set(type, cloned);
    }

    const seqSnapshot = new Map(this.seqs);
    const undoLog: Array<{ type: string; shortId: number; rowId: string }> = [];
    const dropUndoLog: Array<{ type: string; snapshot: ShortIdBucketSnapshot }> = [];
    this.#inTx = true;
    this.#shortIdUndo = undoLog;
    this.#shortIdDropUndo = dropUndoLog;
    try {
      return await fn(this);
    } catch (err) {
      this.store = snapshot;
      this.seqs = seqSnapshot;
      // Replay the drop-undo log in reverse order. Each entry restores an
      // entire bucket that was deleted by dropType/dropNamespace during the tx.
      for (let i = dropUndoLog.length - 1; i >= 0; i--) {
        const entry = dropUndoLog[i];
        if (entry !== undefined) {
          this.shortIds._restoreBucket(this.namespace, entry.type, entry.snapshot);
        }
      }
      // Replay the bind-undo log in reverse order. Each entry unbinds one
      // (type, shortId, rowId) triple from the shortId store. bucket.next
      // is deliberately not reset — burned shortIds stay burned.
      for (let i = undoLog.length - 1; i >= 0; i--) {
        const entry = undoLog[i];
        if (entry !== undefined) {
          this.shortIds._unbind(this.namespace, entry.type, entry.shortId, entry.rowId);
        }
      }
      throw err;
    } finally {
      this.#inTx = false;
      this.#shortIdUndo = null;
      this.#shortIdDropUndo = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Short-id methods (Dataset interface, spec §short-id-design)
  // ---------------------------------------------------------------------------

  async allocateShortId(type: string): Promise<number> {
    return this.shortIds.allocateUnbound(this.namespace, type);
  }

  async bindShortId(type: string, shortId: number, rowId: string): Promise<void> {
    await this.shortIds.bind(this.namespace, type, shortId, rowId);
    // Store shortId directly on the row so read() returns rows without any
    // per-row spread allocation. The withTransaction
    // snapshot shallow-clones every row, so the field is preserved/rolled
    // back correctly via the store snapshot on throw.
    const b = this.store.get(type);
    const row = b?.get(rowId);
    if (row !== undefined) row.shortId = shortId;
    // Inside an open tx, record the binding so rollback can undo it.
    // Outside a tx (#shortIdUndo === null), binds persist unconditionally.
    this.#shortIdUndo?.push({ type, shortId, rowId });
  }

  async resolveShortId(type: string, shortId: number): Promise<string | null> {
    return this.shortIds.resolveShortId(this.namespace, type, shortId);
  }

  async getShortIdForRow(type: string, rowId: string): Promise<number | null> {
    return this.shortIds.getShortIdForRow(this.namespace, type, rowId);
  }

  forNamespace(namespace: string): Dataset {
    return new MemoryDataset({
      namespace,
      ...(this.#fieldDefLookup !== undefined ? { fieldDefLookup: this.#fieldDefLookup } : {}),
      ...(this.typeDefLookup !== undefined ? { typeDefLookup: this.typeDefLookup } : {})
    });
  }
}

// ---------------------------------------------------------------------------
// Filter evaluation helpers
// ---------------------------------------------------------------------------

/**
 * Equality predicate used by `conditionalUpdate`. Handles the three shapes
 * the `_system` invite consumption check touches: scalar `===`, `null` ↔ `null`
 * (including reading back a missing-key field as `undefined`), and `Date` by
 * `.getTime()`. Other object types fall through to reference equality.
 */
function conditionalMatchEq(actual: unknown, expected: unknown): boolean {
  if (expected === null) return actual == null;
  if (actual === null || actual === undefined) return false;
  if (expected instanceof Date) {
    if (actual instanceof Date) return actual.getTime() === expected.getTime();
    return false;
  }
  return actual === expected;
}

function normalizeOrderBy(orderBy: OrderByClause[] | undefined): Array<[string, 'asc' | 'desc']> {
  // No early return for an absent orderBy: the id tail is what a cursor
  // resumes on, and without it every row compares equal to the cursor. pg
  // always appends the tail; this matches it.
  const out: Array<[string, 'asc' | 'desc']> = [];
  let hasIdTail = false;
  for (const clause of orderBy ?? []) {
    const entries = Object.entries(clause) as Array<[string, 'asc' | 'desc']>;
    for (const [field, dir] of entries) {
      out.push([field, dir]);
      if (field === 'id') hasIdTail = true;
    }
  }
  // Append implicit `{ id: 'asc' }` as final tie-breaker unless the caller
  // already pinned one (in either direction).
  if (!hasIdTail) out.push(['id', 'asc']);
  return out;
}

function compareByClauses(
  a: Row,
  b: Row,
  orderBy: Array<[string, 'asc' | 'desc']>,
  fieldDefOf: FieldDefOf
): number {
  for (const [field, dir] of orderBy) {
    const av = asSortValue(field, getFieldValue(a, field), fieldDefOf);
    const bv = asSortValue(field, getFieldValue(b, field), fieldDefOf);
    // Nulls sort last independently of direction (matches SQL's NULLS LAST).
    // Direction flip applies only when both sides are non-null.
    if (av == null && bv == null) continue;
    if (av == null) return 1;
    if (bv == null) return -1;
    const cmp = compareFilterValues(av, bv, isDateField(field, fieldDefOf));
    if (cmp !== 0) return dir === 'asc' ? cmp : -cmp;
  }
  return 0;
}

function findCursorStart(
  pool: Row[],
  orderBy: Array<[string, 'asc' | 'desc']>,
  cursorValues: unknown[],
  cursorId: Id,
  fieldDefOf: FieldDefOf
): number {
  // Build a synthetic "cursor row" and compare with compareByClauses.
  // cursorValues holds one value per orderBy clause, id included, so each
  // value maps to the clause at the same index wherever id sits.
  // Metadata fields (createdAt/updatedAt/createdBy*/updatedBy*) must populate
  // _metadata so getFieldValue() in compareByClauses resolves the cursor side
  // the same way as the row side.
  const cursorRow: Row = { id: cursorId };
  const meta: Record<string, unknown> = {};
  const createdBy: Record<string, unknown> = {};
  const updatedBy: Record<string, unknown> = {};
  orderBy.forEach(([field], i) => {
    const v = cursorValues[i];
    if (field === 'id') return;
    if (field === 'createdAt' || field === 'updatedAt' || field === 'seq') meta[field] = v;
    else if (field === 'createdById') createdBy.id = v;
    else if (field === 'createdByKind') createdBy.kind = v;
    else if (field === 'updatedById') updatedBy.id = v;
    else if (field === 'updatedByKind') updatedBy.kind = v;
    else cursorRow[field] = v as Row[string];
  });
  if (Object.keys(createdBy).length > 0) meta.createdBy = createdBy;
  if (Object.keys(updatedBy).length > 0) meta.updatedBy = updatedBy;
  if (Object.keys(meta).length > 0) cursorRow._metadata = meta as unknown as RowMetadata;

  // Linear scan — not optimal, but this is the in-memory reference. Find the
  // first index whose row sorts strictly AFTER the cursor row per the full
  // orderBy (id included, since id is part of orderBy).
  for (let i = 0; i < pool.length; i++) {
    const row = pool[i];
    if (row === undefined) continue;
    if (compareByClauses(row, cursorRow, orderBy, fieldDefOf) > 0) return i;
  }
  return pool.length;
}

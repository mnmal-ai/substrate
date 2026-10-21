/**
 * First-class edge primitive. Spec: §4.6, §6.1, §6.2.
 *
 * Policy + bridged flag are snapshotted at edge-write time. `deletedAt` is
 * terminal — set only by `tombstone(id)`, never cleared. `update()` is narrow:
 * only `lastSweptAt` and `blocked` are mutable post-write (enforced by the
 * `EdgePatch` type).
 */

import type { Id } from './core.js';

export type OnDelete = 'set_null' | 'cascade' | 'restrict' | 'orphan';
export type OnMissing = 'reject' | 'allow';

export interface EdgeRef {
  ns: string;
  type: string;
  id: Id;
  bridged?: boolean;
}

export interface Edge {
  id: string; // ULID, monotonic within process; primary key
  from: EdgeRef;
  to: EdgeRef;
  fieldName: string;
  policy: OnDelete;
  createdAt: Date;
  deletedAt?: Date;
  lastSweptAt?: Date;
  blocked?: boolean;
}

/**
 * Narrow patch type for `EdgesStore.update`. Immutable fields (from, to,
 * policy, fieldName, createdAt, id-as-identity) cannot be changed post-write.
 * `deletedAt` is managed exclusively by `tombstone(id)`.
 */
export type EdgePatch = Pick<Edge, 'id'> & Partial<Pick<Edge, 'lastSweptAt' | 'blocked'>>;

export type EdgeWriteInput = Omit<
  Edge,
  'id' | 'createdAt' | 'lastSweptAt' | 'deletedAt' | 'blocked'
>;

export type CanDeleteResult = { ok: true } | { ok: false; blockedBy: Edge[] };

export interface EdgesStore {
  /**
   * Stable identifier for the storage substrate this edges store wraps.
   * Parallels `Dataset.txScopeId` (spec §5.3). When an `EdgesStore`
   * and a `Dataset` share a `txScopeId`, the engine enlists edge
   * mutations into the dataset's `withScopedTransaction`, making
   * row-tombstone + edge-tombstone within one frame atomic.
   *
   * Convention:
   * - pg: derived from the `postgres.Sql` pool reference identity. A
   *   `PgEdgesStore` constructed against the same `Sql` as a
   *   `PgDataset` advertises the same `txScopeId`.
   * - memory: unique per `MemoryEdgesStore` instance. A memory edges
   *   store can never coalesce into a dataset's substrate tx; the engine
   *   falls back to nested independent transactions for that case.
   */
  readonly txScopeId: string;
  write(input: EdgeWriteInput): Promise<Edge>;
  tombstone(id: string, at?: Date): Promise<void>;
  update(patch: EdgePatch): Promise<void>;
  readNextBatch(
    cursorId: string | null,
    size: number
  ): Promise<{ edges: Edge[]; lastId: string | null }>;
  findEdgesTo(ref: EdgeRef): Promise<Edge[]>;
  /**
   * Batched `findEdgesTo`: all live (non-tombstoned) inbound edges whose `to`
   * matches ANY of `refs`, in a single round-trip. Empty `refs` yields an
   * empty result. Callers group the flat result by `edge.to` themselves.
   */
  findEdgesToMany(refs: readonly EdgeRef[]): Promise<Edge[]>;
  findEdgesFrom(ref: EdgeRef): Promise<Edge[]>;
  canDelete(ref: EdgeRef): Promise<CanDeleteResult>;
  findBlocked(): Promise<Edge[]>;
  /**
   * List live (non-tombstoned) edges where `from_ns === namespace` OR
   * `to_ns === namespace`. Used by drop-namespace to detect dangling refs
   * when `cascade === 'refuse'`. Bounded by `limit` — callers only need
   * enough to decide + surface a sample.
   */
  findEdgesTouchingNamespace(namespace: string, limit: number): Promise<Edge[]>;

  /**
   * List live (non-tombstoned) edges where either endpoint matches
   * `(namespace, type)`. Used by drop-type for the same cascade-refuse check.
   */
  findEdgesTouchingType(namespace: string, type: string, limit: number): Promise<Edge[]>;

  /**
   * Distinct namespaces other than `namespace` at the far end of any edge
   * (tombstoned or live) touching `namespace`, or `(namespace, type)` when
   * `type` is given: the namespaces `dropEdgesByNamespace` / `dropEdgesByType`
   * would delete edges from.
   */
  namespacesLinkedTo(namespace: string, type?: string): Promise<string[]>;

  /**
   * Physically delete every edge (tombstoned or live) where `from_ns === namespace`
   * OR `to_ns === namespace`. Used by drop-namespace when `cascade === 'delete'`.
   * Returns the exact count physically removed.
   *
   * Same atomicity rules as `tombstone` — MUST run inside a caller-supplied
   * `withTransaction` for multi-store atomicity.
   */
  dropEdgesByNamespace(namespace: string, within?: readonly string[]): Promise<number>;

  /**
   * Physically delete every edge (tombstoned or live) where either endpoint
   * matches `(namespace, type)`. Used by drop-type when `cascade === 'delete'`.
   * `within` restricts both drops to edges whose far end is `namespace` or one
   * of the listed namespaces.
   */
  dropEdgesByType(namespace: string, type: string, within?: readonly string[]): Promise<number>;

  /**
   * Execute `fn` atomically. All ops performed on the `tx` argument run inside
   * one substrate transaction. On throw, every mutation inside the callback
   * rolls back; on resolve, the transaction commits and the value is returned.
   *
   * Nested calls flatten into the outer tx (savepoints out of scope).
   * Cross-store atomicity with a sibling `Dataset.withTransaction` is the
   * engine's concern; each store manages its own tx independently here.
   * For enlisted cross-store atomicity, see `Dataset.withScopedTransaction`
   * which yields a tx-bound `EdgesStore` alongside the tx-bound datasets.
   *
   * Mirrors `Dataset.withTransaction` (§4.5, G1 §5.3).
   */
  withTransaction<T>(fn: (tx: EdgesStore) => Promise<T>): Promise<T>;
}

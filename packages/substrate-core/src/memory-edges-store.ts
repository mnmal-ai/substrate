/**
 * In-memory EdgesStore. Spec: §4.6.
 *
 * Single process-scoped table, monotonic string ids (lexicographically sortable).
 * Tombstones are terminal; update is narrow (only lastSweptAt / blocked) and
 * runtime-checks the patch shape because strict types alone can't prevent
 * callers casting through `any`.
 */

import { randomUUID } from 'node:crypto';
import type {
  CanDeleteResult,
  Edge,
  EdgePatch,
  EdgeRef,
  EdgesStore,
  EdgeWriteInput
} from '@mnmal-ai/substrate-types';

export interface MemoryEdgesStoreOptions {
  now: () => Date;
}

const MUTABLE_PATCH_FIELDS = new Set(['id', 'lastSweptAt', 'blocked']);

// Type-tagged so string "5" and number 5 hash distinctly — this is the strict
// `id` equality the ref-keyed indexes and the batched-lookup Set rely on.
const refKey = (r: EdgeRef): string => `${r.ns}\u0000${r.type}\u0000${typeof r.id}\u0000${r.id}`;

export class MemoryEdgesStore implements EdgesStore {
  private edges: Map<string, Edge> = new Map();
  // Secondary indexes for the ref-keyed lookups: refKey(edge.to) /
  // refKey(edge.from) → edge ids. Tombstoned edges stay indexed (lookups filter
  // deletedAt); only dropEdges* or a tx rollback prunes them. The cold admin /
  // sweep reads stay full scans.
  readonly #toIndex: Map<string, Set<string>> = new Map();
  readonly #fromIndex: Map<string, Set<string>> = new Map();
  private readonly now: () => Date;
  private counter = 0;
  // Guards nested `withTransaction` from taking a second snapshot — the
  // outermost tx owns the rollback point. Mirrors MemoryDataset.#inTx.
  #inTx = false;

  /**
   * Memory-backed edges stores cannot enlist into any dataset's substrate
   * transaction — they own their own single Map with no shared storage
   * identity. Each instance advertises a unique id so the engine can
   * distinguish instances and fall back to its nested-tx path.
   */
  readonly txScopeId: string = `memory-edges:${randomUUID()}`;

  constructor(options: MemoryEdgesStoreOptions) {
    this.now = options.now;
  }

  /**
   * Generate a lexicographically-monotonic id. Real deployments use ULIDs; for
   * the reference in-memory store we just need "sortable + monotonic within a
   * process," which `ts-counter` delivers without pulling a dependency.
   */
  private nextId(): string {
    const ts = Date.now().toString(16).padStart(12, '0');
    const c = (this.counter++).toString(16).padStart(10, '0');
    return `${ts}-${c}`;
  }

  #bucket(index: Map<string, Set<string>>, key: string): Set<string> {
    let set = index.get(key);
    if (set === undefined) {
      set = new Set<string>();
      index.set(key, set);
    }
    return set;
  }

  #indexAdd(edge: Edge): void {
    this.#bucket(this.#toIndex, refKey(edge.to)).add(edge.id);
    this.#bucket(this.#fromIndex, refKey(edge.from)).add(edge.id);
  }

  #indexRemove(edge: Edge): void {
    this.#toIndex.get(refKey(edge.to))?.delete(edge.id);
    this.#fromIndex.get(refKey(edge.from))?.delete(edge.id);
  }

  /** Rebuild both indexes from `this.edges`. Used on tx rollback, where the
   * edges map is swapped back to a pre-tx snapshot and the incrementally
   * maintained indexes would otherwise be stale. O(N) on the exceptional path. */
  #rebuildIndexes(): void {
    this.#toIndex.clear();
    this.#fromIndex.clear();
    for (const edge of this.edges.values()) this.#indexAdd(edge);
  }

  /**
   * Every read hands out a COPY, so a later `tombstone` / `update` cannot
   * rewrite a result the caller already holds (e.g. `canDelete`'s `blockedBy`
   * inside a `RestrictViolation`). Shallow is sufficient: `from` / `to` are
   * never mutated in place.
   */
  #copy(e: Edge): Edge {
    return { ...e };
  }

  /** Live (non-tombstoned) edges whose indexed ref equals `key`. */
  #liveByIndex(index: Map<string, Set<string>>, key: string): Edge[] {
    const ids = index.get(key);
    if (ids === undefined) return [];
    const out: Edge[] = [];
    for (const id of ids) {
      const e = this.edges.get(id);
      if (e !== undefined && e.deletedAt === undefined) out.push(this.#copy(e));
    }
    return out;
  }

  async write(input: EdgeWriteInput): Promise<Edge> {
    const edge: Edge = {
      id: this.nextId(),
      from: input.from,
      to: input.to,
      fieldName: input.fieldName,
      policy: input.policy,
      createdAt: this.now()
    };
    this.edges.set(edge.id, edge);
    this.#indexAdd(edge);
    return this.#copy(edge);
  }

  async tombstone(id: string, at?: Date): Promise<void> {
    const existing = this.edges.get(id);
    if (!existing) return;
    if (existing.deletedAt !== undefined) return;
    existing.deletedAt = at ?? this.now();
  }

  async update(patch: EdgePatch): Promise<void> {
    for (const key of Object.keys(patch)) {
      if (!MUTABLE_PATCH_FIELDS.has(key)) {
        throw new Error(`EdgesStore.update: field '${key}' is immutable`);
      }
    }

    const existing = this.edges.get(patch.id);
    if (!existing) return;

    if (patch.lastSweptAt !== undefined) {
      existing.lastSweptAt = patch.lastSweptAt;
    }
    if (patch.blocked !== undefined) {
      existing.blocked = patch.blocked;
    }
  }

  async readNextBatch(
    cursorId: string | null,
    size: number
  ): Promise<{ edges: Edge[]; lastId: string | null }> {
    const sorted = [...this.edges.values()].sort((a, b) =>
      a.id < b.id ? -1 : a.id > b.id ? 1 : 0
    );
    const start = cursorId === null ? 0 : sorted.findIndex((e) => e.id > cursorId);
    const slice = start < 0 ? [] : sorted.slice(start, start + size);
    const last = slice[slice.length - 1];
    return { edges: slice.map((e) => this.#copy(e)), lastId: last ? last.id : null };
  }

  async findEdgesTo(ref: EdgeRef): Promise<Edge[]> {
    return this.#liveByIndex(this.#toIndex, refKey(ref));
  }

  async findEdgesToMany(refs: readonly EdgeRef[]): Promise<Edge[]> {
    if (refs.length === 0) return [];
    const seen = new Set<string>();
    const out: Edge[] = [];
    for (const ref of refs) {
      const ids = this.#toIndex.get(refKey(ref));
      if (ids === undefined) continue;
      for (const id of ids) {
        if (seen.has(id)) continue;
        const e = this.edges.get(id);
        if (e !== undefined && e.deletedAt === undefined) {
          seen.add(id);
          out.push(this.#copy(e));
        }
      }
    }
    return out;
  }

  async findEdgesFrom(ref: EdgeRef): Promise<Edge[]> {
    return this.#liveByIndex(this.#fromIndex, refKey(ref));
  }

  async canDelete(ref: EdgeRef): Promise<CanDeleteResult> {
    const blockedBy: Edge[] = [];
    for (const e of this.#liveByIndex(this.#toIndex, refKey(ref))) {
      if (e.policy === 'restrict') blockedBy.push(e);
    }
    return blockedBy.length === 0 ? { ok: true } : { ok: false, blockedBy };
  }

  async findBlocked(): Promise<Edge[]> {
    const out: Edge[] = [];
    for (const e of this.edges.values()) {
      if (e.deletedAt !== undefined) continue;
      if (e.blocked === true) out.push(this.#copy(e));
    }
    return out;
  }

  async findEdgesTouchingNamespace(namespace: string, limit: number): Promise<Edge[]> {
    const out: Edge[] = [];
    for (const edge of this.edges.values()) {
      if (edge.deletedAt !== undefined) continue;
      if (edge.from.ns === namespace || edge.to.ns === namespace) {
        out.push(this.#copy(edge));
        if (out.length >= limit) break;
      }
    }
    return out;
  }

  async findEdgesTouchingType(namespace: string, type: string, limit: number): Promise<Edge[]> {
    const out: Edge[] = [];
    for (const edge of this.edges.values()) {
      if (edge.deletedAt !== undefined) continue;
      const fromMatch = edge.from.ns === namespace && edge.from.type === type;
      const toMatch = edge.to.ns === namespace && edge.to.type === type;
      if (fromMatch || toMatch) {
        out.push(this.#copy(edge));
        if (out.length >= limit) break;
      }
    }
    return out;
  }

  async namespacesLinkedTo(namespace: string, type?: string): Promise<string[]> {
    const out = new Set<string>();
    for (const edge of this.edges.values()) {
      const fromMatch =
        edge.from.ns === namespace && (type === undefined || edge.from.type === type);
      const toMatch = edge.to.ns === namespace && (type === undefined || edge.to.type === type);
      if (fromMatch) out.add(edge.to.ns);
      if (toMatch) out.add(edge.from.ns);
    }
    out.delete(namespace);
    return [...out].sort();
  }

  async dropEdgesByNamespace(namespace: string, within?: readonly string[]): Promise<number> {
    const allowed = within === undefined ? null : new Set([namespace, ...within]);
    let count = 0;
    for (const id of Array.from(this.edges.keys())) {
      const edge = this.edges.get(id);
      if (edge === undefined) continue;
      const fromMatch = edge.from.ns === namespace;
      const toMatch = edge.to.ns === namespace;
      if (farEndAllowed(edge, fromMatch, toMatch, allowed)) {
        this.edges.delete(id);
        this.#indexRemove(edge);
        count++;
      }
    }
    return count;
  }

  async dropEdgesByType(
    namespace: string,
    type: string,
    within?: readonly string[]
  ): Promise<number> {
    const allowed = within === undefined ? null : new Set([namespace, ...within]);
    let count = 0;
    for (const id of Array.from(this.edges.keys())) {
      const edge = this.edges.get(id);
      if (edge === undefined) continue;
      const fromMatch = edge.from.ns === namespace && edge.from.type === type;
      const toMatch = edge.to.ns === namespace && edge.to.type === type;
      if (farEndAllowed(edge, fromMatch, toMatch, allowed)) {
        this.edges.delete(id);
        this.#indexRemove(edge);
        count++;
      }
    }
    return count;
  }

  /**
   * Snapshot-and-restore atomicity. Spec §4.6, G1 §5.3.
   *
   * The memory store holds a single `edges` Map; tx routing goes through
   * `this`. On throw, we swap `edges` back to the pre-tx snapshot. The clone
   * depth is one level (map + per-edge `{...}`) so `tombstone` / `update`
   * mutations — which flip fields on the Edge object — are isolated.
   */
  async withTransaction<T>(fn: (tx: EdgesStore) => Promise<T>): Promise<T> {
    if (this.#inTx) {
      // Flattened re-entry: outer tx owns the rollback point. A throw here
      // unwinds to the outer `withTransaction` which performs the restore.
      return fn(this);
    }

    const snapshot = new Map<string, Edge>();
    for (const [id, edge] of this.edges.entries()) snapshot.set(id, { ...edge });

    this.#inTx = true;
    try {
      return await fn(this);
    } catch (err) {
      this.edges = snapshot;
      this.#rebuildIndexes();
      throw err;
    } finally {
      this.#inTx = false;
    }
  }
}

/** Does a touching edge's far end fall in `allowed` (null: any)? */
function farEndAllowed(
  edge: Edge,
  fromMatch: boolean,
  toMatch: boolean,
  allowed: ReadonlySet<string> | null
): boolean {
  if (allowed === null) return fromMatch || toMatch;
  return (fromMatch && allowed.has(edge.to.ns)) || (toMatch && allowed.has(edge.from.ns));
}

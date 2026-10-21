/**
 * MemoryShortIdStore — in-process allocator + lookup for shortId, scoped per
 * (namespace, type). Used by MemoryDataset and the in-memory half of
 * the cross-server-parity test. Fully synchronous semantics under the async
 * interface; the promise veneer exists so the pg and memory stores share
 * one signature.
 */

interface Bucket {
  next: number;
  byShort: Map<number, string>;
  byRow: Map<string, number>;
}

const EMPTY_BY_ROW: ReadonlyMap<string, number> = new Map();

export class MemoryShortIdStore {
  private buckets = new Map<string, Bucket>();

  private key(ns: string, type: string): string {
    return `${ns}/${type}`;
  }

  private bucket(ns: string, type: string): Bucket {
    const k = this.key(ns, type);
    let b = this.buckets.get(k);
    if (!b) {
      b = { next: 1, byShort: new Map(), byRow: new Map() };
      this.buckets.set(k, b);
    }
    return b;
  }

  /**
   * Allocate a new shortId AND record the (shortId → rowId) mapping in one
   * step. Convenience wrapper around `allocateUnbound` + `bind` for callers
   * that know the row id at allocation time.
   */
  async allocate(ns: string, type: string, rowId: string): Promise<number> {
    const short = await this.allocateUnbound(ns, type);
    await this.bind(ns, type, short, rowId);
    return short;
  }

  /**
   * Advance the (ns, type) counter and return the next shortId without
   * binding it to any row. Caller must call `bind` after the row is written.
   */
  async allocateUnbound(ns: string, type: string): Promise<number> {
    const b = this.bucket(ns, type);
    return b.next++;
  }

  /**
   * Record the (shortId → rowId) pairing. Safe to call without a prior
   * `allocateUnbound` (the mapping is stored unconditionally).
   */
  async bind(ns: string, type: string, shortId: number, rowId: string): Promise<void> {
    const b = this.bucket(ns, type);
    b.byShort.set(shortId, rowId);
    b.byRow.set(rowId, shortId);
    if (shortId >= b.next) b.next = shortId + 1;
  }

  async resolveShortId(ns: string, type: string, shortId: number): Promise<string | null> {
    return this.bucket(ns, type).byShort.get(shortId) ?? null;
  }

  async getShortIdForRow(ns: string, type: string, rowId: string): Promise<number | null> {
    return this.bucket(ns, type).byRow.get(rowId) ?? null;
  }

  /**
   * Live readonly view of the (rowId → shortId) map for (ns, type). Returned
   * once before a scan loop so the caller can do bulk enrichment with zero
   * per-row await overhead. Returns a sentinel empty map when no bucket exists
   * so callers don't need to null-check, and does NOT create a bucket as a
   * side-effect.
   *
   * Contract: the returned map is a live reference to internal state. Callers
   * must not mutate it, and must only read within a synchronous span (no
   * awaits between taking the view and consuming it) if concurrent bindings
   * could happen mid-scan. `MemoryDataset.read` honours this.
   */
  snapshotByRow(ns: string, type: string): ReadonlyMap<string, number> {
    return this.buckets.get(this.key(ns, type))?.byRow ?? EMPTY_BY_ROW;
  }

  /**
   * Seed the store from an existing corpus (used by tests and by the
   * backfill path's memory equivalent). Advances `next` to max(shortId) + 1.
   */
  preload(ns: string, type: string, entries: Array<{ shortId: number; rowId: string }>): void {
    const b = this.bucket(ns, type);
    for (const e of entries) {
      b.byShort.set(e.shortId, e.rowId);
      b.byRow.set(e.rowId, e.shortId);
      if (e.shortId >= b.next) b.next = e.shortId + 1;
    }
  }

  /**
   * Internal: drop a (shortId → rowId) mapping without touching `next`.
   * Used by MemoryDataset.withTransaction to roll back bindings made
   * inside a tx that threw. Counter stays advanced — matches pg SEQUENCE
   * semantics where a burned id number never gets reused.
   *
   * Pre-condition: `byShort[shortId]` and `byRow[rowId]` refer to each other,
   * or both are absent. Deleting mismatched entries will corrupt the store;
   * the tx undo log guarantees this because each entry comes from one `bind`.
   */
  _unbind(ns: string, type: string, shortId: number, rowId: string): void {
    const b = this.bucket(ns, type);
    b.byShort.delete(shortId);
    b.byRow.delete(rowId);
  }

  /**
   * Internal: return a snapshot of all (shortId, rowId) pairs for (ns, type)
   * plus its `next` counter, then remove the bucket entirely. Used by
   * dropType / dropNamespace so a tx rollback can restore via `_restoreBucket`.
   *
   * Returns no entries and `next: 1` when no bucket exists.
   */
  _snapshotAndDeleteBucket(ns: string, type: string): ShortIdBucketSnapshot {
    const k = this.key(ns, type);
    const b = this.buckets.get(k);
    if (!b) return { entries: [], next: 1 };
    const entries: Array<{ shortId: number; rowId: string }> = [];
    for (const [shortId, rowId] of b.byShort.entries()) {
      entries.push({ shortId, rowId });
    }
    this.buckets.delete(k);
    return { entries, next: b.next };
  }

  /**
   * Internal: restore a bucket captured by `_snapshotAndDeleteBucket`. The
   * counter is set to the greatest of its current value, the snapshot's
   * `next` and max(shortId) + 1, so ids burned before the drop stay burned.
   */
  _restoreBucket(ns: string, type: string, snapshot: ShortIdBucketSnapshot): void {
    this.preload(ns, type, snapshot.entries);
    const b = this.bucket(ns, type);
    if (snapshot.next > b.next) b.next = snapshot.next;
  }
}

/** A dropped short-id bucket: its bindings and its `next` counter. */
export interface ShortIdBucketSnapshot {
  entries: Array<{ shortId: number; rowId: string }>;
  next: number;
}

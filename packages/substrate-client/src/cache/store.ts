/**
 * Signals-backed reactive cache. Keyed by canonicalised frame key (same shape
 * as `canonicaliseFrameKey`). Each entry holds signals for `data`, `loading`,
 * `error`, plus refCount + invalidatedAt for lifecycle and drift management.
 *
 * Lifecycle:
 * - subscribe(key) → increment refCount, return an unsubscribe that decrements.
 * - When refCount → 0, schedule GC after `idleGcMs`; cancel if a new subscribe
 *   arrives in that window.
 * - invalidate(keyPrefix): if any entry under that prefix has refCount > 0,
 *   stamp `invalidatedAt` (callers observe and re-fetch). Entries with
 *   refCount === 0 are dropped.
 */

import { type Signal, signal } from '@preact/signals-core';
import type { Diagnostic } from '../diagnostics.js';
import { reduceSubscribeRows } from '../subscribe-rows.js';
import type { SubscribeEvent } from '../transport/ws.js';

export interface CacheEntry<T = unknown> {
  readonly data: Signal<T | undefined>;
  readonly loading: Signal<boolean>;
  readonly error: Signal<Error | null>;
  /**
   * Non-fatal diagnostics from the envelope that produced `data` — empty when
   * there is nothing to report. Cached with the data so every reader of this
   * key sees them, not only the caller that issued the request.
   */
  readonly diagnostics: Signal<Diagnostic[]>;
  /** Reactive signal — bumped whenever invalidate() stamps this entry. Resets to 0 on set(). */
  readonly invalidatedSignal: Signal<number>;
  refCount: number;
  invalidatedAt: number | null;
  lastFetched: number;
  gcTimer: ReturnType<typeof setTimeout> | null;
}

export interface CacheStoreOpts {
  idleGcMs: number;
}

export class CacheStore {
  readonly #entries = new Map<string, CacheEntry>();
  readonly #idleGcMs: number;

  constructor(opts: CacheStoreOpts) {
    this.#idleGcMs = opts.idleGcMs;
  }

  get<T = unknown>(key: string): CacheEntry<T> {
    const existing = this.#entries.get(key);
    if (existing !== undefined) return existing as CacheEntry<T>;
    const entry: CacheEntry<T> = {
      data: signal<T | undefined>(undefined),
      loading: signal(false),
      error: signal<Error | null>(null),
      diagnostics: signal<Diagnostic[]>([]),
      invalidatedSignal: signal(0),
      refCount: 0,
      invalidatedAt: null,
      lastFetched: 0,
      gcTimer: null
    };
    this.#entries.set(key, entry);
    return entry;
  }

  peek<T = unknown>(key: string): CacheEntry<T> | undefined {
    return this.#entries.get(key) as CacheEntry<T> | undefined;
  }

  subscribe(key: string): () => void {
    const entry = this.get(key);
    entry.refCount += 1;
    if (entry.gcTimer !== null) {
      clearTimeout(entry.gcTimer);
      entry.gcTimer = null;
    }
    let unsubscribed = false;
    return () => {
      if (unsubscribed) return;
      unsubscribed = true;
      entry.refCount -= 1;
      if (entry.refCount === 0) this.#scheduleGc(key, entry);
    };
  }

  set<T>(key: string, data: T, diagnostics: Diagnostic[] = []): void {
    const entry = this.get<T>(key);
    entry.data.value = data;
    entry.loading.value = false;
    entry.error.value = null;
    // Keep the previous array's identity when both are empty, so identity-based
    // readers of the signal do not see a change on every write.
    if (diagnostics.length > 0 || entry.diagnostics.value.length > 0) {
      entry.diagnostics.value = diagnostics;
    }
    entry.invalidatedAt = null;
    entry.invalidatedSignal.value = 0;
    entry.lastFetched = Date.now();
  }

  setLoading(key: string, loading: boolean): void {
    const entry = this.get(key);
    entry.loading.value = loading;
  }

  setError(key: string, err: Error): void {
    const entry = this.get(key);
    entry.error.value = err;
    entry.loading.value = false;
  }

  invalidate(keyPrefix: string): void {
    const now = Date.now();
    for (const [key, entry] of this.#entries) {
      if (!key.startsWith(keyPrefix)) continue;
      if (entry.refCount > 0) {
        entry.invalidatedAt = now;
        entry.invalidatedSignal.value = now;
      } else {
        if (entry.gcTimer !== null) clearTimeout(entry.gcTimer);
        this.#entries.delete(key);
      }
    }
  }

  /**
   * Apply a subscribe event to the entry at `cacheKey`, patching the row slot
   * under `qualifiedKey` in the entry's `data` envelope.
   *
   *  - snapshot → replace the entire envelope via `set()`
   *  - add      → append the single row to the list at data[qualifiedKey]
   *  - update   → replace row by id in the list at data[qualifiedKey]
   *  - remove   → drop row by removedId from the list at data[qualifiedKey]
   *  - end / error / chunk → no cache change (the hook surfaces these)
   *
   * `update` / `remove` on an entry without data are no-ops — the server always
   * emits `snapshot` first.
   */
  applySubscribeEvent(cacheKey: string, qualifiedKey: string, event: SubscribeEvent): void {
    if (event.kind === 'snapshot') {
      this.set(cacheKey, event.data);
      return;
    }
    if (event.kind !== 'add' && event.kind !== 'update' && event.kind !== 'remove') {
      return; // end / error / chunk: no cache mutation.
    }

    const entry = this.get(cacheKey);
    const current = entry.data.value as Record<string, unknown> | undefined;

    // `add` initialises a missing/empty slot; `update`/`remove` require an
    // existing array row-slot.
    if (event.kind !== 'add' && (current === undefined || !Array.isArray(current[qualifiedKey]))) {
      return;
    }

    const list = Array.isArray(current?.[qualifiedKey]) ? (current[qualifiedKey] as unknown[]) : [];
    const next = reduceSubscribeRows(list, qualifiedKey, event);
    if (next === list) return; // no-op (e.g. update event with no id)
    entry.data.value = { ...(current ?? {}), [qualifiedKey]: next };
  }

  #scheduleGc(key: string, entry: CacheEntry): void {
    if (entry.gcTimer !== null) clearTimeout(entry.gcTimer);
    entry.gcTimer = setTimeout(() => {
      entry.gcTimer = null;
      if (entry.refCount === 0) this.#entries.delete(key);
    }, this.#idleGcMs);
  }
}

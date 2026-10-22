/**
 * `KeyRegistry` — dataset-backed public-key cache. Spec §5.12.
 *
 * Priming + write-through invalidation. The registry is the synchronous
 * source-of-truth the auth verifier consults for dataset-backed keys. Keys
 * live in the `_system/Key` table; writes go through autoCRUD and fire
 * `install(row)` / `evict(kid)` so lookups see new state within the same
 * request cycle.
 *
 * `install` takes the row rather than re-reading it: the autoCRUD interceptor
 * runs INSIDE the writing transaction, so a re-read cannot see the
 * uncommitted write and would evict a new key or cache a revoked one as live.
 *
 * Invariants:
 *   - `lookup(kid)` is synchronous and returns `null` for missing or revoked
 *     keys. The auth path cannot afford an awaited DB hit per request.
 *   - Rows with an unrecognised algorithm are dropped from the cache with a
 *     metric; a malformed row does not nuke the whole registry.
 *   - `primeFromDataset` runs once at compose-time AFTER the `_system`
 *     namespace is wired. Tests drive it explicitly via the returned handle.
 */

import { decodeList } from '@mnmal-ai/substrate-policy';
import type { Dataset, Row } from '@mnmal-ai/substrate-types';
import { isKeyAlgorithm, KEY_TYPE, type KeyAlgorithm } from './types.js';

export interface KeyRecord {
  kid: string;
  algorithm: KeyAlgorithm;
  /** PEM-encoded public key (SPKI or PKCS#1). */
  publicKey: string;
  namespaces: Array<string>;
  capabilities: Array<string>;
  revokedAt: Date | null;
}

export interface KeyRegistry {
  /** Synchronous lookup against the in-memory cache. Returns null when not found or revoked. */
  lookup(kid: string): KeyRecord | null;
  /**
   * Install a row the caller already holds. Preferred over `refresh` for any
   * caller that has just written the row: it needs no read, so it cannot be
   * defeated by transaction visibility.
   *
   * Returns false when the row does not project (unknown algorithm, missing
   * key material) — the caller has handed over something unusable and the
   * cache is left untouched rather than being corrupted by a partial write.
   */
  install(row: Row): boolean;
  /**
   * Re-read a single row from the dataset. ONLY sound for callers that are
   * outside the writing transaction — an in-tx caller cannot see its own
   * write and will evict the very key it just created. Such callers want
   * `install` instead.
   */
  refresh(kid: string): Promise<void>;
  /** Remove a kid from the cache (for delete/purge). */
  evict(kid: string): void;
  /** Reload every row — called once at compose-time. */
  primeFromDataset(): Promise<void>;
  /**
   * Stop the optional periodic re-prime timer. No-op when re-prime is
   * disabled. Called on graceful shutdown; the timer is `.unref()`-ed so this
   * is only strictly needed for deterministic test tear-down.
   */
  dispose(): void;
}

export interface CreateKeyRegistryOptions {
  dataset: Dataset;
  /** Test seam for deterministic revocation-check time. Defaults to `() => new Date()`. */
  now?: () => Date;
  /**
   * Optional warning sink for rows that fail shape checks at cache-load time
   * (e.g. unknown algorithm). Silent no-op when absent.
   */
  onWarn?(message: string, detail?: unknown): void;
  /**
   * Periodic full re-prime interval (ms). A second instance that revokes a key
   * writes only to the shared store, so this cache would otherwise stay stale
   * until restart. When set (> 0), a timer reloads the whole table on the
   * interval. Reloads build a fresh map and swap it in, so lookups never
   * observe a half-loaded cache; a failed reload leaves the last-known-good
   * snapshot in place.
   *
   * Worth enabling even on a single instance: it bounds a cache entry left by
   * a rolled-back transaction to one interval, and it is the only thing that
   * picks up writes that bypass the engine (e.g. `substrate-admin revoke` writing
   * direct to postgres).
   */
  reprimeIntervalMs?: number;
}

function coerceDate(v: unknown): Date | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v;
  if (typeof v === 'string' && v.length > 0) {
    const parsed = new Date(v);
    if (!Number.isNaN(parsed.getTime())) return parsed;
    return null;
  }
  if (typeof v === 'number' && Number.isFinite(v)) {
    return new Date(v);
  }
  return null;
}

/**
 * Project a raw dataset row into a `KeyRecord`. Returns null on any
 * structural failure — caller decides whether to warn or drop silently.
 */
function projectRow(row: Row): KeyRecord | null {
  const kid = row.kid;
  if (typeof kid !== 'string' || kid.length === 0) return null;
  const algorithm = row.algorithm;
  if (!isKeyAlgorithm(algorithm)) return null;
  const publicKey = row.publicKey;
  if (typeof publicKey !== 'string' || publicKey.length === 0) return null;
  return {
    kid,
    algorithm,
    publicKey,
    namespaces: decodeList(row.namespaces),
    capabilities: decodeList(row.capabilities),
    revokedAt: coerceDate(row.revokedAt)
  };
}

export function createKeyRegistry(opts: CreateKeyRegistryOptions): KeyRegistry {
  const dataset = opts.dataset;
  const now = opts.now ?? ((): Date => new Date());
  const warn = opts.onWarn ?? ((): void => undefined);
  // `let` so a full reload can atomically swap in a freshly-built map — lookups
  // (which read whatever `cache` currently points at) never observe a
  // half-loaded state. `refresh`/`evict` mutate whichever map is live.
  let cache = new Map<string, KeyRecord>();
  // Bumped by every per-kid change, so a re-prime that started before one
  // drops its snapshot rather than undo it (a revoke would otherwise revive).
  let generation = 0;

  function isLive(record: KeyRecord): boolean {
    if (record.revokedAt === null) return true;
    // Revocation times are stamped with now() at the call site; treat anything
    // at-or-before present-time as revoked. Future-dated revocations are valid
    // until their wall-clock moment (rare, but matches JWT `nbf`-style intent).
    return record.revokedAt.getTime() > now().getTime();
  }

  /**
   * Build a fresh map from the whole table (unbounded: one row per verifier
   * key, tens at most), preferring the LIVE row for a duplicated kid.
   *
   * `substrate-admin rotate` leaves two rows per kid — the new live one and the
   * old revoked one — and the read is unordered, so liveness, via the same
   * `isLive` predicate `lookup` and `refresh` use, picks the winner.
   *
   * Not expressible as `where: { revokedAt: { eq: null } }`: a FUTURE
   * `revokedAt` is a scheduled revocation that must still resolve.
   */
  async function loadAll(): Promise<Map<string, KeyRecord>> {
    const { rows } = await dataset.read(KEY_TYPE, {});
    const next = new Map<string, KeyRecord>();
    for (const row of rows) {
      const projected = projectRow(row);
      if (projected === null) {
        warn('substrate_key_registry_malformed_row', { id: row.id });
        continue;
      }
      // Prefer the live row for a duplicated kid.
      const seen = next.get(projected.kid);
      if (seen !== undefined && isLive(seen) && !isLive(projected)) continue;
      next.set(projected.kid, projected);
    }
    return next;
  }

  // Single place that turns a row into a cache entry, so `install` and
  // `refresh` cannot drift in how they validate or what they store.
  function installRow(row: Row): boolean {
    const projected = projectRow(row);
    if (projected === null) return false;
    generation++;
    cache.set(projected.kid, projected);
    return true;
  }

  let timer: ReturnType<typeof setInterval> | null = null;
  const reprimeIntervalMs = opts.reprimeIntervalMs;
  if (
    reprimeIntervalMs !== undefined &&
    Number.isFinite(reprimeIntervalMs) &&
    reprimeIntervalMs > 0
  ) {
    timer = setInterval(() => {
      const started = generation;
      loadAll()
        .then((next) => {
          if (generation === started) cache = next;
        })
        .catch((err) => {
          // A transient dataset failure must not nuke the cache — keep serving
          // the last-known-good snapshot until a later tick succeeds.
          warn('substrate_key_registry_reprime_failed', {
            error: err instanceof Error ? err.message : String(err)
          });
        });
    }, reprimeIntervalMs);
    // Don't pin the event loop — a re-prime timer must never keep the process
    // alive. Tests call dispose() for deterministic tear-down.
    timer.unref?.();
  }

  return {
    lookup(kid: string): KeyRecord | null {
      const record = cache.get(kid);
      if (record === undefined) return null;
      if (!isLive(record)) return null;
      return record;
    },

    async refresh(kid: string): Promise<void> {
      // Same liveness preference as `loadAll`, via the same predicate. No
      // `limit: 1`: the read is unordered, so every row for the kid is needed
      // to find the live one.
      const { rows } = await dataset.read(KEY_TYPE, {
        where: { kid: { eq: kid } }
      });
      const row =
        rows.find((r) => {
          const p = projectRow(r);
          return p !== null && isLive(p);
        }) ?? undefined;
      if (row === undefined) {
        // No LIVE row: either revoked (evicting is the point) or genuinely
        // gone. Evicting is correct AND fail-closed for both — but warn, since
        // an in-tx caller that cannot see its own insert also lands here.
        warn('substrate_key_registry_no_live_row', { kid });
        generation++;
        cache.delete(kid);
        return;
      }
      if (!installRow(row)) {
        warn('substrate_key_registry_malformed_row', { kid });
        generation++;
        cache.delete(kid);
      }
    },

    install(row: Row): boolean {
      return installRow(row);
    },

    evict(kid: string): void {
      generation++;
      cache.delete(kid);
    },

    async primeFromDataset(): Promise<void> {
      cache = await loadAll();
    },

    dispose(): void {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    }
  };
}

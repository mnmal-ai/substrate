/**
 * Idempotency store interface. Spec: §5.13.
 *
 * `mutate` frames may carry an `idempotencyKey` so a retried call returns the
 * cached envelope instead of double-writing. The store is pluggable — the
 * reference in-memory implementation lives in `@mnmal-ai/substrate-core`; a
 * distributed deployment would back this with Redis or the substrate itself.
 * Queries are naturally idempotent and do NOT consult the store.
 */

import type { PackEnvelope } from './schema.js';

export interface IdempotencyStore {
  /**
   * Fetch a cached envelope by dedup key. MUST return `undefined` for expired
   * entries — lazy expiry is acceptable, but the caller MUST NOT observe
   * stale results.
   */
  get(key: string): Promise<PackEnvelope | undefined>;
  /**
   * Cache `envelope` under `key` with `ttlMs` lifetime. The engine invokes this
   * only on a successful, error-free mutate frame.
   */
  put(key: string, envelope: PackEnvelope, ttlMs: number): Promise<void>;
  /**
   * Reap expired entries. Returns the count deleted. Implementations may
   * no-op (e.g. `MemoryIdempotencyStore` already expires lazily on `get`)
   * or actively delete (e.g. pg implementations need to free row space).
   * Called on an interval by the binary; not in the request path.
   */
  reapExpired(): Promise<{ deleted: number }>;
}

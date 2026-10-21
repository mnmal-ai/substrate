/**
 * In-memory `IdempotencyStore`. Spec: §5.13.
 *
 * Process-local Map. Suitable for single-process deployments
 * and for tests; distributed deployments need an external store. Expiry is
 * lazy on `get`: expired entries are evicted when they're next observed. No
 * background sweeper — the store is bounded by the retry window (default 24h)
 * and the dedup-key cardinality of the caller.
 */

import type { IdempotencyStore, PackEnvelope } from '@mnmal-ai/substrate-types';

interface Entry {
  envelope: PackEnvelope;
  expiresAt: number;
}

export interface MemoryIdempotencyStoreOptions {
  /**
   * Clock injection point for deterministic tests. Defaults to `Date.now`.
   */
  now?: () => number;
}

export class MemoryIdempotencyStore implements IdempotencyStore {
  readonly #entries: Map<string, Entry> = new Map();
  readonly #now: () => number;

  constructor(options: MemoryIdempotencyStoreOptions = {}) {
    this.#now = options.now ?? ((): number => Date.now());
  }

  async get(key: string): Promise<PackEnvelope | undefined> {
    const entry = this.#entries.get(key);
    if (entry === undefined) return undefined;
    if (entry.expiresAt <= this.#now()) {
      this.#entries.delete(key);
      return undefined;
    }
    return entry.envelope;
  }

  async put(key: string, envelope: PackEnvelope, ttlMs: number): Promise<void> {
    const now = this.#now();
    const expiresAt = now + ttlMs;
    const existing = this.#entries.get(key);
    // Live entry: the envelope is immutable and the window may only be
    // extended, so a key resolves to ONE answer for its whole window.
    // Expired or absent: replace outright; the dedupe window has closed.
    if (existing !== undefined && existing.expiresAt > now) {
      existing.expiresAt = Math.max(existing.expiresAt, expiresAt);
      return;
    }
    this.#entries.set(key, { envelope, expiresAt });
  }

  async reapExpired(): Promise<{ deleted: number }> {
    const now = this.#now();
    let deleted = 0;
    for (const [key, entry] of this.#entries) {
      if (entry.expiresAt <= now) {
        this.#entries.delete(key);
        deleted += 1;
      }
    }
    return { deleted };
  }
}

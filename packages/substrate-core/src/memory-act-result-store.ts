/**
 * In-memory `ActResultStore`. Records are held in their JSON wire form
 * (`bigint` becomes a decimal string), so memory and Postgres answer alike.
 * Expiry is lazy on reads; `reapExpired` deletes.
 */

import {
  type ActResultRecord,
  type ActResultStore,
  stringifyJson
} from '@mnmal-ai/substrate-types';

interface Entry {
  record: ActResultRecord;
  expiresAt: number;
}

export interface MemoryActResultStoreOptions {
  /** Clock injection point for deterministic tests. Defaults to `Date.now`. */
  now?: () => number;
}

export class MemoryActResultStore implements ActResultStore {
  readonly #entries: Map<string, Entry> = new Map();
  readonly #now: () => number;

  constructor(options: MemoryActResultStoreOptions = {}) {
    this.#now = options.now ?? ((): number => Date.now());
  }

  async get(id: string, ownerKey: string): Promise<ActResultRecord | undefined> {
    const entry = this.#entries.get(id);
    if (
      entry === undefined ||
      entry.record.ownerKey !== ownerKey ||
      entry.expiresAt <= this.#now()
    ) {
      return undefined;
    }
    return entry.record;
  }

  async findByIdempotencyKey(ownerKey: string, key: string): Promise<ActResultRecord | undefined> {
    const now = this.#now();
    for (const entry of this.#entries.values()) {
      if (
        entry.record.ownerKey === ownerKey &&
        entry.record.idempotencyKey === key &&
        entry.expiresAt > now
      ) {
        return entry.record;
      }
    }
    return undefined;
  }

  async put(record: ActResultRecord, ttlMs: number): Promise<void> {
    const now = this.#now();
    if (record.idempotencyKey !== undefined) {
      // The first live write for (ownerKey, key) wins; an expired one is replaced.
      for (const [id, entry] of this.#entries) {
        if (
          entry.record.ownerKey !== record.ownerKey ||
          entry.record.idempotencyKey !== record.idempotencyKey
        )
          continue;
        if (entry.expiresAt > now) return;
        this.#entries.delete(id);
      }
    }
    this.#entries.set(record.id, {
      record: JSON.parse(stringifyJson(record)) as ActResultRecord,
      expiresAt: now + ttlMs
    });
  }

  async reapExpired(): Promise<{ deleted: number }> {
    const now = this.#now();
    let deleted = 0;
    for (const [id, entry] of this.#entries) {
      if (entry.expiresAt <= now) {
        this.#entries.delete(id);
        deleted += 1;
      }
    }
    return { deleted };
  }
}

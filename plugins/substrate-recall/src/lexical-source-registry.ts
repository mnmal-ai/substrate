/**
 * Registry of the types carrying a `lexical.source` — the lexical twin of
 * `EmbedSourceRegistry`, retained from `contributePostWrites` so the process
 * can answer "which types are lexically indexed, and how would I re-index one?"
 *
 * Read at call time, not resolved eagerly: namespaces register AFTER the
 * substrate composes, so anything resolved up front sees an empty world.
 */

import type { PostWriteHook, Row } from '@mnmal-ai/substrate-types';
import type { LexicalOutcome } from './lexical-index.js';

/** One lexically-indexed type: its identity, and how to re-index one row. */
export interface LexicalSourceEntry {
  namespace: string;
  type: string;
  /** The post-write hook built from this type's `lexical.source`. */
  hook: PostWriteHook;
  /**
   * Re-index one row and report the outcome; the backfill runs on this.
   * Optional only to keep the published interface non-breaking. Treat absence
   * as "cannot report", never as success.
   */
  reindex?: (row: Row) => Promise<LexicalOutcome>;
  /**
   * Classify one row WITHOUT writing — the read-only twin of `reindex`,
   * built from the same source function. Optional, like `reindex`. Absent →
   * coverage reports `unindexable: null` (unknown, not zero) and scans nothing.
   */
  classify?: (row: Row) => Promise<LexicalClassifyOutcome>;
}

/** What became of one row's dry-run classification. Mirrors `LexicalOutcome` minus the writes. */
export type LexicalClassifyOutcome =
  /** Source returned text — the row belongs in the index. */
  | { status: 'indexable' }
  /** Source returned the null sentinel — the row is refused, by design. */
  | { status: 'unindexable' }
  /** Row carried no string `id`; nothing could be classified. */
  | { status: 'no-id' }
  | { status: 'failed'; error: string };

/** Identity half of an entry — what `types()` returns. */
export type LexicalTypeRef = Pick<LexicalSourceEntry, 'namespace' | 'type'>;

export class LexicalSourceRegistry {
  readonly #byKey = new Map<string, LexicalSourceEntry>();

  /**
   * Register one lexically-indexed type. Idempotent on (namespace, type) — a
   * re-install overwrites, because the LATEST registration reflects the
   * currently-composed namespace definition.
   */
  add(entry: LexicalSourceEntry): void {
    this.#byKey.set(`${entry.namespace}/${entry.type}`, entry);
  }

  /** The entry for one type, or undefined when it declares no `lexical.source`. */
  get(namespace: string, type: string): LexicalSourceEntry | undefined {
    return this.#byKey.get(`${namespace}/${type}`);
  }

  /** Every lexically-indexed type, sorted by (namespace, type) so audit runs diff cleanly. */
  types(): ReadonlyArray<LexicalTypeRef> {
    return [...this.#byKey.values()]
      .map(({ namespace, type }) => ({ namespace, type }))
      .sort((a, b) => a.namespace.localeCompare(b.namespace) || a.type.localeCompare(b.type));
  }

  size(): number {
    return this.#byKey.size;
  }
}

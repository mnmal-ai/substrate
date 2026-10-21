/**
 * Registry of the types that carry an `embed.source`, retained from
 * `contributePostWrites` so the process can answer "which types are embedded,
 * and how would I re-embed one?" (embed-stats, the admin reindex route).
 *
 * Read at call time, not resolved eagerly: namespaces register AFTER the
 * substrate composes, so anything resolved up front sees an empty world.
 */

import type { PostWriteHook, Row } from '@mnmal-ai/substrate-types';
import type { EmbedOutcome } from './embed-and-store.js';

/** One embedded type: its identity, and the hook that (re)embeds one of its rows. */
export interface EmbedSourceEntry {
  namespace: string;
  type: string;
  /**
   * The post-write hook built from this type's `embed.source`. Invoking it
   * with a row re-embeds that row exactly as the write path would.
   */
  hook: PostWriteHook;
  /**
   * Re-embed one row of this type and report the outcome; the admin reindex
   * route runs on this. Unlike `hook`, which swallows errors because the
   * write has already committed, it reports failures.
   *
   * `createRecallPlugin` always populates it; it is optional only to keep the
   * published interface non-breaking. Treat absence as "cannot report", never
   * as success.
   */
  reembed?: (row: Row) => Promise<EmbedOutcome>;
}

/** Identity half of an entry — what `types()` returns. */
export type EmbeddedTypeRef = Pick<EmbedSourceEntry, 'namespace' | 'type'>;

export class EmbedSourceRegistry {
  readonly #byKey = new Map<string, EmbedSourceEntry>();

  /**
   * Register one embedded type. Idempotent on (namespace, type) — a re-install
   * overwrites rather than duplicating, because the LATEST registration
   * reflects the currently-composed namespace definition.
   */
  add(entry: EmbedSourceEntry): void {
    this.#byKey.set(`${entry.namespace}/${entry.type}`, entry);
  }

  /** The hook for one type, or undefined when the type carries no `embed.source`. */
  get(namespace: string, type: string): EmbedSourceEntry | undefined {
    return this.#byKey.get(`${namespace}/${type}`);
  }

  /** Every embedded type, sorted by (namespace, type) so audit runs diff cleanly. */
  types(): ReadonlyArray<EmbeddedTypeRef> {
    return [...this.#byKey.values()]
      .map(({ namespace, type }) => ({ namespace, type }))
      .sort((a, b) => a.namespace.localeCompare(b.namespace) || a.type.localeCompare(b.type));
  }

  size(): number {
    return this.#byKey.size;
  }
}

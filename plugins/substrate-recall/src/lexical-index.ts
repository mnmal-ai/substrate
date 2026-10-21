/**
 * Write-path primitive for the lexical arm — the keyword counterpart to
 * `embed-and-store.ts`. One implementation, two error postures:
 *
 *   makeLexicalPostWrite  swallows  — the row's mutation has already
 *                                     committed, so a throw would fail a write
 *                                     that already succeeded.
 *   makeLexicalReindex    reports   — a backfill's only evidence that the work
 *                                     happened is what it returns.
 */

import type { PostWriteHook, Row } from '@mnmal-ai/substrate-types';
import type { LexicalClassifyOutcome } from './lexical-source-registry.js';
import type { LexicalStore } from './lexical-store.js';

const LOG_PREFIX = 'substrate-recall.lexical:';

export interface LexicalPostWriteBinding {
  namespace: string;
  type: string;
  source: (row: Row) => string | null | undefined | Promise<string | null | undefined>;
  store: LexicalStore;
}

/** What became of one row's lexical indexing attempt. */
export type LexicalOutcome =
  | { status: 'indexed' }
  /** Source returned the null sentinel — any indexed text was removed. */
  | { status: 'unindexable' }
  /** Row carried no string `id`; nothing was attempted. */
  | { status: 'no-id' }
  | { status: 'failed'; error: string };

/** Index one row and REPORT what happened, without logging. */
export async function lexicalRowReporting(
  row: Row,
  binding: LexicalPostWriteBinding
): Promise<LexicalOutcome> {
  const id = typeof row.id === 'string' ? row.id : null;
  if (id === null) return { status: 'no-id' };
  // Stamped before the source runs, as in `embedRowReporting`: of two racing
  // writes, the store keeps the text of the later one.
  const now = new Date();
  try {
    const text = await binding.source(row);
    if (text === null || text === undefined) {
      // Un-indexable. Delete unconditionally rather than declining to write —
      // see `LexicalStore.delete`. `''` is NOT this case: an empty string
      // indexes normally, matching `embed.source`.
      await binding.store.delete({
        rowNamespace: binding.namespace,
        rowType: binding.type,
        rowId: id
      });
      return { status: 'unindexable' };
    }
    await binding.store.upsert({
      rowNamespace: binding.namespace,
      rowType: binding.type,
      rowId: id,
      text,
      now
    });
    return { status: 'indexed' };
  } catch (err) {
    return { status: 'failed', error: err instanceof Error ? err.message : String(err) };
  }
}

/** Build the post-write hook that keeps one type's lexical index current. */
export function makeLexicalPostWrite(binding: LexicalPostWriteBinding): PostWriteHook {
  return async (row: Row): Promise<void> => {
    const outcome = await lexicalRowReporting(row, binding);
    if (outcome.status === 'failed') {
      const id = typeof row.id === 'string' ? row.id : '<no-id>';
      process.stderr.write(
        `${LOG_PREFIX} ${binding.namespace}/${binding.type} ${id}: ${outcome.error}\n`
      );
    }
  };
}

/**
 * Build the re-index function a backfill runs on. Shares the hook's binding,
 * so a backfilled row matches a written one.
 */
export function makeLexicalReindex(
  binding: LexicalPostWriteBinding
): (row: Row) => Promise<LexicalOutcome> {
  return (row) => lexicalRowReporting(row, binding);
}

/**
 * Build the pure classifier a dry-run coverage scan runs on. Shares the hook's
 * binding; evaluates the source and reports, touching no store.
 */
export function makeLexicalClassify(
  binding: LexicalPostWriteBinding
): (row: Row) => Promise<LexicalClassifyOutcome> {
  return async (row) => {
    const id = typeof row.id === 'string' ? row.id : null;
    if (id === null) return { status: 'no-id' };
    try {
      const text = await binding.source(row);
      return text === null || text === undefined
        ? { status: 'unindexable' }
        : { status: 'indexable' };
    } catch (err) {
      return { status: 'failed', error: err instanceof Error ? err.message : String(err) };
    }
  };
}

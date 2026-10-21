/** The reindex page loop: the caller owns progress and stop, the server owns one page. */

import type { AdminReindexInput, AdminReindexPage } from '@mnmal-ai/substrate/client';
import type { TypeRef } from './args.js';

export interface TypeProgress {
  readonly ref: TypeRef;
  scanned: number;
  embedded: number;
  unindexable: number;
  failed: number;
  pages: number;
  done: boolean;
}

export type ReindexOutcome =
  | { readonly kind: 'done'; readonly progress: readonly TypeProgress[] }
  /** Stopped by the operator between pages: `at` is the type in progress, `cursor` where it would resume. */
  | {
      readonly kind: 'stopped';
      readonly progress: readonly TypeProgress[];
      readonly at: TypeRef;
      readonly cursor: string | undefined;
    }
  /** A page failed (503, lock, a cursorless hasMore): progress up to it is kept. */
  | {
      readonly kind: 'failed';
      readonly progress: readonly TypeProgress[];
      readonly at: TypeRef;
      readonly error: unknown;
    };

const PAGE_LIMIT = 200;

export async function runReindex(
  types: readonly TypeRef[],
  page: (input: AdminReindexInput) => Promise<AdminReindexPage>,
  hooks: {
    readonly stopRequested: () => boolean;
    readonly onProgress: (p: readonly TypeProgress[]) => void;
  }
): Promise<ReindexOutcome> {
  const progress: TypeProgress[] = types.map((ref) => ({
    ref,
    scanned: 0,
    embedded: 0,
    unindexable: 0,
    failed: 0,
    pages: 0,
    done: false
  }));
  for (const p of progress) {
    let cursor: string | undefined;
    for (;;) {
      let r: AdminReindexPage;
      try {
        r = await page({
          namespace: p.ref.namespace,
          type: p.ref.type,
          limit: PAGE_LIMIT,
          ...(cursor !== undefined ? { cursor } : {})
        });
        if (r.hasMore && typeof r.nextCursor !== 'string') {
          throw new Error('server reported hasMore with no nextCursor');
        }
      } catch (error) {
        return { kind: 'failed', progress, at: p.ref, error };
      }
      p.scanned += r.scanned;
      p.embedded += r.embedded;
      p.unindexable += r.unindexable;
      p.failed += r.failed;
      p.pages += 1;
      if (!r.hasMore) {
        p.done = true;
        hooks.onProgress(progress);
        const next = progress[progress.indexOf(p) + 1];
        if (next !== undefined && hooks.stopRequested()) {
          return { kind: 'stopped', progress, at: next.ref, cursor: undefined };
        }
        break;
      }
      cursor = r.nextCursor;
      hooks.onProgress(progress);
      if (hooks.stopRequested()) return { kind: 'stopped', progress, at: p.ref, cursor };
    }
  }
  return { kind: 'done', progress };
}

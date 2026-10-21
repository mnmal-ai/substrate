import type { NlSuggestion } from '@mnmal-ai/substrate-nl/complete';
import type { Suggestion } from '@mnmal-ai/surface-core';

/** End of the whitespace-delimited token the cursor sits in. */
export function tokenEnd(draft: string, cursor: number): number {
  let i = Math.max(0, Math.min(cursor, draft.length));
  while (i < draft.length && !/\s/.test(draft[i] as string)) i++;
  return i;
}

/**
 * A substrate-nl suggestion computed from the text before the cursor, as a core suggestion over the
 * whole draft: its span keeps its start and runs to the end of the token under the cursor
 * so `status:op|p` completes to `status:open`, not `status:openp`.
 */
export function adapt(draft: string, cursor: number, s: NlSuggestion): Suggestion {
  return {
    label: s.label,
    insert: s.insert,
    replace: [s.replace[0], tokenEnd(draft, cursor)],
    score: s.score,
    ...(s.detail !== undefined ? { detail: s.detail } : {})
  };
}

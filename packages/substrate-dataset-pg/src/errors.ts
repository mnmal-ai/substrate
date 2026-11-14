/**
 * Re-exports of `NamespaceMismatch` + `ReservedField` from `@mnmal-ai/substrate-types`,
 * which owns them so `instanceof` works across both dataset impls.
 */

import { QUERY_TIMEOUT, ResolverFrameError } from '@mnmal-ai/substrate-types';

export { NamespaceMismatch, ReservedField } from '@mnmal-ai/substrate-types';

/**
 * A statement-timeout cancel (57014) as `query_timeout`, else null. Shared by
 * every pg query path (dataset reads, the edges store, the recall plugin), so a
 * role- or database-level `statement_timeout` is never a 500.
 *
 * `subject` prefixes the message (`ns/Type`, `edges`, `recall`). With a caller
 * `signal` that has aborted, it is the caller's cancel, not a timeout: null.
 * 57014 also covers an operator's cancel, so the message does not claim a
 * timeout. `timeoutMs` is omitted when the limit is not known to be substrate's own.
 */
export function queryTimeoutError(
  subject: string,
  err: unknown,
  signal?: AbortSignal,
  timeoutMs?: number
): ResolverFrameError | null {
  if ((err as { code?: unknown } | null)?.code !== '57014' || signal?.aborted === true) {
    return null;
  }
  return new ResolverFrameError(
    QUERY_TIMEOUT,
    `${subject}: the query was cancelled by the server (statement timeout or cancel)` +
      (timeoutMs !== undefined ? `; the limit is ${timeoutMs} ms` : ''),
    timeoutMs !== undefined ? { timeoutMs } : undefined
  );
}

/** Awaits `query`, rethrowing a statement-timeout cancel as {@link queryTimeoutError}. */
export async function timeoutAware<T>(subject: string, query: PromiseLike<T>): Promise<T> {
  try {
    return await query;
  } catch (err) {
    throw queryTimeoutError(subject, err) ?? err;
  }
}

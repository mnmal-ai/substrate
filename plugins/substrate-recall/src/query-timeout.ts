/**
 * Recall's SQL (the embeddings, lexical and cluster stores, the row filter)
 * cancelled by a role- or database-level statement_timeout: refused
 * `query_timeout` on every surface instead of a 500 (#1836). The mapping is
 * dataset-pg's, shared with its reads and the edges store.
 */

import { jsonResponse } from '@mnmal-ai/substrate-compose';
import { queryTimeoutError } from '@mnmal-ai/substrate-dataset-pg';

/** A 57014 as `query_timeout`, else null. */
export function recallQueryTimeout(err: unknown): ReturnType<typeof queryTimeoutError> {
  return queryTimeoutError('recall', err);
}

/** A 57014 as a 503 `query_timeout` response, else null. */
export function queryTimeoutResponse(err: unknown): ReturnType<typeof jsonResponse> | null {
  const refused = recallQueryTimeout(err);
  return refused === null
    ? null
    : jsonResponse(503, { error: { code: refused.code, message: refused.message } });
}

/** `fn` with a 57014 it throws refused `query_timeout`. */
export function timeoutMapped<A extends unknown[], R>(
  fn: (...args: A) => Promise<R>
): (...args: A) => Promise<R> {
  return async (...args) => {
    try {
      return await fn(...args);
    } catch (err) {
      throw recallQueryTimeout(err) ?? err;
    }
  };
}

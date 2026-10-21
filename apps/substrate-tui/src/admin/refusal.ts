import { AdminBackfillError, AuthError, NetworkError } from '@mnmal-ai/substrate/client';
import { sanitise } from '@mnmal-ai/surface-core';

export interface Refusal {
  readonly code: string;
  readonly message: string;
  /** The refusal body's route-specific fields, when it had any (NetworkError/AuthError `.body`). Unsanitised, unlike `code` and `message`: sanitise whatever of it is rendered. */
  readonly body?: Readonly<Record<string, unknown>>;
}

/** A server refusal as the server said it: `code: message`, sanitised, never retried. A chunked backfill wraps its failure; the cause is the refusal. */
export function refusalOf(err: unknown): Refusal {
  const e = err instanceof AdminBackfillError ? err.cause : err;
  const known = e instanceof NetworkError || e instanceof AuthError;
  const code = known ? (e.code ?? String(e.status ?? 'error')) : 'error';
  const message =
    (known ? e.serverMessage : undefined) ?? (e instanceof Error ? e.message : String(e));
  return {
    code: sanitise(code),
    message: sanitise(message),
    ...(known && e.body !== undefined ? { body: e.body } : {})
  };
}

/**
 * Minimal JSON-over-HTTP client for the `substrate federate` verbs.
 *
 * A non-2xx status is a RESULT, not an error: callers map peer error codes to
 * specific operator-facing messages, which they cannot do from an exception.
 * Only transport failures and timeouts reject.
 *
 * There is deliberately no way to skip TLS verification. Every caller of this
 * module puts a secret on the wire — `join` sends a single-use invite code an
 * active MITM could steal and redeem as itself, and `check` sends a live
 * bearer JWT. A self-signed lab CA belongs in NODE_EXTRA_CA_CERTS, which Node
 * honours natively and which still verifies the chain.
 */

import { tokenAudience } from '@mnmal-ai/substrate-client';

const DEFAULT_TIMEOUT_MS = 10_000;

export class HttpJsonError extends Error {
  override readonly name = 'HttpJsonError';
}

export interface HttpJsonResult {
  status: number;
  /** Parsed JSON body, or `undefined` when the body was not JSON. */
  body: unknown;
  /** The response body verbatim — used in error messages when parsing failed. */
  raw: string;
}

export interface HttpJsonOptions {
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
}

export type HttpJsonFn = (url: string, opts?: HttpJsonOptions) => Promise<HttpJsonResult>;

export async function httpJson(url: string, opts: HttpJsonOptions = {}): Promise<HttpJsonResult> {
  const headers: Record<string, string> = { accept: 'application/json', ...opts.headers };
  const init: RequestInit = {
    method: opts.method ?? 'GET',
    headers,
    signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  };
  if (opts.body !== undefined) {
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify(opts.body);
  }
  try {
    tokenAudience(url);
  } catch (err) {
    throw new HttpJsonError(err instanceof Error ? err.message : String(err));
  }
  // A redirect would carry the credential to wherever it points.
  init.redirect = 'error';

  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (err) {
    throw new HttpJsonError(`${url}: ${err instanceof Error ? err.message : String(err)}`);
  }

  const raw = await res.text();
  let body: unknown;
  try {
    body = raw.length > 0 ? JSON.parse(raw) : undefined;
  } catch {
    body = undefined;
  }
  return { status: res.status, body, raw };
}

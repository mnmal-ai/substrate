/** The MCP server's HTTP calls to `/substrate/v1/*`, its agent token and its tool-result shapes. */

import { substrateFetch, tokenAudience } from '@mnmal-ai/substrate-client';
import { stringifyJson, trimTrailingSlashes } from '@mnmal-ai/substrate-types';
import { makeAgentJwtProvider } from './agent-jwt.js';

// Module-level provider; set once at server startup via configureAgentAuth.
let agentJwt: () => string | null = () => null;

/**
 * Call at MCP server startup (next to where SUBSTRATE_URL is read) to arm the
 * agent JWT; its `aud` is `endpoint`'s origin.
 */
export function configureAgentAuth(env: NodeJS.ProcessEnv, endpoint: string): void {
  agentJwt = makeAgentJwtProvider(env, new URL(endpoint).origin);
}

/** Request headers for `endpoint`; a token is only sent where `tokenAudience` allows. */
function authHeaders(endpoint: string, extra: Record<string, string>): Record<string, string> {
  const token = agentJwt();
  if (token === null) return extra;
  tokenAudience(endpoint);
  return { ...extra, authorization: token };
}

export interface ToolResultContent {
  type: 'text';
  text: string;
}

export interface ToolResult {
  [key: string]: unknown;
  content: ToolResultContent[];
  isError?: boolean;
}

export function errorResult(message: string): ToolResult {
  return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
}

export function okResult(value: unknown): ToolResult {
  return { content: [{ type: 'text', text: stringifyJson(value) }] };
}

export function toMessage(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  // Include cause message when present — structured errors (e.g. NetworkError)
  // store the originating Error as cause rather than embedding it in message.
  if (err.cause instanceof Error && err.cause.message) {
    return `${err.message}: ${err.cause.message}`;
  }
  return err.message;
}

/**
 * POST a JSON body to a Substrate HTTP endpoint and return the parsed response.
 *
 * `errorMode` controls the !ok branch:
 *   - 'parsedError' — try to parse the response as Substrate's `{error: {message}}`
 *     envelope; throw the inner message. Falls back to `HTTP <status>` if the
 *     body isn't shaped that way. Used by /substrate/v1/recall.
 *   - 'textPreview' (default) — read the response as text and throw a
 *     `POST <path> returned <status>: <preview>` message capped at 500 chars.
 *     Used by /substrate/v1/nl + /substrate/v1/_system/drop-{namespace,type}.
 */
export async function postSubstrate<T>(
  endpoint: string,
  path: string,
  body: unknown,
  errorMode: 'parsedError' | 'textPreview' = 'textPreview'
): Promise<T> {
  const url = `${trimTrailingSlashes(endpoint)}${path}`;
  let res: Response;
  try {
    res = await substrateFetch(url, {
      method: 'POST',
      headers: authHeaders(endpoint, {
        'content-type': 'application/json',
        accept: 'application/json'
      }),
      body: JSON.stringify(body),
      // A redirect would carry the token to wherever it points.
      redirect: 'error'
    });
  } catch (err) {
    throw new Error(
      `Substrate request to ${url} failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  if (!res.ok) {
    if (errorMode === 'parsedError') {
      let parsed: unknown = null;
      try {
        parsed = await res.json();
      } catch {
        /* fall through to HTTP status */
      }
      // Envelopes come nested (`{ error: { message } }`) or flat (`{ code, message }`).
      const env =
        parsed !== null && typeof parsed === 'object'
          ? (parsed as { error?: { message?: string }; message?: unknown })
          : undefined;
      const flat = typeof env?.message === 'string' ? env.message : undefined;
      const message =
        env !== undefined && 'error' in env
          ? (env.error?.message ?? flat ?? 'unknown error')
          : (flat ?? `HTTP ${res.status}`);
      throw new Error(message);
    }
    const preview = await res.text().catch(() => '<unreadable>');
    throw new Error(`POST ${path} returned ${res.status}: ${preview.slice(0, 500)}`);
  }
  return (await res.json()) as T;
}

/**
 * GET a JSON body from a Substrate HTTP endpoint and return the parsed response.
 * The read-only sibling of `postSubstrate` — used for `/substrate/v1/federated-schema`.
 * Non-2xx throws `GET <path> returned <status>: <preview>` (capped 500 chars);
 * a transport failure wraps the cause with the failing URL.
 */
export async function getSubstrate<T>(endpoint: string, path: string): Promise<T> {
  const url = `${trimTrailingSlashes(endpoint)}${path}`;
  let res: Response;
  try {
    res = await substrateFetch(url, {
      method: 'GET',
      headers: authHeaders(endpoint, { accept: 'application/json' }),
      redirect: 'error'
    });
  } catch (err) {
    throw new Error(
      `Substrate request to ${url} failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  if (!res.ok) {
    const preview = await res.text().catch(() => '<unreadable>');
    throw new Error(`GET ${path} returned ${res.status}: ${preview.slice(0, 500)}`);
  }
  return (await res.json()) as T;
}

/** Test seam: temporarily swap the agent JWT provider, run getSubstrate, then restore. */
export async function getSubstrateForTest<T>(
  endpoint: string,
  path: string,
  provider: () => string | null
): Promise<T> {
  const prev = agentJwt;
  agentJwt = provider;
  try {
    return await getSubstrate<T>(endpoint, path);
  } finally {
    agentJwt = prev;
  }
}

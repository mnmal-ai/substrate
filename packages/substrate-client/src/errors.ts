/**
 * Typed error hierarchy for @mnmal-ai/substrate-client. Consumers `instanceof`-branch
 * on these to implement drift-specific UX, auth retry logic, etc.
 *
 * Note: `AbortSignal` fires surface as native `DOMException` with `name: 'AbortError'`,
 * NOT as a custom error in this module. Consumers check via `err.name === 'AbortError'`.
 */
export { SchemaDriftError } from '@mnmal-ai/substrate-pack';

/** What a non-2xx HTTP response said, when it said it as JSON `{ error, code }`. */
export interface NetworkErrorInfo {
  status?: number;
  code?: string;
  serverMessage?: string;
  /** The refusal's parsed JSON object, verbatim: route-specific detail (`edgeCount`, `unmapped`, `invalid`, …) lives here. */
  body?: Readonly<Record<string, unknown>>;
}

export class NetworkError extends Error {
  override readonly name = 'NetworkError';
  /** HTTP status of the response, when the failure was one. */
  readonly status?: number;
  /** The server's JSON error `code`, when its body carried one. */
  readonly code?: string;
  /** The server's JSON `error` text, when its body carried one. */
  readonly serverMessage?: string;
  /** The refusal's parsed JSON object, verbatim. */
  readonly body?: Readonly<Record<string, unknown>>;
  constructor(
    message: string,
    override readonly cause: unknown,
    info: NetworkErrorInfo = {}
  ) {
    super(message);
    if (info.status !== undefined) this.status = info.status;
    if (info.code !== undefined) this.code = info.code;
    if (info.serverMessage !== undefined) this.serverMessage = info.serverMessage;
    if (info.body !== undefined) this.body = info.body;
  }
}

/**
 * Thrown on Substrate auth failures — 401 (unauthenticated) or 403 (authenticated but
 * not authorised). Proxy-level failures (407, 511) fall through to NetworkError.
 */
export class AuthError extends Error {
  override readonly name = 'AuthError';
  /** The server's JSON error `code`, when its body carried one: the auth gate says `forbidden`. */
  readonly code?: string;
  /** The server's JSON `error` or `message` text, when its body carried one. */
  readonly serverMessage?: string;
  /** The refusal's parsed JSON object, verbatim. */
  readonly body?: Readonly<Record<string, unknown>>;
  constructor(
    message: string,
    readonly status: 401 | 403,
    info: {
      code?: string;
      serverMessage?: string;
      body?: Readonly<Record<string, unknown>>;
    } = {}
  ) {
    super(message);
    if (info.code !== undefined) this.code = info.code;
    if (info.serverMessage !== undefined) this.serverMessage = info.serverMessage;
    if (info.body !== undefined) this.body = info.body;
  }
}

export class SubscribeError extends Error {
  override readonly name = 'SubscribeError';
  constructor(
    message: string,
    readonly code: string
  ) {
    super(message);
  }
}

/**
 * HTTP transport for one-shot query + mutate + federated-schema requests.
 * Knows about headers, status codes, JSON vs pack Accept negotiation.
 * Does NOT know about envelope shape or schema drift — that's the wire layer.
 */

import type { PackEnvelope, QualifiedFrame, Schema } from '@mnmal-ai/substrate-types';
import { AuthError, NetworkError, type NetworkErrorInfo } from '../errors.js';

export type { QualifiedFrame };

export interface HttpTransportOpts {
  endpoint: string;
  token?: string;
  getToken?: () => string | Promise<string>;
  fetch?: typeof fetch;
}

export interface HttpCallOpts {
  wire?: 'json' | 'pack';
  signal?: AbortSignal;
  headers?: Record<string, string>;
}

export class HttpTransport {
  readonly #endpoint: string;
  readonly #fetch: typeof fetch;
  readonly #token: string | undefined;
  readonly #getToken: (() => string | Promise<string>) | undefined;

  constructor(opts: HttpTransportOpts) {
    if (opts.token !== undefined && opts.getToken !== undefined) {
      throw new Error('HttpTransport: provide `token` OR `getToken`, not both');
    }
    this.#endpoint = opts.endpoint.replace(/\/+$/, '');
    this.#fetch = (opts.fetch ?? globalThis.fetch).bind(globalThis);
    this.#token = opts.token;
    this.#getToken = opts.getToken;
  }

  async query(frame: QualifiedFrame, opts: HttpCallOpts): Promise<PackEnvelope> {
    return this.#postEnvelope(`${this.#endpoint}/substrate/v1/query`, frame, opts);
  }

  async mutate(frame: QualifiedFrame, opts: HttpCallOpts): Promise<PackEnvelope> {
    return this.#postEnvelope(`${this.#endpoint}/substrate/v1/mutate`, frame, opts);
  }

  async federatedSchema(opts: HttpCallOpts = {}): Promise<Record<string, Schema>> {
    const url = `${this.#endpoint}/substrate/v1/federated-schema`;
    const headers = await this.#headers('json', opts.headers);
    let res: Response;
    try {
      res = await this.#fetch(url, {
        method: 'GET',
        headers,
        ...(opts.signal !== undefined ? { signal: opts.signal } : {})
      });
    } catch (err) {
      throw new NetworkError(`GET ${url} failed`, err);
    }
    await this.#assertOk(res, url);
    return (await res.json()) as Record<string, Schema>;
  }

  /** A request to an arbitrary /substrate path with the client's auth; asserts ok (a 304 passes only with allow304). */
  async raw(
    path: string,
    init: {
      method: 'GET' | 'POST' | 'PATCH';
      body?: unknown;
      accept?: string;
      allow304?: boolean;
      headers?: Record<string, string>;
      signal?: AbortSignal;
    }
  ): Promise<Response> {
    const url = `${this.#endpoint}${path}`;
    const extra: Record<string, string> = init.accept !== undefined ? { accept: init.accept } : {};
    for (const [k, v] of Object.entries(init.headers ?? {})) extra[k.toLowerCase()] = v;
    const headers = await this.#headers('json', extra);
    if (init.body === undefined) delete headers['content-type'];
    let res: Response;
    try {
      res = await this.#fetch(url, {
        method: init.method,
        headers,
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
        ...(init.signal !== undefined ? { signal: init.signal } : {})
      });
    } catch (err) {
      throw new NetworkError(`${init.method} ${url} failed`, err);
    }
    if (!(init.allow304 === true && res.status === 304)) await this.#assertOk(res, url);
    return res;
  }

  async #postEnvelope(url: string, body: unknown, opts: HttpCallOpts): Promise<PackEnvelope> {
    const wire = opts.wire ?? 'json';
    const headers = await this.#headers(wire, opts.headers);
    let res: Response;
    try {
      res = await this.#fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        ...(opts.signal !== undefined ? { signal: opts.signal } : {})
      });
    } catch (err) {
      throw new NetworkError(`POST ${url} failed`, err);
    }
    await this.#assertOk(res, url);
    if (wire === 'pack') {
      const buf = await res.arrayBuffer();
      // SubstrateClient decodes this marker into a real envelope.
      return { __packBytes: new Uint8Array(buf) } as unknown as PackEnvelope;
    }
    return (await res.json()) as PackEnvelope;
  }

  async #headers(
    wire: 'json' | 'pack',
    extra?: Record<string, string>
  ): Promise<Record<string, string>> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: wire === 'pack' ? 'application/vnd.substrate.pack' : 'application/json'
    };
    const tok = this.#token ?? (this.#getToken ? await this.#getToken() : undefined);
    if (tok !== undefined) headers.authorization = `Bearer ${tok}`;
    return { ...headers, ...extra };
  }

  async #assertOk(res: Response, url: string): Promise<void> {
    if (res.ok) return;
    if (res.status === 401 || res.status === 403) {
      const { code, serverMessage, body } = await errorInfo(res);
      const info = {
        ...(code !== undefined ? { code } : {}),
        ...(serverMessage !== undefined ? { serverMessage } : {}),
        ...(body !== undefined ? { body } : {})
      };
      throw new AuthError(
        `${res.status === 401 ? 'Unauthorised' : 'Forbidden'}: ${url}`,
        res.status,
        info
      );
    }
    throw new NetworkError(`${res.status} from ${url}`, null, await errorInfo(res));
  }
}

/** The status plus whatever a JSON body says: the whole object as `body`, the first string of `error.message` (the recall plugin's nested shape), `error`, `message` as the message, and the first string of `error.code`, `code` as the code. Non-JSON bodies leave the status alone. */
async function errorInfo(res: Response): Promise<NetworkErrorInfo> {
  const info: NetworkErrorInfo = { status: res.status };
  try {
    const body: unknown = JSON.parse(await res.text());
    if (body !== null && typeof body === 'object' && !Array.isArray(body)) {
      const b = body as Record<string, unknown>;
      info.body = b;
      // The recall plugin nests its refusal: { error: { code, message } }.
      const nested =
        b.error !== null && typeof b.error === 'object'
          ? (b.error as Record<string, unknown>)
          : undefined;
      // First STRING wins: a non-string `error` (an object without a message) must not block `message`.
      const message = [nested?.message, b.error, b.message].find((v) => typeof v === 'string');
      const code = [nested?.code, b.code].find((v) => typeof v === 'string');
      if (typeof message === 'string') info.serverMessage = message;
      if (typeof code === 'string') info.code = code;
    }
  } catch {
    // not JSON: status alone
  }
  return info;
}

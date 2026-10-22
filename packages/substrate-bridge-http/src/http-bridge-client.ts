/**
 * `HttpBridgeClient` — HTTP-based `BridgeClient` impl. Spec §5.8.
 *
 * Wire endpoints:
 *   - GET  {baseUrl}/substrate/v1/federated-schema
 *   - POST {baseUrl}/substrate/v1/query   (JSON body — a `BridgeFrame`)
 *   - POST {baseUrl}/substrate/v1/mutate  (JSON body — a `BridgeFrame`)
 *
 * `readRow` composes a single-key query over `(ns, type, id)` and extracts the
 * row from the response envelope. Used by the sweep's `resolveTarget` to
 * classify bridged edges.
 *
 * Reachability is tracked via a `setInterval` that pings
 * `federated-schema`. The timer is `.unref()`d so it never holds the process
 * open. Every network-layer failure (fetch rejection, timeout or 5xx status)
 * flips the cached verdict to false AND throws `BridgeUnreachableError` to the
 * caller. Successful responses flip it back to true.
 *
 * Dispose is idempotent — safe to call more than once. Post-dispose calls to
 * `federatedSchema`/`query`/`mutate`/`readRow` still attempt fetch (callers
 * can elect to keep using the client for single-shot ops after disposing the
 * health probe).
 */

import type {
  BridgeClient,
  BridgeFrame,
  EdgeRef,
  PackEnvelope,
  Row,
  Schema
} from '@mnmal-ai/substrate-types';
import { BridgeUnreachableError } from '@mnmal-ai/substrate-types';

export interface HttpBridgeClientOptions {
  name: string;
  baseUrl: string;
  /** Override the global `fetch`. Primarily a test seam. */
  fetch?: typeof fetch;
  /**
   * Health-check cadence in ms. Default 10000 (10s per §5.8 "Reads are
   * timeout-bound"). Tests pass a tiny value and dispose aggressively.
   */
  healthCheckIntervalMs?: number;
  /**
   * Initial reachability verdict. Defaults to `true` — the first health probe
   * settles the real value. Tests may set `false` to start in the unreachable
   * state without waiting for a probe.
   */
  initialReachable?: boolean;
  /**
   * Supplies the full `Authorization` header value (e.g. `Bearer <jwt>`) for
   * every outbound call. Omitted for unauthenticated remotes. Called per
   * request — the provider owns caching and refresh.
   */
  auth?: () => string;
  /**
   * Most milliseconds one call may take, body included, before it fails as
   * unreachable. Default 10000. Without it a peer that accepts the connection
   * and then stalls hangs every bridged read.
   */
  timeoutMs?: number;
  /** Most bytes one response body may carry before the call fails. Default 64 MiB. */
  maxResponseBytes?: number;
}

const DEFAULT_HEALTH_INTERVAL_MS = 10_000;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RESPONSE_BYTES = 64 * 1024 * 1024;

export class HttpBridgeClient implements BridgeClient {
  readonly name: string;
  readonly baseUrl: string;
  readonly #fetch: typeof fetch;
  readonly #intervalMs: number;
  readonly #auth: (() => string) | undefined;
  readonly #timeoutMs: number;
  readonly #maxResponseBytes: number;
  #reachable: boolean;
  #timer: ReturnType<typeof setInterval> | undefined;
  #disposed = false;

  constructor(opts: HttpBridgeClientOptions) {
    this.name = opts.name;
    this.baseUrl = opts.baseUrl.endsWith('/') ? opts.baseUrl.slice(0, -1) : opts.baseUrl;
    this.#fetch = opts.fetch ?? fetch;
    this.#intervalMs = opts.healthCheckIntervalMs ?? DEFAULT_HEALTH_INTERVAL_MS;
    this.#auth = opts.auth;
    this.#timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#maxResponseBytes = opts.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    this.#reachable = opts.initialReachable ?? true;
    this.#startHealthProbe();
  }

  isReachable(): boolean {
    return this.#reachable;
  }

  async federatedSchema(): Promise<Record<string, Schema>> {
    return this.#getJson<Record<string, Schema>>('/substrate/v1/federated-schema');
  }

  query(frame: BridgeFrame): Promise<PackEnvelope> {
    return this.#postJson<PackEnvelope>('/substrate/v1/query', frame);
  }

  mutate(frame: BridgeFrame): Promise<PackEnvelope> {
    return this.#postJson<PackEnvelope>('/substrate/v1/mutate', frame);
  }

  async readRow(ref: EdgeRef): Promise<Row | null> {
    const key = `${ref.ns}/${ref.type}`;
    const frame: BridgeFrame = {
      [key]: {
        params: { id: ref.id, includeDeleted: true },
        fields: { id: true, _deletedAt: true }
      }
    };
    const envelope = await this.query(frame);
    const data = envelope.data?.[key];
    // An absent key means the peer refused the frame; only a present-but-empty
    // answer says the row is gone. The peer answered, so reachability stays.
    if (data === undefined) {
      const code = envelope.errors?.[0]?.code ?? 'no_data';
      throw new BridgeUnreachableError(this.name, this.baseUrl, `refused (${code})`);
    }
    if (data === null) return null;
    if (Array.isArray(data)) {
      const first = data[0];
      return first === undefined || first === null ? null : (first as Row);
    }
    return data as Row;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    if (this.#timer !== undefined) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }
  }

  #headers(base?: Record<string, string>): Record<string, string> {
    const headers: Record<string, string> = { ...base };
    if (this.#auth !== undefined) headers.authorization = this.#auth();
    return headers;
  }

  #startHealthProbe(): void {
    const timer = setInterval(() => {
      void this.#probeOnce();
    }, this.#intervalMs);
    const unref = (timer as unknown as { unref?: () => void }).unref;
    if (typeof unref === 'function') unref.call(timer);
    this.#timer = timer;
  }

  async #probeOnce(): Promise<void> {
    try {
      const res = await this.#fetch(`${this.baseUrl}/substrate/v1/federated-schema`, {
        method: 'GET',
        headers: this.#headers(),
        // A redirect would carry the bridge credential to wherever the peer points.
        redirect: 'error',
        signal: AbortSignal.timeout(this.#timeoutMs)
      });
      this.#reachable = res.ok;
      // Only the status matters; an unread body holds the connection.
      await res.body?.cancel();
    } catch {
      this.#reachable = false;
    }
  }

  #getJson<T>(path: string): Promise<T> {
    return this.#request<T>(path, { method: 'GET', headers: this.#headers() });
  }

  /**
   * Non-2xx handling for both verbs. 5xx and auth failures throw
   * `BridgeUnreachableError`; anything else throws a plain `Error`.
   *
   * Only 401 and 5xx flip coordinator-wide reachability. A 403 refuses THIS
   * operation only — flipping the shared flag would make every read against
   * a healthy peer short-circuit as unreachable after one refused mutate. A
   * credential that cannot read is still caught by `#probeOnce`.
   */
  #throwForStatus(status: number, path: string): never {
    if (status >= 500) {
      this.#reachable = false;
      throw new BridgeUnreachableError(this.name, this.baseUrl, `HTTP ${status}`);
    }
    if (status === 401 || status === 403) {
      if (status === 401) this.#reachable = false;
      throw new BridgeUnreachableError(this.name, this.baseUrl, `HTTP ${status} (auth)`);
    }
    throw new Error(`bridge '${this.name}' ${path} returned HTTP ${status}`);
  }

  #postJson<T>(path: string, body: unknown): Promise<T> {
    return this.#request<T>(path, {
      method: 'POST',
      headers: this.#headers({ 'content-type': 'application/json' }),
      body: JSON.stringify(body)
    });
  }

  /** The body as text, refusing once it passes `maxResponseBytes`. */
  async #readCapped(res: Response, path: string): Promise<string> {
    const tooLarge = () =>
      new Error(`bridge '${this.name}' ${path} response exceeds ${this.#maxResponseBytes} bytes`);
    if (Number(res.headers.get('content-length')) > this.#maxResponseBytes) {
      await res.body?.cancel();
      throw tooLarge();
    }
    if (res.body === null) return '';
    const chunks: Array<Uint8Array> = [];
    let total = 0;
    for await (const chunk of res.body) {
      total += chunk.byteLength;
      if (total > this.#maxResponseBytes) throw tooLarge();
      chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString('utf8');
  }

  async #request<T>(path: string, init: RequestInit): Promise<T> {
    // One deadline for the response AND its body: a peer can stall either.
    const signal = AbortSignal.timeout(this.#timeoutMs);
    let res: Response;
    try {
      res = await this.#fetch(`${this.baseUrl}${path}`, { ...init, redirect: 'error', signal });
    } catch (err) {
      this.#reachable = false;
      throw new BridgeUnreachableError(this.name, this.baseUrl, err);
    }
    if (!res.ok) this.#throwForStatus(res.status, path);
    try {
      const parsed = JSON.parse(await this.#readCapped(res, path)) as T;
      this.#reachable = true;
      return parsed;
    } catch (err) {
      if (!signal.aborted) throw err;
      this.#reachable = false;
      throw new BridgeUnreachableError(this.name, this.baseUrl, err);
    }
  }
}

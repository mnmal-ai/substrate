/**
 * SubstrateClient — the public facade over the HTTP and WS transports, wire
 * decoding and schema-drift handling.
 *
 * Routing is protocol-mandated: query and mutate go over HTTP only (WS does
 * not accept them); subscribe and stream go over WS only.
 *
 * Drift detection is lazy-seeded: the client cannot replicate the server's
 * federated schema-version hash, so the first envelope's `schemaVersion` seeds
 * the cache and any later mismatch refetches the schema and accepts the new
 * version as authoritative.
 */

import {
  applyDecodePlanInPlace,
  buildDecodePlan,
  type DecodeEnvelopeCtx,
  type DecodePlanEntry,
  decodeEnvelope
} from '@mnmal-ai/substrate-pack';
import {
  type FieldDef,
  type FieldInput,
  type PackEnvelope,
  parseQualifiedKey,
  type RuntimeErrors,
  type RuntimeMetrics,
  type Schema
} from '@mnmal-ai/substrate-types';
import { type AdminApi, createAdminApi } from './admin/api.js';
import { CacheStore } from './cache/store.js';
import {
  collectDiagnostics,
  createDefaultDiagnosticsSink,
  type DiagnosticsSink
} from './diagnostics.js';
import { createNlApi, type NlApi } from './nl.js';
import { watchRows } from './subscribe-rows.js';
import { assertSingleKey, augmentFramesWithId } from './subscribe-util.js';
import { HttpTransport, type QualifiedFrame } from './transport/http.js';
import {
  type SubscribeEvent,
  type WebSocketImpl,
  type WsEncoding,
  type WsFrameRequest,
  type WsOverloadResubscribeOpts,
  WsTransport
} from './transport/ws.js';
import { decodeJsonEnvelope, isPackMarker, type PackMarker } from './wire/json.js';

export interface SubstrateClientOptions {
  endpoint: string;
  token?: string;
  /**
   * Supplies the bare JWT (no `Bearer ` prefix — the transports add it).
   *
   * Sync providers are accepted so `@mnmal-ai/substrate-policy`'s synchronous
   * `makeTokenProvider` is usable directly; the transports `await` either way.
   */
  getToken?: () => string | Promise<string>;
  fetch?: typeof fetch;
  reconnect?: {
    baseDelayMs?: number;
    maxDelayMs?: number;
    jitter?: number;
  };
  /**
   * Wire encoding for the WS surface (subscribe + stream). Default `json`.
   * `pack` advertises the `substrate-pack` subprotocol at handshake; the connection
   * then exclusively speaks msgpack frames with positionally-encoded `data`,
   * which the client decodes back to named-object rows using the cached
   * federated schema. Negotiated once per WS connection — distinct from the
   * per-call HTTP `wire` opt because the WS subprotocol is a handshake-time
   * choice.
   */
  wsEncoding?: WsEncoding;
  /**
   * Auto-resubscribe policy for `subscription_overloaded` teardowns. Default:
   * enabled with 3 attempts. See the README "Terminal-aware resubscribe" section.
   */
  overloadResubscribe?: WsOverloadResubscribeOpts;
  /**
   * Explicit WebSocket implementation for the subscribe/stream surface. Must
   * be node-ws-compatible (`new (url, protocols?, { headers })`) so the
   * bearer can ride the upgrade. Defaults to node-ws under Node and the
   * global WebSocket elsewhere — see WsTransportOpts.webSocket.
   */
  webSocket?: WebSocketImpl;
  /**
   * Sink for non-fatal envelope diagnostics (`_diagnostics`) on query/mutate
   * responses: projection keys the type does not declare, a where-clause that
   * never reached the validator, and any diagnostic a newer substrate reports
   * that this client cannot read.
   *
   * Defaults to a deduped `console.warn`. Pass an explicit no-op only if you
   * surface the slot yourself — silence is the failure this exists to prevent.
   */
  onDiagnostics?: DiagnosticsSink;
}

export interface CallOpts {
  wire?: 'json' | 'pack';
  signal?: AbortSignal;
  headers?: Record<string, string>;
}

export class SubstrateClient {
  readonly #http: HttpTransport;
  #ws: WsTransport | null = null;
  #nl: NlApi | undefined;
  #admin: AdminApi | undefined;
  readonly #wsEndpoint: string;
  readonly #wsToken: string | undefined;
  readonly #wsGetToken: (() => string | Promise<string>) | undefined;
  readonly #wsEncoding: WsEncoding;
  readonly #reconnectOpts: SubstrateClientOptions['reconnect'];
  readonly #overloadResubscribeOpts: WsOverloadResubscribeOpts | undefined;
  readonly #webSocketImpl: WebSocketImpl | undefined;
  #schemaCache: Record<string, Schema> | null = null;
  #schemaFetch: Promise<Record<string, Schema>> | null = null;
  #driftCachedVersion: string | null = null;
  #closed = false;
  #wsReqSeq = 0;
  readonly #cache: CacheStore;
  readonly #onDiagnostics: DiagnosticsSink;

  constructor(opts: SubstrateClientOptions) {
    if (opts.token !== undefined && opts.getToken !== undefined) {
      throw new Error('SubstrateClient: provide `token` OR `getToken`, not both');
    }

    this.#http = new HttpTransport({
      endpoint: opts.endpoint,
      ...(opts.token !== undefined ? { token: opts.token } : {}),
      ...(opts.getToken !== undefined ? { getToken: opts.getToken } : {}),
      ...(opts.fetch !== undefined ? { fetch: opts.fetch } : {})
    });

    // Browser WebSocket can't set custom upgrade headers; node-ws can and is
    // preferred under Node. Browser consumers need a header-capable `webSocket`.
    this.#wsEndpoint = `${opts.endpoint.replace(/^http/, 'ws').replace(/\/+$/, '')}/substrate/v1/ws`;
    this.#wsToken = opts.token;
    this.#wsGetToken = opts.getToken;
    this.#wsEncoding = opts.wsEncoding ?? 'json';
    this.#reconnectOpts = opts.reconnect;
    this.#overloadResubscribeOpts = opts.overloadResubscribe;
    this.#webSocketImpl = opts.webSocket;
    this.#onDiagnostics = opts.onDiagnostics ?? createDefaultDiagnosticsSink();

    this.#cache = new CacheStore({ idleGcMs: 5000 });
  }

  /** Natural-language ask (SSE or JSON) and the served namespace pack. Requires the substrate-nl plugin. */
  get nl(): NlApi {
    this.#nl ??= createNlApi(this.#http);
    return this.#nl;
  }

  /** The admin-gated routes. Needs an identity whose grant confers `admin`. */
  get admin(): AdminApi {
    this.#admin ??= createAdminApi(this.#http);
    return this.#admin;
  }

  #ensureOpen(): void {
    if (this.#closed) throw new Error('SubstrateClient: already closed');
  }

  async federatedSchema(): Promise<Record<string, Schema>> {
    this.#ensureOpen();
    if (this.#schemaCache !== null) return this.#schemaCache;
    if (this.#schemaFetch === null) {
      // Cleared on failure as well as success: a cached rejection would fail every later
      // query and mutate until the process restarted.
      this.#schemaFetch = this.#http.federatedSchema().then(
        (schema) => {
          this.#schemaCache = schema;
          this.#schemaFetch = null;
          return schema;
        },
        (err: unknown) => {
          this.#schemaFetch = null;
          throw err;
        }
      );
    }
    return this.#schemaFetch;
  }

  async query(frame: QualifiedFrame, opts: CallOpts = {}): Promise<PackEnvelope> {
    this.#ensureOpen();
    await this.federatedSchema();
    const wire = opts.wire ?? 'json';
    const raw = await this.#http.query(frame, {
      wire,
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
      ...(opts.headers !== undefined ? { headers: opts.headers } : {})
    });
    return this.#decode(raw, frame, wire);
  }

  async mutate(frame: QualifiedFrame, opts: CallOpts = {}): Promise<PackEnvelope> {
    this.#ensureOpen();
    await this.federatedSchema();
    const wire = opts.wire ?? 'json';
    const raw = await this.#http.mutate(frame, {
      wire,
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
      ...(opts.headers !== undefined ? { headers: opts.headers } : {})
    });
    return this.#decode(raw, frame, wire);
  }

  subscribe(frame: QualifiedFrame, _opts: CallOpts = {}): AsyncIterable<SubscribeEvent> {
    // _opts is reserved (abort signal, custom headers); not yet wired.
    this.#ensureOpen();
    const req = this.#frameToWsRequest(frame);
    const inner = this.#getWs().subscribe(req);
    return this.#wsEncoding === 'pack' ? this.#wrapPackDecode(inner, req.frame) : inner;
  }

  stream(frame: QualifiedFrame, _opts: CallOpts = {}): AsyncIterable<SubscribeEvent> {
    // _opts is reserved (abort signal, custom headers); not yet wired.
    this.#ensureOpen();
    const req = this.#frameToWsRequest(frame);
    const inner = this.#getWs().stream(req);
    return this.#wsEncoding === 'pack' ? this.#wrapPackDecode(inner, req.frame) : inner;
  }

  /**
   * Live typed-row view over a single-key subscription. Subscribes under the
   * hood, folds snapshot/add/update/remove into the current row-set, and yields
   * the maintained `T[]` after each delta — hiding the raw `SubscribeEvent`
   * protocol. `id` is force-selected (via `augmentFramesWithId`) so
   * update/remove can correlate rows by id.
   *
   * Completes when the subscription ends; throws on an error frame — the same
   * contract as `subscribe`. Breaking the consuming `for await` cancels the
   * underlying WS subscription. Reconnect / overload-resubscribe are handled by
   * `subscribe`; each fresh snapshot atomically replaces the row-set.
   *
   * Single-qualified-key only: multi-key frames throw; use `subscribe` for
   * those or for raw events.
   */
  watch<T = Record<string, unknown>>(frame: QualifiedFrame): AsyncIterable<T[]> {
    this.#ensureOpen();
    const qualifiedKey = assertSingleKey(frame);
    return watchRows<T>(this.subscribe(augmentFramesWithId(frame)), qualifiedKey);
  }

  /**
   * @internal — not part of the stable public surface.
   */
  get cache(): CacheStore {
    return this.#cache;
  }

  invalidate(keyPrefix: string): void {
    this.#ensureOpen();
    this.#cache.invalidate(keyPrefix);
  }

  /** Runtime metrics: op totals, per-key latency, process health, slowest requests. Needs `read`. */
  async metrics(opts: { signal?: AbortSignal } = {}): Promise<RuntimeMetrics> {
    this.#ensureOpen();
    const res = await this.#http.raw('/substrate/v1/metrics', {
      method: 'GET',
      ...(opts.signal !== undefined ? { signal: opts.signal } : {})
    });
    return (await res.json()) as RuntimeMetrics;
  }

  /** The recent error log. Needs `admin`. */
  async errors(opts: { signal?: AbortSignal } = {}): Promise<RuntimeErrors> {
    this.#ensureOpen();
    const res = await this.#http.raw('/substrate/v1/errors', {
      method: 'GET',
      ...(opts.signal !== undefined ? { signal: opts.signal } : {})
    });
    return (await res.json()) as RuntimeErrors;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#ws !== null) {
      await this.#ws.close();
      this.#ws = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  #getWs(): WsTransport {
    if (this.#ws === null) {
      this.#ws = new WsTransport({
        endpoint: this.#wsEndpoint,
        encoding: this.#wsEncoding,
        ...(this.#wsToken !== undefined ? { token: this.#wsToken } : {}),
        ...(this.#wsGetToken !== undefined ? { getToken: this.#wsGetToken } : {}),
        ...(this.#reconnectOpts !== undefined ? { reconnect: this.#reconnectOpts } : {}),
        ...(this.#overloadResubscribeOpts !== undefined
          ? { overloadResubscribe: this.#overloadResubscribeOpts }
          : {}),
        ...(this.#webSocketImpl !== undefined ? { webSocket: this.#webSocketImpl } : {})
      });
    }
    return this.#ws;
  }

  async #refetchSchema(): Promise<void> {
    const schema = await this.#http.federatedSchema();
    this.#schemaCache = schema;
    // Does not touch #driftCachedVersion — #decode sets it from the envelope.
  }

  async #decode(
    raw: PackEnvelope,
    frame: QualifiedFrame,
    wire: 'json' | 'pack'
  ): Promise<PackEnvelope> {
    let env: PackEnvelope;

    if (wire === 'pack' && isPackMarker(raw as unknown)) {
      const schema = this.#schemaCache ?? {};
      const marker = raw as unknown as PackMarker;
      const ctx = this.#buildDecodeCtx(frame, schema);
      env = decodeEnvelope(marker.__packBytes, ctx);
    } else {
      env = decodeJsonEnvelope(raw);
    }

    // Lazy-seeded drift detection; see the file header.
    if (this.#driftCachedVersion === null) {
      this.#driftCachedVersion = env.schemaVersion;
    } else if (this.#driftCachedVersion !== env.schemaVersion) {
      await this.#refetchSchema();
      this.#driftCachedVersion = env.schemaVersion;
    }

    // `_diagnostics` rides only query/mutate envelopes, all of which pass
    // here, so surfacing them here cannot be bypassed by a consumer.
    collectDiagnostics(env._diagnostics, this.#onDiagnostics);

    return env;
  }

  /**
   * Convert a `QualifiedFrame` into a `WsFrameRequest` for the WsTransport.
   *
   * The id MUST be unique per call: a key-derived id lets a re-subscribe race
   * the old sub's terminal frame and silently kill the new one. The type-key
   * prefix is only for readable logs. WsTransport reuses the id verbatim on
   * reconnect, so it is stable for the subscription's lifetime.
   */
  #frameToWsRequest(frame: QualifiedFrame): WsFrameRequest {
    this.#wsReqSeq += 1;
    const id = `${Object.keys(frame).sort().join('|')}#${this.#wsReqSeq}`;
    // WsFrameRequest.frame expects a flat (non-batched) frame map — strip arrays
    // to the first entry so the type aligns. Batched WS subscriptions are not
    // part of the v2 protocol.
    const wsFrame: WsFrameRequest['frame'] = {};
    for (const [key, entry] of Object.entries(frame)) {
      const single = Array.isArray(entry) ? entry[0] : entry;
      wsFrame[key] = {
        params: (single?.params ?? {}) as Record<string, unknown>,
        fields: (single?.fields ?? {}) as Record<string, unknown>
      };
    }
    return { id, frame: wsFrame };
  }

  /**
   * Wrap a WS event stream so each `data`-bearing frame (snapshot/add/update/
   * chunk) gets its positional tuple values reconstructed into named-object
   * rows using the cached federated schema. Errors from the inner stream
   * (transport drop, server error frame) propagate untouched.
   *
   * The decode plan is built once, after the schema resolves, and reused for
   * every frame of the subscription.
   *
   * Hand-rolled iterator, NOT a native async generator: the generator form
   * queues return() behind an in-flight next(), which on a quiet connection
   * never resolves, so close() would hang. return() here forwards immediately.
   */
  #wrapPackDecode(
    inner: AsyncIterable<SubscribeEvent>,
    frameSpec: WsFrameRequest['frame']
  ): AsyncIterable<SubscribeEvent> {
    const buildPlan = async (): Promise<DecodePlanEntry[]> => {
      const schemas = await this.federatedSchema();
      return buildDecodePlan(frameSpec, schemas);
    };
    return {
      [Symbol.asyncIterator]: (): AsyncIterator<SubscribeEvent> => {
        const innerIt = inner[Symbol.asyncIterator]();
        let planPromise: Promise<DecodePlanEntry[]> | null = null;
        return {
          // Does NOT serialize concurrent next() calls, same as the transport
          // iterator; for-await never overlaps next().
          async next(): Promise<IteratorResult<SubscribeEvent>> {
            planPromise ??= buildPlan();
            const plan = await planPromise;
            const result = await innerIt.next();
            if (!result.done) applyDecodePlanInPlace(result.value, plan);
            return result;
          },
          async return(): Promise<IteratorResult<SubscribeEvent>> {
            // Forward immediately; the transport resolves its pending waiter
            // and sends the cancel frame.
            await innerIt.return?.();
            return { value: undefined as unknown as SubscribeEvent, done: true };
          }
        };
      }
    };
  }

  #buildDecodeCtx(frame: QualifiedFrame, schemas: Record<string, Schema>): DecodeEnvelopeCtx {
    // Mutation keys decode via the declared `returns` FieldDef (fieldsByKey is
    // left unset; the decoder checks returnsByKey first). Everything else
    // decodes via the request's `fields` selection.
    const fieldsByKey: Record<string, FieldInput> = {};
    const returnsByKey: Record<string, FieldDef> = {};
    const typeByKey: Record<string, string> = {};
    const currentNsByKey: Record<string, string> = {};

    for (const key of Object.keys(frame)) {
      const frameEntry = frame[key];
      const entry = Array.isArray(frameEntry) ? frameEntry[0] : frameEntry;

      // Unqualified keys are skipped; the server rejects them anyway.
      const parsed = parseQualifiedKey(key);
      if (parsed === null) continue;
      const { ns, name } = parsed;

      currentNsByKey[key] = ns;
      typeByKey[key] = name;

      const nsSchema = schemas[ns];
      if (nsSchema !== undefined && nsSchema.mutations[name] !== undefined) {
        returnsByKey[key] = nsSchema.mutations[name].returns;
      } else {
        fieldsByKey[key] = (entry?.fields ?? {}) as FieldInput;
      }
    }

    return { fieldsByKey, returnsByKey, typeByKey, schemas, currentNsByKey };
  }
}

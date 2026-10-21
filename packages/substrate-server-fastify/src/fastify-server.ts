/**
 * Reference SubstrateServer backed by Fastify 5.x.
 *
 * TLS design call: Fastify requires the https options at construction time, so
 * `tls` must be passed to the constructor. Passing `tls` on `start()` when the
 * instance was built without it is a programming error and throws — we do not
 * silently re-construct.
 *
 * onError design call: we register BOTH `setErrorHandler` and the `onError`
 * hook. The `onError` hook fires for errors that surface inside the request
 * lifecycle (including those thrown by handlers before the reply is sent); the
 * `setErrorHandler` override preserves Fastify's default 500 response shape
 * while still invoking the user hook. A per-request WeakSet guard stops the
 * hook from firing twice for the same error.
 *
 * createPluginRouter design call: plugin routes are mounted under
 * `/substrate/v1/plugins/<name>` so they can never shadow `/substrate/v1/*` and two plugins
 * declaring the same subpath (e.g. `/ping`) stay isolated. The facade
 * prefixes every path before handing it to `registerRoute` / `registerWsRoute`
 * — the main Fastify instance still sees one flat routing table.
 *
 * start() twice: Fastify's listen() rejects on a second call. We surface that
 * error as-is rather than caching and returning the prior address — the
 * caller's intent is ambiguous, fail loudly.
 */

import { randomUUID } from 'node:crypto';
import compressPlugin from '@fastify/compress';
import corsPlugin from '@fastify/cors';
import websocketPlugin, { type WebsocketHandler } from '@fastify/websocket';
import type {
  HttpHandler,
  HttpMethod,
  PluginRouter,
  RequestObserver,
  RuntimeOp,
  StartOpts,
  SubstrateRequest,
  SubstrateResponse,
  SubstrateServer,
  TlsConfig,
  WsConnection,
  WsHandler
} from '@mnmal-ai/substrate-types';
import { WS_REASON_SERVER_RESTART } from '@mnmal-ai/substrate-types';
import Fastify, {
  type FastifyError,
  type FastifyHttpsOptions,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest
} from 'fastify';
import { applySubstrateResponse, toSubstrateRequest } from './translate.js';

/**
 * CORS configuration for browser-facing deployments.
 *
 * `origins`: the allowed origins, or `'*'` for any origin.
 *   - `'*'` enables `Access-Control-Allow-Origin: *` (anonymous requests only —
 *     browsers refuse it paired with `credentials: true`).
 *   - An explicit list sends back the matched origin via reflect-origin so
 *     credentialed requests (Authorization header) work across origins.
 *
 * `credentials`: whether to emit `Access-Control-Allow-Credentials: true`.
 *   Defaults to `true` when `origins` is an explicit list, `false` when `'*'`.
 *
 * When `cors` is unset on `FastifySubstrateServerOptions` the CORS plugin is never
 * registered.
 */
export interface CorsOptions {
  origins: string[] | '*';
  credentials?: boolean;
}

export interface FastifySubstrateServerOptions {
  logger?: boolean;
  bodyLimit?: number;
  tls?: TlsConfig;
  cors?: CorsOptions;
  /**
   * Response compression. Defaults to enabled — gzip/deflate/brotli for JSON +
   * text responses above 1 KB, when the client advertises Accept-Encoding.
   * Binary content types (application/octet-stream, application/vnd.substrate.pack)
   * are not compressed (msgpack pack bytes are already dense). Set `false`
   * to disable when an upstream proxy already handles compression.
   */
  compression?: boolean;
  /**
   * Most milliseconds a client may take to send a whole request (headers and
   * body). Default 30 000. Fastify's own default is 0, no limit, which lets a
   * slow sender hold a connection open forever. Streamed responses are not
   * bounded by it. `0` disables.
   */
  requestTimeout?: number;
  /** Largest WebSocket frame accepted, in bytes. Default 1 MiB (`ws` allows 100 MiB). */
  wsMaxPayload?: number;
  /**
   * Most bytes a WebSocket may have queued for a peer that is not reading.
   * A send past it closes the socket 1013 `send_buffer_full`. Default 16 MiB.
   */
  wsMaxBuffered?: number;
  /** Operator-facing warnings (e.g. a WebSocket closed for a full send buffer). Default: Fastify's logger. */
  onWarn?: (message: string) => void;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_WS_MAX_PAYLOAD = 1 << 20;
const DEFAULT_WS_MAX_BUFFERED = 16 << 20;
/** How long a buffer-full socket gets to finish its close handshake before it is dropped. */
const WS_CLOSE_GRACE_MS = 1_000;

type ErrorHook = (err: Error, req?: SubstrateRequest) => void;

const HANDLED_ERRORS = new WeakSet<Error>();

export class FastifySubstrateServer implements SubstrateServer {
  private readonly fastify: FastifyInstance;
  private readonly hasTls: boolean;
  private errorHook: ErrorHook | undefined;
  #observer: RequestObserver | undefined;
  #inFlightObserver: ((op: RuntimeOp, delta: 1 | -1) => void) | undefined;
  private readonly inFlight = new Set<AbortController>();
  // Live WS connections paired with the route layer's pre-close emitter (set
  // via `conn.onShutdown(...)`). Walked on `stop()` to flush structured `end`
  // frames per subscription before the underlying socket closes — clients see
  // a graceful shutdown signal instead of a 1006 abrupt drop.
  private readonly inFlightWs = new Map<WsConnection, ((reason: string) => void) | null>();
  // Route-level graceful-shutdown listeners (`onShutdown`). Separate from
  // `inFlightWs` because these are per-ROUTE, not per-connection: an SSE route
  // registers once at compose time and owns whatever responses are open when
  // the notice fires.
  readonly #shutdownHooks = new Set<(reason: string) => void>();
  // One entry per response still streaming a body, resolved when its socket
  // finishes. `stop()` waits on these before `fastify.close()` — see
  // `#drainThenClose` for why the ordering is load-bearing.
  readonly #streamedResponses = new Set<Promise<void>>();
  readonly #wsMaxBuffered: number;
  readonly #onWarn: ((message: string) => void) | undefined;

  constructor(options: FastifySubstrateServerOptions = {}) {
    const {
      logger = false,
      bodyLimit,
      tls,
      cors,
      compression = true,
      requestTimeout = DEFAULT_REQUEST_TIMEOUT_MS,
      wsMaxPayload = DEFAULT_WS_MAX_PAYLOAD,
      wsMaxBuffered = DEFAULT_WS_MAX_BUFFERED,
      onWarn
    } = options;
    this.#wsMaxBuffered = wsMaxBuffered;
    this.#onWarn = onWarn;
    this.hasTls = tls !== undefined;

    const common = {
      logger,
      requestTimeout,
      ...(bodyLimit !== undefined ? { bodyLimit } : {})
    };
    if (tls) {
      const httpsOptions: FastifyHttpsOptions<never>['https'] = {
        cert: tls.cert,
        key: tls.key,
        ...(tls.ca !== undefined ? { ca: tls.ca } : {})
      };
      this.fastify = Fastify({ ...common, https: httpsOptions });
    } else {
      this.fastify = Fastify(common);
    }

    // Raw-bytes parsers for binary payloads (substrate-pack). Everything else
    // falls back to Fastify's built-ins; translate.coerceBody re-encodes any
    // parsed object back to a Buffer before it reaches a handler.
    this.fastify.addContentTypeParser(
      'application/octet-stream',
      { parseAs: 'buffer' },
      (_req, body, done) => done(null, body)
    );
    this.fastify.addContentTypeParser(
      'application/vnd.substrate.pack',
      { parseAs: 'buffer' },
      (_req, body, done) => done(null, body)
    );

    this.fastify.setErrorHandler((err: FastifyError, req, reply) => {
      this.invokeErrorHook(err, req);
      const statusCode = err.statusCode ?? 500;
      // A 5xx is a fault on our side whose message can carry table names and
      // row values, so the client gets a generic body; `onError` gets the error.
      const internal = statusCode >= 500;
      // Substrate-shaped error envelope so envelope-aware clients parse failures
      // like any other error; the status code still discriminates 4xx vs 5xx.
      reply
        .status(statusCode)
        .header('content-type', 'application/json; charset=utf-8')
        .send({
          schemaVersion: '',
          data: {},
          shapes: {},
          errors: [
            internal
              ? { message: 'internal server error', code: 'internal_error' }
              : {
                  message: err.message,
                  code:
                    typeof err.code === 'string' && err.code.length > 0 ? err.code : 'request_error'
                }
          ]
        });
    });

    this.fastify.addHook(
      'onError',
      async (req: FastifyRequest, _reply: FastifyReply, err: FastifyError) => {
        this.invokeErrorHook(err, req);
      }
    );

    // Compression goes on before route plugins so it wraps every reply,
    // including ones registered later via `route()` / `createPluginRouter()`.
    // 1024-byte threshold skips tiny responses where header overhead would
    // outweigh the saving; the default mime-db filter only touches text-shaped
    // types so application/octet-stream + application/vnd.substrate.pack pass through.
    // `void` — third-party plugin; failures surface at ready() time.
    if (compression) {
      void this.fastify.register(compressPlugin, { threshold: 1024 });
    }

    // Register the CORS plugin before any routes so preflight OPTIONS requests
    // are intercepted before they reach 404 handlers. When `cors` is unset
    // (agent-only deployments) the plugin is skipped entirely — zero overhead.
    if (cors !== undefined) {
      // `origin: '*'` sends a literal wildcard header (anonymous requests only).
      // `origin: <array>` reflects the matching origin, enabling credentialed
      // cross-origin requests. `true` (reflect-all) is intentionally not used
      // because combining reflected origin with credentials:true is the setup
      // that works, while '*' + credentials:true is a browser error.
      // `void` — third-party plugin; failures surface at ready() time.
      void this.fastify.register(corsPlugin, {
        origin: cors.origins === '*' ? '*' : cors.origins,
        credentials: cors.credentials ?? cors.origins !== '*',
        methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
        allowedHeaders: ['Authorization', 'Content-Type', 'Accept']
      });
    }

    // Register the websocket plugin eagerly. `fastify-plugin` wraps
    // @fastify/websocket so its `wsHandler` route option propagates through
    // the plugin tree — subsequent child-plugin registrations (made via
    // `websocket()` / `createPluginRouter().websocket()`) inherit it.
    // `void` — third-party plugin; failures surface at ready() time.
    void this.fastify.register(websocketPlugin, { options: { maxPayload: wsMaxPayload } });
  }

  private invokeErrorHook(err: Error, req?: FastifyRequest): void {
    if (!this.errorHook) return;
    if (HANDLED_ERRORS.has(err)) return;
    HANDLED_ERRORS.add(err);
    try {
      this.errorHook(err, req ? toSubstrateRequest(req) : undefined);
    } catch {
      // Error-hook faults must not mask the original error.
    }
  }

  async start(opts?: StartOpts): Promise<{ address: string; port: number }> {
    if (opts?.tls && !this.hasTls) {
      throw new Error(
        'FastifySubstrateServer: tls must be supplied at construction time, not to start()'
      );
    }
    const host = opts?.host ?? '0.0.0.0';
    const port = opts?.port ?? 0;
    await this.fastify.ready();
    const address = await this.fastify.listen({ host, port });
    const info = this.fastify.addresses()[0];
    if (!info) {
      const match = /:(\d+)$/.exec(address);
      const fallbackPort = match?.[1] ? Number.parseInt(match[1], 10) : port;
      return { address: host, port: fallbackPort };
    }
    return { address: info.address, port: info.port };
  }

  async stop(opts?: { grace?: number; abortInFlight?: boolean }): Promise<void> {
    // Notify live WS connections BEFORE fastify.close() drops their sockets,
    // so the route layer can emit structured `end { reason }` frames and the
    // client sees a graceful shutdown signal instead of a 1006 abrupt drop.
    this.notifyWsShutdown(WS_REASON_SERVER_RESTART);
    // Same courtesy for routes holding an HTTP response open (SSE). This runs
    // BEFORE `abortAllRequests` deliberately: such a response IS an in-flight
    // request, and aborting it first would tear the session down as a client
    // disconnect — no terminal frame, and the teardown attributed to
    // `socket_close` rather than `shutdown`.
    this.#notifyShutdown(WS_REASON_SERVER_RESTART);
    if (opts?.abortInFlight === true) {
      this.abortAllRequests('server_shutdown');
    }
    const grace = opts?.grace;
    if (grace === undefined) {
      await this.#drainThenClose();
      return;
    }
    await Promise.race([
      this.#drainThenClose(),
      new Promise<void>((resolve) => {
        setTimeout(resolve, grace).unref();
      })
    ]);
  }

  /**
   * Let streamed responses finish before handing off to `fastify.close()`.
   *
   * `close()` takes exactly ONE pass at reaping idle keep-alive connections. A
   * socket still flushing its final bytes at that instant survives the pass,
   * and nothing revisits it — so `close()` waits on a connection that will
   * never be reaped, and a bare `stop()` never returns.
   *
   * Unbounded on purpose: `fastify.close()` already waits on in-flight
   * requests, so a route that ignores the shutdown notice blocks `stop()`
   * anyway. Callers who need a ceiling pass `grace`, which races this whole
   * sequence.
   */
  async #drainThenClose(): Promise<void> {
    await Promise.all([...this.#streamedResponses]);
    // One macrotask: the response's `close` fires around the socket's
    // return to the idle pool, and `closeIdleConnections()` only sees sockets
    // already parked there.
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    await this.fastify.close();
  }

  abortAllRequests(reason?: string): void {
    // Snapshot first — controller.abort() triggers the route handler's finally
    // block which calls inFlight.delete(controller). Iterating the live Set
    // while it's being mutated yields undefined behaviour across runtimes.
    const controllers = [...this.inFlight];
    for (const controller of controllers) {
      if (!controller.signal.aborted) controller.abort(reason ?? 'aborted');
    }
  }

  onShutdown(cb: (reason: string) => void): void {
    this.#shutdownHooks.add(cb);
  }

  /**
   * Fan the shutdown notice out to every registered route hook. Synchronous so
   * a hook's final writes are queued before `fastify.close()` starts draining.
   */
  #notifyShutdown(reason: string): void {
    for (const hook of [...this.#shutdownHooks]) {
      try {
        hook(reason);
      } catch {
        // One route's teardown must not block another's, nor abort the drain.
      }
    }
  }

  /**
   * Walk every live WS connection and invoke its registered shutdown emitter,
   * then close the socket with code 1012 (Service Restart). Synchronous so
   * frames flush before the @fastify/websocket plugin's close pass runs.
   */
  private notifyWsShutdown(reason: string): void {
    // Snapshot — emitters call conn.close() which fires onClose, removing the
    // entry from inFlightWs. Iterating the live map would skip pairs.
    const entries = [...this.inFlightWs.entries()];
    for (const [conn, emit] of entries) {
      try {
        emit?.(reason);
      } catch {
        // Route-layer emit may throw if the socket buffer is full or already
        // half-closed — swallow so one bad conn doesn't block the rest of the
        // drain. Each conn's close still fires below.
      }
      try {
        conn.close(1012, reason);
      } catch {
        // Already closed.
      }
    }
  }

  /**
   * Wrap an HTTP-method route in a child plugin so it lands in the plugin
   * queue *after* compress / cors / websocket have finished loading.
   * @fastify/compress installs an `onRoute` hook that decorates each route
   * with compression metadata; routes added directly to the parent scope
   * before ready() runs miss that hook and are never compressed.
   *
   * Done-callback form (not `async`) because registerRoute is synchronous —
   * no extra Promise to discard.
   */
  #registerWrapped(
    method: HttpMethod,
    path: string,
    handler: HttpHandler,
    inFlight: Set<AbortController> = this.inFlight
  ): void {
    this.fastify.register((scope, _opts, done) => {
      registerRoute(scope, method, path, handler, inFlight, this.#streamedResponses);
      done();
    });
  }

  /** Same ordering guarantee as #registerWrapped but for WebSocket routes. */
  #registerWsWrapped(path: string, handler: WsHandler): void {
    this.fastify.register((scope, _opts, done) => {
      registerWsRoute(
        scope,
        path,
        handler,
        this.inFlightWs,
        (err) => this.invokeErrorHook(err),
        this.#wsMaxBuffered,
        this.#onWarn ?? ((message) => scope.log.warn(message))
      );
      done();
    });
  }

  route(method: HttpMethod, path: string, handler: HttpHandler): void {
    this.#registerWrapped(method, path, this.#instrument(method, path, handler));
  }

  #instrument(method: HttpMethod, path: string, handler: HttpHandler): HttpHandler {
    // Op is resolved once at registration time (Fastify routes are static).
    // Only query/mutate are observed.
    const op: RuntimeOp | null =
      method === 'POST' && path === '/substrate/v1/query'
        ? 'query'
        : method === 'POST' && path === '/substrate/v1/mutate'
          ? 'mutate'
          : null;
    if (op === null) return handler;
    return async (req): Promise<SubstrateResponse> => {
      // Scope: only completed responses are observed. A handler that throws
      // propagates without being counted — route handlers return error
      // envelopes rather than throwing, so this is rare.
      const inflight = this.#inFlightObserver;
      this.#notifyInFlight(inflight, op, 1);
      try {
        const startedAt = Date.now();
        const res = await handler(req);
        const obs = this.#observer;
        if (obs !== undefined) {
          try {
            obs({ op, ok: res.status < 400, durationMs: Date.now() - startedAt });
          } catch {
            // A buggy observer must never break request handling.
          }
        }
        return res;
      } finally {
        this.#notifyInFlight(inflight, op, -1);
      }
    };
  }

  #notifyInFlight(
    fn: ((op: RuntimeOp, delta: 1 | -1) => void) | undefined,
    op: RuntimeOp,
    delta: 1 | -1
  ): void {
    if (fn === undefined) return;
    try {
      fn(op, delta);
    } catch {
      // A buggy observer must never break request handling.
    }
  }

  observeInFlight(fn: (op: RuntimeOp, delta: 1 | -1) => void): void {
    this.#inFlightObserver = fn;
  }

  observeRequests(observer: RequestObserver): void {
    this.#observer = observer;
  }

  websocket(path: string, handler: WsHandler): void {
    this.#registerWsWrapped(path, handler);
  }

  onError(hook: ErrorHook): void {
    this.errorHook = hook;
  }

  createPluginRouter(plugin: { name: string }): PluginRouter {
    const prefix = `/substrate/v1/plugins/${plugin.name}`;
    const prefixed = (path: string): string =>
      `${prefix}${path.length === 0 ? '/' : path.startsWith('/') ? path : `/${path}`}`;

    const VERBS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'] as const;
    const verbEntries = VERBS.map((method) => [
      method.toLowerCase(),
      (path: string, handler: HttpHandler) =>
        this.#registerWrapped(method, prefixed(path), handler, this.inFlight)
    ]);

    return {
      ...(Object.fromEntries(verbEntries) as Pick<
        PluginRouter,
        'get' | 'post' | 'put' | 'delete' | 'patch'
      >),
      websocket: (path, handler) => this.#registerWsWrapped(prefixed(path), handler)
    };
  }

  async inject(req: Partial<SubstrateRequest>): Promise<SubstrateResponse> {
    await this.fastify.ready();
    const method = req.method ?? 'GET';
    const url = buildInjectUrl(req.path ?? '/', req.query ?? {});
    const headers = { ...(req.headers ?? {}) };
    const payload = req.body ?? undefined;
    const injectOpts = {
      method,
      url,
      headers,
      ...(payload !== undefined ? { payload } : {})
    };
    // Fastify's inject() is overloaded; the Promise-returning signature takes
    // a single options arg. The object-literal overload trips TS's overload
    // resolution, hence the explicit cast below.
    const result = await (
      this.fastify.inject as (opts: typeof injectOpts) => Promise<{
        statusCode: number;
        headers: Record<string, string | string[] | undefined | number>;
        rawPayload: Buffer;
      }>
    )(injectOpts);
    const rawHeaders = result.headers;
    const outHeaders: Record<string, string> = {};
    for (const [k, v] of Object.entries(rawHeaders)) {
      if (v === undefined) continue;
      outHeaders[k] = Array.isArray(v) ? v.join(', ') : String(v);
    }
    return {
      status: result.statusCode,
      headers: outHeaders,
      body: result.rawPayload
    };
  }
}

function buildInjectUrl(path: string, query: Record<string, string>): string {
  const keys = Object.keys(query);
  if (keys.length === 0) return path;
  const qs = new URLSearchParams();
  for (const k of keys) {
    const v = query[k];
    if (v !== undefined) qs.set(k, v);
  }
  const sep = path.includes('?') ? '&' : '?';
  return `${path}${sep}${qs.toString()}`;
}

/**
 * Register a response that streams its body, resolving when the underlying
 * socket finishes (`close` covers both a completed response and a torn-down
 * connection). `stop()` awaits these so it never calls `fastify.close()` while
 * a socket is mid-flush.
 */
function trackStreamedResponse(reply: FastifyReply, streamed: Set<Promise<void>>): void {
  let settle: (() => void) | undefined;
  const finished = new Promise<void>((resolve) => {
    settle = resolve;
  });
  streamed.add(finished);
  reply.raw.once('close', () => {
    streamed.delete(finished);
    // The executor above ran synchronously, so `settle` is assigned.
    settle!();
  });
}

function registerRoute(
  fastify: FastifyInstance,
  method: HttpMethod,
  path: string,
  handler: HttpHandler,
  inFlight: Set<AbortController>,
  streamed: Set<Promise<void>>
): void {
  fastify.route({
    method,
    url: path,
    handler: async (req: FastifyRequest, reply: FastifyReply) => {
      const controller = new AbortController();
      inFlight.add(controller);
      // Detect client disconnects via the RESPONSE stream, not the request
      // stream: `req.raw` 'close' fires once the request body is consumed,
      // before the handler finishes, and would cancel live requests. A
      // `reply.raw` 'close' before the response is flushed is a real disconnect.
      const onResponseClose = (): void => {
        if (!reply.raw.writableFinished && !controller.signal.aborted) {
          controller.abort('client_disconnect');
        }
      };
      reply.raw.once('close', onResponseClose);
      try {
        const hReq = toSubstrateRequest(req, controller.signal);
        const hRes = await handler(hReq);
        if (hRes.body instanceof ReadableStream) trackStreamedResponse(reply, streamed);
        await applySubstrateResponse(reply, hRes);
      } finally {
        reply.raw.off('close', onResponseClose);
        inFlight.delete(controller);
      }
    }
  });
}

function registerWsRoute(
  fastify: FastifyInstance,
  path: string,
  handler: WsHandler,
  inFlightWs: Map<WsConnection, ((reason: string) => void) | null>,
  onHandlerError: (err: Error) => void,
  maxBuffered: number,
  warn: (message: string) => void
): void {
  const wsHandler: WebsocketHandler = (socket, req) => {
    // Upgrade metadata (path, headers, query, params, identity) rides on the
    // SubstrateRequest — same shape HTTP handlers see. Body is forced to null
    // because WS upgrades don't carry one; the default coercion agrees for a
    // GET, but we set it explicitly so intent is loud at the boundary.
    const substrateReq: SubstrateRequest = { ...toSubstrateRequest(req), body: null };
    let shutdownEmitter: ((reason: string) => void) | null = null;
    let bufferFull = false;
    const conn: WsConnection = {
      id: randomUUID(),
      send(frame) {
        if (bufferFull) return;
        // A peer that stops reading would otherwise grow the queue without
        // bound. Close with a reason a client can act on; a peer that never
        // reads the close frame is dropped after the grace period, and either
        // way 'close' runs the route's teardown.
        if (socket.bufferedAmount > maxBuffered) {
          bufferFull = true;
          warn(
            `websocket ${path} conn ${conn.id}: send buffer full (${socket.bufferedAmount} > ${maxBuffered} bytes); closing 1013`
          );
          socket.close(1013, 'send_buffer_full');
          setTimeout(() => socket.terminate(), WS_CLOSE_GRACE_MS).unref?.();
          return;
        }
        if (typeof frame === 'string') {
          socket.send(frame);
        } else if (Buffer.isBuffer(frame)) {
          socket.send(frame);
        } else {
          socket.send(Buffer.from(frame));
        }
      },
      // Stream back-pressure. Resolve immediately when the
      // socket's queued bytes are under the high-water mark (the common case —
      // zero cost on `send`); otherwise poll until the buffer drains or the
      // socket leaves OPEN, so a stuck/closing socket never hangs the producer.
      drain() {
        const HIGH_WATER = 1 << 20; // 1 MiB
        if (socket.bufferedAmount <= HIGH_WATER || socket.readyState !== 1) {
          return Promise.resolve();
        }
        return new Promise<void>((resolve) => {
          const check = (): void => {
            if (socket.readyState !== 1 || socket.bufferedAmount <= HIGH_WATER) {
              resolve();
              return;
            }
            setTimeout(check, 10).unref?.();
          };
          setTimeout(check, 10).unref?.();
        });
      },
      onMessage(cb) {
        socket.on('message', (buf: Buffer) => {
          cb(Buffer.isBuffer(buf) ? buf : Buffer.from(buf));
        });
      },
      onClose(cb) {
        socket.on('close', (code: number) => {
          cb(code);
        });
      },
      close(code, reason) {
        socket.close(code, reason);
      },
      onShutdown(cb) {
        shutdownEmitter = cb;
        // Re-publish the latest emitter to the registry — the route layer
        // installs its emitter mid-handler, after the conn was first added.
        inFlightWs.set(conn, shutdownEmitter);
      }
    };
    inFlightWs.set(conn, null);
    socket.on('close', () => {
      inFlightWs.delete(conn);
    });
    // A rejection here would be an unhandledRejection, which can crash the
    // process; report it and close with 1011 (internal error) instead.
    const fail = (err: unknown): void => {
      onHandlerError(err instanceof Error ? err : new Error(String(err)));
      socket.close(1011, 'internal error');
    };
    try {
      Promise.resolve(handler(substrateReq, conn)).catch(fail);
    } catch (err) {
      fail(err);
    }
  };
  fastify.route({
    method: 'GET',
    url: path,
    handler: (_req, reply) => {
      // Non-upgrade GETs on a WS path get a 426. The wsHandler below
      // intercepts Upgrade requests before this plain handler runs.
      reply.status(426).send({ error: 'Upgrade Required' });
    },
    wsHandler
  });
}

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
 * prefixes every path before handing it to `registerRoute`
 * — the main Fastify instance still sees one flat routing table.
 *
 * start() twice: Fastify's listen() rejects on a second call. We surface that
 * error as-is rather than caching and returning the prior address — the
 * caller's intent is ambiguous, fail loudly.
 */

import { constants as h2constants, type ServerHttp2Stream } from 'node:http2';
import type { Socket } from 'node:net';
import type { TLSSocket } from 'node:tls';
import compressPlugin from '@fastify/compress';
import corsPlugin from '@fastify/cors';
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
  TlsConfig
} from '@mnmal-ai/substrate-types';
import { WS_REASON_SERVER_RESTART } from '@mnmal-ai/substrate-types';
import Fastify, {
  type FastifyError,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest
} from 'fastify';
import { applySubstrateResponse, toSubstrateRequest } from './translate.js';

/** @fastify/compress's default filter. It already leaves `text/event-stream` alone. */
const COMPRESSIBLE =
  /^text\/(?!event-stream)|(?:\+|\/)json(?:;|$)|(?:\+|\/)text(?:;|$)|(?:\+|\/)xml(?:;|$)|octet-stream(?:;|$)/u;
/** Frame streams are `+json`, but a gzip stream buffers, which would stop them streaming. */
const FRAME_STREAM = /^application\/vnd\.substrate\.frames\+/u;

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
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
/** Streams one HTTP/2 connection may have open at once. Node's default is unbounded. */
const H2_MAX_CONCURRENT_STREAMS = 128;

type ErrorHook = (err: Error, req?: SubstrateRequest) => void;

const HANDLED_ERRORS = new WeakSet<Error>();

export class FastifySubstrateServer implements SubstrateServer {
  private readonly fastify: FastifyInstance;
  private readonly hasTls: boolean;
  private errorHook: ErrorHook | undefined;
  #observer: RequestObserver | undefined;
  #inFlightObserver: ((op: RuntimeOp, delta: 1 | -1) => void) | undefined;
  private readonly inFlight = new Set<AbortController>();
  // Route-level graceful-shutdown listeners (`onShutdown`): a stream route
  // registers once at compose time and owns whatever responses are open when
  // the notice fires.
  readonly #shutdownHooks = new Set<(reason: string) => void>();
  // Open connections, so `stop()` can destroy any still open at `grace`. Not
  // sessions: a refused HTTP/1.1 socket never becomes one, and Node holds it open.
  readonly #sockets = new Set<Socket>();
  // TLS sockets refused for not offering h2; `stop()` destroys them at once.
  readonly #refused = new Set<TLSSocket>();

  constructor(options: FastifySubstrateServerOptions = {}) {
    const {
      logger = false,
      bodyLimit,
      tls,
      cors,
      compression = true,
      requestTimeout = DEFAULT_REQUEST_TIMEOUT_MS
    } = options;
    this.hasTls = tls !== undefined;

    const common = {
      logger,
      requestTimeout,
      ...(bodyLimit !== undefined ? { bodyLimit } : {})
    };
    // HTTP/2 only: over TLS by ALPN, otherwise cleartext with prior knowledge
    // (h2c). An HTTP/1.1 client is refused at the connection.
    const settings = { maxConcurrentStreams: H2_MAX_CONCURRENT_STREAMS };
    this.fastify = Fastify({
      ...common,
      http2: true,
      ...(tls
        ? {
            https: {
              allowHTTP1: false,
              cert: tls.cert,
              key: tls.key,
              ...(tls.ca !== undefined ? { ca: tls.ca } : {}),
              settings
            }
          }
        : { http: { settings } })
    }) as unknown as FastifyInstance;
    if (requestTimeout > 0) boundH2Requests(this.fastify, requestTimeout);
    this.fastify.server.on('connection', (socket: Socket) => {
      this.#sockets.add(socket);
      socket.once('close', () => this.#sockets.delete(socket));
    });
    // Node answers a TLS client that offered no h2 with a 403, then holds the
    // socket for `unknownProtocolTimeout` (10 s), which would stall `stop()`.
    this.fastify.server.on('secureConnection', (socket: TLSSocket) => {
      if (socket.alpnProtocol === 'h2') return;
      this.#refused.add(socket);
      socket.once('close', () => this.#refused.delete(socket));
    });

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
      void this.fastify.register(compressPlugin, {
        threshold: 1024,
        customTypes: (type: string) => COMPRESSIBLE.test(type) && !FRAME_STREAM.test(type)
      });
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
    // Routes holding a response open (streams) flush a terminal `end { reason }`
    // frame and end it. This runs BEFORE `abortAllRequests` deliberately: such a response IS an in-flight
    // request, and aborting it first would tear the session down as a client
    // disconnect — no terminal frame, and the teardown attributed to
    // `client_disconnect` rather than `shutdown`.
    this.#notifyShutdown(WS_REASON_SERVER_RESTART);
    if (opts?.abortInFlight === true) {
      this.abortAllRequests('server_shutdown');
    }
    // `fastify.close()` sends every session a GOAWAY: no new streams, and the
    // open ones finish. At `grace`, any connection still open is destroyed.
    for (const socket of this.#refused) socket.destroy();
    const closed = this.fastify.close();
    const grace = opts?.grace;
    if (grace !== undefined) {
      let timer: NodeJS.Timeout | undefined;
      const late = await Promise.race([
        closed.then(
          () => false,
          () => false
        ),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(true), grace);
          timer.unref();
        })
      ]);
      clearTimeout(timer);
      if (late) for (const socket of this.#sockets) socket.destroy();
    }
    await closed;
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
   * Wrap an HTTP-method route in a child plugin so it lands in the plugin
   * queue *after* compress / cors have finished loading.
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
      registerRoute(scope, method, path, handler, inFlight);
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
      >)
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

function registerRoute(
  fastify: FastifyInstance,
  method: HttpMethod,
  path: string,
  handler: HttpHandler,
  inFlight: Set<AbortController>
): void {
  fastify.route({
    method,
    url: path,
    handler: async (req: FastifyRequest, reply: FastifyReply) => {
      const controller = new AbortController();
      inFlight.add(controller);
      // Detect client disconnects via the RESPONSE: a `reply.raw` 'close'
      // before the response was ended is a disconnect. Not `writableFinished`:
      // an HTTP/2 response reports it true once a reset destroys the stream.
      const onResponseClose = (): void => {
        if (!reply.raw.writableEnded && !controller.signal.aborted) {
          controller.abort('client_disconnect');
        }
      };
      reply.raw.once('close', onResponseClose);
      try {
        const hReq = toSubstrateRequest(req, controller.signal);
        const hRes = await handler(hReq);
        await applySubstrateResponse(reply, hRes);
      } finally {
        reply.raw.off('close', onResponseClose);
        inFlight.delete(controller);
      }
    }
  });
}

/**
 * HTTP/2 has no `requestTimeout`: give each h2 request `ms` to arrive in full
 * (headers and body), then reset its stream. The clock stops once the handler
 * runs, so a streamed response is not bounded by it.
 */
function boundH2Requests(fastify: FastifyInstance, ms: number): void {
  const timers = new WeakMap<object, NodeJS.Timeout>();
  fastify.addHook('onRequest', async (req) => {
    const stream = (req.raw as { stream?: ServerHttp2Stream }).stream;
    if (stream === undefined) return;
    const timer = setTimeout(() => stream.close(h2constants.NGHTTP2_CANCEL), ms);
    timers.set(req.raw, timer);
    stream.once('close', () => clearTimeout(timer));
  });
  fastify.addHook('preHandler', async (req, reply) => {
    clearTimeout(timers.get(req.raw));
    // A reset stream ends its body early; the cut-off request must not reach the handler.
    const stream = (req.raw as { stream?: ServerHttp2Stream }).stream;
    if (stream?.closed === true) return reply.code(408).send();
  });
}

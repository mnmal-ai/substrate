/**
 * Transport abstraction. Spec: §4.8.
 *
 * `SubstrateServer` parallels `Dataset` for the transport layer. The engine
 * is server-blind — resolver dispatch, policy, edges, sweep never see a
 * framework type. Reference impls: Fastify, H3, NodeHttp, Bun, Memory.
 *
 * `PluginRouter` is a scoped view handed to coordinator plugins via
 * `server.createPluginRouter({ name })`. The router inherits the server's
 * framework while presenting a stable shape to plugins.
 *
 * Transport symmetry (§4.8): a WS upgrade is an HTTP GET with
 * `Connection: Upgrade`, so upgrade-time metadata (path, headers, query,
 * params, identity) is carried on `SubstrateRequest`. `WsConnection` is
 * reduced to the live-socket primitive — `id` plus send/onMessage/onClose/
 * close. Upgrade concerns live on `req`, live-connection ops on `conn`.
 */

import type { Identity } from './policy.js';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'HEAD' | 'OPTIONS';

export interface SubstrateRequest {
  method: HttpMethod;
  path: string;
  headers: Record<string, string>;
  query: Record<string, string>;
  params: Record<string, string>;
  body: Buffer | null;
  identity?: Identity;
  /**
   * Remote peer IP observed at the transport layer. Populated by adapters
   * (Fastify: `request.ip`; memory: caller supplies via `inject({ peerIp })`).
   * Absent when transport doesn't expose it. Consumers that gate on peer IP
   * (e.g. `x-forwarded-for` trust) treat `undefined` as "untrusted peer".
   */
  peerIp?: string;
  /**
   * Client IP after the trusted-proxy check, stamped by the host before plugin
   * and kernel route handlers run. Never read from the client.
   */
  clientIp?: string;
  /** Whether the deployment verifies credentials, stamped with `clientIp`. */
  authEnabled?: boolean;
  /**
   * Per-request abort signal. Production transports (Fastify) wire it to fire
   * on socket close (client disconnect) and on `abortAllRequests()` during
   * graceful shutdown. Route handlers thread it into `engine.query/mutate`
   * via `signal:` so resolvers can cooperatively bail. Optional because
   * test fixtures and embedded `inject()` callers may not need cancellation.
   */
  signal?: AbortSignal;
}

export interface SubstrateResponse {
  status: number;
  headers?: Record<string, string>;
  body?: Buffer | Uint8Array | string | ReadableStream;
}

export type HttpHandler = (req: SubstrateRequest) => SubstrateResponse | Promise<SubstrateResponse>;

/** Request op classes counted by the runtime-metrics surface (§ engine-metrics spec). */
export type RuntimeOp = 'query' | 'mutate';

/** One observed HTTP request at the transport seam. */
export interface RequestObservation {
  readonly op: RuntimeOp;
  /** Transport-level success — HTTP status < 400. Frame-level envelope errors still count ok. */
  readonly ok: boolean;
  /** Wall-clock elapsed from handler entry to response, measured via Date.now(). Always >= 0. */
  readonly durationMs: number;
}

export type RequestObserver = (o: RequestObservation) => void;

export interface WsConnection {
  readonly id: string;
  send(frame: Buffer | Uint8Array | string): void;
  /**
   * Transport-level back-pressure seam. Resolves once the
   * socket's write buffer is below its high-water mark — immediately when it
   * already is. The stream route awaits this between chunks so a fast producer
   * paces to a slow consumer instead of growing the send buffer unbounded.
   * Optional: transports without buffer introspection (memory tests) omit it,
   * and the route treats a missing hook as "always drained".
   */
  drain?(): Promise<void>;
  onMessage(cb: (frame: Buffer) => void): void;
  onClose(cb: (code?: number) => void): void;
  close(code?: number, reason?: string): void;
  /**
   * Register a callback invoked synchronously during graceful server shutdown,
   * BEFORE the underlying socket is closed. Higher layers use this to flush
   * structured frames (e.g. `{ kind: 'end', reason: 'server_restart' }` per
   * active subscription) so clients can short-circuit reconnect backoff
   * instead of seeing an abrupt 1006 drop. Optional — transports without a
   * pre-close hook (memory tests) may omit it; the route layer should
   * tolerate undefined.
   */
  onShutdown?(cb: (reason: string) => void): void;
}

export type WsHandler = (req: SubstrateRequest, conn: WsConnection) => void | Promise<void>;

export interface TlsConfig {
  cert: string | Buffer;
  key: string | Buffer;
  ca?: string | Buffer;
}

export interface StartOpts {
  host?: string;
  port?: number;
  tls?: TlsConfig;
}

export interface PluginRouter {
  get(path: string, handler: HttpHandler): void;
  post(path: string, handler: HttpHandler): void;
  put(path: string, handler: HttpHandler): void;
  delete(path: string, handler: HttpHandler): void;
  patch(path: string, handler: HttpHandler): void;
  websocket(path: string, handler: WsHandler): void;
}

export interface SubstrateServer {
  start(opts?: StartOpts): Promise<{ address: string; port: number }>;
  stop(opts?: { grace?: number; abortInFlight?: boolean }): Promise<void>;
  route(method: HttpMethod, path: string, handler: HttpHandler): void;
  websocket(path: string, handler: WsHandler): void;
  onError?(hook: (err: Error, req?: SubstrateRequest) => void): void;
  createPluginRouter(plugin: { name: string }): PluginRouter;
  /**
   * Abort every in-flight HTTP request's `req.signal` so resolvers cooperatively
   * bail. Used during graceful shutdown to give the engine a chance to roll
   * back mutations before fastify's drain timeout fires. WS connections are
   * not affected by this call; their teardown rides on socket close.
   */
  abortAllRequests(reason?: string): void;
  /**
   * Register a callback invoked synchronously at the START of `stop()` —
   * before in-flight requests are aborted and before the transport drains.
   *
   * The HTTP analogue of `WsConnection.onShutdown`, for routes that hold
   * a response open indefinitely (SSE): handlers flush a terminal frame and end
   * their response, or the drain would wait forever.
   *
   * Additive, not last-one-wins (unlike `onError`): a dropped registration is
   * a leaked stream. Optional — transports with no graceful phase may omit it,
   * and callers must tolerate undefined.
   */
  onShutdown?(cb: (reason: string) => void): void;
  /**
   * Test-only: invoke the server's handler pipeline without opening a socket.
   * Networked implementations may leave this undefined.
   */
  inject?(req: Partial<SubstrateRequest>): Promise<SubstrateResponse>;
  /**
   * Register a per-request observer for op throughput + latency. Optional —
   * transports without instrumentation may omit it. At most one observer; a
   * second call replaces the first. The transport invokes it only for the
   * `/substrate/v1/query` and `/substrate/v1/mutate` routes.
   */
  observeRequests?(observer: RequestObserver): void;
  /** Optional: told when a query/mutate HTTP request starts (+1) and ends (-1), including when it throws. */
  observeInFlight?(fn: (op: RuntimeOp, delta: 1 | -1) => void): void;
}

/**
 * In-process `SubstrateServer` used by integration tests and embedded hosts.
 *
 * Design calls:
 *   - `inject()` works before `start()`. Test code should not need lifecycle
 *     ceremony to exercise handlers. `start()`/`stop()` are still honored so
 *     the full `SubstrateServer` contract (including second-start-throws and
 *     grace-shutdown) is observable.
 *   - `createPluginRouter({ name })` mounts every plugin route under
 *     `/substrate/v1/plugins/<name>` so plugin routes can never shadow `/substrate/v1/*` and two
 *     plugins declaring the same path (e.g. `/ping`) stay isolated. The
 *     prefix is applied in the router facade, not inside `route()` itself,
 *     so the core server keeps a flat routing table.
 *   - Route resolution is first-match-wins in registration order. This is the
 *     simplest observable behaviour and matches how tests typically author
 *     fixtures — more specific routes register first.
 *   - The error hook is last-one-wins. Networked impls differ (Fastify
 *     overwrites its own setErrorHandler, and our impl mirrors that).
 *   - WS handler throws and rejections are surfaced through `onError` because
 *     there's no transport to close; an unknown WS path throws synchronously
 *     from `connectWebsocket` so misuse is loud.
 */

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
  WsHandler
} from '@mnmal-ai/substrate-types';
import { WS_REASON_SERVER_RESTART } from '@mnmal-ai/substrate-types';
import { createMemoryWsPair, type MemoryWsClient } from './memory-ws-connection.js';
import { matchRoute } from './route-matcher.js';

type ErrorHook = (err: Error, req?: SubstrateRequest) => void;

export class UnknownWsPathError extends Error {
  constructor(path: string) {
    super(`No websocket route registered for path: ${path}`);
    this.name = 'UnknownWsPathError';
  }
}

/**
 * @internal — thrown when `MemorySubstrateServer.start()` is called twice.
 * Re-exported from the package index; treat as package-private.
 */
export class AlreadyStartedError extends Error {
  constructor() {
    super('MemorySubstrateServer is already started');
    this.name = 'AlreadyStartedError';
  }
}

interface RouteEntry {
  readonly method: HttpMethod;
  readonly pattern: string;
  readonly handler: HttpHandler;
}

interface WsRouteEntry {
  readonly pattern: string;
  readonly handler: WsHandler;
}

// Inline (not imported from `@mnmal-ai/substrate-compose`) because substrate-compose
// pulls substrate-server-memory in as a devDep for its test fixtures — turbo's
// build pipeline rejects the resulting cycle. Frozen at module level to skip
// per-request allocation.
const JSON_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'content-type': 'application/json'
});

function jsonBody(obj: unknown): Buffer {
  return Buffer.from(JSON.stringify(obj), 'utf8');
}

// Resolved per request at dispatch time because inject() matches the route
// table dynamically. Only query/mutate are observed.
function opForRoute(method: string, pathname: string): RuntimeOp | null {
  if (method !== 'POST') return null;
  if (pathname === '/substrate/v1/query') return 'query';
  if (pathname === '/substrate/v1/mutate') return 'mutate';
  return null;
}

function buildPluginPrefix(name: string): string {
  return `/substrate/v1/plugins/${name}`;
}

function normaliseSubpath(path: string): string {
  if (path.length === 0) return '/';
  return path.startsWith('/') ? path : `/${path}`;
}

function parseQuery(path: string): { pathname: string; query: Record<string, string> } {
  const q = path.indexOf('?');
  if (q === -1) return { pathname: path, query: {} };
  const pathname = path.slice(0, q);
  const qs = new URLSearchParams(path.slice(q + 1));
  const query: Record<string, string> = {};
  for (const [k, v] of qs.entries()) query[k] = v;
  return { pathname, query };
}

export class MemorySubstrateServer implements SubstrateServer {
  readonly #routes: RouteEntry[] = [];
  readonly #wsRoutes: WsRouteEntry[] = [];
  readonly #inFlight = new Set<AbortController>();
  readonly #shutdownHooks = new Set<(reason: string) => void>();
  #errorHook: ErrorHook | undefined;
  #observer: RequestObserver | undefined;
  #inFlightObserver: ((op: RuntimeOp, delta: 1 | -1) => void) | undefined;
  #started = false;
  #pending = 0;

  route(method: HttpMethod, path: string, handler: HttpHandler): void {
    this.#routes.push({ method, pattern: path, handler });
  }

  websocket(path: string, handler: WsHandler): void {
    this.#wsRoutes.push({ pattern: path, handler });
  }

  onError(hook: ErrorHook): void {
    this.#errorHook = hook;
  }

  observeRequests(observer: RequestObserver): void {
    this.#observer = observer;
  }

  observeInFlight(fn: (op: RuntimeOp, delta: 1 | -1) => void): void {
    this.#inFlightObserver = fn;
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

  async start(_opts?: StartOpts): Promise<{ address: string; port: number }> {
    if (this.#started) throw new AlreadyStartedError();
    this.#started = true;
    return { address: 'memory://', port: 0 };
  }

  async stop(opts?: { grace?: number; abortInFlight?: boolean }): Promise<void> {
    // Before the abort, for the same reason the Fastify impl documents: a
    // route holding a response open is an in-flight request, and aborting it
    // first turns a graceful shutdown into a client disconnect.
    this.#notifyShutdown(WS_REASON_SERVER_RESTART);
    if (opts?.abortInFlight === true) {
      this.abortAllRequests('server_shutdown');
    }
    const grace = opts?.grace;
    if (grace !== undefined && this.#pending > 0) {
      // Await in-flight injects up to `grace` ms. With `abortInFlight: true`
      // the signal fires above and a cooperating handler will resolve quickly;
      // otherwise this is a passive wait and we stop watching at the deadline.
      await new Promise<void>((resolve) => {
        const deadline = setTimeout(resolve, grace);
        deadline.unref?.();
        const tick = (): void => {
          if (this.#pending === 0) {
            clearTimeout(deadline);
            resolve();
            return;
          }
          const t = setTimeout(tick, 1);
          t.unref?.();
        };
        tick();
      });
    }
    this.#started = false;
  }

  abortAllRequests(reason?: string): void {
    const controllers = [...this.#inFlight];
    for (const controller of controllers) {
      if (!controller.signal.aborted) controller.abort(reason ?? 'aborted');
    }
  }

  onShutdown(cb: (reason: string) => void): void {
    this.#shutdownHooks.add(cb);
  }

  #notifyShutdown(reason: string): void {
    for (const hook of [...this.#shutdownHooks]) {
      try {
        hook(reason);
      } catch {
        // One route's teardown must not block another's.
      }
    }
  }

  createPluginRouter(plugin: { name: string }): PluginRouter {
    const prefix = buildPluginPrefix(plugin.name);
    const prefixed = (path: string): string => `${prefix}${normaliseSubpath(path)}`;
    return {
      get: (path, handler) => this.route('GET', prefixed(path), handler),
      post: (path, handler) => this.route('POST', prefixed(path), handler),
      put: (path, handler) => this.route('PUT', prefixed(path), handler),
      delete: (path, handler) => this.route('DELETE', prefixed(path), handler),
      patch: (path, handler) => this.route('PATCH', prefixed(path), handler),
      websocket: (path, handler) => this.websocket(prefixed(path), handler)
    };
  }

  async inject(req: Partial<SubstrateRequest>): Promise<SubstrateResponse> {
    this.#pending++;
    // When the caller supplies their own signal, we route it through unchanged
    // — they own the lifecycle. Otherwise mint a controller per inject so
    // `abortAllRequests()` has something to fire at.
    const ownedController = req.signal === undefined ? new AbortController() : null;
    if (ownedController !== null) this.#inFlight.add(ownedController);
    const signal = req.signal ?? ownedController?.signal;
    try {
      const method = req.method ?? 'GET';
      const rawPath = req.path ?? '/';
      const parsed = parseQuery(rawPath);
      const query = req.query ?? parsed.query;
      const headers = req.headers ?? {};
      const body = req.body ?? null;

      let matched: RouteEntry | undefined;
      let params: Record<string, string> = {};
      for (const entry of this.#routes) {
        if (entry.method !== method) continue;
        const m = matchRoute(entry.pattern, parsed.pathname);
        if (m !== null) {
          matched = entry;
          params = { ...m, ...(req.params ?? {}) };
          break;
        }
      }

      if (!matched) {
        return {
          status: 404,
          headers: JSON_HEADERS,
          body: jsonBody({ error: 'not found' })
        };
      }

      const substrateReq: SubstrateRequest = {
        method,
        path: parsed.pathname,
        headers,
        query,
        params,
        body,
        ...(req.identity !== undefined ? { identity: req.identity } : {}),
        ...(req.peerIp !== undefined ? { peerIp: req.peerIp } : {}),
        ...(signal !== undefined ? { signal } : {})
      };

      try {
        const op = opForRoute(method, parsed.pathname);
        if (op === null) {
          return await matched.handler(substrateReq);
        }
        // Scope: only completed responses are observed. A handler that throws
        // falls through to the outer catch (→ 500) and is NOT counted — route
        // handlers return error envelopes rather than throwing, so this is rare.
        const inflight = this.#inFlightObserver;
        this.#notifyInFlight(inflight, op, 1);
        try {
          const startedAt = Date.now();
          const res = await matched.handler(substrateReq);
          const obs = this.#observer;
          if (obs !== undefined) {
            try {
              obs({ op, ok: res.status < 400, durationMs: Date.now() - startedAt });
            } catch {
              // A buggy observer must never break request handling (mirrors the
              // onFrame-throw guard in engine-subscribe.ts).
            }
          }
          return res;
        } finally {
          this.#notifyInFlight(inflight, op, -1);
        }
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        if (this.#errorHook) {
          try {
            this.#errorHook(error, substrateReq);
          } catch {
            // Swallow error-hook faults: they must not mask the originating error.
          }
        }
        return {
          status: 500,
          headers: JSON_HEADERS,
          // The same envelope FastifySubstrateServer sends, and as generic: the
          // message can carry table names and row values, so it stays server-side.
          body: jsonBody({
            schemaVersion: '',
            data: {},
            shapes: {},
            errors: [{ message: 'internal server error', code: 'internal_error' }]
          })
        };
      }
    } finally {
      this.#pending--;
      if (ownedController !== null) this.#inFlight.delete(ownedController);
    }
  }

  #reportWsError(err: unknown): void {
    const error = err instanceof Error ? err : new Error(String(err));
    if (!this.#errorHook) return;
    try {
      this.#errorHook(error);
    } catch {
      // Hook faults must not mask the originating error.
    }
  }

  connectWebsocket(path: string, headers: Record<string, string> = {}): MemoryWsClient {
    const parsed = parseQuery(path);
    let matched: WsRouteEntry | undefined;
    let params: Record<string, string> = {};
    for (const entry of this.#wsRoutes) {
      const m = matchRoute(entry.pattern, parsed.pathname);
      if (m !== null) {
        matched = entry;
        params = m;
        break;
      }
    }
    if (!matched) throw new UnknownWsPathError(parsed.pathname);

    // Per §4.8 transport symmetry, upgrade metadata travels on SubstrateRequest.
    // params come straight from the router match; query is the parsed
    // querystring; body is null (WS upgrades carry none).
    const substrateReq: SubstrateRequest = {
      method: 'GET',
      path: parsed.pathname,
      headers,
      query: parsed.query,
      params,
      body: null
    };

    const { server, client } = createMemoryWsPair();
    // Dispatch the handler on a microtask. This mirrors real WS behaviour where
    // the server-side `onopen` fires after the caller has had a chance to
    // register listeners. If we invoked synchronously, a handler that sends
    // before yielding would drop the frame (no listener registered yet).
    queueMicrotask(() => {
      try {
        const result = matched.handler(substrateReq, server);
        if (result && typeof (result as Promise<void>).then === 'function') {
          (result as Promise<void>).catch((err: unknown) => {
            this.#reportWsError(err);
          });
        }
      } catch (err) {
        this.#reportWsError(err);
      }
    });
    return client;
  }
}

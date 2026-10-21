/**
 * SSE transport adapter + the routes that mount it. Spec §2.3, §5.
 *
 * Routes: `GET|POST /substrate/v1/stream`, `GET|POST /substrate/v1/subscribe`, and
 * `POST /substrate/v1/stream/ticket`. Failures BEFORE the stream opens are ordinary
 * HTTP status codes; once bytes are on the wire the status is spent and errors
 * travel in-band as `event: error`.
 *
 * One HTTP response carries exactly ONE session, so — unlike the WS route —
 * there is no session map here and cancellation IS disconnection.
 *
 * Back-pressure: the returned `ReadableStream` is demand-driven. `emit` awaits
 * the consumer's demand before resolving, and because the engine awaits
 * `onFrame` per chunk (§5.5), that pause propagates all the way back to the
 * producer. Only DATA-BEARING frames pace to demand — see the comment in
 * `emit` for why terminal frames must not.
 */

import type { Engine, MetricFn } from '@mnmal-ai/substrate-core';
import type {
  FieldInput,
  HttpHandler,
  Identity,
  SubstrateRequest,
  SubstrateResponse,
  SubstrateServer
} from '@mnmal-ai/substrate-types';
import { type AuthConfig, credentialLapse, watchCredential } from '../auth.js';
import type { ConnectionLimiter } from './connection-limit.js';
import { extractClientIp, jsonResponse } from './helpers.js';
import { SSE_HEADERS, SSE_HEARTBEAT, sseEvent, sseRetry } from './sse-frame.js';
import {
  type CloseReason,
  erroredKey,
  type SessionFrame,
  StreamSession,
  type StreamTransport
} from './stream-session.js';
import { hashFrame, mintStreamTicket, TICKET_TTL_MS, verifyStreamTicket } from './stream-ticket.js';

export interface SseTransportOptions {
  /** Idle keepalive period. Proxies reap silent connections. */
  heartbeatMs?: number;
  /** Client reconnect backoff advertised on open. */
  retryMs?: number;
  /** Fired when the CONSUMER tears down — i.e. the client disconnected. */
  onCancel?: () => void;
}

const DEFAULT_HEARTBEAT_MS = 20_000;
const DEFAULT_RETRY_MS = 5_000;

export function createSseTransport(opts: SseTransportOptions): {
  transport: StreamTransport;
  body: ReadableStream<Uint8Array>;
  /**
   * Write a frame the ROUTE owns rather than the session — today only the
   * graceful-shutdown `end`. Synchronous, and deliberately NOT part of
   * `StreamTransport`: that contract is the session's, and its async `emit`
   * exists to pace the producer to consumer demand. A shutdown frame is the
   * last write before the response closes, so parking it on demand could
   * strand it behind a consumer that has already stopped reading.
   */
  writeFrame: (frame: SessionFrame) => void;
} {
  const encoder = new TextEncoder();
  const heartbeatMs = opts.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;

  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let closed = false;
  /**
   * Resolvers of parked `emit` calls. Must be a Set, not a single slot: a
   * multi-key subscribe drains each key on its own task sharing one `onFrame`,
   * so two `emit`s can be in flight at once, and a single slot would strand
   * the first one's drain task.
   */
  const demand = new Set<() => void>();

  const stopHeartbeat = (): void => {
    if (heartbeat !== null) {
      clearInterval(heartbeat);
      heartbeat = null;
    }
  };

  /** Wake every parked `emit`, not just one — see the `demand` docblock. */
  const releaseDemand = (): void => {
    for (const resolve of demand) resolve();
    demand.clear();
  };

  /**
   * Shared by every teardown path (write failure, close, consumer cancel) so
   * none of them can leave the heartbeat ticking or an `emit` parked forever;
   * a parked `emit` strands the engine's producer loop.
   */
  const teardown = (): void => {
    closed = true;
    stopHeartbeat();
    releaseDemand();
  };

  const write = (text: string): void => {
    if (closed || controller === null) return;
    try {
      controller.enqueue(encoder.encode(text));
    } catch {
      // The consumer tore down between our `closed` check and the enqueue.
      // Every path that sets `closed` must run the FULL teardown: `close()`
      // short-circuits on the `closed` guard, so a bare flag flip here is the
      // last chance to stop the heartbeat and release parked `emit`s.
      teardown();
      controller = null;
    }
  };

  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
      write(sseRetry(opts.retryMs ?? DEFAULT_RETRY_MS));
      heartbeat = setInterval(() => write(SSE_HEARTBEAT), heartbeatMs);
      // Node keeps the process alive for interval timers; a keepalive must not.
      heartbeat.unref?.();
    },
    pull() {
      // New demand exists — every parked `emit` gets a chance to re-check and
      // proceed, not just the most recently parked one.
      releaseDemand();
    },
    cancel() {
      // Client disconnected. Release any parked `emit` (it would otherwise
      // park forever — nothing will ever call `pull` again) and notify the
      // route so it can cancel the underlying session.
      teardown();
      controller = null;
      opts.onCancel?.();
    }
  });

  const transport: StreamTransport = {
    emit: async (frame: SessionFrame, fieldsByKey: ReadonlyMap<string, FieldInput>) => {
      if (closed) return;
      write(sseEvent(frame, fieldsByKey));
      // `end`/`error` are terminal: the session awaits this call and then
      // closes the transport. A terminal frame parked on demand would hold the
      // response open forever once the consumer stops reading, so only
      // data-bearing frames pace to consumer demand.
      if (frame.kind === 'end' || frame.kind === 'error') return;
      // Yield until the consumer asks for more. `desiredSize <= 0` means the
      // queue is full; waiting on the next `pull` (or a teardown, which also
      // releases `demand`) is the backpressure signal.
      if (controller !== null && (controller.desiredSize ?? 1) <= 0) {
        await new Promise<void>((resolve) => {
          demand.add(resolve);
        });
      }
    },
    close: (_reason: CloseReason) => {
      // `_reason` is intentionally unused: the terminal reason already ships
      // in the `end` frame's own payload.
      if (closed) return;
      teardown();
      try {
        controller?.close();
      } catch {
        // Already closed by the consumer — nothing to do.
      }
      controller = null;
    }
  };

  return {
    transport,
    body,
    writeFrame: (frame: SessionFrame) => write(sseEvent(frame, undefined))
  };
}

type FrameRecord = Record<string, { params?: Record<string, unknown>; fields?: FieldInput }>;

/** The capability a stream ticket must carry, and the one the mint route grants. */
const STREAM_CAPABILITY = 'read';

export type ParsedStreamRequest =
  | { ok: true; frame: FrameRecord; identity: Identity | null }
  | { ok: false; status: 400 | 401; code: string };

/**
 * Shape validation: an object whose every VALUE is a plain object. Inner
 * `params`/`fields` bags stay opaque — the engine validates those.
 *
 * The values must be checked here: `StreamSession` reads `entry.fields` off
 * each one, and a throw after the transport opens leaks its heartbeat timer.
 *
 * Unlike `validateFrame` in `helpers.ts`, array values (the §5.13
 * batched-mutate shape) are rejected: streams cannot carry them, so this
 * turns an in-band error into a pre-stream 400.
 */
function isFrameRecord(value: unknown): value is FrameRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  for (const entry of Object.values(value)) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return false;
  }
  return true;
}

function parseFrameJson(raw: string): FrameRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return isFrameRecord(parsed) ? parsed : null;
}

/**
 * Resolve the frame + identity for a stream request.
 *
 * GET is the EventSource path: the frame rides the query string and auth rides
 * a ticket, because EventSource can set neither a body nor headers. POST is the
 * node/MCP path: frame in the body, auth already applied upstream by `gate`.
 *
 * Both paths feed the SAME `JSON.parse`, so a frame's value types are identical
 * either way — a ticket minted from a POST body verifies against the same frame
 * arriving via GET. Never coerce query values to strings.
 */
export function parseStreamRequest(
  req: Pick<SubstrateRequest, 'method' | 'body' | 'query' | 'identity'>,
  secret: string,
  nowMs: number
): ParsedStreamRequest {
  const raw = req.method === 'POST' ? (req.body?.toString('utf8') ?? '') : (req.query.frame ?? '');
  const frame = parseFrameJson(raw);
  if (frame === null) return { ok: false, status: 400, code: 'invalid_frame' };

  if (req.method === 'POST') {
    return { ok: true, frame, identity: req.identity ?? null };
  }

  const ticket = req.query.ticket;
  if (ticket === undefined || ticket === '') {
    return { ok: false, status: 401, code: 'ticket_missing' };
  }
  const verdict = verifyStreamTicket(secret, ticket, frame, nowMs);
  if (!verdict.ok) return { ok: false, status: 401, code: verdict.code };
  // Enforce the capability the payload carries rather than trusting that the
  // mint route (which always grants `read`) is the only issuer.
  if (!verdict.payload.capabilities.includes(STREAM_CAPABILITY)) {
    return { ok: false, status: 401, code: 'ticket_missing_capability' };
  }
  return { ok: true, frame, identity: verdict.payload.identity };
}

/** Errors BEFORE the stream opens are ordinary HTTP; after, they're in-band. */
function errorResponse(status: number, code: string): SubstrateResponse {
  return jsonResponse(status, { errors: [{ message: code, code }] });
}

/**
 * Structural match for `compose.ts`'s `gate`. Declared here rather than
 * importing `Capability` from `compose.ts`, which imports this module —
 * that would be a cycle.
 */
export type RouteGate = (
  handler: HttpHandler,
  required: 'read' | 'mutate' | 'admin' | null
) => HttpHandler;

/** One open SSE response, as the graceful-shutdown walk needs to see it. */
interface LiveSseResponse {
  /** Flush the terminal `end { reason }` the client is owed. */
  end(reason: string): void;
  /** Tear the session down, attributing it to `shutdown`. */
  cancel(): void;
}

export function registerSseRoutes(
  server: SubstrateServer,
  engine: Engine,
  trustedProxies: Set<string>,
  secret: string,
  gate: RouteGate,
  /**
   * Server-side trace for failures the client is deliberately told nothing
   * about; the only record an operator gets that a session failed to start.
   */
  metric: MetricFn,
  /** When set, a stream ends once the credential that opened it lapses. */
  auth?: AuthConfig,
  /** Per-client cap shared with the WS route; absent → uncapped. */
  connections?: ConnectionLimiter,
  /** Per-client session cap shared with the WS route; absent → uncapped. */
  sessionCap?: ConnectionLimiter
): void {
  /**
   * Every SSE response currently held open, for the graceful-shutdown walk.
   * Lives at route scope (WS keeps one per socket) because an SSE response
   * has no connection object to hang a hook off. A subscribe never self-ends,
   * so without this `server.stop()` would wait on it forever.
   */
  const live = new Set<LiveSseResponse>();
  /**
   * Latched by the shutdown notice. A request already in flight but not yet
   * in `live` would never be told to end and would hang the drain, so no new
   * stream opens after the notice.
   */
  let shuttingDown = false;
  server.onShutdown?.((reason) => {
    shuttingDown = true;
    // Snapshot — `cancel` closes the transport, which deletes from `live`.
    for (const record of [...live]) {
      // Frame BEFORE cancel: cancelling closes the transport, and a closed
      // transport drops writes.
      record.end(reason);
      record.cancel();
    }
    live.clear();
  });

  const open =
    (mode: 'subscribe' | 'stream'): HttpHandler =>
    async (req: SubstrateRequest): Promise<SubstrateResponse> => {
      // Pre-stream, so an ordinary HTTP status is still available to say it.
      if (shuttingDown) return errorResponse(503, 'server_shutting_down');
      const parsed = parseStreamRequest(req, secret, Date.now());
      if (!parsed.ok) return errorResponse(parsed.status, parsed.code);
      // A ticket can outlive the token that minted it by up to its TTL.
      const lapsed = auth === undefined ? null : credentialLapse(parsed.identity, auth);
      if (lapsed !== null) return errorResponse(401, lapsed);

      const clientIp = extractClientIp(req, trustedProxies);
      // Auth off: key by IP, since the identity says nothing about the caller.
      const release =
        connections === undefined
          ? () => {}
          : connections.acquire(auth === undefined ? null : parsed.identity, clientIp);
      if (release === null) return errorResponse(429, 'too_many_connections');
      const releaseSlot =
        sessionCap === undefined
          ? () => {}
          : sessionCap.acquire(auth === undefined ? null : parsed.identity, clientIp);
      if (releaseSlot === null) {
        release();
        return errorResponse(429, 'too_many_sessions');
      }
      // Declared BEFORE the transport so `onCancel` can close over it. The
      // `?.` covers the window where the client disconnects before the session
      // exists; the later spurious-cancel window is covered by `cancel` being
      // idempotent (it early-returns once the session is terminated).
      let session: StreamSession | undefined;
      const sessionId = `sse-${mode}`;
      const { transport, body, writeFrame } = createSseTransport({
        onCancel: () => session?.cancel('client_disconnect')
      });

      /**
       * This response's entry in the shutdown registry. Closures over
       * `session` rather than a field holding it, so the record can be built
       * before the session exists and `close` can drop it by identity.
       */
      const record: LiveSseResponse = {
        end: (reason) => writeFrame({ id: sessionId, kind: 'end', reason, final: true }),
        cancel: () => session?.cancel('shutdown')
      };

      /**
       * A subscribe that fails at REGISTRATION emits a lone `error` per key and
       * no `end`, so the session would never close the transport. The engine
       * handle can't report this, so the route watches the frames: errors
       * before `start` resolves are registration errors, and `path[0]` names
       * the failed key.
       *
       * Only "EVERY key failed" is safe to act on: a multi-key subscribe keeps
       * a live handle for the keys that succeeded.
       */
      const keys = Object.keys(parsed.frame);
      const failedKeys = new Set<string>();
      let registering = true;
      let stopWatch = (): void => {};
      /** Set while `start` is in flight. */
      let starting: Promise<void> | undefined;
      const freeSlots = (): void => {
        release();
        releaseSlot();
      };
      const watched: StreamTransport = {
        emit: async (frame, fieldsByKey) => {
          if (registering) {
            const key = erroredKey(frame);
            if (key !== undefined) failedKeys.add(key);
          }
          await transport.emit(frame, fieldsByKey);
        },
        close: (reason) => {
          // Single choke point for every terminal path (client disconnect,
          // engine `end`, shutdown), so the registry can't outlive the
          // responses in it.
          live.delete(record);
          // An abort can land while the engine's snapshot read still runs; the
          // slots stay held until `start` settles so aborts can't outrun the caps.
          if (starting === undefined) freeSlots();
          else void starting.then(freeSlots, freeSlots);
          stopWatch();
          transport.close(reason);
        }
      };

      try {
        session = StreamSession.create(
          {
            id: sessionId,
            mode,
            frame: parsed.frame,
            identity: parsed.identity,
            headers: req.headers,
            ...(clientIp !== undefined ? { clientIp } : {})
          },
          watched
        );
      } catch (err) {
        // No session will ever close `watched`, so close it here: it holds both slots.
        watched.close('complete');
        metric('sse_stream_start_failed', {
          mode,
          keys: Object.keys(parsed.frame ?? {}),
          error: err instanceof Error ? err.message : String(err)
        });
        return errorResponse(500, 'stream_start_failed');
      }
      live.add(record);
      // A transport-level abort (socket closed) must tear the session down too.
      // Registered before `start` so an abort landing mid-registration is
      // honoured by `start`'s own cancel-while-registering check.
      req.signal?.addEventListener('abort', () => session?.cancel('client_disconnect'), {
        once: true
      });
      try {
        const started = session.start(engine).finally(() => {
          starting = undefined;
        });
        starting = started;
        await started;
      } catch (err) {
        // The transport is already live (heartbeat armed), so the throw must
        // not escape the handler: `cancel` closes the transport. The client is
        // told only `stream_start_failed`; substrate-compose has no logger, so the
        // metric sink is the operator's trace.
        metric('sse_stream_start_failed', {
          mode,
          keys: Object.keys(parsed.frame ?? {}),
          error: err instanceof Error ? err.message : String(err)
        });
        session.cancel('complete');
        return errorResponse(500, 'stream_start_failed');
      }
      registering = false;
      // A close that ran during `start` already called `stopWatch`, so arming
      // now would leave an interval nothing clears.
      if (!session.isTerminated)
        stopWatch = watchCredential(parsed.identity, auth, (lapse) => {
          writeFrame({ id: sessionId, kind: 'end', reason: lapse, final: true });
          session?.cancel('cancelled');
        });
      // `every` on an empty key set is true, which is the behaviour we want: an
      // empty frame registers nothing and would leak the same way. Streams are
      // exempt — `engine.stream` always emits a terminal `end`.
      if (mode === 'subscribe' && keys.every((k) => failedKeys.has(k))) {
        // Deliberately no synthesized `end` frame: WS ends this case the same
        // way, and the two transports must stay frame-for-frame identical.
        session.cancel('complete');
      }
      return { status: 200, headers: SSE_HEADERS, body };
    };

  for (const [path, mode] of [
    ['/substrate/v1/stream', 'stream'],
    ['/substrate/v1/subscribe', 'subscribe']
  ] as const) {
    // GET is deliberately UNGATED: `withAuth` rejects a tokenless request
    // before the handler runs, and EventSource cannot send `Authorization` —
    // gating it would make the ticket path (whose entire purpose is that
    // limitation) unreachable. The ticket, minted by the gated POST below and
    // verified in `parseStreamRequest`, is this route's authentication.
    server.route('GET', path, open(mode));
    server.route('POST', path, gate(open(mode), 'read'));
  }

  server.route(
    'POST',
    '/substrate/v1/stream/ticket',
    gate(async (req: SubstrateRequest): Promise<SubstrateResponse> => {
      const frame = parseFrameJson(req.body?.toString('utf8') ?? '');
      if (frame === null) return errorResponse(400, 'invalid_frame');
      const ticket = mintStreamTicket(
        secret,
        {
          identity: req.identity ?? null,
          capabilities: [STREAM_CAPABILITY],
          frameHash: hashFrame(frame)
        },
        Date.now()
      );
      return jsonResponse(200, { ticket, expiresIn: TICKET_TTL_MS / 1000 });
    }, 'read')
  );
}

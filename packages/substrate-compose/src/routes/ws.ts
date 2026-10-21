/**
 * GET /substrate/v1/ws — live subscription + streaming upgrade. Spec §5.4, §5.5, §8.5.
 *
 * Dispatches the unified frame grammar:
 *   - `subscribe` → engine.subscribe; snapshot + live pushes on `onFrame`.
 *   - `stream`    → engine.stream; chunk frames + terminal end/error.
 *   - `cancel`    → handle.cancel. The route emits `{ kind: 'end', final: true }`
 *     for a SUBSCRIBE only; a stream self-emits its terminal
 *     `end { _meta.cancelled }` through the engine's cancellation path, and a
 *     route-side `end` would duplicate it.
 *
 * Encoding negotiation: the client advertises `Sec-WebSocket-Protocol:
 * substrate-pack` at handshake. Connections that negotiate that subprotocol
 * receive msgpack binary frames with positional `data`; any other (or no)
 * subprotocol falls back to JSON. The engine stays transport-blind — it hands
 * `onFrame` callbacks named-object rows, and this layer serialises them per
 * connection.
 *
 * Session lifecycle is NOT owned here: each `subscribe` / `stream` op opens a
 * `StreamSession` (see `stream-session.ts`) and this route is its
 * `StreamTransport` — it serialises, writes, and applies back-pressure. What
 * stays route-local is everything genuinely socket-shaped: subprotocol
 * negotiation, the id→session map (one socket multiplexes many), and the
 * close/shutdown teardown.
 *
 * Fields-for-push encoding seam: the engine emits `WsResponseFrame` with
 * named-object `data` keyed by the qualified frame key. For substrate-pack
 * encoding, we need the original client-sent `FieldInput` to produce the
 * positional tuple — the session captures that selection map at dispatch time
 * and hands it back on every `emit`.
 *
 * Back-pressure: the route layer owns pause/resume, not the engine. §5.5's
 * `StreamInput.onFrame` is async precisely so this route can await a socket
 * drain between chunks. After each data frame we await `conn.drain()`; the
 * Fastify transport resolves it once the send buffer is below
 * its high-water mark, pacing a fast producer to a slow consumer. Transports
 * that don't expose a buffer (memory/test) omit `drain`, so back-pressure there
 * is a no-op and frames flow unthrottled.
 */

import type { Engine, MetricFn } from '@mnmal-ai/substrate-core';
import {
  decodeWsEnvelope,
  encodePositional,
  encodeWsFrame,
  isPlainRequestData,
  type WireMode,
  WS_SUBPROTOCOL_SUBSTRATE_PACK
} from '@mnmal-ai/substrate-pack';
import {
  type FieldInput,
  type Identity,
  parseQualifiedKey,
  type Schema,
  type SubstrateRequest,
  type SubstrateServer,
  type WsRequestFrame,
  type WsResponseFrame
} from '@mnmal-ai/substrate-types';
import { type AuthConfig, authenticateBearer, extractBearer, watchCredential } from '../auth.js';
import { type ConnectionLimiter, MAX_SESSIONS_PER_CLIENT } from './connection-limit.js';
import { extractClientIp } from './helpers.js';
import { projectWsFrame } from './project-json.js';
import {
  erroredKey,
  type SessionFrame,
  StreamSession,
  type StreamTransport
} from './stream-session.js';
import { describeIdentity } from './whoami.js';

/**
 * Detect the negotiated subprotocol from the upgrade request. @fastify/websocket
 * surfaces the accepted subprotocol in `sec-websocket-protocol`; the client's
 * offered list arrives in the request headers the same way. We treat "the
 * header mentions `substrate-pack`" as opt-in — the caller's responsibility is to
 * advertise it at handshake.
 */
function usesSubstratePack(req: SubstrateRequest): boolean {
  const raw = req.headers['sec-websocket-protocol'];
  if (raw === undefined) return false;
  for (const clause of raw.split(',')) {
    if (clause.trim() === WS_SUBPROTOCOL_SUBSTRATE_PACK) return true;
  }
  return false;
}

function parseRequestFrame(buf: Buffer, mode: WireMode): WsRequestFrame | null {
  try {
    const value = decodeWsEnvelope<unknown>(buf, mode);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
    if (!isPlainRequestData(value)) return null;
    const v = value as Record<string, unknown>;
    if (typeof v.id !== 'string') return null;
    if (v.op !== 'subscribe' && v.op !== 'stream' && v.op !== 'cancel' && v.op !== 'whoami') {
      return null;
    }
    return value as WsRequestFrame;
  } catch {
    return null;
  }
}

function serializeFrame(
  frame: WsResponseFrame,
  mode: WireMode,
  fieldsByKey: ReadonlyMap<string, FieldInput> | undefined,
  engine: Engine
): Buffer | string {
  if (mode === 'json') return JSON.stringify(projectWsFrame(frame, fieldsByKey));
  const encoded = encodeDataForPack(frame, fieldsByKey, engine);
  const wire = encodeWsFrame(encoded, mode);
  return typeof wire === 'string' ? wire : Buffer.from(wire);
}

/**
 * Produce a wire-ready frame object — for substrate-pack, positionally encode
 * `data` against the per-key FieldInput + the engine's federated schema. Remove
 * frames (no `data`) and error/end frames pass through untouched.
 */
function encodeDataForPack(
  frame: WsResponseFrame,
  fieldsByKey: ReadonlyMap<string, FieldInput> | undefined,
  engine: Engine
): WsResponseFrame {
  if (frame.data === undefined || fieldsByKey === undefined) return frame;
  const schemas = engine.federatedSchema();
  const encoded: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(frame.data as Record<string, unknown>)) {
    const parsed = parseQualifiedKey(key);
    if (parsed === null) {
      encoded[key] = value;
      continue;
    }
    const { ns, name } = parsed;
    const fields = fieldsByKey.get(key);
    const schema: Schema | undefined = schemas[ns];
    if (fields === undefined || schema === undefined) {
      encoded[key] = value;
      continue;
    }
    const rawShape = frame.shapes?.[key];
    // Subscriptions + streams never emit batched (array-of-shapes) values —
    // the batched mutate surface is §5.13 and is rejected on subscribe/stream
    // entry. Narrow to the single-frame shape so the encoder can dispatch
    // cleanly; the array arm is unreachable here by contract.
    const shape: 'single' | 'list' | undefined = Array.isArray(rawShape) ? undefined : rawShape;
    encoded[key] = encodeByShape(value, fields, schema, name, shape, {
      schemas,
      currentNs: ns
    });
  }
  return { ...frame, data: encoded };
}

function encodeByShape(
  value: unknown,
  fields: FieldInput,
  schema: Schema,
  typeName: string,
  shape: 'single' | 'list' | undefined,
  ctx: { schemas: Record<string, Schema>; currentNs: string }
): unknown {
  if (value === null || value === undefined) return null;
  if (shape === 'list') {
    if (!Array.isArray(value)) return value;
    return value.map((row) => encodePositional(row, fields, schema, typeName, ctx));
  }
  return encodePositional(value, fields, schema, typeName, ctx);
}

/**
 * Most logical sessions one socket may hold open. Each holds an engine
 * subscription, so an unbounded count is unbounded server work per socket.
 */
export const MAX_SESSIONS_PER_SOCKET = 1024;

export function registerWsRoute(
  server: SubstrateServer,
  engine: Engine,
  trustedProxies: Set<string>,
  metric: MetricFn,
  auth?: AuthConfig,
  /** Who an auth-off socket acts as — the same actor auth-off HTTP routes carry. */
  systemIdentity: Identity | null = null,
  /** Per-client cap shared with the SSE routes; absent → uncapped. */
  connections?: ConnectionLimiter,
  /** Per-client session cap shared with the SSE routes; absent → uncapped. */
  sessionCap?: ConnectionLimiter
): void {
  server.websocket('/substrate/v1/ws', async (req, conn) => {
    // Snapshot the post-trust clientIp at upgrade time — `req.peerIp` doesn't
    // change mid-connection, so one resolution serves every subscribe/stream
    // ctx we build below. Trust gating lives in `extractClientIp` exclusively;
    // the per-frame handlers just read the cached value.
    const wsClientIp = extractClientIp(req, trustedProxies);
    // Never `req.identity`: nothing on an upgrade request has authenticated it.
    let wsIdentity: Identity | undefined =
      auth === undefined ? (systemIdentity ?? undefined) : undefined;
    if (auth !== undefined) {
      const token = extractBearer(req.headers.authorization);
      // Mirror `withAuth`'s mode handling. Under `attribute` an ABSENT token
      // is allowed and the connection runs anonymously; a PRESENT-but-invalid
      // one still closes, in both modes.
      //
      // There is no WS mutate, so this admits only anonymous subscriptions,
      // which still meet the namespace's own read policy in `engine.subscribe`.
      const anonymousAllowed = auth.mode === 'attribute' && token === null;
      if (!anonymousAllowed) {
        const verdict = token === null ? null : authenticateBearer(token, auth);
        if (verdict === null || !verdict.ok) {
          // Same signal as the HTTP 401 body: the safe reason where there is
          // one, bare 'unauthorized' at the oracle boundary (unknown kid / bad
          // signature). Callers match on the code, not the reason string.
          const reason = verdict?.reason ?? null;
          const errorBody =
            reason === null
              ? { message: 'unauthorized', code: 'unauthorized' }
              : { message: `unauthorized: ${reason}`, code: 'unauthorized', reason };
          try {
            conn.send(
              JSON.stringify({
                id: '',
                kind: 'error',
                errors: [errorBody]
              })
            );
          } catch {
            // Transport may refuse the write if the socket already closed — fine.
          }
          conn.close(4001, reason === null ? 'unauthorized' : `unauthorized: ${reason}`);
          return;
        }
        wsIdentity = verdict.identity;
      }
    }
    // Auth off: every socket carries the system identity, so key by IP instead.
    const release =
      connections === undefined
        ? () => {}
        : connections.acquire(auth === undefined ? null : wsIdentity, wsClientIp);
    if (release === null) {
      try {
        conn.send(
          JSON.stringify({
            id: '',
            kind: 'error',
            errors: [{ message: 'too many connections', code: 'too_many_connections' }]
          })
        );
      } catch {
        // Transport may refuse the write if the socket already closed — fine.
      }
      conn.close(1013, 'too_many_connections');
      return;
    }
    const mode: WireMode = usesSubstratePack(req) ? 'pack' : 'json';

    /**
     * One socket carries many logical sessions, so multiplexing lives here
     * rather than in `StreamSession`. `isStream` rides alongside because the
     * cancel acknowledgement differs by mode (see the cancel handler) and the
     * session deliberately doesn't expose its own mode.
     */
    const sessions = new Map<string, { session: StreamSession; isStream: boolean }>();

    /** Raw send for frames that belong to no session (parse errors, cancel acks). */
    const sendBare = (frame: SessionFrame): void => {
      try {
        conn.send(serializeFrame(frame, mode, undefined, engine));
      } catch {
        // Socket already closed — our onClose handler will clean up. Swallow
        // the write error so a late-firing emission doesn't surface as an
        // unhandled exception.
      }
    };

    /** `owner` lets a late close from a replaced session leave its successor's entry alone. */
    const transportFor = (
      id: string,
      owner: () => StreamSession | undefined,
      releaseSlot: () => void,
      startOf: () => Promise<void> | undefined
    ): StreamTransport => ({
      emit: async (frame, fieldsByKey) => {
        const wire = serializeFrame(frame, mode, fieldsByKey, engine);
        try {
          conn.send(wire);
        } catch {
          // The socket is gone; parking on a drain that will never resolve
          // would strand the engine's producer loop, so bail instead.
          return;
        }
        // The engine awaits this per frame, so awaiting the transport's drain
        // here paces a fast producer to a slow consumer. Every data-bearing
        // frame paces, the same predicate SSE uses.
        //
        // A terminal must never park: the session awaits this call and then
        // closes the transport, so a consumer that stopped reading right after
        // a terminal would defer `close()` indefinitely.
        //
        // Transports without a `drain` hook (memory/test) are treated as
        // always-drained.
        if (frame.kind !== 'end' && frame.kind !== 'error' && conn.drain !== undefined) {
          await conn.drain();
        }
      },
      close: () => {
        // A cancel can land while the engine's snapshot read still runs; holding
        // the slot until `start` settles stops cancel-and-resubscribe outrunning the cap.
        const starting = startOf();
        if (starting === undefined) releaseSlot();
        else void starting.then(releaseSlot, releaseSlot);
        if (sessions.get(id)?.session === owner()) sessions.delete(id);
      }
    });

    /**
     * Register BEFORE dispatching to the engine: a `cancel` frame can arrive in
     * the same synchronous batch as the `subscribe`/`stream` that precedes it
     * (memory transports invoke message listeners inline), and a session that
     * isn't in the map yet is a session that cancel cannot find.
     */
    function openSession(request: WsRequestFrame, sessionMode: 'subscribe' | 'stream'): void {
      // A second session under a live id would drop the first out of the map,
      // where neither cancel nor socket close can reach it again.
      if (sessions.has(request.id)) {
        sendBare({
          id: request.id,
          kind: 'error',
          errors: [{ message: `session id '${request.id}' is already open`, code: 'duplicate_id' }]
        });
        return;
      }
      if (sessions.size >= MAX_SESSIONS_PER_SOCKET) {
        sendBare({
          id: request.id,
          kind: 'error',
          errors: [
            {
              message: `at most ${MAX_SESSIONS_PER_SOCKET} sessions per socket`,
              code: 'too_many_sessions'
            }
          ]
        });
        return;
      }
      const releaseSlot =
        sessionCap === undefined
          ? () => {}
          : sessionCap.acquire(auth === undefined ? null : wsIdentity, wsClientIp);
      if (releaseSlot === null) {
        sendBare({
          id: request.id,
          kind: 'error',
          errors: [
            {
              message: `at most ${MAX_SESSIONS_PER_CLIENT} sessions per client`,
              code: 'too_many_sessions'
            }
          ]
        });
        return;
      }
      // A subscribe that fails at registration emits a lone `error` per key and
      // no `end`, so the session would never close. Errors before `start`
      // resolves are registration errors; only "every key failed" ends it,
      // since a multi-key subscribe keeps the keys that succeeded live.
      const keys = Object.keys(request.frame ?? {});
      const failedKeys = new Set<string>();
      let registering = true;
      /** Set while `start` is in flight. */
      let starting: Promise<void> | undefined;
      const transport = transportFor(
        request.id,
        () => session,
        releaseSlot,
        () => starting
      );
      const session: StreamSession = StreamSession.create(
        {
          id: request.id,
          mode: sessionMode,
          frame: request.frame ?? {},
          identity: wsIdentity ?? null,
          headers: req.headers,
          ...(wsClientIp !== undefined ? { clientIp: wsClientIp } : {})
        },
        {
          emit: (frame, fieldsByKey) => {
            if (registering) {
              const key = erroredKey(frame);
              if (key !== undefined) failedKeys.add(key);
            }
            return transport.emit(frame, fieldsByKey);
          },
          close: transport.close
        }
      );
      sessions.set(request.id, { session, isStream: sessionMode === 'stream' });
      // An unhandled rejection would leave the session registered and the
      // client waiting forever. Tear it down and send a terminal pair instead;
      // the error itself stays server-side.
      const started = session.start(engine).finally(() => {
        starting = undefined;
      });
      starting = started;
      void started.then(
        () => {
          registering = false;
          // An empty frame registers nothing and is ended the same way.
          if (sessionMode === 'subscribe' && keys.every((k) => failedKeys.has(k))) {
            session.cancel('complete');
          }
        },
        (err: unknown) => {
          // As in SSE: the wire answer stays opaque, the operator gets the trace.
          metric('ws_stream_start_failed', {
            mode: sessionMode,
            keys: Object.keys(request.frame ?? {}),
            error: err instanceof Error ? err.message : String(err)
          });
          releaseSlot();
          if (sessions.get(request.id)?.session === session) sessions.delete(request.id);
          sendBare({
            id: request.id,
            kind: 'error',
            errors: [{ message: 'stream_start_failed', code: 'stream_start_failed' }]
          });
          sendBare({ id: request.id, kind: 'end', final: true });
        }
      );
    }

    conn.onMessage((buf) => {
      const request = parseRequestFrame(buf, mode);
      if (!request) {
        sendBare({
          id: '',
          kind: 'error',
          errors: [{ message: 'invalid frame', code: 'invalid_frame' }]
        });
        return;
      }
      // Answers from `wsIdentity`, the identity resolved at UPGRADE, so it
      // reports what this socket actually carries: anonymous (tokenless under
      // `attribute`) or authenticated. An invalid token closed at handshake.
      if (request.op === 'whoami') {
        // The SAME projection the HTTP route uses.
        const principal = wsIdentity === undefined ? null : describeIdentity(wsIdentity);
        sendBare({
          id: request.id,
          kind: 'whoami',
          data: {
            authEnabled: auth !== undefined,
            identity: auth === undefined ? null : principal
          }
        });
        return;
      }
      if (request.op === 'subscribe') {
        openSession(request, 'subscribe');
        return;
      }
      if (request.op === 'stream') {
        openSession(request, 'stream');
        return;
      }
      if (request.op === 'cancel') {
        const record = sessions.get(request.id);
        if (record === undefined) {
          // No matching session — still acknowledge so the client isn't left
          // waiting for a frame that will never arrive.
          sendBare({ id: request.id, kind: 'end', final: true });
          return;
        }
        record.session.cancel('cancelled');
        sessions.delete(request.id);
        // Streams emit their own terminal `end { _meta.cancelled }` frame via
        // the engine's cancellation path — the route would otherwise fire a
        // duplicate plain `end`. Subscriptions don't self-emit on cancel (the
        // bus just unhooks), so the route still owns that case.
        if (!record.isStream) sendBare({ id: request.id, kind: 'end', final: true });
      }
    });

    // The socket outlives the token it opened with: when that credential
    // expires or is revoked, end every session and close.
    const stopWatch = watchCredential(wsIdentity, auth, (lapse) => {
      for (const [id, record] of sessions) {
        sendBare({ id, kind: 'end', reason: lapse, final: true });
        record.session.cancel('cancelled');
      }
      sessions.clear();
      conn.close(4001, lapse);
    });

    conn.onClose(() => {
      release();
      stopWatch();
      for (const record of sessions.values()) record.session.cancel('client_disconnect');
      sessions.clear();
    });

    // Server-initiated graceful shutdown: emit a structured `end` frame per
    // active subscription/stream BEFORE the underlying socket closes, so
    // clients can short-circuit reconnect backoff and re-subscribe immediately
    // instead of treating the close as an abrupt 1006 transport failure.
    // Memory transport may not implement onShutdown; tolerate missing hook.
    conn.onShutdown?.((reason) => {
      for (const [id, record] of sessions) {
        sendBare({ id, kind: 'end', reason, final: true });
        record.session.cancel('shutdown');
      }
      sessions.clear();
    });
  });
}

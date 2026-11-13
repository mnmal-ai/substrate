/**
 * The stream routes: `POST /substrate/v1/stream` and `POST /substrate/v1/subscribe`.
 * The response body is a sequence of length-prefixed frames, JSON or pack as the
 * `Accept` header asks; any other `Accept` is refused `406 not_acceptable`.
 * Failures BEFORE the stream opens are ordinary HTTP status codes; once bytes are
 * on the wire the status is spent and errors travel in-band as `error` frames.
 *
 * One HTTP response carries exactly ONE session, so cancellation IS disconnection.
 *
 * Back-pressure: the returned `ReadableStream` is demand-driven. `emit` awaits
 * the consumer's demand before resolving, and because the engine awaits
 * `onFrame` per chunk (§5.5), that pause propagates all the way back to the
 * producer.
 */

import type { Engine, MetricFn } from '@mnmal-ai/substrate-core';
import {
  FRAMES_JSON_MIME,
  FRAMES_PACK_MIME,
  framesEncodingFromAccept
} from '@mnmal-ai/substrate-pack';
import type {
  FieldInput,
  HttpHandler,
  SubstrateRequest,
  SubstrateResponse,
  SubstrateServer
} from '@mnmal-ai/substrate-types';
import { type AuthConfig, credentialLapse, watchCredential } from '../auth.js';
import type { ConnectionLimiter } from './connection-limit.js';
import { createFramesTransport, framesHeaders } from './frames-transport.js';
import { extractClientIp, jsonResponse } from './helpers.js';
import { erroredKey, StreamSession, type StreamTransport } from './stream-session.js';

type FrameRecord = Record<string, { params?: Record<string, unknown>; fields?: FieldInput }>;

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

/** Errors BEFORE the stream opens are ordinary HTTP; after, they're in-band. */
function errorResponse(status: number, code: string, message = code): SubstrateResponse {
  return jsonResponse(status, { errors: [{ message, code }] });
}

const NOT_ACCEPTABLE = `streams answer ${FRAMES_JSON_MIME} or ${FRAMES_PACK_MIME}; send one in Accept`;

/**
 * Structural match for `compose.ts`'s `gate`. Declared here rather than
 * importing `Capability` from `compose.ts`, which imports this module —
 * that would be a cycle.
 */
export type RouteGate = (
  handler: HttpHandler,
  required: 'read' | 'mutate' | 'admin' | null
) => HttpHandler;

/** One open stream response, as the graceful-shutdown walk needs to see it. */
interface LiveStream {
  /** Flush the terminal `end { reason }` the client is owed. */
  end(reason: string): void;
  /** Tear the session down, attributing it to `shutdown`. */
  cancel(): void;
}

export function registerStreamRoutes(
  server: SubstrateServer,
  engine: Engine,
  trustedProxies: Set<string>,
  gate: RouteGate,
  /**
   * Server-side trace for failures the client is deliberately told nothing
   * about; the only record an operator gets that a session failed to start.
   */
  metric: MetricFn,
  /** When set, a stream ends once the credential that opened it lapses. */
  auth?: AuthConfig,
  /** Per-client connection cap; absent → uncapped. */
  connections?: ConnectionLimiter,
  /** Per-client session cap; absent → uncapped. */
  sessionCap?: ConnectionLimiter
): void {
  /**
   * Every stream response currently held open, for the graceful-shutdown walk.
   * A subscribe never self-ends, so without this `server.stop()` would wait on
   * it forever.
   */
  const live = new Set<LiveStream>();
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
      const frames = framesEncodingFromAccept(req.headers.accept);
      if (frames === undefined) return errorResponse(406, 'not_acceptable', NOT_ACCEPTABLE);
      const frame = parseFrameJson(req.body?.toString('utf8') ?? '');
      if (frame === null) return errorResponse(400, 'invalid_frame');
      const parsed = { frame, identity: req.identity ?? null };
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
      const sessionId = `frames-${mode}`;
      const { transport, body, writeFrame } = createFramesTransport({
        mode: frames,
        engine,
        onCancel: () => session?.cancel('client_disconnect'),
        onTooLarge: () => session?.cancel('cancelled')
      });

      /**
       * This response's entry in the shutdown registry. Closures over
       * `session` rather than a field holding it, so the record can be built
       * before the session exists and `close` can drop it by identity.
       */
      const record: LiveStream = {
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
        metric('stream_start_failed', {
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
        metric('stream_start_failed', {
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
        // Deliberately no synthesized `end` frame: the client reads the lone
        // `error` frames and the closed body.
        session.cancel('complete');
      }
      return {
        status: 200,
        headers: framesHeaders(frames),
        body
      };
    };

  server.route('POST', '/substrate/v1/stream', gate(open('stream'), 'read'));
  server.route('POST', '/substrate/v1/subscribe', gate(open('subscribe'), 'read'));
}

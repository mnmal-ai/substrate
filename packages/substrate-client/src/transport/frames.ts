/**
 * Subscribe and stream over length-prefixed frame streams: one POST per
 * subscription, its response body a sequence of frames (substrate-pack's
 * stream-frames codec). Each subscription owns its request, so cancelling one
 * aborts only that request.
 *
 * A subscription survives the following, re-subscribing for a fresh
 * snapshot: a dropped connection (after backoff), `end { server_restart }`
 * (at once), `subscription_overloaded` (after the overload delay, within its
 * budget) and a lapsed credential when `getToken` can mint a new one. A 401 or
 * 403 is terminal. A stream is never re-sent, since that would replay its chunks.
 */

import {
  DEFAULT_STREAM_IDLE_MS,
  decodeStreamFrames,
  decodeWsEnvelope,
  FRAMES_JSON_MIME,
  FRAMES_PACK_MIME,
  withIdleTimeout
} from '@mnmal-ai/substrate-pack';
import { AuthError, NetworkError, SubscribeError } from '../errors.js';
import { ReconnectScheduler, type ReconnectSchedulerOpts } from '../reconnect.js';
import {
  DEFAULT_OVERLOAD_RESUBSCRIBE,
  DEFAULT_RECONNECT,
  type FrameMessage,
  msgToEvent,
  type SubscribeEvent,
  type WsOverloadResubscribeOpts
} from './frame-event.js';
import type { HttpTransport, QualifiedFrame } from './http.js';

export type FrameStreamPath = '/substrate/v1/subscribe' | '/substrate/v1/stream';

export interface FrameStreamOpts {
  wire: 'json' | 'pack';
  reconnect?: Partial<ReconnectSchedulerOpts>;
  overload?: WsOverloadResubscribeOpts;
  /** True when a fresh token can be minted, so a lapsed credential re-subscribes. */
  canRefreshToken: boolean;
  /** Aborting ends the iterable cleanly, as `return()` does. */
  signal?: AbortSignal;
  /** Drop a response that sends no bytes, heartbeats included, for this long. `0` disables. */
  idleMs?: number;
}

/** `NetworkError.code` when the server does not answer with frame streams. */
export const FRAMES_UNSUPPORTED = 'frames_unsupported';
/** `NetworkError.code` when a stream was cut short by a server restart. */
export const STREAM_INTERRUPTED = 'stream_interrupted';
const OVERLOADED = 'subscription_overloaded';
const SERVER_RESTART = 'server_restart';
const LAPSES = new Set(['credential_expired', 'credential_changed']);

/** How one response ended: re-subscribe after `delayMs`, or stop. */
type Next = { delayMs: number } | 'stop';

export function openFrameStream(
  http: HttpTransport,
  path: FrameStreamPath,
  frame: QualifiedFrame,
  opts: FrameStreamOpts
): AsyncIterable<SubscribeEvent> {
  return {
    [Symbol.asyncIterator]: () => {
      const ctrl = new AbortController();
      const signal =
        opts.signal === undefined ? ctrl.signal : anySignal([ctrl.signal, opts.signal]);
      const gen = run(http, path, frame, opts, signal);
      // Hand-rolled: a generator queues return() behind a pending next(),
      // which on a quiet subscription never settles. Aborting settles it.
      return {
        next: () => gen.next(),
        return: async () => {
          ctrl.abort();
          await gen.return(undefined);
          return { value: undefined, done: true };
        }
      };
    }
  };
}

async function* run(
  http: HttpTransport,
  path: FrameStreamPath,
  frame: QualifiedFrame,
  opts: FrameStreamOpts,
  signal: AbortSignal
): AsyncGenerator<SubscribeEvent, void, undefined> {
  const subscribe = path === '/substrate/v1/subscribe';
  const reconnect = { ...DEFAULT_RECONNECT, ...opts.reconnect };
  const backoff = new ReconnectScheduler(reconnect);
  const overload = { ...DEFAULT_OVERLOAD_RESUBSCRIBE, ...opts.overload };
  let overloadAttempts = 0;
  let lastOverloadAt: number | null = null;
  let opened = false;
  let busyRetries = 0;
  const accept = opts.wire === 'pack' ? FRAMES_PACK_MIME : FRAMES_JSON_MIME;

  for (;;) {
    let body: ReadableStream<Uint8Array>;
    try {
      const res = await http.raw(path, { method: 'POST', body: frame, accept, signal });
      const type = res.headers.get('content-type') ?? '';
      if (!type.startsWith(accept)) {
        await res.body?.cancel();
        // Terminal: an older server answers SSE, and retrying will not change that.
        throw new NetworkError(
          `POST ${path} answered '${type}', not ${accept}: the server predates frame streams`,
          null,
          { status: res.status, code: FRAMES_UNSUPPORTED }
        );
      }
      if (res.body === null) throw new NetworkError(`POST ${path}: response has no body`, null);
      body = res.body;
    } catch (err) {
      if (signal.aborted) return;
      // A 429 is the per-client stream cap, often a slot the server has not yet freed from a
      // stream the caller just closed: retry it a few times before giving up.
      if (!opened && isBusy(err) && busyRetries < BUSY_RETRIES) {
        busyRetries++;
        if (!(await sleep(backoff.nextDelay(), signal))) return;
        continue;
      }
      // Before any response a failure is most likely a wrong endpoint or token, so it surfaces.
      if (err instanceof AuthError || !opened || !subscribe || refused(err)) throw err;
      if (!(await sleep(backoff.nextDelay(), signal))) return;
      continue;
    }
    opened = true;
    const openedAt = Date.now();

    let next: Next | undefined;
    try {
      const idleMs = opts.idleMs ?? DEFAULT_STREAM_IDLE_MS;
      for await (const payload of decodeStreamFrames(
        idleMs > 0 ? withIdleTimeout(body, idleMs) : body
      )) {
        const msg = decodeFrame(payload, opts.wire);
        // Only a response that delivers and then lasts proves health: one that sends its
        // snapshot and drops at once must keep growing the delay, or every retry re-queries.
        if (Date.now() - openedAt >= reconnect.maxDelayMs) backoff.reset();
        if (
          subscribe &&
          msg.kind === 'error' &&
          msg.errors?.[0]?.code === OVERLOADED &&
          overload.enabled
        ) {
          const now = Date.now();
          if (lastOverloadAt !== null && now - lastOverloadAt > overload.healthyResetMs) {
            overloadAttempts = 0;
          }
          lastOverloadAt = now;
          if (overloadAttempts < overload.maxAttempts) {
            overloadAttempts += 1;
            next = { delayMs: jittered(overload, overloadAttempts) };
            break;
          }
        }
        // Its `end` would read as complete, so a stream cut short throws instead.
        if (!subscribe && msg.kind === 'end' && msg.reason === SERVER_RESTART) {
          throw new NetworkError(`POST ${path}: the server restarted mid-stream`, null, {
            code: STREAM_INTERRUPTED
          });
        }
        const event = msgToEvent(msg); // throws SubscribeError on `error`
        if (event === null) continue;
        yield event;
        if (msg.kind === 'end') {
          const survives =
            subscribe &&
            (msg.reason === SERVER_RESTART ||
              (msg.reason !== undefined && LAPSES.has(msg.reason) && opts.canRefreshToken));
          next = survives ? { delayMs: 0 } : 'stop';
          break;
        }
      }
    } catch (err) {
      if (signal.aborted) return;
      if (
        err instanceof SubscribeError ||
        (err instanceof NetworkError && err.code === STREAM_INTERRUPTED)
      )
        throw err;
      if (!subscribe) {
        throw err instanceof NetworkError
          ? err
          : new NetworkError(`POST ${path}: the stream broke before its end frame`, err);
      }
      // The body broke (dropped connection, truncated frame): fall through to backoff.
    }
    if (next === 'stop') return;
    if (next === undefined) {
      if (signal.aborted) return;
      if (!subscribe)
        throw new NetworkError(`POST ${path}: stream ended without an end frame`, null);
      next = { delayMs: backoff.nextDelay() };
    }
    if (!(await sleep(next.delayMs, signal))) return;
  }
}

/** Retries of a 429 before the first response, after which it surfaces. */
const BUSY_RETRIES = 3;

function isBusy(err: unknown): boolean {
  return err instanceof NetworkError && err.status === 429;
}

/**
 * A refusal that retrying will not change: a server without frame streams, or a
 * 4xx other than 408 and 429 (the frame no longer validates, say).
 */
function refused(err: unknown): boolean {
  if (!(err instanceof NetworkError)) return false;
  if (err.code === FRAMES_UNSUPPORTED) return true;
  const status = err.status;
  return status !== undefined && status >= 400 && status < 500 && status !== 408 && status !== 429;
}

/**
 * Aborts when any of `signals` does. `AbortSignal.any` holds no listener on its
 * sources, so finished subscriptions leave nothing behind on a shared signal; the
 * fallback, for browsers before 2024, does.
 */
export function anySignal(signals: AbortSignal[]): AbortSignal {
  if (typeof AbortSignal.any === 'function') return AbortSignal.any(signals);
  const ctrl = new AbortController();
  for (const s of signals) {
    if (s.aborted) {
      ctrl.abort(s.reason);
      break;
    }
    s.addEventListener('abort', () => ctrl.abort(s.reason), { once: true });
  }
  return ctrl.signal;
}

function decodeFrame(payload: Uint8Array, wire: 'json' | 'pack'): FrameMessage {
  const value =
    wire === 'pack'
      ? decodeWsEnvelope<unknown>(payload, 'pack')
      : (JSON.parse(new TextDecoder().decode(payload)) as unknown);
  if (
    value === null ||
    typeof value !== 'object' ||
    typeof (value as FrameMessage).kind !== 'string'
  ) {
    throw new NetworkError('malformed frame in subscription stream', null);
  }
  return value as FrameMessage;
}

function jittered(cfg: Required<WsOverloadResubscribeOpts>, attempt: number): number {
  const raw = Math.min(cfg.baseDelayMs * 2 ** (attempt - 1), cfg.maxDelayMs);
  return cfg.jitter === 0 ? raw : raw + (Math.random() * 2 - 1) * raw * cfg.jitter;
}

/** Resolves true after `ms`, or false as soon as `signal` aborts. */
function sleep(ms: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve(true);
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

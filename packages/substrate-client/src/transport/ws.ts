/**
 * WsTransport — high-level WebSocket transport for Substrate subscriptions.
 *
 * Manages one raw socket per `(endpoint, auth)` pair via MultiplexedSocket.
 * Exposes `subscribe` and `stream` as AsyncIterables; `cancel` is handled
 * transparently via the iterator's `return()` method.
 *
 * Protocol:
 * - No hello/handshake: send subscribe/stream frames immediately on open.
 * - WS handles: subscribe, stream, cancel only. Query/mutate use HTTP.
 * - Auth: Bearer token in Authorization header on the HTTP upgrade request.
 *   Node-ws supports custom headers; the WHATWG/browser WebSocket does not,
 *   so under Node node-ws is always preferred even when a global WebSocket
 *   exists. True browsers cannot authenticate the WS without a
 *   header-capable `webSocket` implementation.
 * - Response kinds: snapshot / add / update / remove / chunk / end / error.
 * - Terminal kinds for cleanup: 'end' and 'error'.
 *
 * Reconnect: when the socket closes unexpectedly, ReconnectScheduler backs
 * off and re-opens. Active subscriptions are resubscribed on the new socket —
 * the consumer's AsyncIterable keeps flowing (snapshot arrives again from the
 * server's perspective; the consumer sees it as a new event). A transport that
 * has never connected does not retry: its first failure rejects `next()`.
 */

import { WS_SUBPROTOCOL_SUBSTRATE_PACK } from '@mnmal-ai/substrate-pack';
import { WebSocket as NodeWebSocket } from 'ws';
import { NetworkError, SubscribeError } from '../errors.js';
import { ReconnectScheduler, type ReconnectSchedulerOpts } from '../reconnect.js';
import { type FrameId, type InboundMessage, MultiplexedSocket, type Pending } from './multiplex.js';

/**
 * Terminal-cause tokens from the WS teardown contract
 * (docs/ws-subscription-contract.md). Local literals, not substrate-types
 * imports: they are stable wire contract, like the 1012 close code.
 */
const REASON_SUBSCRIPTION_OVERLOADED = 'subscription_overloaded';
const REASON_SERVER_RESTART = 'server_restart';

export type WsEncoding = 'json' | 'pack';

/**
 * Minimal constructor shape for an injectable WebSocket implementation.
 * Must be node-ws-compatible when headers are needed: `(url, protocols?,
 * { headers })`. The WHATWG/browser constructor matches the first two
 * parameters and simply cannot receive headers.
 */
export type WebSocketImpl = new (
  url: string,
  protocols?: string | string[],
  options?: { headers?: Record<string, string> }
) => unknown;

/**
 * Pick the WebSocket implementation for a connection.
 *
 * Priority: injected > node-ws under Node > global (browser). Node ≥22 ships
 * a global WebSocket that cannot carry headers, so preferring it would
 * silently drop the bearer.
 *
 * Throws when a token is configured but the only available implementation
 * cannot carry headers (a true browser): connecting anonymously to an
 * auth-gated server would loop on 4001 instead.
 */
export function selectWebSocketImpl(opts: {
  injected: WebSocketImpl | undefined;
  isNode: boolean;
  globalWs: WebSocketImpl | undefined;
  nodeWs: WebSocketImpl;
  hasToken: boolean;
}): { impl: WebSocketImpl; supportsHeaders: boolean } {
  if (opts.injected !== undefined) {
    // An explicitly injected implementation is trusted to be node-ws-shaped.
    return { impl: opts.injected, supportsHeaders: true };
  }
  if (opts.isNode) {
    // Under Node, node-ws is always available (bundled dependency) and is the
    // only implementation that can attach the Authorization header.
    return { impl: opts.nodeWs, supportsHeaders: true };
  }
  if (opts.globalWs !== undefined) {
    if (opts.hasToken) {
      throw new NetworkError(
        'WsTransport: a bearer token is configured but the only available WebSocket ' +
          'implementation (the WHATWG/browser global) cannot carry the Authorization ' +
          'header. Supply a header-capable implementation via the `webSocket` option.',
        null
      );
    }
    return { impl: opts.globalWs, supportsHeaders: false };
  }
  throw new NetworkError('WsTransport: no WebSocket implementation available', null);
}

/** Bounded auto-resubscribe policy for overload teardowns (contract class 1). */
export interface WsOverloadResubscribeOpts {
  /** Master switch. Default true. `false` restores terminal-on-overload. */
  enabled?: boolean;
  /** Retry budget per overload streak. Default 3. */
  maxAttempts?: number;
  /** Exponential backoff between retries. Defaults mirror reconnect. */
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Fraction 0..1 of symmetric noise on each delay. Default 0.1. */
  jitter?: number;
  /**
   * A subscription that stays healthy this long after its last overload gets
   * a fresh retry budget. Reset-on-recovery alone would let a thrashing
   * consumer loop forever. Default 60_000.
   */
  healthyResetMs?: number;
}

export interface WsTransportOpts {
  endpoint: string;
  /** Static bearer token. */
  token?: string;
  /** Dynamic token resolver — called each time a socket is opened. */
  getToken?: () => string | Promise<string>;
  /**
   * Explicit WebSocket implementation. Must be node-ws-compatible
   * (`new (url, protocols?, { headers })`) so the bearer can ride the
   * upgrade. Overrides the built-in selection (node-ws under Node, the
   * global WebSocket elsewhere).
   */
  webSocket?: WebSocketImpl;
  reconnect?: Partial<ReconnectSchedulerOpts>;
  /**
   * Wire encoding for the WS surface. `pack` advertises the `substrate-pack`
   * subprotocol at handshake; the server then exclusively speaks msgpack
   * frames with positionally-encoded `data`. Default `json`. The connection
   * negotiates the subprotocol once at handshake — this is set per-transport,
   * not per-call (unlike the HTTP wire which is per-call via Accept).
   */
  encoding?: WsEncoding;
  /**
   * Auto-resubscribe policy for `subscription_overloaded` teardowns. Default:
   * enabled with 3 attempts. The consumer sees a fresh snapshot after each
   * resubscribe — the same thing it already sees after socket-close reconnect.
   */
  overloadResubscribe?: WsOverloadResubscribeOpts;
}

/** Caller-facing request shape — `op` is added internally by subscribe()/stream(). */
export interface WsFrameRequest {
  id: string;
  frame: Record<string, { params?: Record<string, unknown>; fields?: Record<string, unknown> }>;
}

/** Internal frame shape sent to the server (includes `op`). */
interface WsSubscribeFrame extends WsFrameRequest {
  op: 'subscribe' | 'stream';
}

/** Events emitted by the subscribe/stream AsyncIterable. */
export type SubscribeEvent<T = unknown> =
  | { kind: 'snapshot'; data: T; shapes?: Record<string, string> }
  | { kind: 'add'; data: T; shapes?: Record<string, string> }
  | { kind: 'update'; data: T; shapes?: Record<string, string> }
  | { kind: 'remove'; removedId: string }
  | { kind: 'chunk'; data: T; shapes?: Record<string, string>; sequence?: number }
  | { kind: 'end'; final?: boolean; reason?: string }
  | { kind: 'error'; errors: Array<{ message: string; code?: string }> };

const DEFAULT_RECONNECT: ReconnectSchedulerOpts = {
  baseDelayMs: 1000,
  maxDelayMs: 30_000,
  jitter: 0.1
};

const DEFAULT_OVERLOAD_RESUBSCRIBE: Required<WsOverloadResubscribeOpts> = {
  enabled: true,
  maxAttempts: 3,
  baseDelayMs: 1000,
  maxDelayMs: 30_000,
  jitter: 0.1,
  healthyResetMs: 60_000
};

/**
 * Discriminated payload carried through the waiter / queue.
 * Routing errors through here (rather than throwing in onMessage) prevents
 * uncaught throws from escaping the 'message' event listener, which can
 * crash the process in node-ws.
 */
type WaiterPayload = { ok: true; msg: InboundMessage } | { ok: false; err: Error };

/** Track an active subscription so we can resubscribe after reconnect. */
interface ActiveSub {
  /** The original frame sent to the server. */
  frame: WsSubscribeFrame;
  /** Current socket-level id (stays the same across reconnects). */
  socketId: FrameId;
  /** Queue of buffered payloads the consumer hasn't read yet. */
  queue: WaiterPayload[];
  /** If the consumer is waiting, resolve its next() call here. */
  waiter: ((payload: WaiterPayload | null) => void) | null;
  /** Set when the sub terminates (end or error) or is cancelled by consumer. */
  done: boolean;
  /** Overload-retry state (contract class 1). Attempts used this streak. */
  overloadAttempts: number;
  /** Timestamp of the last overload terminal; null until the first one. */
  lastOverloadAt: number | null;
  /** Pending backoff timer for the next resubscribe attempt, if any. */
  retryTimer: ReturnType<typeof setTimeout> | null;
}

export class WsTransport {
  readonly #endpoint: string;
  readonly #token: string | undefined;
  readonly #getToken: (() => string | Promise<string>) | undefined;
  readonly #webSocket: WebSocketImpl | undefined;
  readonly #reconnectOpts: ReconnectSchedulerOpts;
  readonly #encoding: WsEncoding;
  readonly #overloadResubscribe: Required<WsOverloadResubscribeOpts>;

  /** Current multiplexed socket, or null if not yet opened / closed. */
  #mux: MultiplexedSocket | null = null;
  /** Promise that resolves when the socket is open and ready. */
  #openPromise: Promise<MultiplexedSocket> | null = null;
  /** Set when close() is called — no more reconnects. */
  #destroyed = false;

  /** Active subscriptions keyed by their logical frame id. */
  readonly #activeSubs = new Map<string, ActiveSub>();
  /** Guard: prevents multiple concurrent #reconnectActiveSubs invocations. */
  #reconnecting = false;
  /**
   * Close code captured from the most recent unintentional socket close.
   * Read once by the next `#openLoop` and cleared. When it equals 1012
   * (W3C "Service Restart") the loop skips its first scheduled backoff —
   * the server is intentionally bouncing and we'd rather pay one wasted
   * connect attempt than 1+s of jittered delay.
   */
  #lastCloseCode: number | null = null;
  /**
   * Backoff for closes that come AFTER an accepted upgrade (1013 overload,
   * 4001 on a lapsed credential). It lives on the transport, not the open
   * loop, so repeated churn grows the delay; a socket that delivers a frame
   * and outlives `maxDelayMs` proves healthy and resets it.
   */
  readonly #churn: ReconnectScheduler;
  /**
   * Retry forever only once a socket has opened. Before that, a failure is
   * most likely a wrong endpoint or a broken token, so it surfaces instead.
   */
  #hasOpened = false;

  constructor(opts: WsTransportOpts) {
    if (opts.token !== undefined && opts.getToken !== undefined) {
      throw new Error('WsTransport: provide `token` OR `getToken`, not both');
    }
    this.#endpoint = opts.endpoint;
    this.#token = opts.token;
    this.#getToken = opts.getToken;
    this.#webSocket = opts.webSocket;
    this.#reconnectOpts = { ...DEFAULT_RECONNECT, ...opts.reconnect };
    this.#churn = new ReconnectScheduler(this.#reconnectOpts);
    this.#encoding = opts.encoding ?? 'json';
    this.#overloadResubscribe = { ...DEFAULT_OVERLOAD_RESUBSCRIBE, ...opts.overloadResubscribe };
  }

  /**
   * Subscribe to a live query. Returns an AsyncIterable of SubscribeEvents.
   * Calling `break` or `return()` on the iterator sends a cancel frame.
   */
  subscribe(req: WsFrameRequest): AsyncIterable<SubscribeEvent> {
    return this.#makeIterable({ ...req, op: 'subscribe' });
  }

  /** Stream a one-shot resolver. Returns chunk events followed by an end event. */
  stream(req: WsFrameRequest): AsyncIterable<SubscribeEvent> {
    return this.#makeIterable({ ...req, op: 'stream' });
  }

  /** Gracefully shut down. Cancels all active subscriptions and closes the socket. */
  async close(): Promise<void> {
    this.#destroyed = true;
    // Notify all active subs that we're done (null signals transport closed)
    for (const [, sub] of this.#activeSubs) {
      sub.done = true;
      if (sub.retryTimer !== null) {
        clearTimeout(sub.retryTimer);
        sub.retryTimer = null;
      }
      if (sub.waiter) {
        sub.waiter(null);
        sub.waiter = null;
      }
    }
    this.#activeSubs.clear();
    if (this.#mux) {
      this.#mux.close();
      this.#mux = null;
    }
    this.#openPromise = null;
  }

  /** Ensure a connected MultiplexedSocket is available. */
  async #ensureOpen(): Promise<MultiplexedSocket> {
    if (this.#mux !== null) return this.#mux;
    if (this.#openPromise !== null) return this.#openPromise;
    this.#openPromise = this.#openLoop();
    return this.#openPromise;
  }

  /**
   * Open loop: try to open a socket; on failure, backoff and retry.
   * Runs until connected or #destroyed.
   */
  async #openLoop(): Promise<MultiplexedSocket> {
    const scheduler = new ReconnectScheduler(this.#reconnectOpts);
    // Read-and-clear the close-code hint from the previous socket. After a
    // graceful restart (1012) skip the first backoff; later failures use
    // normal backoff in case the server never comes back.
    const wasGracefulRestart = this.#lastCloseCode === 1012;
    // The server accepted the last socket and then closed it, so the open
    // itself will succeed: without a wait here the loop would reopen at
    // round-trip speed for as long as the server keeps closing.
    const churned = this.#lastCloseCode === 1013 || this.#lastCloseCode === 4001;
    this.#lastCloseCode = null;
    if (churned) {
      await this.#churn.schedule();
      if (this.#destroyed) throw new NetworkError('WsTransport destroyed', null);
    }
    let firstFailure = true;
    while (true) {
      // A close() during the backoff sleep must not open a new socket.
      if (this.#destroyed) throw new NetworkError('WsTransport destroyed', null);
      try {
        const mux = await this.#openOnce();
        // close() saw no mux while this open was in flight, so it is ours to close.
        if (this.#destroyed) {
          mux.close();
          throw new NetworkError('WsTransport destroyed', null);
        }
        scheduler.reset();
        this.#hasOpened = true;
        this.#mux = mux;
        this.#openPromise = null;
        return mux;
      } catch (err) {
        if (this.#destroyed) throw new NetworkError('WsTransport destroyed', err);
        if (!this.#hasOpened) {
          this.#openPromise = null;
          throw err;
        }
        if (wasGracefulRestart && firstFailure) {
          firstFailure = false;
          // Yield to the event loop instead of waiting `baseDelayMs`. One
          // free retry in the optimistic case the server is already up.
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
        } else {
          firstFailure = false;
          await scheduler.schedule();
        }
        // close() may have fired during the backoff sleep.
        if (this.#destroyed) throw new NetworkError('WsTransport destroyed', null);
      }
    }
  }

  /** Open one WebSocket connection and resolve when it's ready. */
  async #openOnce(): Promise<MultiplexedSocket> {
    const token = this.#token ?? (this.#getToken ? await this.#getToken() : undefined);

    const subprotocols = this.#encoding === 'pack' ? [WS_SUBPROTOCOL_SUBSTRATE_PACK] : undefined;
    const ws = await new Promise<WebSocket>((resolve, reject) => {
      let rawWs: WebSocket;

      const { impl, supportsHeaders } = selectWebSocketImpl({
        injected: this.#webSocket,
        isNode: typeof process !== 'undefined' && process.versions?.node !== undefined,
        globalWs: (globalThis as { WebSocket?: WebSocketImpl }).WebSocket,
        nodeWs: NodeWebSocket as unknown as WebSocketImpl,
        hasToken: token !== undefined
      });
      if (supportsHeaders) {
        const headers: Record<string, string> = {};
        if (token !== undefined) headers.authorization = `Bearer ${token}`;
        rawWs = new impl(this.#endpoint, subprotocols, { headers }) as WebSocket;
      } else {
        rawWs = (
          subprotocols !== undefined
            ? new impl(this.#endpoint, subprotocols)
            : new impl(this.#endpoint)
        ) as WebSocket;
      }

      // Pack frames arrive as binary; ask for ArrayBuffer rather than the
      // platform default (Blob in browsers) so the multiplexer can decode
      // synchronously without an await on `.arrayBuffer()`.
      if (this.#encoding === 'pack') {
        try {
          (rawWs as { binaryType?: BinaryType }).binaryType = 'arraybuffer';
        } catch {
          // Some platforms don't allow setting binaryType post-construct;
          // substrate-pack's `decodeWsEnvelope` handles both ArrayBuffer and Buffer.
        }
      }

      const onOpen = () => {
        rawWs.removeEventListener('error', onError);
        resolve(rawWs);
      };
      const onError = (ev: Event) => {
        rawWs.removeEventListener('open', onOpen);
        reject(new NetworkError(`WS connect failed: ${this.#endpoint}`, ev));
      };
      rawWs.addEventListener('open', onOpen);
      rawWs.addEventListener('error', onError);
    });

    const mux = new MultiplexedSocket(ws, { usePack: this.#encoding === 'pack' });
    const openedAt = Date.now();
    // A socket that never delivered a frame proved nothing, however long it
    // stayed open (a refused upgrade under load can outlast `maxDelayMs`).
    let delivered = false;
    ws.addEventListener(
      'message',
      () => {
        delivered = true;
      },
      { once: true }
    );

    // Wire up unexpected-close handler for reconnect + resubscribe.
    ws.addEventListener('close', (ev: CloseEvent) => {
      // Only reconnect if we didn't initiate the close.
      if (this.#destroyed) return;
      const healthy = delivered && Date.now() - openedAt >= this.#reconnectOpts.maxDelayMs;
      if (healthy) this.#churn.reset();
      // 4001 = unauthorized. Retrying with the same credentials would loop
      // forever, so fail every active sub and stop. The exception is a
      // credential that lapsed on a socket that had been working, when a
      // provider can mint a fresh one: reconnect. A socket refused at once is
      // not healthy, so a provider whose tokens never work still fails here.
      if (ev.code === 4001 && !(healthy && this.#canRefreshToken())) {
        if (this.#mux === mux) this.#mux = null;
        this.#failActiveSubs(
          new NetworkError(
            `WS closed 4001 unauthorized by ${this.#endpoint} — bearer rejected ` +
              '(wrong/expired token, or none configured against an auth-gated server)',
            ev
          )
        );
        return;
      }
      if (this.#mux === mux) {
        this.#mux = null;
        // Lets the next #openLoop skip its first backoff after a 1012.
        this.#lastCloseCode = ev.code;
      }
      // Resubscribe all active subs on the new socket.
      this.#reconnectActiveSubs().catch(() => {
        // If reconnect fails permanently, active subs will get onClose from the
        // loop's final error; nothing more to do here.
      });
    });

    return mux;
  }

  /** Only a provider can mint a fresh token; a fixed `token` would be refused again. */
  #canRefreshToken(): boolean {
    return this.#token === undefined && this.#getToken !== undefined;
  }

  /** Terminate every active sub with `err` — delivered so next() throws. */
  #failActiveSubs(err: Error): void {
    for (const [, sub] of this.#activeSubs) {
      if (sub.done) continue;
      sub.done = true;
      if (sub.retryTimer !== null) {
        clearTimeout(sub.retryTimer);
        sub.retryTimer = null;
      }
      const payload: WaiterPayload = { ok: false, err };
      if (sub.waiter) {
        const w = sub.waiter;
        sub.waiter = null;
        w(payload);
      } else {
        sub.queue.push(payload);
      }
    }
    this.#activeSubs.clear();
  }

  /** Re-subscribe all active subs after a reconnect. */
  async #reconnectActiveSubs(): Promise<void> {
    // Serialise: socket flaps can fire several close events, and each would
    // otherwise open its own socket and double-subscribe.
    if (this.#reconnecting) return;
    if (this.#destroyed) return;
    this.#reconnecting = true;
    try {
      if (this.#activeSubs.size === 0) return;
      let mux: MultiplexedSocket;
      try {
        mux = await this.#ensureOpen();
      } catch {
        // Reconnect failed — drain all active subs
        for (const [, sub] of this.#activeSubs) {
          sub.done = true;
          if (sub.retryTimer !== null) {
            clearTimeout(sub.retryTimer);
            sub.retryTimer = null;
          }
          if (sub.waiter) {
            sub.waiter(null);
            sub.waiter = null;
          }
        }
        this.#activeSubs.clear();
        return;
      }

      for (const [, sub] of this.#activeSubs) {
        if (sub.done) continue;
        // A pending overload retry would double-subscribe on top of this
        // reconnect-path resubscribe — the reconnect supersedes it.
        if (sub.retryTimer !== null) {
          clearTimeout(sub.retryTimer);
          sub.retryTimer = null;
        }
        this.#doSubscribe(mux, sub);
      }
    } finally {
      this.#reconnecting = false;
    }
  }

  /** Send a subscribe/stream frame on the mux and wire up the Pending handler. */
  #doSubscribe(mux: MultiplexedSocket, sub: ActiveSub): void {
    const pending: Pending = {
      onMessage: (msg: InboundMessage) => {
        if (sub.done) return;
        const action = this.#classifyTerminal(msg, sub);
        if (action === 'suppress') return;
        // Catch msgToEvent's throw (SubscribeError on 'error' frames) and route
        // it through the payload: throwing inside a node-ws 'message' listener
        // can crash the process.
        let payload: WaiterPayload;
        try {
          const ev = msgToEvent(msg);
          if (ev === null) return; // unrecognised kind — drop silently
          payload = { ok: true, msg };
        } catch (err) {
          payload = { ok: false, err: err instanceof Error ? err : new Error(String(err)) };
          sub.done = true;
        }
        // Terminal kinds mark done — except 'survive' (server_restart), where
        // the event is delivered but the sub stays live for the reconnect
        // path to resubscribe.
        if (action === 'terminal' && (msg.kind === 'end' || msg.kind === 'error')) {
          sub.done = true;
        }
        if (sub.waiter) {
          const w = sub.waiter;
          sub.waiter = null;
          w(payload);
        } else {
          sub.queue.push(payload);
        }
      },
      onClose: (_reason: string) => {
        if (sub.done) return;
        // Socket dropped unexpectedly — don't mark done here because
        // #reconnectActiveSubs will re-wire. But if destroyed, drain.
        if (this.#destroyed) {
          sub.done = true;
          if (sub.waiter) {
            sub.waiter(null);
            sub.waiter = null;
          }
        }
        // Otherwise let #reconnectActiveSubs handle it via the close listener.
      }
    };

    const outFrame: Record<string, unknown> = {
      id: sub.socketId,
      op: sub.frame.op,
      frame: sub.frame.frame
    };
    mux.send(outFrame, pending);
  }

  /**
   * Classify a frame per the teardown contract (substrate repo
   * docs/ws-subscription-contract.md) BEFORE msgToEvent, which throws on
   * error frames.
   *
   * - 'suppress': consumed by the retry machinery; never reaches the consumer.
   *   Overload error frames with budget left schedule a resubscribe here; the
   *   trailing `end { reason: 'subscription_overloaded' }` of a suppressed
   *   teardown is swallowed too.
   * - 'survive': delivered to the consumer but NOT terminal — server_restart
   *   end frames; the sub stays live so the socket-close reconnect path
   *   resubscribes it.
   * - 'terminal': mark done on delivery.
   * - 'data': everything else.
   */
  #classifyTerminal(
    msg: InboundMessage,
    sub: ActiveSub
  ): 'suppress' | 'survive' | 'terminal' | 'data' {
    const cfg = this.#overloadResubscribe;
    if (msg.kind === 'error') {
      const code = msg.errors?.[0]?.code;
      if (code !== REASON_SUBSCRIPTION_OVERLOADED || !cfg.enabled) return 'terminal';
      const now = Date.now();
      if (sub.lastOverloadAt !== null && now - sub.lastOverloadAt > cfg.healthyResetMs) {
        sub.overloadAttempts = 0;
      }
      sub.lastOverloadAt = now;
      if (sub.overloadAttempts >= cfg.maxAttempts) return 'terminal';
      sub.overloadAttempts += 1;
      this.#scheduleOverloadRetry(sub);
      return 'suppress';
    }
    if (msg.kind === 'end') {
      if (msg.reason === REASON_SUBSCRIPTION_OVERLOADED && cfg.enabled && sub.retryTimer !== null) {
        // Defensive: on the normal path the mux drops the pending entry on the
        // error frame, so this trailing end never reaches us. Guards a re-registered
        // sub receiving a stale trailing end from a prior teardown.
        return 'suppress';
      }
      if (msg.reason === REASON_SERVER_RESTART) return 'survive';
      // The 4001 that follows reconnects on a fresh token (see the close handler).
      if (
        (msg.reason === 'credential_expired' || msg.reason === 'credential_changed') &&
        this.#canRefreshToken()
      ) {
        return 'survive';
      }
      return 'terminal';
    }
    return 'data';
  }

  /** Backoff then re-send the subscribe frame for `sub` on the live socket. */
  #scheduleOverloadRetry(sub: ActiveSub): void {
    const cfg = this.#overloadResubscribe;
    const raw = Math.min(cfg.baseDelayMs * 2 ** (sub.overloadAttempts - 1), cfg.maxDelayMs);
    const delay = cfg.jitter === 0 ? raw : raw + (Math.random() * 2 - 1) * raw * cfg.jitter;
    sub.retryTimer = setTimeout(() => {
      sub.retryTimer = null;
      if (sub.done || this.#destroyed) return;
      this.#ensureOpen()
        .then((mux) => {
          if (!sub.done) this.#doSubscribe(mux, sub);
        })
        .catch(() => {
          // Open-loop failure is owned by the reconnect path; it drains subs.
        });
    }, delay);
  }

  #makeIterable(frame: WsSubscribeFrame): AsyncIterable<SubscribeEvent> {
    const logicalId = frame.id;
    const transport = this;

    return {
      [Symbol.asyncIterator]() {
        const sub: ActiveSub = {
          frame,
          socketId: logicalId,
          queue: [],
          waiter: null,
          done: false,
          overloadAttempts: 0,
          lastOverloadAt: null,
          retryTimer: null
        };
        transport.#activeSubs.set(logicalId, sub);

        // Kick off connection + send subscribe frame (fire-and-forget; first
        // next() will wait for the first message to arrive).
        transport
          .#ensureOpen()
          .then((mux) => {
            if (!sub.done) transport.#doSubscribe(mux, sub);
          })
          .catch((err: unknown) => {
            if (sub.done) return;
            // Can't connect: deliver the error so next() rejects with it.
            sub.done = true;
            transport.#activeSubs.delete(logicalId);
            const payload: WaiterPayload = {
              ok: false,
              err: err instanceof Error ? err : new NetworkError(String(err), err)
            };
            if (sub.waiter) {
              const w = sub.waiter;
              sub.waiter = null;
              w(payload);
            } else {
              sub.queue.push(payload);
            }
          });

        const iterator: AsyncIterator<SubscribeEvent> = {
          async next(): Promise<IteratorResult<SubscribeEvent>> {
            while (true) {
              if (sub.queue.length > 0) {
                const payload = sub.queue.shift()!;
                // Error payloads throw from next(), outside any event listener.
                if (!payload.ok) {
                  sub.done = true;
                  transport.#activeSubs.delete(logicalId);
                  throw payload.err;
                }
                const ev = msgToEvent(payload.msg);
                if (ev === null) continue; // skip unrecognised kinds
                return { value: ev, done: false };
              }
              if (sub.done) return { value: undefined as unknown as SubscribeEvent, done: true };

              // Wait for the next message
              const payload = await new Promise<WaiterPayload | null>((resolve) => {
                sub.waiter = resolve;
              });
              if (payload === null) {
                // Transport closed or destroyed — clean termination
                return { value: undefined as unknown as SubscribeEvent, done: true };
              }
              if (!payload.ok) {
                sub.done = true;
                transport.#activeSubs.delete(logicalId);
                throw payload.err;
              }
              const ev = msgToEvent(payload.msg);
              if (ev !== null) return { value: ev, done: false };
              // Unknown kind: loop and wait for next
            }
          },

          async return(): Promise<IteratorResult<SubscribeEvent>> {
            if (!sub.done) {
              sub.done = true;
              if (sub.retryTimer !== null) {
                clearTimeout(sub.retryTimer);
                sub.retryTimer = null;
              }
              transport.#activeSubs.delete(logicalId);
              // Send cancel if we have a socket
              if (transport.#mux) {
                transport.#mux.cancel(sub.socketId);
              }
              // Wake any waiting consumer
              if (sub.waiter) {
                sub.waiter(null);
                sub.waiter = null;
              }
            }
            return { value: undefined as unknown as SubscribeEvent, done: true };
          }
        };

        return iterator;
      }
    };
  }
}

/** Convert an InboundMessage to a SubscribeEvent, or null if unrecognised. */
function msgToEvent(msg: InboundMessage): SubscribeEvent | null {
  switch (msg.kind) {
    case 'snapshot':
    case 'add':
    case 'update':
      return {
        kind: msg.kind,
        data: msg.data,
        ...(msg.shapes !== undefined ? { shapes: msg.shapes as Record<string, string> } : {})
      } as SubscribeEvent;
    case 'chunk':
      return {
        kind: 'chunk',
        data: msg.data,
        ...(msg.shapes !== undefined ? { shapes: msg.shapes as Record<string, string> } : {}),
        ...(msg.sequence !== undefined ? { sequence: msg.sequence } : {})
      };
    case 'remove':
      return { kind: 'remove', removedId: msg.removedId ?? '' };
    case 'end':
      return {
        kind: 'end',
        ...(msg.final !== undefined ? { final: msg.final } : {}),
        ...(msg.reason !== undefined ? { reason: msg.reason } : {})
      };
    case 'error': {
      const errors = msg.errors ?? [{ message: 'unknown error', code: 'unknown' }];
      const first = errors[0] ?? { message: 'unknown error', code: 'unknown' };
      // Throw SubscribeError — it will propagate from next()
      throw new SubscribeError(first.message, first.code ?? 'unknown');
    }
    default:
      return null;
  }
}

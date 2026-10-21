/**
 * Transport-agnostic streaming session core. Spec §2.5 (protocol neutrality),
 * §5.5 (stream dispatch).
 *
 * A `StreamSession` is ONE logical stream or subscription. Multiplexing is a
 * TRANSPORT concern: the WS route holds a `Map<id, StreamSession>` because one
 * socket carries many; the SSE route holds exactly one because one HTTP
 * response carries one. Keeping the session ignorant of multiplexing lets
 * both transports share this core.
 */

import type {
  Engine,
  StreamHandle,
  SubscriptionCancelReason,
  SubscriptionHandle
} from '@mnmal-ai/substrate-core';
import type { FieldInput, Identity, WsResponseFrame } from '@mnmal-ai/substrate-types';

/**
 * The frame a session emits.
 *
 * An alias of the engine's response frame, which is transport-neutral in
 * content despite its name; re-shaping it would risk dropping fields such as
 * `_meta.cancelled` and `reason`.
 */
export type SessionFrame = WsResponseFrame;

/**
 * The frame key an engine registration error blames, or undefined when the
 * error isn't attributable to one key.
 */
export function erroredKey(frame: SessionFrame): string | undefined {
  if (frame.kind !== 'error') return undefined;
  return frame.errors?.[0]?.path?.[0];
}

export type CloseReason = 'complete' | 'client_disconnect' | 'shutdown' | 'cancelled';

export interface StreamTransport {
  /**
   * Write one frame. Awaiting the returned promise IS the backpressure signal:
   * a transport that can block (WS socket drain, SSE ReadableStream demand)
   * resolves only once the consumer is ready. Transports with no buffer
   * (memory/test) resolve immediately and chunks flow unthrottled.
   */
  emit(frame: SessionFrame, fieldsByKey: ReadonlyMap<string, FieldInput>): Promise<void>;
  /**
   * Terminal. Implementations MUST tolerate being called more than once.
   *
   * A transport that owns a finite resource (an SSE response) cannot rely on
   * this alone to release it: a subscribe that fails at registration emits a
   * lone `error` and no `end`, so the session never closes. The transport must
   * detect "an `error` arrived AND no entry was registered" itself — not merely
   * "an `error` arrived", since a multi-key subscribe can fail one key and keep
   * the others live.
   */
  close(reason: CloseReason): void;
}

/**
 * Close reason → the token the engine records as
 * `engine_subscription_closed_<reason>`. Mapped here rather than per transport
 * so metric names are identical whichever transport opens the session.
 * Pinned by apps/substrate/test/ws-teardown-contract.test.ts.
 */
const ENGINE_CANCEL_REASON: Record<CloseReason, SubscriptionCancelReason> = {
  complete: 'cancel',
  cancelled: 'cancel',
  client_disconnect: 'socket_close',
  shutdown: 'shutdown'
};

export interface StreamSessionInit {
  id: string;
  mode: 'subscribe' | 'stream';
  frame: Record<string, { params?: Record<string, unknown>; fields?: FieldInput }>;
  identity: Identity | null;
  headers: Record<string, string>;
  clientIp?: string;
}

export class StreamSession {
  readonly id: string;
  readonly #init: StreamSessionInit;
  readonly #transport: StreamTransport;
  readonly #fieldsByKey: Map<string, FieldInput>;
  #handle: SubscriptionHandle | StreamHandle | null = null;
  #terminated = false;
  #endDelivered = false;
  /** Set by `cancel()` only, so `start` can tell "cancelled" from "completed". */
  #cancelReason: CloseReason | null = null;

  private constructor(init: StreamSessionInit, transport: StreamTransport) {
    this.id = init.id;
    this.#init = init;
    this.#transport = transport;
    // Build the selection map eagerly so validation errors round-trip under the
    // same encoding success frames would use.
    this.#fieldsByKey = new Map<string, FieldInput>();
    for (const [k, entry] of Object.entries(init.frame)) {
      this.#fieldsByKey.set(k, entry.fields ?? {});
    }
  }

  /** True once a terminal frame arrived or `cancel()` ran. */
  get isTerminated(): boolean {
    return this.#terminated;
  }

  /**
   * Construction is deliberately separate from dispatch: a multiplexing
   * transport must register the session (`create` → map → `start`) before the
   * engine is touched, or a `cancel` arriving in the same synchronous batch
   * finds no session and the stream runs on uncancelled.
   */
  static create(init: StreamSessionInit, transport: StreamTransport): StreamSession {
    return new StreamSession(init, transport);
  }

  /** Dispatch to the engine. Call at most once, after registering the session. */
  async start(engine: Engine): Promise<void> {
    const ctx = {
      identity: this.#init.identity,
      headers: this.#init.headers,
      meta: {},
      ...(this.#init.clientIp !== undefined ? { clientIp: this.#init.clientIp } : {})
    };
    const dispatch = {
      id: this.#init.id,
      frame: this.#init.frame,
      ctx,
      onFrame: (f: SessionFrame) => this.#onEngineFrame(f)
    };

    const handle =
      this.#init.mode === 'subscribe' ? await engine.subscribe(dispatch) : engine.stream(dispatch);
    this.#handle = handle;
    // A cancel that landed while the engine was registering had no handle to
    // act on. Honour it now so the dispatch doesn't outlive its session — the
    // engine's cancellation path is also what produces the terminal frame the
    // client is owed (`end { _meta.cancelled }` for a stream).
    if (this.#cancelReason !== null) handle.cancel(ENGINE_CANCEL_REASON[this.#cancelReason]);
  }

  /**
   * Idempotent. Cancels the engine handle at most once so a client disconnect
   * racing a natural `end` cannot double-cancel.
   */
  cancel(reason: CloseReason): void {
    if (this.#terminated) return;
    this.#terminated = true;
    this.#cancelReason = reason;
    this.#handle?.cancel(ENGINE_CANCEL_REASON[reason]);
    this.#transport.close(reason);
  }

  /**
   * Awaited by the engine per chunk (§5.5), so the transport's async `emit`
   * is an end-to-end backpressure signal.
   *
   * `end` is the only session-terminating frame kind: failures emit `error`
   * followed by `end`, and a cancelled stream's `end { _meta.cancelled }`
   * arrives after `cancel()`, so cancellation gates data frames but not that
   * terminal. A subscribe that fails at registration therefore never closes
   * the transport here; see `StreamTransport.close`.
   */
  async #onEngineFrame(frame: SessionFrame): Promise<void> {
    if (this.#endDelivered) return;
    const isTerminal = frame.kind === 'end';
    if (this.#terminated && !isTerminal) return;
    await this.#transport.emit(frame, this.#fieldsByKey);
    if (isTerminal) {
      // Engine-side terminal: mark done WITHOUT re-cancelling the handle (the
      // engine already finished) but still close the transport.
      this.#endDelivered = true;
      this.#terminated = true;
      this.#transport.close('complete');
    }
  }
}

/**
 * MultiplexedSocket — low-level WS multiplexer.
 *
 * One raw WebSocket; outbound frames get a client-generated `id`; inbound
 * frames with a matching `id` route to the right pending handler.
 *
 * Subscribe/stream ops stay pending across multiple messages (they receive
 * snapshot/add/update/remove/chunk/end/error frames). Query/mutate are not
 * handled here — those go via HTTP.
 *
 * Encoding: JSON-over-WS by default. Pass `usePack: true` to send/receive
 * msgpack-encoded frames matching the `substrate-pack` subprotocol negotiated
 * one level up by `WsTransport`. Under pack, `data` values arrive as
 * positional tuples — the higher layer (`SubstrateClient`) is responsible for
 * the schema-driven positional → named decode; the multiplexer only
 * handles wire-format framing.
 *
 * Works with both node-ws WebSocket and browser native WebSocket via the
 * shared `addEventListener` interface (node-ws v8+ supports it).
 */

import { decodeWsEnvelope, encodeWsFrame, type WireMode } from '@mnmal-ai/substrate-pack';

export type FrameId = string;

/** Inbound frame shape from the server (WsResponseFrame). */
export interface InboundMessage {
  id: FrameId;
  kind: string;
  data?: unknown;
  shapes?: Record<string, unknown>;
  removedId?: string;
  errors?: Array<{ message: string; code?: string; path?: string[] }>;
  final?: boolean;
  schemaVersion?: string;
  sequence?: number;
  /** Set by the server on `end` frames during graceful shutdown. */
  reason?: string;
}

/** Terminal response kinds — once received the pending entry is cleared. */
const TERMINAL_KINDS = new Set(['end', 'error']);

export interface Pending {
  onMessage(msg: InboundMessage): void;
  onClose(reason: string): void;
}

export class MultiplexedSocket {
  readonly #ws: WebSocket;
  readonly #mode: WireMode;
  readonly #pending = new Map<FrameId, Pending>();
  #seq = 0;
  #closing = false;

  /**
   * Accept either a node `ws` WebSocket or a browser WebSocket — both expose
   * `addEventListener`. The constructor wires up message and close handling.
   *
   * `usePack` is set by `WsTransport` after the `substrate-pack` subprotocol
   * has been negotiated at handshake; once true the socket exclusively
   * speaks msgpack frames.
   */
  constructor(ws: WebSocket, opts: { usePack?: boolean } = {}) {
    this.#ws = ws;
    this.#mode = opts.usePack === true ? 'pack' : 'json';
    ws.addEventListener('message', (ev) => this.#onMessage(ev));
    ws.addEventListener('close', (ev) => this.#onClose(ev));
  }

  nextId(): FrameId {
    this.#seq += 1;
    return `c${this.#seq}`;
  }

  /**
   * Serialise + send `frame` (which must already include an `id` field) and
   * register `pending` as the handler for responses bearing that id.
   * Returns the frame id for caller bookkeeping.
   */
  send(frame: Record<string, unknown>, pending: Pending): FrameId {
    const id = (frame.id as FrameId | undefined) ?? this.nextId();
    const frameWithId = id === frame.id ? frame : { ...frame, id };
    this.#pending.set(id, pending);
    try {
      this.#sendWire(encodeWsFrame(frameWithId, this.#mode));
    } catch (_err) {
      // Socket closed before send — remove and notify
      this.#pending.delete(id);
      pending.onClose('send failed');
    }
    return id;
  }

  /**
   * Send a cancel frame for a given subscription id and remove the pending
   * handler. The server will emit a terminal `end` frame; since we delete the
   * pending entry here, that frame is silently dropped.
   */
  cancel(id: FrameId): void {
    this.#pending.delete(id);
    try {
      this.#sendWire(encodeWsFrame({ id, op: 'cancel' }, this.#mode));
    } catch {
      // Socket already closed — nothing to do.
    }
  }

  /**
   * Push wire bytes to the socket. The branch exists because `WebSocket.send`'s
   * overloads don't accept the union. Binary frames are copied into a fresh
   * `Uint8Array` so the backing buffer is an `ArrayBuffer`, not the
   * `ArrayBufferLike` msgpackr's `Buffer` is typed with — avoiding a cast.
   */
  #sendWire(wire: string | Uint8Array): void {
    if (typeof wire === 'string') {
      this.#ws.send(wire);
    } else {
      this.#ws.send(new Uint8Array(wire));
    }
  }

  close(): void {
    if (this.#closing) return;
    this.#closing = true;
    try {
      this.#ws.close();
    } catch {
      // Already closed.
    }
  }

  #onMessage(ev: MessageEvent): void {
    let msg: InboundMessage;
    try {
      msg = decodeWsEnvelope<InboundMessage>(ev.data, this.#mode);
    } catch {
      return; // unparseable frame — ignore
    }
    const pending = this.#pending.get(msg.id);
    if (!pending) return;
    // Terminal kinds: clear pending BEFORE calling onMessage so that the handler
    // can re-register without us immediately clobbering its new entry.
    if (TERMINAL_KINDS.has(msg.kind)) {
      this.#pending.delete(msg.id);
    }
    pending.onMessage(msg);
  }

  #onClose(ev: CloseEvent): void {
    // Always notify pending handlers, even on intentional close, or a
    // consumer blocked in next() never resolves after a direct close().
    //
    // Reason: client-initiated close, graceful server restart (1012, W3C
    // "Service Restart"), or any other drop.
    const reason = this.#closing
      ? 'transport_closed'
      : ev.code === 1012
        ? 'server_restart'
        : `ws closed (code ${ev.code})`;
    const snapshot = [...this.#pending.entries()];
    this.#pending.clear();
    for (const [, pending] of snapshot) {
      pending.onClose(reason);
    }
  }
}

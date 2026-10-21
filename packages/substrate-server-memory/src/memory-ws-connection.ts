/**
 * In-process WebSocket pair. One end is the server-side `WsConnection`
 * handed to the user's `WsHandler`; the other is a `MemoryWsClient` returned
 * to test code so it can drive the connection without opening a socket.
 *
 * Per §4.8 transport symmetry, upgrade metadata (path, headers, query, params)
 * rides on `SubstrateRequest`, not on `WsConnection`. The pair only needs an
 * `id` — the caller (`MemorySubstrateServer`) builds the `SubstrateRequest` separately.
 *
 * Frames are normalised to Buffer on delivery so handlers see the same shape
 * they would over a real WS (the `WsConnection.onMessage` signature is
 * `(frame: Buffer) => void`). `send()` accepts Buffer / Uint8Array / string on
 * both sides and normalises before dispatch.
 *
 * Close semantics:
 *   - First close from either side transitions the pair to closed and fires
 *     both sides' onClose callbacks synchronously with the provided code.
 *   - Subsequent close() calls are no-ops (no duplicate events).
 *   - send() on a closed endpoint throws a named error — callers that race
 *     a close against a send should handle this, mirroring real WS behaviour
 *     where the underlying socket may have shut down mid-write.
 */

import { randomUUID } from 'node:crypto';
import type { WsConnection } from '@mnmal-ai/substrate-types';

/**
 * @internal — thrown when sending on a closed in-memory WS pair. Treat as
 * package-private.
 */
export class WsClosedError extends Error {
  constructor() {
    super('WebSocket is closed');
    this.name = 'WsClosedError';
  }
}

type Frame = Buffer | Uint8Array | string;
type MessageCb = (frame: Buffer) => void;
type CloseCb = (code?: number) => void;

function toBuffer(frame: Frame): Buffer {
  if (typeof frame === 'string') return Buffer.from(frame, 'utf8');
  if (Buffer.isBuffer(frame)) return frame;
  return Buffer.from(frame);
}

export interface MemoryWsClient {
  send(frame: Frame): void;
  onMessage(cb: (frame: Buffer) => void): void;
  onClose(cb: (code?: number) => void): void;
  close(code?: number, reason?: string): void;
  readonly closed: boolean;
}

interface Endpoint {
  readonly messageListeners: MessageCb[];
  readonly closeListeners: CloseCb[];
}

/**
 * @internal — paired in-memory WS endpoints used by `MemorySubstrateServer`
 * for inject-style WS testing. Treat as package-private.
 */
export function createMemoryWsPair(): {
  server: WsConnection;
  client: MemoryWsClient;
} {
  const serverSide: Endpoint = { messageListeners: [], closeListeners: [] };
  const clientSide: Endpoint = { messageListeners: [], closeListeners: [] };
  const state = { closed: false };

  const closePair = (code?: number): void => {
    if (state.closed) return;
    state.closed = true;
    // Snapshot listeners before firing: a close handler might register more,
    // but those should not be invoked for THIS close event.
    const s = serverSide.closeListeners.slice();
    const c = clientSide.closeListeners.slice();
    for (const cb of s) {
      try {
        cb(code);
      } catch {
        // A faulty close listener must not prevent the peer's listeners from firing.
      }
    }
    for (const cb of c) {
      try {
        cb(code);
      } catch {
        // See above.
      }
    }
  };

  const server: WsConnection = {
    id: randomUUID(),
    send(frame) {
      if (state.closed) throw new WsClosedError();
      const buf = toBuffer(frame);
      for (const cb of clientSide.messageListeners.slice()) cb(buf);
    },
    onMessage(cb) {
      serverSide.messageListeners.push(cb);
    },
    onClose(cb) {
      serverSide.closeListeners.push(cb);
    },
    close(code, _reason) {
      closePair(code);
    }
  };

  const client: MemoryWsClient = {
    send(frame) {
      if (state.closed) throw new WsClosedError();
      const buf = toBuffer(frame);
      for (const cb of serverSide.messageListeners.slice()) cb(buf);
    },
    onMessage(cb) {
      clientSide.messageListeners.push(cb);
    },
    onClose(cb) {
      clientSide.closeListeners.push(cb);
    },
    close(code, _reason) {
      closePair(code);
    },
    get closed() {
      return state.closed;
    }
  };

  return { server, client };
}

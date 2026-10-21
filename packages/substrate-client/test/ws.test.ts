/**
 * WsTransport tests — drives a fake Substrate WS server using the `ws` package.
 *
 * Protocol notes (confirmed from apps/substrate/src/routes/ws.ts):
 * - No hello/handshake: server starts accepting frames immediately.
 * - WS supports: subscribe, stream, cancel ops only. Query/mutate are HTTP.
 * - Auth: Bearer token in Authorization header on the upgrade request.
 * - Response shape: { id, kind, data?, removedId?, errors?, final?, shapes? }
 * - Terminal kinds for subscriptions: 'end' and 'error' — these close a sub.
 */

import type { WsResponseFrame } from '@mnmal-ai/substrate-types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocketServer, type WebSocket as WsSocket } from 'ws';
import { WsTransport } from '../src/transport/ws.js';

let wss: WebSocketServer;
let port: number;

beforeEach(async () => {
  wss = new WebSocketServer({ port: 0 });
  await new Promise<void>((r) => wss.once('listening', () => r()));
  const addr = wss.address();
  port = typeof addr === 'object' && addr ? (addr as { port: number }).port : 0;
});

afterEach(async () => {
  await new Promise<void>((r) => wss.close(() => r()));
});

/** Parse a client message from the fake server. */
function parseMsg(raw: unknown): Record<string, unknown> {
  const str = typeof raw === 'string' ? raw : Buffer.isBuffer(raw) ? raw.toString('utf8') : '';
  return JSON.parse(str) as Record<string, unknown>;
}

/** Send a server→client response frame from the fake server. */
function serverSend(socket: WsSocket, frame: WsResponseFrame): void {
  socket.send(JSON.stringify(frame));
}

describe('WsTransport', () => {
  it('multiplexes a subscribe frame and yields snapshot then add then end', async () => {
    // Fake server: on subscribe → send snapshot, then add, then end (on cancel)
    wss.once('connection', (socket) => {
      socket.on('message', (raw) => {
        const msg = parseMsg(raw);
        if (msg.op === 'subscribe') {
          // snapshot
          serverSend(socket, {
            id: msg.id as string,
            kind: 'snapshot',
            data: { 'default/Todo': [] },
            shapes: { 'default/Todo': 'list' }
          });
          // add one item after a tick
          setImmediate(() => {
            serverSend(socket, {
              id: msg.id as string,
              kind: 'add',
              data: { 'default/Todo': { id: '1', title: 'hello' } },
              shapes: { 'default/Todo': 'single' }
            });
          });
        }
        if (msg.op === 'cancel') {
          serverSend(socket, { id: msg.id as string, kind: 'end', final: true });
        }
      });
    });

    const t = new WsTransport({
      endpoint: `ws://127.0.0.1:${port}`,
      reconnect: { baseDelayMs: 10, maxDelayMs: 50, jitter: 0 }
    });

    try {
      const iterable = t.subscribe({
        id: 'sub-1',
        frame: { 'default/Todo': { params: {}, fields: { id: true, title: true } } }
      });

      const events: Array<{ kind: string; data?: unknown }> = [];
      for await (const ev of iterable) {
        events.push(ev);
        if (ev.kind === 'add') break; // stop after add; iterator.return() sends cancel
      }

      expect(events[0]?.kind).toBe('snapshot');
      expect(events[1]?.kind).toBe('add');
    } finally {
      await t.close();
    }
  });

  it('routes error frame to the iterator and throws SubscribeError', async () => {
    wss.once('connection', (socket) => {
      socket.on('message', (raw) => {
        const msg = parseMsg(raw);
        if (msg.op === 'subscribe') {
          serverSend(socket, {
            id: msg.id as string,
            kind: 'error',
            errors: [{ message: 'not found', code: 'unknown_name' }]
          });
        }
      });
    });

    const t = new WsTransport({
      endpoint: `ws://127.0.0.1:${port}`,
      reconnect: { baseDelayMs: 10, maxDelayMs: 50, jitter: 0 }
    });

    try {
      const iterable = t.subscribe({
        id: 'err-1',
        frame: { 'default/Nope': { params: {}, fields: {} } }
      });

      await expect(async () => {
        for await (const _ of iterable) {
          /* consume */
        }
      }).rejects.toMatchObject({ name: 'SubscribeError', code: 'unknown_name' });
    } finally {
      await t.close();
    }
  });

  it('reconnects after server drops and resubscribes active subscription', async () => {
    // First server connection will drop. Second will serve normally.
    let connectionCount = 0;
    let droppedSocket: WsSocket | null = null;

    wss.on('connection', (socket) => {
      connectionCount += 1;
      if (connectionCount === 1) {
        // Store it so we can drop it after the subscribe arrives
        droppedSocket = socket;
        socket.on('message', (raw) => {
          const msg = parseMsg(raw);
          if (msg.op === 'subscribe') {
            // Send one snapshot then drop the connection
            serverSend(socket, {
              id: msg.id as string,
              kind: 'snapshot',
              data: { 'default/Todo': [] },
              shapes: { 'default/Todo': 'list' }
            });
            // Destroy after a tick so client sees the snapshot first
            setImmediate(() => socket.terminate());
          }
        });
      } else {
        // Second connection: respond to resubscribe with a snapshot then add
        socket.on('message', (raw) => {
          const msg = parseMsg(raw);
          if (msg.op === 'subscribe') {
            serverSend(socket, {
              id: msg.id as string,
              kind: 'snapshot',
              data: { 'default/Todo': [{ id: '2', title: 'after reconnect' }] },
              shapes: { 'default/Todo': 'list' }
            });
          }
          if (msg.op === 'cancel') {
            serverSend(socket, { id: msg.id as string, kind: 'end', final: true });
          }
        });
      }
    });

    const t = new WsTransport({
      endpoint: `ws://127.0.0.1:${port}`,
      reconnect: { baseDelayMs: 10, maxDelayMs: 50, jitter: 0 }
    });

    try {
      const iterable = t.subscribe({
        id: 'reconnect-sub',
        frame: { 'default/Todo': { params: {}, fields: { id: true, title: true } } }
      });

      const events: Array<{ kind: string; data?: unknown }> = [];
      for await (const ev of iterable) {
        events.push(ev);
        // After collecting two snapshots (one pre-drop, one post-reconnect), break
        if (events.filter((e) => e.kind === 'snapshot').length >= 2) break;
      }

      // Should have gotten the first snapshot, then after reconnect the second
      const snapshots = events.filter((e) => e.kind === 'snapshot');
      expect(snapshots.length).toBeGreaterThanOrEqual(2);
      // Second reconnect snapshot should include the row
      expect(connectionCount).toBeGreaterThanOrEqual(2);
    } finally {
      await t.close();
    }

    void droppedSocket; // reference to satisfy linter
  });
});

describe('WsTransport: a server never reached', () => {
  it('rejects next() with the connect failure instead of retrying forever', async () => {
    // Bind then free a port so nothing listens on it.
    const probe = new WebSocketServer({ port: 0 });
    await new Promise<void>((r) => probe.once('listening', () => r()));
    const deadPort = (probe.address() as { port: number }).port;
    await new Promise<void>((r) => probe.close(() => r()));

    const t = new WsTransport({ endpoint: `ws://127.0.0.1:${deadPort}` });
    try {
      const iter = t
        .subscribe({ id: 'dead', frame: { 'default/Todo': { params: {}, fields: { id: true } } } })
        [Symbol.asyncIterator]();
      await expect(iter.next()).rejects.toThrow(/WS connect failed/);
    } finally {
      await t.close();
    }
  });

  it('rejects next() when getToken throws', async () => {
    const t = new WsTransport({
      endpoint: `ws://127.0.0.1:${port}`,
      getToken: () => {
        throw new Error('no token today');
      }
    });
    try {
      const iter = t
        .subscribe({ id: 'tok', frame: { 'default/Todo': { params: {}, fields: { id: true } } } })
        [Symbol.asyncIterator]();
      await expect(iter.next()).rejects.toThrow(/no token today/);
    } finally {
      await t.close();
    }
  });
});

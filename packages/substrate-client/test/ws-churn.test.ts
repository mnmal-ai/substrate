/**
 * Closes that arrive AFTER the server accepted the socket: overload (1013)
 * and an expired credential (4001). The open loop only backed off when an
 * open failed, so a server that accepts and then closes was reconnected at
 * round-trip speed forever; and a credential that lapsed mid-subscription
 * ended it quietly even when a token provider could mint a fresh one.
 */

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

const parse = (raw: unknown): Record<string, unknown> =>
  JSON.parse(Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw)) as Record<string, unknown>;
const send = (s: WsSocket, f: Record<string, unknown>): void => s.send(JSON.stringify(f));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('WsTransport — closes after an accepted upgrade', () => {
  it('backs off, growing, when the server keeps closing with 1013', async () => {
    let connections = 0;
    wss.on('connection', (socket) => {
      connections += 1;
      socket.on('message', (raw) => {
        const msg = parse(raw);
        if (msg.op !== 'subscribe') return;
        // A snapshot first, as for a slow consumer closed on send_buffer_full.
        send(socket, { id: msg.id, kind: 'snapshot', data: { 'default/Todo': [] } });
        socket.close(1013, 'send_buffer_full');
      });
    });

    const t = new WsTransport({
      endpoint: `ws://127.0.0.1:${port}`,
      reconnect: { baseDelayMs: 20, maxDelayMs: 200, jitter: 0 }
    });
    try {
      const iter = t
        .subscribe({ id: 's', frame: { 'default/Todo': { params: {}, fields: { id: true } } } })
        [Symbol.asyncIterator]();
      await iter.next();
      await sleep(500);
      // Backoff 20, 40, 80, 160, 200 ms: about six opens in 500 ms. Reopening
      // at once on every close made hundreds.
      expect(connections).toBeGreaterThan(1);
      expect(connections).toBeLessThanOrEqual(8);
      await iter.return?.();
    } finally {
      await t.close();
    }
  });

  it('a lapsed credential with a token provider resubscribes on a fresh token', async () => {
    const auths: Array<string | undefined> = [];
    wss.on('connection', (socket, req) => {
      auths.push(req.headers.authorization);
      const first = auths.length === 1;
      socket.on('message', (raw) => {
        const msg = parse(raw);
        if (msg.op !== 'subscribe') return;
        send(socket, { id: msg.id, kind: 'snapshot', data: { 'default/Todo': [] } });
        if (first) {
          // What the server does when the token expires mid-stream.
          setTimeout(() => {
            send(socket, { id: msg.id, kind: 'end', reason: 'credential_expired', final: true });
            socket.close(4001, 'credential_expired');
          }, 60);
        }
      });
    });

    let minted = 0;
    const t = new WsTransport({
      endpoint: `ws://127.0.0.1:${port}`,
      getToken: () => `tok-${++minted}`,
      reconnect: { baseDelayMs: 5, maxDelayMs: 20, jitter: 0 }
    });
    try {
      const kinds: string[] = [];
      const iter = t
        .subscribe({ id: 's', frame: { 'default/Todo': { params: {}, fields: { id: true } } } })
        [Symbol.asyncIterator]();
      for (let i = 0; i < 3; i++) {
        const r = await iter.next();
        if (r.done) break;
        kinds.push(r.value.kind);
      }
      expect(kinds).toEqual(['snapshot', 'end', 'snapshot']);
      expect(auths).toEqual(['Bearer tok-1', 'Bearer tok-2']);
      await iter.return?.();
    } finally {
      await t.close();
    }
  });

  it('a provider whose tokens are refused at once still fails, without a loop', async () => {
    let connections = 0;
    wss.on('connection', (socket) => {
      connections += 1;
      socket.close(4001, 'unauthorized');
    });
    const t = new WsTransport({
      endpoint: `ws://127.0.0.1:${port}`,
      getToken: () => 'refused',
      reconnect: { baseDelayMs: 5, maxDelayMs: 20, jitter: 0 }
    });
    try {
      await expect(async () => {
        for await (const _ev of t.subscribe({ id: 's', frame: { 'default/Todo': {} } })) {
          // no frames expected
        }
      }).rejects.toThrow(/unauthorized|4001/i);
      await sleep(150);
      expect(connections).toBe(1);
    } finally {
      await t.close();
    }
  });
});

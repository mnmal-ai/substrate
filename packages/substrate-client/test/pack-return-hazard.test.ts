/**
 * Pack-mode return() hazard. A native async generator wrapper would queue
 * return() behind the in-flight next(), which on a quiet connection never
 * resolves. These tests pin the contract: return() resolves promptly even
 * with nothing in flight.
 *
 * Reproduction note: the hang manifests only when the outer generator is in
 * Suspended-Await state — i.e., the consumer has called outerIt.next() again
 * (which causes the generator to await inner.next() inside for-await) AND the
 * inner's waiter promise is unresolved. The test therefore reads the snapshot,
 * then calls outerIt.next() a second time without awaiting it, gives the
 * microtask queue a tick to let the generator enter Suspended-Await, and only
 * then calls return(). Calling return() directly after the first next() call
 * (before a second next()) leaves the generator in Suspended-Yield and does NOT
 * reproduce the hang.
 *
 * That decode still applies through the wrapper is covered in
 * integration.test.ts ('pack-mode decode still applies + return() is prompt').
 */

import * as http from 'node:http';
import { decodeWsEnvelope, encodeWsFrame } from '@mnmal-ai/substrate-pack';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocketServer, type WebSocket as WsSocket } from 'ws';
import { SubstrateClient } from '../src/index.js';

/** Minimal schema for the fake server — enough for the client's schema cache. */
const FAKE_SCHEMA = {
  default: {
    name: 'default',
    version: '1',
    types: {
      Todo: {
        name: 'Todo',
        fields: { id: { type: 'string' }, title: { type: 'string' } }
      }
    },
    mutations: {}
  }
};

let httpServer: http.Server;
let wss: WebSocketServer;
let port: number;
let client: SubstrateClient;

beforeEach(async () => {
  // HTTP server handles the federated-schema endpoint the client fetches at
  // schema-cache warm-up, and serves as the upgrade host for WebSocket.
  httpServer = http.createServer((req, res) => {
    if (req.url === '/substrate/v1/federated-schema') {
      const body = JSON.stringify(FAKE_SCHEMA);
      res.writeHead(200, {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body)
      });
      res.end(body);
      return;
    }
    res.writeHead(404);
    res.end();
  });

  // Accept the substrate-pack subprotocol the client advertises at handshake.
  wss = new WebSocketServer({
    server: httpServer,
    handleProtocols: (protocols) => [...protocols][0] ?? false
  });

  await new Promise<void>((r) => httpServer.listen(0, '127.0.0.1', () => r()));
  const addr = httpServer.address();
  port = typeof addr === 'object' && addr ? (addr as { port: number }).port : 0;

  client = new SubstrateClient({ endpoint: `http://127.0.0.1:${port}`, wsEncoding: 'pack' });
});

afterEach(async () => {
  await client.close();
  await new Promise<void>((r) => wss.close(() => r()));
  await new Promise<void>((r) => httpServer.close(() => r()));
});

/**
 * Helper: send a pack-encoded frame from the server to the client.
 */
function sendPack(socket: WsSocket, frame: Record<string, unknown>): void {
  socket.send(encodeWsFrame(frame, 'pack'));
}

/**
 * Helper: parse a raw inbound message from the client (pack-encoded) into a
 * plain object. The client sends subscribe/cancel frames in pack mode.
 */
function parsePack(raw: unknown): Record<string, unknown> {
  return decodeWsEnvelope<Record<string, unknown>>(raw, 'pack');
}

describe('pack-mode return() on a quiet connection', () => {
  it('resolves promptly instead of hanging behind a parked next()', async () => {
    // Server: on subscribe, send ONE pack-encoded snapshot, then go quiet.
    //
    // Consumer flow that reproduces the Suspended-Await hazard:
    //   1. Read the snapshot via it1.next() — generator yields, enters Suspended-Yield.
    //   2. Call it1.next() a second time (unawaited) — generator re-enters for-await
    //      and calls inner.next(), which parks on the transport waiter.
    //      A microtask delay lets the generator reach Suspended-Await.
    //   3. Call it1.return!() — a native generator would queue this behind the
    //      parked inner.next() → outcome = 'timeout'. The wrapper forwards
    //      return() to inner immediately → outcome = 'returned'.
    wss.once('connection', (socket) => {
      socket.on('message', (raw) => {
        const msg = parsePack(raw);
        if (msg.op !== 'subscribe') return;
        // One snapshot, then silence — the second next() will park forever.
        sendPack(socket, {
          id: msg.id,
          kind: 'snapshot',
          data: { 'default/Todo': [] }
        });
      });
    });

    const it1 = client
      .subscribe({
        'default/Todo': { params: {}, fields: { id: true } }
      })
      [Symbol.asyncIterator]();

    // Step 1: read snapshot.
    const first = await it1.next();
    expect((first.value as { kind: string }).kind).toBe('snapshot');

    // Step 2: trigger the generator to call inner.next() (Suspended-Await).
    // Do NOT await — we need the generator to be blocked when return() fires.
    void it1.next();

    // Give the microtask queue time to let the generator enter Suspended-Await.
    await new Promise<void>((r) => setTimeout(r, 20));

    // Step 3: race return() vs. timeout — the documented hang scenario.
    const outcome = await Promise.race([
      it1.return!().then(() => 'returned'),
      new Promise<string>((r) => setTimeout(() => r('timeout'), 1000))
    ]);
    expect(outcome).toBe('returned');
  });

  it('still sends the cancel frame to the server', async () => {
    // Server records all inbound ops. After return(), the server must have
    // received a cancel frame.
    const receivedOps: string[] = [];
    let cancelResolve: (() => void) | null = null;
    const cancelSeen = new Promise<void>((r) => {
      cancelResolve = r;
    });

    wss.once('connection', (socket) => {
      socket.on('message', (raw) => {
        const msg = parsePack(raw);
        const op = typeof msg.op === 'string' ? msg.op : '';
        receivedOps.push(op);
        if (op === 'subscribe') {
          sendPack(socket, {
            id: msg.id,
            kind: 'snapshot',
            data: { 'default/Todo': [] }
          });
        } else if (op === 'cancel') {
          cancelResolve!();
        }
      });
    });

    const it1 = client
      .subscribe({
        'default/Todo': { params: {}, fields: { id: true } }
      })
      [Symbol.asyncIterator]();

    // Read snapshot, then trigger Suspended-Await (same pattern as test 1).
    const first = await it1.next();
    expect((first.value as { kind: string }).kind).toBe('snapshot');
    void it1.next();
    await new Promise<void>((r) => setTimeout(r, 20));

    // return() must resolve promptly and trigger the cancel frame.
    await it1.return!();

    // Wait for the server to observe the cancel (with a generous timeout).
    const cancelOutcome = await Promise.race([
      cancelSeen.then(() => 'cancel-seen'),
      new Promise<string>((r) => setTimeout(() => r('timeout'), 1000))
    ]);
    expect(cancelOutcome).toBe('cancel-seen');
    expect(receivedOps).toContain('cancel');
  });
});

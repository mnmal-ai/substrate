/**
 * Server-initiated graceful WS shutdown.
 *
 * Clients need a structured signal that a close is a server restart rather
 * than an unexpected drop (a bare 1006 with no payload).
 *
 * The server tracks live conns in `inFlightWs`, exposes an `onShutdown(cb)` hook
 * on `WsConnection`, and walks the registry on `stop()` — invoking each
 * conn's emitter (so the route layer can flush structured `end{reason}`
 * frames per active subscription) before closing the socket with code 1012
 * (Service Restart).
 */

import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { FastifySubstrateServer } from '../src/index.js';

const servers: FastifySubstrateServer[] = [];

function track(s: FastifySubstrateServer): FastifySubstrateServer {
  servers.push(s);
  return s;
}

afterEach(async () => {
  while (servers.length) {
    const s = servers.pop();
    if (s) {
      try {
        await s.stop();
      } catch {
        // Already stopped by the test body — ignore.
      }
    }
  }
});

function waitOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
}

describe('FastifySubstrateServer WS graceful shutdown', () => {
  it('invokes registered onShutdown emitter and closes with 1012', async () => {
    const server = track(new FastifySubstrateServer());
    let receivedReason: string | null = null;

    server.websocket('/substrate/v1/ws', (_req, conn) => {
      conn.onShutdown?.((reason) => {
        receivedReason = reason;
        // Emit a structured "drain" frame the way the real route layer does.
        conn.send(JSON.stringify({ id: 'sub-1', kind: 'end', reason, final: true }));
      });
    });

    const { port } = await server.start({ host: '127.0.0.1', port: 0 });
    const ws = new WebSocket(`ws://127.0.0.1:${port}/substrate/v1/ws`);
    await waitOpen(ws);

    const drain = new Promise<{ frame: string; closeCode: number; closeReason: string }>(
      (resolve) => {
        let frame = '';
        ws.on('message', (data) => {
          frame = Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
        });
        ws.on('close', (code, reasonBuf) => {
          resolve({
            frame,
            closeCode: code,
            closeReason: Buffer.isBuffer(reasonBuf) ? reasonBuf.toString('utf8') : String(reasonBuf)
          });
        });
      }
    );

    await server.stop();
    const observed = await drain;

    expect(receivedReason).toBe('server_restart');
    expect(JSON.parse(observed.frame)).toEqual({
      id: 'sub-1',
      kind: 'end',
      reason: 'server_restart',
      final: true
    });
    expect(observed.closeCode).toBe(1012);
    expect(observed.closeReason).toBe('server_restart');
  });

  it('closes cleanly even when no onShutdown emitter was registered', async () => {
    const server = track(new FastifySubstrateServer());
    server.websocket('/substrate/v1/ws', () => {
      // Handler intentionally registers nothing — exercise the null-emitter path.
    });

    const { port } = await server.start({ host: '127.0.0.1', port: 0 });
    const ws = new WebSocket(`ws://127.0.0.1:${port}/substrate/v1/ws`);
    await waitOpen(ws);

    const closed = new Promise<number>((resolve) => {
      ws.on('close', (code) => resolve(code));
    });

    await server.stop();
    expect(await closed).toBe(1012);
  });

  it('walks every live connection on stop, not just one', async () => {
    const server = track(new FastifySubstrateServer());
    let drained = 0;
    server.websocket('/substrate/v1/ws', (_req, conn) => {
      conn.onShutdown?.(() => {
        drained += 1;
      });
    });

    const { port } = await server.start({ host: '127.0.0.1', port: 0 });
    const sockets = await Promise.all(
      [0, 1, 2].map(async () => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/substrate/v1/ws`);
        await waitOpen(ws);
        return ws;
      })
    );

    await server.stop();
    // All three emitters fire before the sockets close.
    expect(drained).toBe(3);

    // Drain any pending close frames so the test exits cleanly.
    await Promise.all(sockets.map((s) => new Promise<void>((r) => s.on('close', () => r()))));
  });

  it('survives an emitter that throws (one bad conn does not block the rest)', async () => {
    const server = track(new FastifySubstrateServer());
    let secondDrained = false;

    let connCount = 0;
    server.websocket('/substrate/v1/ws', (_req, conn) => {
      const which = connCount++;
      conn.onShutdown?.(() => {
        if (which === 0) throw new Error('first conn emitter explodes');
        secondDrained = true;
      });
    });

    const { port } = await server.start({ host: '127.0.0.1', port: 0 });
    const ws1 = new WebSocket(`ws://127.0.0.1:${port}/substrate/v1/ws`);
    const ws2 = new WebSocket(`ws://127.0.0.1:${port}/substrate/v1/ws`);
    await waitOpen(ws1);
    await waitOpen(ws2);

    await server.stop();
    expect(secondDrained).toBe(true);

    await Promise.all([ws1, ws2].map((s) => new Promise<void>((r) => s.on('close', () => r()))));
  });
});

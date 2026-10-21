/**
 * WS auth: the bearer must survive Node ≥22, whose global WHATWG WebSocket
 * (undici) cannot carry headers.
 *
 * Contract under test:
 * 1. Under Node, node-ws is preferred even when globalThis.WebSocket exists —
 *    the bearer rides the upgrade.
 * 2. A `webSocket` injection option lets consumers supply a node-ws-compatible
 *    implementation explicitly.
 * 3. Close code 4001 (unauthorized) is TERMINAL: active subscriptions surface
 *    an error instead of silently reconnecting forever.
 * 4. selectWebSocketImpl fails fast when a token is configured but the only
 *    available implementation cannot carry headers (true browser).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket as NodeWebSocket, WebSocketServer } from 'ws';
import { SubstrateClient } from '../src/client.js';
import { selectWebSocketImpl, WsTransport } from '../src/transport/ws.js';

let wss: WebSocketServer;
let port: number;

beforeEach(async () => {
  wss = new WebSocketServer({ port: 0 });
  await new Promise<void>((r) => wss.once('listening', () => r()));
  const addr = wss.address();
  port = typeof addr === 'object' && addr ? (addr as { port: number }).port : 0;
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await new Promise<void>((r) => wss.close(() => r()));
});

describe('WsTransport auth', () => {
  it('carries the bearer on the upgrade even when globalThis.WebSocket exists', async () => {
    // Booby-trap the native path: constructing via the global must not happen
    // under Node, where node-ws is the only implementation that can carry the
    // Authorization header.
    class TrapWebSocket {
      constructor() {
        throw new Error('native WebSocket path must not be taken under Node');
      }
    }
    vi.stubGlobal('WebSocket', TrapWebSocket);

    const seenAuth = new Promise<string | undefined>((resolve) => {
      wss.once('connection', (socket, req) => {
        resolve(req.headers.authorization);
        socket.on('message', () => {
          socket.send(JSON.stringify({ id: 'sub-1', kind: 'end', final: true }));
        });
      });
    });

    const t = new WsTransport({
      endpoint: `ws://127.0.0.1:${port}`,
      token: 'tok-123',
      reconnect: { baseDelayMs: 10, maxDelayMs: 50, jitter: 0 }
    });
    try {
      const iterable = t.subscribe({ id: 'sub-1', frame: { 'default/Todo': {} } });
      for await (const ev of iterable) {
        if (ev.kind === 'end') break;
      }
      await expect(seenAuth).resolves.toBe('Bearer tok-123');
    } finally {
      await t.close();
    }
  });

  it('uses an injected webSocket implementation and passes it the auth header', async () => {
    const calls: Array<{ url: string; headers: Record<string, string> | undefined }> = [];
    function RecordingWs(
      this: unknown,
      url: string,
      protocolsOrOpts?: unknown,
      maybeOpts?: { headers?: Record<string, string> }
    ) {
      const opts = (maybeOpts ?? protocolsOrOpts) as { headers?: Record<string, string> };
      calls.push({ url, headers: opts?.headers });
      return new NodeWebSocket(
        url,
        Array.isArray(protocolsOrOpts) ? protocolsOrOpts : undefined,
        opts
      );
    }

    wss.once('connection', (socket) => {
      socket.on('message', () => {
        socket.send(JSON.stringify({ id: 'sub-1', kind: 'end', final: true }));
      });
    });

    const t = new WsTransport({
      endpoint: `ws://127.0.0.1:${port}`,
      token: 'tok-456',
      webSocket: RecordingWs as never,
      reconnect: { baseDelayMs: 10, maxDelayMs: 50, jitter: 0 }
    });
    try {
      const iterable = t.subscribe({ id: 'sub-1', frame: { 'default/Todo': {} } });
      for await (const ev of iterable) {
        if (ev.kind === 'end') break;
      }
      expect(calls).toHaveLength(1);
      expect(calls[0]?.headers?.authorization).toBe('Bearer tok-456');
    } finally {
      await t.close();
    }
  });

  it('treats close 4001 (unauthorized) as terminal — error surfaced, no silent retry loop', async () => {
    let connections = 0;
    wss.on('connection', (socket) => {
      connections += 1;
      // Auth-gated server: accept the upgrade, then close 4001 unauthorized.
      socket.close(4001, 'unauthorized');
    });

    const t = new WsTransport({
      endpoint: `ws://127.0.0.1:${port}`,
      token: 'rejected-token',
      reconnect: { baseDelayMs: 5, maxDelayMs: 20, jitter: 0 }
    });
    try {
      const iterable = t.subscribe({ id: 'sub-1', frame: { 'default/Todo': {} } });
      await expect(async () => {
        for await (const _ev of iterable) {
          // no frames expected
        }
      }).rejects.toThrow(/unauthorized|4001/i);

      // Give any (buggy) reconnect loop a few backoff windows to fire.
      await new Promise((r) => setTimeout(r, 150));
      expect(connections).toBe(1);
    } finally {
      await t.close();
    }
  });
});

describe('SubstrateClient webSocket injection', () => {
  it('forwards the webSocket option to the transport', async () => {
    const calls: string[] = [];
    function RecordingWs(
      this: unknown,
      url: string,
      protocols?: string | string[],
      opts?: { headers?: Record<string, string> }
    ) {
      calls.push(url);
      return new NodeWebSocket(url, protocols, opts);
    }

    wss.once('connection', (socket) => {
      socket.on('message', (raw) => {
        const msg = JSON.parse(String(raw)) as { id: string };
        socket.send(JSON.stringify({ id: msg.id, kind: 'end', final: true }));
      });
    });

    const client = new SubstrateClient({
      endpoint: `http://127.0.0.1:${port}`,
      token: 'tok-789',
      webSocket: RecordingWs as never
    });
    try {
      for await (const ev of client.subscribe({ 'default/Todo': {} })) {
        if (ev.kind === 'end') break;
      }
      expect(calls).toEqual([`ws://127.0.0.1:${port}/substrate/v1/ws`]);
    } finally {
      await client.close();
    }
  });
});

describe('selectWebSocketImpl', () => {
  const Native = class {} as unknown as typeof NodeWebSocket;
  const Injected = class {} as unknown as typeof NodeWebSocket;
  const NodeImpl = class {} as unknown as typeof NodeWebSocket;

  it('prefers an injected implementation over everything', () => {
    expect(
      selectWebSocketImpl({
        injected: Injected,
        isNode: true,
        globalWs: Native,
        nodeWs: NodeImpl,
        hasToken: true
      })
    ).toEqual({ impl: Injected, supportsHeaders: true });
  });

  it('prefers node-ws under Node even when a global WebSocket exists', () => {
    expect(
      selectWebSocketImpl({
        injected: undefined,
        isNode: true,
        globalWs: Native,
        nodeWs: NodeImpl,
        hasToken: false
      })
    ).toEqual({ impl: NodeImpl, supportsHeaders: true });
  });

  it('uses the global WebSocket outside Node when no token is configured', () => {
    expect(
      selectWebSocketImpl({
        injected: undefined,
        isNode: false,
        globalWs: Native,
        nodeWs: NodeImpl,
        hasToken: false
      })
    ).toEqual({ impl: Native, supportsHeaders: false });
  });

  it('fails fast when a token is configured but only a headerless implementation exists', () => {
    expect(() =>
      selectWebSocketImpl({
        injected: undefined,
        isNode: false,
        globalWs: Native,
        nodeWs: NodeImpl,
        hasToken: true
      })
    ).toThrow(/header|bearer|token/i);
  });
});

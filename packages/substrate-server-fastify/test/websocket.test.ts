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
    if (s) await s.stop();
  }
});

function waitOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
}

function asBuffer(data: unknown): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (Array.isArray(data)) return Buffer.concat(data as Buffer[]);
  return Buffer.from(String(data));
}

function waitMessage(ws: WebSocket): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    ws.once('message', (data) => resolve(asBuffer(data)));
    ws.once('error', reject);
  });
}

function waitClose(ws: WebSocket): Promise<number> {
  return new Promise((resolve) => {
    ws.once('close', (code) => resolve(code));
  });
}

describe('FastifySubstrateServer websocket', () => {
  it('closes a socket that sends a frame over wsMaxPayload', async () => {
    const server = track(new FastifySubstrateServer({ wsMaxPayload: 1024 }));
    server.websocket('/substrate/v1/ws', () => {});
    const { port } = await server.start({ host: '127.0.0.1', port: 0 });
    const ws = new WebSocket(`ws://127.0.0.1:${port}/substrate/v1/ws`);
    await waitOpen(ws);
    const closed = waitClose(ws);
    ws.send(Buffer.alloc(2048));
    expect(await closed).toBe(1009); // 1009 = message too big
  });

  it('terminates a socket whose peer stops reading once the buffer passes wsMaxBuffered', async () => {
    const server = track(new FastifySubstrateServer({ wsMaxBuffered: 64 * 1024 }));
    const chunk = Buffer.alloc(256 * 1024);
    const closed = new Promise<void>((resolve) => {
      server.websocket('/substrate/v1/ws', (_req, conn) => {
        let open = true;
        conn.onClose(() => {
          open = false;
          resolve();
        });
        const pump = (): void => {
          if (!open) return;
          conn.send(chunk);
          setImmediate(pump);
        };
        pump();
      });
    });
    const { port } = await server.start({ host: '127.0.0.1', port: 0 });
    const ws = new WebSocket(`ws://127.0.0.1:${port}/substrate/v1/ws`);
    ws.on('upgrade', (res) => res.socket.pause());
    await closed;
    ws.terminate();
  });

  it('closes 1013 send_buffer_full, not a bare drop, when the buffer passes wsMaxBuffered', async () => {
    const warnings: string[] = [];
    const server = track(
      new FastifySubstrateServer({ wsMaxBuffered: 64 * 1024, onWarn: (m) => warnings.push(m) })
    );
    const chunk = Buffer.alloc(256 * 1024);
    server.websocket('/substrate/v1/ws', (_req, conn) => {
      let open = true;
      conn.onClose(() => {
        open = false;
      });
      const pump = (): void => {
        if (!open) return;
        conn.send(chunk);
        setImmediate(pump);
      };
      pump();
    });
    const { port } = await server.start({ host: '127.0.0.1', port: 0 });
    const ws = new WebSocket(`ws://127.0.0.1:${port}/substrate/v1/ws`);
    // A slow reader: stalls long enough to fill the buffer, then catches up.
    ws.on('upgrade', (res) => {
      res.socket.pause();
      setTimeout(() => res.socket.resume(), 200);
    });
    const closed = new Promise<[number, string]>((resolve) => {
      ws.once('close', (code, reason) => resolve([code, reason.toString()]));
    });
    expect(await closed).toEqual([1013, 'send_buffer_full']);
    expect(warnings).toEqual([expect.stringMatching(/send buffer full/)]);
  });

  it('reports a rejecting handler to onError and closes 1011', async () => {
    const server = track(new FastifySubstrateServer());
    const seen: Error[] = [];
    server.onError((err) => {
      seen.push(err);
    });
    server.websocket('/substrate/v1/ws', async () => {
      throw new Error('handler blew up');
    });
    const { port } = await server.start({ host: '127.0.0.1', port: 0 });
    const ws = new WebSocket(`ws://127.0.0.1:${port}/substrate/v1/ws`);
    const closed = waitClose(ws);
    expect(await closed).toBe(1011);
    expect(seen.map((e) => e.message)).toEqual(['handler blew up']);
  });

  it('round-trips a message', async () => {
    const server = track(new FastifySubstrateServer());
    server.websocket('/substrate/v1/ws', (_req, conn) => {
      conn.onMessage((buf) => {
        expect(Buffer.isBuffer(buf)).toBe(true);
        conn.send(Buffer.concat([Buffer.from('echo:'), buf]));
      });
    });
    const { port } = await server.start({ host: '127.0.0.1', port: 0 });
    const ws = new WebSocket(`ws://127.0.0.1:${port}/substrate/v1/ws`);
    await waitOpen(ws);
    const got = waitMessage(ws);
    ws.send('hello');
    const frame = await got;
    expect(frame.toString()).toBe('echo:hello');
    ws.close();
  });

  it('accepts Buffer and string frames on send()', async () => {
    const server = track(new FastifySubstrateServer());
    server.websocket('/ws', (_req, conn) => {
      conn.send('string-frame');
      conn.send(Buffer.from('buffer-frame'));
    });
    const { port } = await server.start({ host: '127.0.0.1', port: 0 });
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const frames: string[] = [];
    const gotTwo = new Promise<void>((resolve) => {
      ws.on('message', (data) => {
        frames.push(asBuffer(data).toString());
        if (frames.length === 2) resolve();
      });
    });
    await waitOpen(ws);
    await gotTwo;
    expect(frames).toEqual(['string-frame', 'buffer-frame']);
    ws.close();
  });

  it('propagates close(code, reason) to the client', async () => {
    const server = track(new FastifySubstrateServer());
    server.websocket('/ws', (_req, conn) => {
      conn.onMessage(() => conn.close(4010, 'bye'));
    });
    const { port } = await server.start({ host: '127.0.0.1', port: 0 });
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await waitOpen(ws);
    const closed = waitClose(ws);
    ws.send('go');
    expect(await closed).toBe(4010);
  });

  it('fires onClose on the server when the client closes', async () => {
    const server = track(new FastifySubstrateServer());
    const closed = new Promise<number | undefined>((resolve) => {
      server.websocket('/ws', (_req, conn) => {
        conn.onClose((code) => resolve(code));
      });
    });
    const { port } = await server.start({ host: '127.0.0.1', port: 0 });
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await waitOpen(ws);
    ws.close(4020, 'client-bye');
    const serverCode = await closed;
    expect(serverCode).toBe(4020);
  });

  it('assigns a unique id to each concurrent connection', async () => {
    const server = track(new FastifySubstrateServer());
    const ids: string[] = [];
    server.websocket('/ws', (_req, conn) => {
      ids.push(conn.id);
      conn.send(conn.id);
    });
    const { port } = await server.start({ host: '127.0.0.1', port: 0 });
    const a = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const b = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const aMsg = waitMessage(a);
    const bMsg = waitMessage(b);
    await Promise.all([waitOpen(a), waitOpen(b)]);
    const [aFrame, bFrame] = await Promise.all([aMsg, bMsg]);
    expect(aFrame.toString()).not.toBe(bFrame.toString());
    expect(ids.length).toBe(2);
    expect(new Set(ids).size).toBe(2);
    a.close();
    b.close();
  });

  it('exposes upgrade path, headers, and query on req', async () => {
    const server = track(new FastifySubstrateServer());
    const seen = new Promise<{
      method: string;
      path: string;
      query: Record<string, string>;
      hasHeader: boolean;
      bodyIsNull: boolean;
    }>((resolve) => {
      server.websocket('/ws', (req, conn) => {
        resolve({
          method: req.method,
          path: req.path,
          query: req.query,
          hasHeader: typeof req.headers.host === 'string',
          bodyIsNull: req.body === null
        });
        conn.close(1000);
      });
    });
    const { port } = await server.start({ host: '127.0.0.1', port: 0 });
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=abc&room=lobby`);
    await waitOpen(ws);
    const info = await seen;
    expect(info.method).toBe('GET');
    expect(info.path).toBe('/ws');
    expect(info.query.token).toBe('abc');
    expect(info.query.room).toBe('lobby');
    expect(info.hasHeader).toBe(true);
    expect(info.bodyIsNull).toBe(true);
    ws.close();
  });

  // Fastify's WS routes accept ':param' path patterns and populate req.params
  // the same way HTTP routes do.
  it('populates req.params from a matched route pattern', async () => {
    const server = track(new FastifySubstrateServer());
    const seen = new Promise<Record<string, string>>((resolve) => {
      server.websocket('/chat/:room', (req, conn) => {
        resolve(req.params);
        conn.close(1000);
      });
    });
    const { port } = await server.start({ host: '127.0.0.1', port: 0 });
    const ws = new WebSocket(`ws://127.0.0.1:${port}/chat/general`);
    await waitOpen(ws);
    const params = await seen;
    expect(params.room).toBe('general');
    ws.close();
  });
});

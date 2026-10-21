import type { SubstrateRequest } from '@mnmal-ai/substrate-types';
import { describe, expect, it } from 'vitest';
import { MemorySubstrateServer, UnknownWsPathError, WsClosedError } from '../src/index.js';

describe('MemorySubstrateServer websocket', () => {
  it('round-trips a message between client and server handler', async () => {
    const server = new MemorySubstrateServer();
    server.websocket('/ws', (_req, conn) => {
      conn.onMessage((buf) => {
        conn.send(Buffer.concat([Buffer.from('echo:'), buf]));
      });
    });
    const client = server.connectWebsocket('/ws');
    const got = new Promise<Buffer>((resolve) => {
      client.onMessage((buf) => resolve(buf));
    });
    // Yield so the handler's microtask runs and registers its onMessage listener.
    await new Promise((r) => setImmediate(r));
    client.send(Buffer.from('hi'));
    const frame = await got;
    expect(frame.toString()).toBe('echo:hi');
  });

  it('lets the handler send unprompted frames that the client receives', async () => {
    const server = new MemorySubstrateServer();
    server.websocket('/ws', (_req, conn) => {
      conn.send(Buffer.from('hi-ack'));
    });
    const client = server.connectWebsocket('/ws');
    const got = new Promise<Buffer>((resolve) => {
      client.onMessage((buf) => resolve(buf));
    });
    const frame = await got;
    expect(frame.toString()).toBe('hi-ack');
  });

  it('fires onClose on the peer when either side closes', async () => {
    const server = new MemorySubstrateServer();
    let serverClosed: number | undefined;
    server.websocket('/ws', (_req, conn) => {
      conn.onClose((code) => {
        serverClosed = code;
      });
    });
    const client = server.connectWebsocket('/ws');
    const clientClosed = new Promise<number | undefined>((resolve) => {
      client.onClose((code) => resolve(code));
    });
    // Yield so the handler's microtask runs and registers its onClose listener.
    await new Promise((r) => setImmediate(r));
    client.close(4010, 'done');
    const code = await clientClosed;
    expect(code).toBe(4010);
    expect(serverClosed).toBe(4010);
  });

  it('close is idempotent (second close is a no-op)', async () => {
    const server = new MemorySubstrateServer();
    server.websocket('/ws', () => {});
    const client = server.connectWebsocket('/ws');
    await new Promise((r) => setImmediate(r));
    let calls = 0;
    client.onClose(() => {
      calls++;
    });
    client.close(1000);
    client.close(4000);
    expect(calls).toBe(1);
  });

  it('send on a closed endpoint throws WsClosedError', async () => {
    const server = new MemorySubstrateServer();
    server.websocket('/ws', () => {});
    const client = server.connectWebsocket('/ws');
    await new Promise((r) => setImmediate(r));
    client.close(1000);
    expect(() => client.send(Buffer.from('nope'))).toThrow(WsClosedError);
  });

  it('throws UnknownWsPathError for an unregistered path', () => {
    const server = new MemorySubstrateServer();
    expect(() => server.connectWebsocket('/missing')).toThrow(UnknownWsPathError);
  });

  it('accepts string and Uint8Array frames on send() and normalises to Buffer', async () => {
    const server = new MemorySubstrateServer();
    const received: string[] = [];
    server.websocket('/ws', (_req, conn) => {
      conn.onMessage((buf) => {
        received.push(buf.toString());
      });
    });
    const client = server.connectWebsocket('/ws');
    await new Promise((r) => setImmediate(r));
    client.send('text');
    client.send(Buffer.from('buf'));
    client.send(new Uint8Array([0x75, 0x38]));
    expect(received).toEqual(['text', 'buf', 'u8']);
  });

  it('assigns a unique id per connection', async () => {
    const server = new MemorySubstrateServer();
    const ids: string[] = [];
    server.websocket('/ws', (_req, conn) => {
      ids.push(conn.id);
    });
    server.connectWebsocket('/ws');
    server.connectWebsocket('/ws');
    await new Promise((r) => setImmediate(r));
    expect(ids.length).toBe(2);
    expect(new Set(ids).size).toBe(2);
  });

  it('surfaces captured path params on req.params', async () => {
    const server = new MemorySubstrateServer();
    const seen: SubstrateRequest[] = [];
    server.websocket('/ws/:room', (req) => {
      seen.push(req);
    });
    server.connectWebsocket('/ws/lobby');
    await new Promise((r) => setImmediate(r));
    expect(seen[0]?.params.room).toBe('lobby');
    expect(seen[0]?.path).toBe('/ws/lobby');
    expect(seen[0]?.method).toBe('GET');
    expect(seen[0]?.body).toBeNull();
  });

  it('parses the upgrade querystring into req.query', async () => {
    const server = new MemorySubstrateServer();
    const seen: SubstrateRequest[] = [];
    server.websocket('/ws', (req) => {
      seen.push(req);
    });
    server.connectWebsocket('/ws?token=abc&room=lobby');
    await new Promise((r) => setImmediate(r));
    expect(seen[0]?.query.token).toBe('abc');
    expect(seen[0]?.query.room).toBe('lobby');
    expect(seen[0]?.path).toBe('/ws');
  });

  it('forwards caller headers onto req.headers', async () => {
    const server = new MemorySubstrateServer();
    const seen: SubstrateRequest[] = [];
    server.websocket('/ws', (req) => {
      seen.push(req);
    });
    server.connectWebsocket('/ws', { authorization: 'Bearer xyz' });
    await new Promise((r) => setImmediate(r));
    expect(seen[0]?.headers.authorization).toBe('Bearer xyz');
  });
});

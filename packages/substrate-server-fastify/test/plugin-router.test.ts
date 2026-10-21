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

describe('createPluginRouter', () => {
  it('mounts plugin routes under /plugins/<name>', async () => {
    const server = new FastifySubstrateServer();
    const router = server.createPluginRouter({ name: 'demo' });
    router.get('/ping', async () => ({ status: 200, body: 'pong' }));
    router.post('/echo', async (req) => ({ status: 200, body: req.body ?? Buffer.alloc(0) }));
    router.put('/up', async () => ({ status: 202, body: 'put' }));
    router.delete('/rm', async () => ({ status: 204 }));
    router.patch('/p', async () => ({ status: 200, body: 'patch' }));

    const ping = await server.inject({ method: 'GET', path: '/substrate/v1/plugins/demo/ping' });
    expect(ping.status).toBe(200);
    expect(ping.body?.toString()).toBe('pong');

    // Un-prefixed path does not hit the plugin handler.
    const unprefixed = await server.inject({ method: 'GET', path: '/ping' });
    expect(unprefixed.status).toBe(404);

    const echo = await server.inject({
      method: 'POST',
      path: '/substrate/v1/plugins/demo/echo',
      headers: { 'content-type': 'application/octet-stream' },
      body: Buffer.from('x')
    });
    expect(echo.body?.toString()).toBe('x');

    const up = await server.inject({ method: 'PUT', path: '/substrate/v1/plugins/demo/up' });
    expect(up.status).toBe(202);

    const del = await server.inject({ method: 'DELETE', path: '/substrate/v1/plugins/demo/rm' });
    expect(del.status).toBe(204);

    const pat = await server.inject({ method: 'PATCH', path: '/substrate/v1/plugins/demo/p' });
    expect(pat.body?.toString()).toBe('patch');
  });

  it('two plugins with overlapping subpaths stay isolated under their own prefix', async () => {
    const server = new FastifySubstrateServer();
    const a = server.createPluginRouter({ name: 'a' });
    const b = server.createPluginRouter({ name: 'b' });
    a.get('/ping', async () => ({ status: 200, body: 'from-a' }));
    b.get('/ping', async () => ({ status: 200, body: 'from-b' }));

    const pingA = await server.inject({ method: 'GET', path: '/substrate/v1/plugins/a/ping' });
    const pingB = await server.inject({ method: 'GET', path: '/substrate/v1/plugins/b/ping' });
    expect(pingA.body?.toString()).toBe('from-a');
    expect(pingB.body?.toString()).toBe('from-b');
  });

  it('registers websocket routes via the plugin router', async () => {
    const server = track(new FastifySubstrateServer());
    const router = server.createPluginRouter({ name: 'demo' });
    router.websocket('/ws', (_req, conn) => {
      conn.onMessage((buf) => conn.send(buf));
    });
    const { port } = await server.start({ host: '127.0.0.1', port: 0 });
    const ws = new WebSocket(`ws://127.0.0.1:${port}/substrate/v1/plugins/demo/ws`);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    const got = new Promise<Buffer>((resolve) => {
      ws.once('message', (data) => {
        if (Buffer.isBuffer(data)) return resolve(data);
        if (data instanceof ArrayBuffer) return resolve(Buffer.from(data));
        if (Array.isArray(data)) return resolve(Buffer.concat(data as Buffer[]));
        resolve(Buffer.from(String(data)));
      });
    });
    ws.send('ping');
    expect((await got).toString()).toBe('ping');
    ws.close();
  });
});

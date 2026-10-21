import { describe, expect, it } from 'vitest';
import { MemorySubstrateServer } from '../src/index.js';

describe('MemorySubstrateServer.createPluginRouter', () => {
  it('mounts plugin routes under /plugins/<name>', async () => {
    const server = new MemorySubstrateServer();
    const router = server.createPluginRouter({ name: 'demo' });
    router.get('/ping', () => ({ status: 200, body: 'pong' }));
    router.post('/echo', (req) => ({ status: 200, body: req.body ?? Buffer.alloc(0) }));
    router.put('/up', () => ({ status: 202, body: 'put' }));
    router.delete('/rm', () => ({ status: 204 }));
    router.patch('/p', () => ({ status: 200, body: 'patch' }));

    const ping = await server.inject({ method: 'GET', path: '/substrate/v1/plugins/demo/ping' });
    expect(ping.status).toBe(200);
    expect(ping.body).toBe('pong');

    // Un-prefixed path does not hit the plugin handler.
    const unprefixed = await server.inject({ method: 'GET', path: '/ping' });
    expect(unprefixed.status).toBe(404);

    const echo = await server.inject({
      method: 'POST',
      path: '/substrate/v1/plugins/demo/echo',
      body: Buffer.from('x')
    });
    expect((echo.body as Buffer).toString()).toBe('x');

    const up = await server.inject({ method: 'PUT', path: '/substrate/v1/plugins/demo/up' });
    expect(up.status).toBe(202);

    const del = await server.inject({ method: 'DELETE', path: '/substrate/v1/plugins/demo/rm' });
    expect(del.status).toBe(204);

    const pat = await server.inject({ method: 'PATCH', path: '/substrate/v1/plugins/demo/p' });
    expect(pat.body).toBe('patch');
  });

  it('two plugins with overlapping subpaths stay isolated under their own prefix', async () => {
    const server = new MemorySubstrateServer();
    const a = server.createPluginRouter({ name: 'a' });
    const b = server.createPluginRouter({ name: 'b' });
    a.get('/ping', () => ({ status: 200, body: 'from-a' }));
    b.get('/ping', () => ({ status: 200, body: 'from-b' }));

    const pingA = await server.inject({ method: 'GET', path: '/substrate/v1/plugins/a/ping' });
    const pingB = await server.inject({ method: 'GET', path: '/substrate/v1/plugins/b/ping' });
    expect(pingA.body).toBe('from-a');
    expect(pingB.body).toBe('from-b');
  });

  it('registers websocket routes reachable via connectWebsocket()', async () => {
    const server = new MemorySubstrateServer();
    const router = server.createPluginRouter({ name: 'demo' });
    router.websocket('/ws', (_req, conn) => {
      conn.onMessage((buf) => conn.send(buf));
    });
    const client = server.connectWebsocket('/substrate/v1/plugins/demo/ws');
    const got = new Promise<Buffer>((resolve) => {
      client.onMessage((buf) => resolve(buf));
    });
    await new Promise((r) => setImmediate(r));
    client.send(Buffer.from('ping'));
    expect((await got).toString()).toBe('ping');
  });
});

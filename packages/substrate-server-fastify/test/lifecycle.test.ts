import { describe, expect, it } from 'vitest';
import { FastifySubstrateServer } from '../src/index.js';

describe('FastifySubstrateServer lifecycle', () => {
  it('start() returns a host and assigned port; stop() closes it', async () => {
    const server = new FastifySubstrateServer();
    server.route('GET', '/ok', async () => ({ status: 200, body: 'ok' }));
    const { address, port } = await server.start({ host: '127.0.0.1', port: 0 });
    expect(address).toBe('127.0.0.1');
    expect(port).toBeGreaterThan(0);
    const res = await fetch(`http://127.0.0.1:${port}/ok`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
    await server.stop();
    await expect(fetch(`http://127.0.0.1:${port}/ok`)).rejects.toThrow();
  });

  it('throws when start() is called twice', async () => {
    const server = new FastifySubstrateServer();
    await server.start({ host: '127.0.0.1', port: 0 });
    try {
      await expect(server.start({ host: '127.0.0.1', port: 0 })).rejects.toThrow();
    } finally {
      await server.stop();
    }
  });

  it('stop() with a grace timeout resolves within that grace even if close is slow', async () => {
    const server = new FastifySubstrateServer();
    server.route('GET', '/slow', async () => ({ status: 200, body: 'ok' }));
    await server.start({ host: '127.0.0.1', port: 0 });
    const start = Date.now();
    await server.stop({ grace: 50 });
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(500);
  });

  it('start() rejects when tls is requested without constructor tls config', async () => {
    const server = new FastifySubstrateServer();
    await expect(
      server.start({
        host: '127.0.0.1',
        port: 0,
        tls: { cert: 'x', key: 'y' }
      })
    ).rejects.toThrow(/tls/);
  });
});

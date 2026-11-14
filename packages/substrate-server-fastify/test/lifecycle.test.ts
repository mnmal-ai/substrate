import dns from 'node:dns';
import http2 from 'node:http2';
import net from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import { createH2Fetch } from '../../substrate-client/src/transport/h2-fetch.js';
import { FastifySubstrateServer } from '../src/index.js';

// The server speaks HTTP/2 only; the platform fetch speaks HTTP/1.1.
const h2fetch = createH2Fetch();

describe('FastifySubstrateServer lifecycle', () => {
  it('start() returns a host and assigned port; stop() closes it', async () => {
    const server = new FastifySubstrateServer();
    server.route('GET', '/ok', async () => ({ status: 200, body: 'ok' }));
    const { address, port } = await server.start({ host: '127.0.0.1', port: 0 });
    expect(address).toBe('127.0.0.1');
    expect(port).toBeGreaterThan(0);
    const res = await h2fetch(`http://127.0.0.1:${port}/ok`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
    await server.stop();
    await expect(h2fetch(`http://127.0.0.1:${port}/ok`)).rejects.toThrow();
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

/** Whether this box can bind the IPv6 loopback at all. */
async function canBindIpv6Loopback(): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.listen(0, '::1', () => probe.close(() => resolve(true)));
  });
}

describe.skipIf(!(await canBindIpv6Loopback()))('FastifySubstrateServer on host localhost', () => {
  it('stop({ grace }) destroys a session held open on the secondary ::1 listener', async () => {
    // Fastify binds a secondary server for each further address `localhost`
    // resolves to. Make it resolve to both loopbacks even where /etc/hosts maps
    // it to 127.0.0.1 only.
    const lookup = dns.lookup;
    const spy = vi.spyOn(dns, 'lookup').mockImplementation(((
      host: string,
      opts: unknown,
      cb: (err: Error | null, addresses: dns.LookupAddress[]) => void
    ) => {
      if (host !== 'localhost') return (lookup as (...a: unknown[]) => void)(host, opts, cb);
      cb(null, [
        { address: '127.0.0.1', family: 4 },
        { address: '::1', family: 6 }
      ]);
    }) as typeof dns.lookup);
    const server = new FastifySubstrateServer();
    server.route('GET', '/never', async () => ({
      status: 200,
      body: new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new Uint8Array([1]));
        }
      })
    }));
    let port: number;
    try {
      ({ port } = await server.start({ host: 'localhost', port: 0 }));
    } finally {
      spy.mockRestore();
    }
    const session = http2.connect(`http://[::1]:${port}`);
    session.on('error', () => {});
    const req = session.request({ ':path': '/never' });
    req.on('error', () => {});
    await new Promise<void>((r) => req.once('data', () => r()));
    const closed = new Promise<boolean>((r) => session.once('close', () => r(true)));
    const t0 = performance.now();
    await server.stop({ grace: 200 });
    const inTime = await Promise.race([
      closed,
      new Promise<boolean>((r) => setTimeout(() => r(false), 2000))
    ]);
    session.destroy();
    expect(inTime).toBe(true);
    expect(performance.now() - t0).toBeLessThan(2000);
  });
});

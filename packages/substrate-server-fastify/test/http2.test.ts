/**
 * The server speaks HTTP/2 only: over TLS by ALPN, and in cleartext with prior
 * knowledge (h2c). An HTTP/1.1 client is refused in both modes.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import http2 from 'node:http2';
import https from 'node:https';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { FastifySubstrateServer } from '../src/index.js';

function hasOpenssl(): boolean {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** A throwaway self-signed certificate for 127.0.0.1, made per run. */
function selfSigned(): { cert: string; key: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'substrate-h2-'));
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'ec',
      '-pkeyopt',
      'ec_paramgen_curve:prime256v1',
      '-nodes',
      '-keyout',
      join(dir, 'key.pem'),
      '-out',
      join(dir, 'cert.pem'),
      '-days',
      '1',
      '-subj',
      '/CN=127.0.0.1',
      '-addext',
      'subjectAltName=IP:127.0.0.1'
    ],
    { stdio: 'ignore' }
  );
  return {
    cert: readFileSync(join(dir, 'cert.pem'), 'utf8'),
    key: readFileSync(join(dir, 'key.pem'), 'utf8'),
    dir
  };
}

const servers: FastifySubstrateServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.stop({ grace: 1000 })));
});

describe.skipIf(!hasOpenssl())('FastifySubstrateServer over TLS: HTTP/2 only', () => {
  const tls = hasOpenssl() ? selfSigned() : { cert: '', key: '', dir: '' };
  afterAll(() => {
    if (tls.dir !== '') rmSync(tls.dir, { recursive: true, force: true });
  });

  async function start(
    setup?: (s: FastifySubstrateServer) => void,
    requestTimeout?: number
  ): Promise<number> {
    const server = new FastifySubstrateServer({
      tls: { cert: tls.cert, key: tls.key },
      ...(requestTimeout !== undefined ? { requestTimeout } : {})
    });
    servers.push(server);
    server.route('GET', '/ping', async () => ({
      status: 200,
      headers: { 'content-type': 'text/plain' },
      body: 'pong'
    }));
    setup?.(server);
    const { port } = await server.start({ host: '127.0.0.1', port: 0 });
    return port;
  }

  function h2Get(
    port: number,
    path: string
  ): Promise<{
    alpn: string | undefined;
    status: number;
    body: string;
    maxStreams: number | undefined;
  }> {
    return new Promise((resolve, reject) => {
      const session = http2.connect(`https://127.0.0.1:${port}`, { ca: tls.cert });
      session.on('error', reject);
      session.on('remoteSettings', () => {
        const req = session.request({ ':path': path });
        let status = 0;
        let body = '';
        req.on('response', (h) => {
          status = Number(h[':status']);
        });
        req.setEncoding('utf8');
        req.on('data', (c: string) => {
          body += c;
        });
        req.on('end', () => {
          const out = {
            alpn: session.alpnProtocol,
            status,
            body,
            maxStreams: session.remoteSettings.maxConcurrentStreams
          };
          session.close();
          resolve(out);
        });
        req.on('error', reject);
        req.end();
      });
    });
  }

  it('negotiates h2 and caps concurrent streams per connection', async () => {
    const port = await start();
    const res = await h2Get(port, '/ping');
    expect(res).toEqual({ alpn: 'h2', status: 200, body: 'pong', maxStreams: 128 });
  });

  it('refuses HTTP/1.1 in TLS mode', async () => {
    const port = await start();
    // Node answers a TLS client that offers no h2 with its own 403 before any route runs.
    const outcome = await new Promise<{ status: number; body: string } | string>((resolve) => {
      https
        .get({ host: '127.0.0.1', port, path: '/ping', ca: tls.cert }, (r) => {
          let body = '';
          r.setEncoding('utf8');
          r.on('data', (c: string) => {
            body += c;
          });
          r.on('end', () => resolve({ status: r.statusCode ?? 0, body }));
        })
        .on('error', (err: NodeJS.ErrnoException) => resolve(err.code ?? err.message));
    });
    if (typeof outcome === 'object') {
      expect(outcome.status).toBe(403);
      expect(outcome.body).not.toContain('pong');
    }
  });

  it('streams a ReadableStream body over h2', async () => {
    const encoder = new TextEncoder();
    const port = await start((s) => {
      s.route('GET', '/stream', async () => ({
        status: 200,
        headers: { 'content-type': 'application/x-ndjson' },
        body: new ReadableStream<Uint8Array>({
          start(c) {
            for (let i = 0; i < 3; i++) c.enqueue(encoder.encode(`{"n":${i}}\n`));
            c.close();
          }
        })
      }));
    });
    const res = await h2Get(port, '/stream');
    expect(res.status).toBe(200);
    expect(res.body).toBe('{"n":0}\n{"n":1}\n{"n":2}\n');
  });

  it('resets an h2 stream whose request body is not sent within requestTimeout', async () => {
    let handled = false;
    const port = await start((s) => {
      s.route('POST', '/echo', async () => {
        handled = true;
        return { status: 200, body: 'ok' };
      });
    }, 300);
    const session = http2.connect(`https://127.0.0.1:${port}`, { ca: tls.cert });
    session.on('error', () => {});
    const req = session.request({
      ':method': 'POST',
      ':path': '/echo',
      'content-type': 'text/plain'
    });
    req.on('error', () => {});
    req.write('partial');
    const t0 = performance.now();
    const code = await new Promise<number>((resolve) =>
      req.on('close', () => resolve(req.rstCode))
    );
    const elapsed = performance.now() - t0;
    session.destroy();
    expect(code).toBe(http2.constants.NGHTTP2_CANCEL);
    expect(elapsed).toBeGreaterThanOrEqual(250);
    expect(elapsed).toBeLessThan(3000);
    expect(handled).toBe(false);
  });

  it('does not bound a streamed h2 response by requestTimeout', async () => {
    const encoder = new TextEncoder();
    const port = await start((s) => {
      s.route('GET', '/slow', async () => ({
        status: 200,
        body: new ReadableStream<Uint8Array>({
          async start(c) {
            c.enqueue(encoder.encode('a'));
            await new Promise((r) => setTimeout(r, 600));
            c.enqueue(encoder.encode('b'));
            c.close();
          }
        })
      }));
    }, 200);
    const res = await h2Get(port, '/slow');
    expect(res.body).toBe('ab');
  });

  it('stops promptly with an idle h2 connection still open', async () => {
    const port = await start();
    const session = http2.connect(`https://127.0.0.1:${port}`, { ca: tls.cert });
    await new Promise<void>((resolve) => session.once('remoteSettings', () => resolve()));
    const server = servers.pop() as FastifySubstrateServer;
    const t0 = performance.now();
    await server.stop({ grace: 5000 });
    expect(performance.now() - t0).toBeLessThan(2000);
    session.destroy();
  });
});

describe('FastifySubstrateServer in cleartext: h2c only', () => {
  async function start(setup?: (s: FastifySubstrateServer) => void): Promise<number> {
    const server = new FastifySubstrateServer();
    servers.push(server);
    server.route('GET', '/ping', async () => ({ status: 200, body: 'pong' }));
    setup?.(server);
    const { port } = await server.start({ host: '127.0.0.1', port: 0 });
    return port;
  }

  it('serves h2 with prior knowledge and caps concurrent streams', async () => {
    const port = await start();
    const session = http2.connect(`http://127.0.0.1:${port}`);
    const maxStreams = await new Promise<number | undefined>((resolve) =>
      session.once('remoteSettings', (s) => resolve(s.maxConcurrentStreams))
    );
    const req = session.request({ ':path': '/ping' });
    req.setEncoding('utf8');
    let body = '';
    req.on('data', (c: string) => {
      body += c;
    });
    await new Promise((r) => req.on('end', r));
    session.close();
    expect({ body, maxStreams }).toEqual({ body: 'pong', maxStreams: 128 });
  });

  it('refuses HTTP/1.1 in cleartext mode', async () => {
    const port = await start();
    const reply = await new Promise<string>((resolve) => {
      let got = '';
      const sock = net.connect(port, '127.0.0.1', () => {
        sock.write('GET /ping HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n');
      });
      sock.setEncoding('latin1');
      sock.on('data', (c: string) => {
        got += c;
      });
      sock.on('error', () => {});
      sock.on('close', () => resolve(got));
    });
    expect(reply).not.toMatch(/^HTTP\/1\.[01] /);
  });

  it('stop() sends GOAWAY: an open stream finishes, and the session closes', async () => {
    const encoder = new TextEncoder();
    let release: (() => void) | undefined;
    const port = await start((s) => {
      s.route('GET', '/slow', async () => ({
        status: 200,
        body: new ReadableStream<Uint8Array>({
          async start(c) {
            c.enqueue(encoder.encode('a'));
            await new Promise<void>((r) => {
              release = r;
            });
            c.enqueue(encoder.encode('b'));
            c.close();
          }
        })
      }));
    });
    const session = http2.connect(`http://127.0.0.1:${port}`);
    const goaway = new Promise<void>((r) => session.once('goaway', () => r()));
    const req = session.request({ ':path': '/slow' });
    req.setEncoding('utf8');
    let body = '';
    req.on('data', (c: string) => {
      body += c;
    });
    const ended = new Promise((r) => req.on('end', r));
    await new Promise<void>((r) => req.once('data', () => r()));
    const stopped = (servers.pop() as FastifySubstrateServer).stop({ grace: 5000 });
    await goaway;
    release?.();
    await ended;
    await stopped;
    expect(body).toBe('ab');
    session.destroy();
  });

  it('stop() destroys a session still open at grace', async () => {
    const port = await start((s) => {
      s.route('GET', '/never', async () => ({
        status: 200,
        body: new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(new Uint8Array([1]));
          }
        })
      }));
    });
    const session = http2.connect(`http://127.0.0.1:${port}`);
    session.on('error', () => {});
    const req = session.request({ ':path': '/never' });
    req.on('error', () => {});
    await new Promise<void>((r) => req.once('data', () => r()));
    const t0 = performance.now();
    await (servers.pop() as FastifySubstrateServer).stop({ grace: 300 });
    expect(performance.now() - t0).toBeLessThan(2000);
    await new Promise<void>((r) => (session.closed ? r() : session.once('close', () => r())));
  });
});

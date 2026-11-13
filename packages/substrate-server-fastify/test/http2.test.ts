/**
 * With TLS the server negotiates HTTP/2 by ALPN and keeps HTTP/1.1 for clients
 * that do not offer h2.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import http2 from 'node:http2';
import https from 'node:https';
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

describe.skipIf(!hasOpenssl())(
  'FastifySubstrateServer over TLS: HTTP/2 with HTTP/1.1 fallback',
  () => {
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

    it('serves a client that does not offer h2 over HTTP/1.1', async () => {
      const port = await start();
      const res = await new Promise<{ version: string; status: number; body: string }>(
        (resolve, reject) => {
          https
            .get({ host: '127.0.0.1', port, path: '/ping', ca: tls.cert }, (r) => {
              let body = '';
              r.setEncoding('utf8');
              r.on('data', (c: string) => {
                body += c;
              });
              r.on('end', () =>
                resolve({ version: r.httpVersion, status: r.statusCode ?? 0, body })
              );
            })
            .on('error', reject);
        }
      );
      expect(res).toEqual({ version: '1.1', status: 200, body: 'pong' });
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

    it('bounds how long an HTTP/1.1 client may take to send a request', () => {
      // Node checks the bound on a 30s sweep, too slow to exercise end to end.
      const server = new FastifySubstrateServer({
        tls: { cert: tls.cert, key: tls.key },
        requestTimeout: 5000
      });
      const raw = (server as unknown as { fastify: { server: { requestTimeout: number } } }).fastify
        .server;
      expect(raw.requestTimeout).toBe(5000);
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
  }
);

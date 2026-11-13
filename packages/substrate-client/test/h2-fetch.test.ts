import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import http2 from 'node:http2';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createH2Fetch, type H2Fetch } from '../src/transport/h2-fetch.js';
import { mockServer } from './_setup.js';

// msw's socket interception (test/_setup.ts) stalls node:http2 connects. These tests talk to
// real local servers only, so this file switches it off; vitest isolates the file.
beforeAll(() => mockServer.close());
// The setup file closes it again after the suite; give it something to close.
afterAll(() => mockServer.listen());

function hasOpenssl(): boolean {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function selfSigned(): { cert: string; key: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'substrate-h2fetch-'));
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

type Handler = (stream: http2.ServerHttp2Stream, headers: http2.IncomingHttpHeaders) => void;
interface TestServer {
  url: string;
  sessions: number;
  versions: string[];
  server: http2.Http2Server | http2.Http2SecureServer;
}

const tls = hasOpenssl() ? selfSigned() : { cert: '', key: '', dir: '' };
afterAll(() => {
  if (tls.dir !== '') rmSync(tls.dir, { recursive: true, force: true });
});
const servers: TestServer[] = [];
const fetches: H2Fetch[] = [];
afterEach(async () => {
  await Promise.all(fetches.splice(0).map((f) => f.close()));
  await Promise.all(
    servers.splice(0).map((s) => new Promise<void>((r) => s.server.close(() => r())))
  );
});

const echo: Handler = (stream, headers) => {
  const chunks: Buffer[] = [];
  stream.on('data', (c: Buffer) => chunks.push(c));
  stream.on('end', () => {
    stream.respond({
      ':status': 200,
      'content-type': 'application/json',
      'x-seen-method': String(headers[':method'])
    });
    stream.end(
      JSON.stringify({
        path: headers[':path'],
        body: Buffer.concat(chunks).toString(),
        auth: headers.authorization ?? null
      })
    );
  });
};

async function start(secure: boolean, handler: Handler = echo): Promise<TestServer> {
  const server = secure
    ? http2.createSecureServer({ cert: tls.cert, key: tls.key, allowHTTP1: false })
    : http2.createServer();
  const t: TestServer = { url: '', sessions: 0, versions: [], server };
  server.on('session', () => {
    t.sessions++;
  });
  server.on('stream', (stream, headers) => {
    t.versions.push('2.0');
    handler(stream as http2.ServerHttp2Stream, headers);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  t.url = `${secure ? 'https' : 'http'}://127.0.0.1:${(server.address() as AddressInfo).port}`;
  servers.push(t);
  return t;
}

const make = (opts: Parameters<typeof createH2Fetch>[0] = {}): H2Fetch => {
  const f = createH2Fetch(opts);
  fetches.push(f);
  return f;
};

describe.skipIf(!hasOpenssl())('createH2Fetch', () => {
  it.each([
    ['TLS', true],
    ['h2c', false]
  ])('GET and POST over %s', async (_name, secure) => {
    const s = await start(secure);
    const f = make(secure ? { ca: tls.cert } : {});
    const get = await f(`${s.url}/a?x=1`, {
      headers: { authorization: 'Bearer t', connection: 'keep-alive' }
    });
    expect(get.status).toBe(200);
    expect(get.headers.get('content-type')).toBe('application/json');
    expect(await get.json()).toEqual({ path: '/a?x=1', body: '', auth: 'Bearer t' });
    const post = await f(`${s.url}/b`, {
      method: 'POST',
      body: JSON.stringify({ n: 1 }),
      headers: { 'content-type': 'application/json' }
    });
    expect(post.headers.get('x-seen-method')).toBe('POST');
    expect(await post.json()).toMatchObject({ body: '{"n":1}' });
    expect(s.versions).toEqual(['2.0', '2.0']);
  });

  it('streams a response body incrementally', async () => {
    let wrote = 0;
    const s = await start(false, (stream) => {
      stream.respond({ ':status': 200 });
      const tick = (): void => {
        stream.write(`c${wrote++}`);
        if (wrote < 3) setTimeout(tick, 50);
        else stream.end();
      };
      tick();
    });
    const res = await make()(`${s.url}/s`);
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toBe('c0');
    expect(wrote).toBeLessThan(3);
    while (!(await reader.read()).done) {}
  });

  it('opens one session for ten concurrent cold requests', async () => {
    const s = await start(false);
    const f = make();
    const res = await Promise.all(Array.from({ length: 10 }, (_, i) => f(`${s.url}/${i}`)));
    await Promise.all(res.map((r) => r.text()));
    expect(s.sessions).toBe(1);
  });

  it('reconnects after the server sends GOAWAY', async () => {
    const s = await start(false, (stream, headers) => {
      echo(stream, headers);
      stream.session?.goaway();
    });
    const f = make();
    await (await f(`${s.url}/1`)).text();
    await new Promise((r) => setTimeout(r, 50));
    const second = await f(`${s.url}/2`);
    expect(second.status).toBe(200);
    await second.text();
    expect(s.sessions).toBe(2);
  });

  it('abort signal cancels the stream and rejects with AbortError', async () => {
    let closed = false;
    const s = await start(false, (stream) => {
      stream.on('close', () => {
        closed = true;
      });
    });
    const ac = new AbortController();
    const pending = make()(`${s.url}/hang`, { signal: ac.signal });
    setTimeout(() => ac.abort(), 50);
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await new Promise((r) => setTimeout(r, 50));
    expect(closed).toBe(true);
  });

  it("redirect: 'error' rejects on a 3xx", async () => {
    const s = await start(false, (stream) => {
      stream.respond({ ':status': 302, location: '/elsewhere' });
      stream.end();
    });
    await expect(make()(`${s.url}/r`, { redirect: 'error' })).rejects.toThrow(/redirect/);
  });

  it('trusts a private CA given as ca, and rejects an untrusted cert', async () => {
    const s = await start(true);
    expect((await make({ ca: tls.cert })(`${s.url}/x`)).status).toBe(200);
    await expect(make()(`${s.url}/x`)).rejects.toThrow();
  });

  it('lets a process exit without close()', async () => {
    const s = await start(false);
    const mod = fileURLToPath(new URL('../src/transport/h2-fetch.ts', import.meta.url));
    const child = spawn(
      process.execPath,
      [fileURLToPath(new URL('./fixtures/h2-exit-child.mjs', import.meta.url)), mod, `${s.url}/x`],
      {
        stdio: ['ignore', 'pipe', 'pipe']
      }
    );
    let out = '';
    child.stdout.on('data', (d: Buffer) => {
      out += d.toString();
    });
    const t0 = performance.now();
    const code = await new Promise<number | null>((resolve) => {
      const kill = setTimeout(() => {
        child.kill('SIGKILL');
        resolve(null);
      }, 5000);
      child.on('exit', (c) => {
        clearTimeout(kill);
        resolve(c);
      });
    });
    expect(out.trim()).toBe('status 200');
    expect(code).toBe(0);
    expect(performance.now() - t0).toBeLessThan(2000);
  });
});

import { compose } from '@mnmal-ai/substrate-compose';
import { MemoryDataset } from '@mnmal-ai/substrate-dataset-memory';
import { MemorySubstrateServer } from '@mnmal-ai/substrate-server-memory';
import type { SubstrateResponse } from '@mnmal-ai/substrate-types';
import { afterEach, describe, expect, it } from 'vitest';
import { HttpJsonError, httpJson } from '../src/cli/federate/http.js';
import { probeAuthPosture } from '../src/cli/federate/probe.js';
import { h2Server, type StubServer } from './fixtures/h2-server.js';

function bodyToString(res: SubstrateResponse): string {
  const b = res.body;
  if (b === undefined || b === null) return '';
  if (typeof b === 'string') return b;
  if (Buffer.isBuffer(b)) return b.toString('utf8');
  if (b instanceof Uint8Array) return Buffer.from(b).toString('utf8');
  return '';
}

/**
 * The genuine `GET /substrate/v1/whoami` response body for a keyless caller, produced
 * by the real `compose()` pipeline — not a hand-rolled shape — so this fixture
 * cannot drift from what a live instance serves. The probe reads whoami rather
 * than onboard because onboard needs a key once auth is on.
 */
async function realWhoamiBody(authEnabled: boolean): Promise<string> {
  const memServer = new MemorySubstrateServer();
  const dataset = new MemoryDataset({ namespace: 'default' });
  const composeOpts: Parameters<typeof compose>[0] = {
    // Required when auth is off, which is one of the two cases built here.
    systemActor: 'test',
    server: memServer,
    dataset
  };
  if (authEnabled) {
    composeOpts.auth = { keys: [{ kid: 'k1', alg: 'HS256', publicKey: 'onboard-fixture-secret' }] };
  }
  const composed = await compose(composeOpts);
  await memServer.start();
  try {
    const res = await memServer.inject({ method: 'GET', path: '/substrate/v1/whoami' });
    return bodyToString(res);
  } finally {
    await composed.stop();
  }
}

let server: StubServer | undefined;

/** Start a one-route stub server and return its origin. */
async function serve(handler: (path: string) => { status: number; body: string }): Promise<string> {
  server = await h2Server((req, res) => {
    const { status, body } = handler(req.url ?? '/');
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(body);
  });
  return server.url;
}

afterEach(async () => {
  if (server !== undefined) {
    await server.close();
    server = undefined;
  }
});

describe('httpJson', () => {
  it('returns status and parsed body for a 200', async () => {
    const origin = await serve(() => ({ status: 200, body: '{"ok":true}' }));
    const res = await httpJson(`${origin}/thing`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('returns a non-2xx status rather than throwing', async () => {
    const origin = await serve(() => ({ status: 409, body: '{"code":"nope"}' }));
    const res = await httpJson(`${origin}/thing`);
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ code: 'nope' });
  });

  it('exposes the raw body when it is not JSON', async () => {
    const origin = await serve(() => ({ status: 200, body: 'plain text' }));
    const res = await httpJson(`${origin}/thing`);
    expect(res.body).toBeUndefined();
    expect(res.raw).toBe('plain text');
  });

  it('POSTs a JSON body', async () => {
    let seen = '';
    server = await h2Server((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        seen = Buffer.concat(chunks).toString('utf8');
        res.writeHead(201, { 'content-type': 'application/json' });
        res.end('{"kid":"k1"}');
      });
    });
    const res = await httpJson(`${server.url}/r`, {
      method: 'POST',
      body: { code: 'c' }
    });
    expect(seen).toBe('{"code":"c"}');
    expect(res.status).toBe(201);
  });

  it('throws HttpJsonError when the host is unreachable', async () => {
    // Port 1 on loopback: reliably refused, no DNS involved.
    await expect(httpJson('http://127.0.0.1:1/health')).rejects.toBeInstanceOf(HttpJsonError);
  });
});

describe('probeAuthPosture', () => {
  it('reports enabled against a genuine whoami body with auth on', async () => {
    const body = await realWhoamiBody(true);
    expect(JSON.parse(body)).toEqual({ authEnabled: true, identity: null });
    const origin = await serve(() => ({ status: 200, body }));
    expect(await probeAuthPosture(origin)).toBe('enabled');
  });

  it('reports disabled against a genuine whoami body with auth off', async () => {
    const body = await realWhoamiBody(false);
    expect(body).toContain('"authEnabled":false');
    const origin = await serve(() => ({ status: 200, body }));
    expect(await probeAuthPosture(origin)).toBe('disabled');
  });

  it('reports unreachable when the peer cannot be contacted', async () => {
    expect(await probeAuthPosture('http://127.0.0.1:1')).toBe('unreachable');
  });

  it('reports unreachable on a non-2xx, rather than guessing', async () => {
    const origin = await serve(() => ({ status: 500, body: '{}' }));
    expect(await probeAuthPosture(origin)).toBe('unreachable');
  });

  it('reports unreachable when authEnabled is absent from the response', async () => {
    // An older binary predating whoami's field. Guessing "disabled" would block
    // a correct setup; guessing "enabled" would defeat the check.
    const origin = await serve(() => ({ status: 200, body: '{"version":"1.0.0"}' }));
    expect(await probeAuthPosture(origin)).toBe('unreachable');
  });

  it('reports unreachable when authEnabled is not a boolean', async () => {
    const origin = await serve(() => ({ status: 200, body: '{"authEnabled":"yes"}' }));
    expect(await probeAuthPosture(origin)).toBe('unreachable');
  });

  it('requests /substrate/v1/whoami, which answers without a key', async () => {
    let path = '';
    const origin = await serve((p) => {
      path = p;
      return { status: 200, body: '{"authEnabled":true,"identity":null}' };
    });
    await probeAuthPosture(origin);
    expect(path).toBe('/substrate/v1/whoami');
  });
});

import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { FastifySubstrateServer } from '../src/index.js';

const LARGE_JSON_BODY = JSON.stringify({ data: 'x'.repeat(2048) });

describe('FastifySubstrateServer compression', () => {
  it('gzips large JSON responses by default when Accept-Encoding: gzip is sent', async () => {
    const server = new FastifySubstrateServer();
    server.route('GET', '/big', async () => ({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: LARGE_JSON_BODY
    }));
    const res = await server.inject({
      method: 'GET',
      path: '/big',
      headers: { 'accept-encoding': 'gzip' }
    });
    expect(res.status).toBe(200);
    expect(res.headers?.['content-encoding']).toBe('gzip');
    const decoded = gunzipSync(res.body as Buffer).toString('utf-8');
    expect(decoded).toBe(LARGE_JSON_BODY);
  });

  it('passes small responses through uncompressed (under threshold)', async () => {
    const server = new FastifySubstrateServer();
    server.route('GET', '/small', async () => ({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: '{"ok":true}'
    }));
    const res = await server.inject({
      method: 'GET',
      path: '/small',
      headers: { 'accept-encoding': 'gzip' }
    });
    expect(res.status).toBe(200);
    expect(res.headers?.['content-encoding']).toBeUndefined();
  });

  it('does not compress when Accept-Encoding is absent', async () => {
    const server = new FastifySubstrateServer();
    server.route('GET', '/big', async () => ({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: LARGE_JSON_BODY
    }));
    const res = await server.inject({ method: 'GET', path: '/big' });
    expect(res.status).toBe(200);
    expect(res.headers?.['content-encoding']).toBeUndefined();
  });

  it('does not compress binary content types (e.g. application/vnd.substrate.pack)', async () => {
    const server = new FastifySubstrateServer();
    server.route('GET', '/pack', async () => ({
      status: 200,
      headers: { 'content-type': 'application/vnd.substrate.pack' },
      body: Buffer.alloc(4096, 0xab)
    }));
    const res = await server.inject({
      method: 'GET',
      path: '/pack',
      headers: { 'accept-encoding': 'gzip' }
    });
    expect(res.status).toBe(200);
    expect(res.headers?.['content-encoding']).toBeUndefined();
  });

  it('disables compression when constructor opt is false', async () => {
    const server = new FastifySubstrateServer({ compression: false });
    server.route('GET', '/big', async () => ({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: LARGE_JSON_BODY
    }));
    const res = await server.inject({
      method: 'GET',
      path: '/big',
      headers: { 'accept-encoding': 'gzip' }
    });
    expect(res.status).toBe(200);
    expect(res.headers?.['content-encoding']).toBeUndefined();
  });
});

import { describe, expect, it } from 'vitest';
import { FastifySubstrateServer } from '../src/index.js';

describe('FastifySubstrateServer HTTP', () => {
  it('bounds how long a client may take to send a request, 30s by default', () => {
    // Node checks the bound on a 30s sweep, too slow to exercise end to end.
    const timeoutOf = (s: FastifySubstrateServer): number =>
      (s as unknown as { fastify: { server: { requestTimeout: number } } }).fastify.server
        .requestTimeout;
    expect(timeoutOf(new FastifySubstrateServer())).toBe(30_000);
    expect(timeoutOf(new FastifySubstrateServer({ requestTimeout: 5000 }))).toBe(5000);
  });

  it('routes GET and returns the handler response', async () => {
    const server = new FastifySubstrateServer();
    server.route('GET', '/ping', async () => ({
      status: 200,
      headers: { 'content-type': 'text/plain' },
      body: 'pong'
    }));
    const res = await server.inject({ method: 'GET', path: '/ping' });
    expect(res.status).toBe(200);
    expect(res.headers?.['content-type']).toContain('text/plain');
    expect(res.body?.toString()).toBe('pong');
  });

  it('hands the handler a Buffer for POST bodies', async () => {
    const server = new FastifySubstrateServer();
    let received: Buffer | null = null;
    server.route('POST', '/echo', async (req) => {
      received = req.body;
      return { status: 200, body: req.body ?? Buffer.alloc(0) };
    });
    const res = await server.inject({
      method: 'POST',
      path: '/echo',
      headers: { 'content-type': 'application/octet-stream' },
      body: Buffer.from('binary-payload')
    });
    expect(res.status).toBe(200);
    expect(Buffer.isBuffer(received)).toBe(true);
    expect((received as unknown as Buffer).toString()).toBe('binary-payload');
  });

  it('returns 404 when no route matches', async () => {
    const server = new FastifySubstrateServer();
    const res = await server.inject({ method: 'GET', path: '/nope' });
    expect(res.status).toBe(404);
  });

  it('invokes onError hook and returns the error-handler response when a handler throws', async () => {
    const server = new FastifySubstrateServer();
    const seen: Error[] = [];
    server.onError((err) => {
      seen.push(err);
    });
    server.route('GET', '/boom', async () => {
      throw new Error('kaboom');
    });
    const res = await server.inject({ method: 'GET', path: '/boom' });
    expect(res.status).toBe(500);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.message).toBe('kaboom');
  });

  it('returns a Substrate-shaped envelope on uncaught throws', async () => {
    // The 500 path must keep the structured `{ data, shapes, errors }` shape so
    // envelope-aware clients parse it rather than silently dropping it, and
    // must not carry the thrown message, which can name tables and values.
    const server = new FastifySubstrateServer();
    server.route('POST', '/substrate/v1/query', async () => {
      throw Object.assign(new Error('duplicate key value violates "rows_pkey"'), { code: '23505' });
    });
    const res = await server.inject({ method: 'POST', path: '/substrate/v1/query' });
    expect(res.status).toBe(500);
    const body = JSON.parse(res.body?.toString() ?? '{}');
    expect(body).toMatchObject({
      schemaVersion: '',
      data: {},
      shapes: {},
      errors: [
        {
          message: 'internal server error',
          code: 'internal_error'
        }
      ]
    });
    expect(res.headers?.['content-type']).toContain('application/json');
  });

  it('uses request_error code on 4xx-status thrown errors', async () => {
    class HttpError extends Error {
      readonly statusCode = 400;
    }
    const server = new FastifySubstrateServer();
    server.route('GET', '/bad', async () => {
      throw new HttpError('bad request shape');
    });
    const res = await server.inject({ method: 'GET', path: '/bad' });
    expect(res.status).toBe(400);
    const body = JSON.parse(res.body?.toString() ?? '{}');
    expect(body.errors?.[0]).toMatchObject({
      message: 'bad request shape',
      code: 'request_error'
    });
  });

  it('supports sync return values', async () => {
    const server = new FastifySubstrateServer();
    server.route('GET', '/sync', () => ({ status: 200, body: 'sync-ok' }));
    const res = await server.inject({ method: 'GET', path: '/sync' });
    expect(res.body?.toString()).toBe('sync-ok');
  });

  it('preserves header names as Fastify emits them (lowercase)', async () => {
    const server = new FastifySubstrateServer();
    server.route('GET', '/headers', async (req) => ({
      status: 200,
      body: Buffer.from(JSON.stringify(req.headers))
    }));
    const res = await server.inject({
      method: 'GET',
      path: '/headers',
      headers: { 'X-Custom': 'foo', 'x-lower': 'bar' }
    });
    const got = JSON.parse(res.body?.toString() ?? '{}');
    expect(got['x-custom']).toBe('foo');
    expect(got['x-lower']).toBe('bar');
  });

  it('passes query parameters through', async () => {
    const server = new FastifySubstrateServer();
    server.route('GET', '/q', async (req) => ({
      status: 200,
      body: Buffer.from(JSON.stringify(req.query))
    }));
    const res = await server.inject({
      method: 'GET',
      path: '/q',
      query: { a: '1', b: 'two' }
    });
    expect(JSON.parse(res.body?.toString() ?? '{}')).toEqual({ a: '1', b: 'two' });
  });

  it('surfaces route params', async () => {
    const server = new FastifySubstrateServer();
    server.route('GET', '/items/:id', async (req) => ({
      status: 200,
      body: Buffer.from(JSON.stringify(req.params))
    }));
    const res = await server.inject({ method: 'GET', path: '/items/42' });
    expect(JSON.parse(res.body?.toString() ?? '{}')).toEqual({ id: '42' });
  });
});

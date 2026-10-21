import { describe, expect, it } from 'vitest';
import { MemorySubstrateServer } from '../src/index.js';

describe('MemorySubstrateServer.inject (HTTP)', () => {
  it('routes a GET to the registered handler', async () => {
    const server = new MemorySubstrateServer();
    server.route('GET', '/ping', () => ({
      status: 200,
      headers: { 'content-type': 'text/plain' },
      body: 'pong'
    }));
    const res = await server.inject({ method: 'GET', path: '/ping' });
    expect(res.status).toBe(200);
    expect(res.body).toBe('pong');
    expect(res.headers?.['content-type']).toBe('text/plain');
  });

  it('supports sync and async handlers identically', async () => {
    const server = new MemorySubstrateServer();
    server.route('GET', '/sync', () => ({ status: 200, body: 'sync' }));
    server.route('GET', '/async', async () => ({ status: 200, body: 'async' }));
    const a = await server.inject({ method: 'GET', path: '/sync' });
    const b = await server.inject({ method: 'GET', path: '/async' });
    expect(a.body).toBe('sync');
    expect(b.body).toBe('async');
  });

  it('returns 404 JSON when no route matches', async () => {
    const server = new MemorySubstrateServer();
    const res = await server.inject({ method: 'GET', path: '/nope' });
    expect(res.status).toBe(404);
    expect(res.headers?.['content-type']).toBe('application/json');
    const body = res.body;
    expect(Buffer.isBuffer(body)).toBe(true);
    expect(JSON.parse((body as Buffer).toString('utf8'))).toEqual({ error: 'not found' });
  });

  it('returns 500 and invokes onError when a handler throws', async () => {
    const server = new MemorySubstrateServer();
    const seen: Error[] = [];
    server.onError((err) => {
      seen.push(err);
    });
    server.route('GET', '/boom', () => {
      throw new Error('kaboom');
    });
    const res = await server.inject({ method: 'GET', path: '/boom' });
    expect(res.status).toBe(500);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.message).toBe('kaboom');
    const body = JSON.parse((res.body as Buffer).toString('utf8'));
    // Fastify's envelope, and nothing of the thrown message.
    expect(body).toEqual({
      schemaVersion: '',
      data: {},
      shapes: {},
      errors: [{ message: 'internal server error', code: 'internal_error' }]
    });
  });

  it('still returns 500 when no error hook is registered', async () => {
    const server = new MemorySubstrateServer();
    server.route('GET', '/boom', () => {
      throw new Error('silent');
    });
    const res = await server.inject({ method: 'GET', path: '/boom' });
    expect(res.status).toBe(500);
  });

  it('does not let a faulty error hook mask the original error', async () => {
    const server = new MemorySubstrateServer();
    const seen: string[] = [];
    server.onError((err) => {
      seen.push(err.message);
      throw new Error('hook-fault');
    });
    server.route('GET', '/boom', () => {
      throw new Error('orig');
    });
    const res = await server.inject({ method: 'GET', path: '/boom' });
    expect(res.status).toBe(500);
    expect(seen).toEqual(['orig']);
    const body = JSON.parse((res.body as Buffer).toString('utf8'));
    expect(body.errors[0].code).toBe('internal_error');
  });

  it('populates params from a :param pattern', async () => {
    const server = new MemorySubstrateServer();
    server.route('GET', '/items/:id', (req) => ({
      status: 200,
      body: Buffer.from(JSON.stringify(req.params))
    }));
    const res = await server.inject({ method: 'GET', path: '/items/42' });
    expect(JSON.parse((res.body as Buffer).toString('utf8'))).toEqual({ id: '42' });
  });

  it('parses query from the path when not passed explicitly', async () => {
    const server = new MemorySubstrateServer();
    server.route('GET', '/search', (req) => ({
      status: 200,
      body: Buffer.from(JSON.stringify(req.query))
    }));
    const res = await server.inject({ method: 'GET', path: '/search?q=hello&page=2' });
    expect(JSON.parse((res.body as Buffer).toString('utf8'))).toEqual({ q: 'hello', page: '2' });
  });

  it('prefers an explicitly-passed query object over path querystring', async () => {
    const server = new MemorySubstrateServer();
    server.route('GET', '/q', (req) => ({
      status: 200,
      body: Buffer.from(JSON.stringify(req.query))
    }));
    const res = await server.inject({
      method: 'GET',
      path: '/q?ignored=1',
      query: { explicit: 'yes' }
    });
    expect(JSON.parse((res.body as Buffer).toString('utf8'))).toEqual({ explicit: 'yes' });
  });

  it('passes a Buffer body through to the handler', async () => {
    const server = new MemorySubstrateServer();
    let received: Buffer | null = null;
    server.route('POST', '/echo', (req) => {
      received = req.body;
      return { status: 200, body: req.body ?? Buffer.alloc(0) };
    });
    const res = await server.inject({
      method: 'POST',
      path: '/echo',
      body: Buffer.from('binary-payload')
    });
    expect(res.status).toBe(200);
    expect(Buffer.isBuffer(received)).toBe(true);
    expect((received as unknown as Buffer).toString()).toBe('binary-payload');
  });

  it('forwards headers verbatim to the handler', async () => {
    const server = new MemorySubstrateServer();
    server.route('GET', '/h', (req) => ({
      status: 200,
      body: Buffer.from(JSON.stringify(req.headers))
    }));
    const res = await server.inject({
      method: 'GET',
      path: '/h',
      headers: { 'X-Custom': 'foo', authorization: 'bearer x' }
    });
    expect(JSON.parse((res.body as Buffer).toString('utf8'))).toEqual({
      'X-Custom': 'foo',
      authorization: 'bearer x'
    });
  });

  it('matches first-registered route when multiple could match', async () => {
    const server = new MemorySubstrateServer();
    server.route('GET', '/u/:id', () => ({ status: 200, body: 'first' }));
    server.route('GET', '/u/special', () => ({ status: 200, body: 'second' }));
    const res = await server.inject({ method: 'GET', path: '/u/special' });
    expect(res.body).toBe('first');
  });

  it('distinguishes method on the same path', async () => {
    const server = new MemorySubstrateServer();
    server.route('GET', '/r', () => ({ status: 200, body: 'get' }));
    server.route('POST', '/r', () => ({ status: 201, body: 'post' }));
    const g = await server.inject({ method: 'GET', path: '/r' });
    const p = await server.inject({ method: 'POST', path: '/r' });
    expect(g.body).toBe('get');
    expect(p.body).toBe('post');
    expect(p.status).toBe(201);
  });
});

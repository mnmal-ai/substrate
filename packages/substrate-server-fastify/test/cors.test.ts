import { describe, expect, it } from 'vitest';
import { FastifySubstrateServer } from '../src/index.js';

describe('FastifySubstrateServer CORS', () => {
  it('does not emit CORS headers when cors option is unset', async () => {
    const server = new FastifySubstrateServer();
    server.route('GET', '/ping', async () => ({ status: 200, body: 'pong' }));
    const res = await server.inject({
      method: 'GET',
      path: '/ping',
      headers: { origin: 'http://localhost:5173' }
    });
    expect(res.headers?.['access-control-allow-origin']).toBeUndefined();
  });

  it('handles OPTIONS preflight and returns the requesting origin when cors is configured', async () => {
    const server = new FastifySubstrateServer({
      cors: { origins: ['http://localhost:5173'], credentials: true }
    });
    server.route('POST', '/substrate/v1/query', async () => ({ status: 200, body: '{}' }));
    const res = await server.inject({
      method: 'OPTIONS',
      path: '/substrate/v1/query',
      headers: {
        origin: 'http://localhost:5173',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type, authorization'
      }
    });
    expect(res.status).toBe(204);
    expect(res.headers?.['access-control-allow-origin']).toBe('http://localhost:5173');
    expect(res.headers?.['access-control-allow-credentials']).toBe('true');
  });

  it('reflects the matching origin on a normal GET when cors is configured', async () => {
    const server = new FastifySubstrateServer({
      cors: { origins: ['http://localhost:5173'] }
    });
    server.route('GET', '/substrate/v1/federated-schema', async () => ({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: '{}'
    }));
    const res = await server.inject({
      method: 'GET',
      path: '/substrate/v1/federated-schema',
      headers: { origin: 'http://localhost:5173' }
    });
    expect(res.status).toBe(200);
    expect(res.headers?.['access-control-allow-origin']).toBe('http://localhost:5173');
  });

  it('does not reflect an unlisted origin', async () => {
    const server = new FastifySubstrateServer({
      cors: { origins: ['http://localhost:5173'] }
    });
    server.route('GET', '/ping', async () => ({ status: 200, body: 'pong' }));
    const res = await server.inject({
      method: 'GET',
      path: '/ping',
      headers: { origin: 'http://evil.example.com' }
    });
    // @fastify/cors either omits the header or returns false for unlisted origins
    const acao = res.headers?.['access-control-allow-origin'];
    expect(acao === undefined || acao === 'false').toBe(true);
  });

  it('does not pair a wildcard origin with credentials by default', async () => {
    const server = new FastifySubstrateServer({ cors: { origins: '*' } });
    server.route('GET', '/ping', async () => ({ status: 200, body: 'pong' }));
    const res = await server.inject({
      method: 'GET',
      path: '/ping',
      headers: { origin: 'http://anywhere.example.com' }
    });
    expect(res.headers?.['access-control-allow-origin']).toBe('*');
    expect(res.headers?.['access-control-allow-credentials']).toBeUndefined();
  });

  it('admits PUT, PATCH and DELETE in a preflight', async () => {
    const server = new FastifySubstrateServer({ cors: { origins: ['http://app.example.com'] } });
    server.route('PATCH', '/thing', async () => ({ status: 200, body: 'ok' }));
    const res = await server.inject({
      method: 'OPTIONS',
      path: '/thing',
      headers: {
        origin: 'http://app.example.com',
        'access-control-request-method': 'PATCH'
      }
    });
    expect(res.headers?.['access-control-allow-methods']).toContain('PATCH');
    expect(res.headers?.['access-control-allow-methods']).toContain('DELETE');
  });

  it('emits wildcard origin when cors.origins is "*"', async () => {
    const server = new FastifySubstrateServer({
      cors: { origins: '*', credentials: false }
    });
    server.route('GET', '/ping', async () => ({ status: 200, body: 'pong' }));
    const res = await server.inject({
      method: 'GET',
      path: '/ping',
      headers: { origin: 'http://anywhere.example.com' }
    });
    expect(res.headers?.['access-control-allow-origin']).toBe('*');
    expect(res.headers?.['access-control-allow-credentials']).toBeUndefined();
  });
});

import type { RuntimeOp } from '@mnmal-ai/substrate-types';
import { describe, expect, it } from 'vitest';
import { MemorySubstrateServer } from '../src/memory-server.js';

function track(server: MemorySubstrateServer) {
  const events: Array<[RuntimeOp, 1 | -1]> = [];
  let level = 0;
  server.observeInFlight((op, d) => {
    level += d;
    events.push([op, d]);
  });
  return { events, level: () => level };
}

describe('MemorySubstrateServer observeInFlight', () => {
  it('sees +1 then -1 for a query', async () => {
    const server = new MemorySubstrateServer();
    const t = track(server);
    server.route('POST', '/substrate/v1/query', () => ({ status: 200 }));
    await server.inject({ method: 'POST', path: '/substrate/v1/query' });
    expect(t.events).toEqual([
      ['query', 1],
      ['query', -1]
    ]);
  });

  it('still decrements when the handler throws', async () => {
    const server = new MemorySubstrateServer();
    const t = track(server);
    server.route('POST', '/substrate/v1/mutate', () => {
      throw new Error('boom');
    });
    const res = await server.inject({ method: 'POST', path: '/substrate/v1/mutate' });
    expect(res.status).toBe(500);
    expect(t.events).toEqual([
      ['mutate', 1],
      ['mutate', -1]
    ]);
    expect(t.level()).toBe(0);
  });

  it('ignores non query/mutate routes', async () => {
    const server = new MemorySubstrateServer();
    const t = track(server);
    server.route('GET', '/health', () => ({ status: 200 }));
    await server.inject({ method: 'GET', path: '/health' });
    expect(t.events).toEqual([]);
  });

  it('counts concurrent requests', async () => {
    const server = new MemorySubstrateServer();
    const t = track(server);
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    server.route('POST', '/substrate/v1/query', async () => {
      await gate;
      return { status: 200 };
    });
    const a = server.inject({ method: 'POST', path: '/substrate/v1/query' });
    const b = server.inject({ method: 'POST', path: '/substrate/v1/query' });
    await new Promise((r) => setTimeout(r, 10));
    expect(t.level()).toBe(2);
    release();
    await Promise.all([a, b]);
    expect(t.level()).toBe(0);
  });

  it('survives a throwing observer', async () => {
    const server = new MemorySubstrateServer();
    server.observeInFlight(() => {
      throw new Error('bad');
    });
    server.route('POST', '/substrate/v1/query', () => ({ status: 200 }));
    const res = await server.inject({ method: 'POST', path: '/substrate/v1/query' });
    expect(res.status).toBe(200);
  });
});

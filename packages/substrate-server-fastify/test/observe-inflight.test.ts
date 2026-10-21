import type { RuntimeOp } from '@mnmal-ai/substrate-types';
import { describe, expect, it } from 'vitest';
import { FastifySubstrateServer } from '../src/index.js';

function track(server: FastifySubstrateServer) {
  const events: Array<[RuntimeOp, 1 | -1]> = [];
  let level = 0;
  server.observeInFlight((op, d) => {
    level += d;
    events.push([op, d]);
  });
  return { events, level: () => level };
}

async function boot(server: FastifySubstrateServer): Promise<string> {
  const { port } = await server.start({ host: '127.0.0.1', port: 0 });
  return `http://127.0.0.1:${port}`;
}

describe('FastifySubstrateServer observeInFlight', () => {
  it('sees +1 then -1 for a query', async () => {
    const server = new FastifySubstrateServer();
    const t = track(server);
    server.route('POST', '/substrate/v1/query', async () => ({ status: 200, body: '{}' }));
    const base = await boot(server);
    try {
      await fetch(`${base}/substrate/v1/query`, { method: 'POST', body: '{}' });
      expect(t.events).toEqual([
        ['query', 1],
        ['query', -1]
      ]);
    } finally {
      await server.stop();
    }
  });

  it('still decrements when the handler throws', async () => {
    const server = new FastifySubstrateServer();
    const t = track(server);
    server.route('POST', '/substrate/v1/mutate', async () => {
      throw new Error('boom');
    });
    const base = await boot(server);
    try {
      const res = await fetch(`${base}/substrate/v1/mutate`, { method: 'POST', body: '{}' });
      expect(res.status).toBe(500);
      expect(t.events).toEqual([
        ['mutate', 1],
        ['mutate', -1]
      ]);
      expect(t.level()).toBe(0);
    } finally {
      await server.stop();
    }
  });

  it('ignores non query/mutate routes', async () => {
    const server = new FastifySubstrateServer();
    const t = track(server);
    server.route('GET', '/health', async () => ({ status: 200, body: 'ok' }));
    const base = await boot(server);
    try {
      await fetch(`${base}/health`);
      expect(t.events).toEqual([]);
    } finally {
      await server.stop();
    }
  });

  it('counts concurrent requests', async () => {
    const server = new FastifySubstrateServer();
    const t = track(server);
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    server.route('POST', '/substrate/v1/query', async () => {
      await gate;
      return { status: 200, body: '{}' };
    });
    const base = await boot(server);
    try {
      const a = fetch(`${base}/substrate/v1/query`, { method: 'POST', body: '{}' });
      const b = fetch(`${base}/substrate/v1/query`, { method: 'POST', body: '{}' });
      await new Promise((r) => setTimeout(r, 100));
      expect(t.level()).toBe(2);
      release();
      await Promise.all([a, b]);
      expect(t.level()).toBe(0);
    } finally {
      await server.stop();
    }
  });
});

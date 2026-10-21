import type { RequestObservation } from '@mnmal-ai/substrate-types';
import { describe, expect, it } from 'vitest';
import { MemorySubstrateServer } from '../src/memory-server.js';

describe('MemorySubstrateServer observeRequests', () => {
  it('observes query + mutate routes with op, ok, and a duration', async () => {
    const server = new MemorySubstrateServer();
    const seen: RequestObservation[] = [];
    server.observeRequests((o) => seen.push(o));

    server.route('POST', '/substrate/v1/query', () => ({ status: 200 }));
    server.route('POST', '/substrate/v1/mutate', () => ({ status: 422 }));
    server.route('GET', '/health', () => ({ status: 200 }));

    await server.inject({ method: 'POST', path: '/substrate/v1/query' });
    await server.inject({ method: 'POST', path: '/substrate/v1/mutate' });
    await server.inject({ method: 'GET', path: '/health' });

    expect(seen).toHaveLength(2);
    expect(seen[0]).toMatchObject({ op: 'query', ok: true });
    expect(seen[1]).toMatchObject({ op: 'mutate', ok: false });
    expect(typeof seen[0]?.durationMs).toBe('number');
    expect(seen[0]!.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('does not throw when the observer itself throws', async () => {
    const server = new MemorySubstrateServer();
    server.observeRequests(() => {
      throw new Error('bad observer');
    });
    server.route('POST', '/substrate/v1/query', () => ({ status: 200 }));
    const res = await server.inject({ method: 'POST', path: '/substrate/v1/query' });
    expect(res.status).toBe(200);
  });
});

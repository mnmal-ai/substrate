import { describe, expect, it } from 'vitest';
import { createEmbedStats } from '../src/embed-stats.js';
import { embedStatsRouteHandler, handleEmbedStatsRequest } from '../src/embed-stats-route.js';
import { InMemoryEmbeddingsStore } from '../src/in-memory-embeddings-store.js';
import { InMemoryLexicalStore } from '../src/in-memory-lexical-store.js';
import { createRecallPlugin } from '../src/plugin.js';

describe('handleEmbedStatsRequest', () => {
  it('returns enabled=false with zeroed snapshot when no stats provided', () => {
    const res = handleEmbedStatsRequest(undefined);
    expect(res.enabled).toBe(false);
    expect(res.writes).toBe(0);
    expect(res.successes).toBe(0);
    expect(res.failures).toBe(0);
    expect(res.lastFailure).toBe(null);
    // since should still be a valid ISO string — epoch is the sentinel.
    expect(() => new Date(res.since).toISOString()).not.toThrow();
  });

  it('returns enabled=true with current snapshot when stats provided', () => {
    const stats = createEmbedStats(() => new Date('2026-04-24T12:00:00Z'));
    stats.recordSuccess();
    stats.recordSuccess();
    stats.recordFailure('d1', 'ollama timeout');
    const res = handleEmbedStatsRequest(stats);
    expect(res.enabled).toBe(true);
    expect(res.writes).toBe(3);
    expect(res.successes).toBe(2);
    expect(res.failures).toBe(1);
    expect(res.lastFailure?.rowId).toBe('d1');
    expect(res.since).toBe('2026-04-24T12:00:00.000Z');
  });

  it('reflects updates across subsequent calls (re-reads live counter)', () => {
    const stats = createEmbedStats();
    expect(handleEmbedStatsRequest(stats).writes).toBe(0);
    stats.recordSuccess();
    expect(handleEmbedStatsRequest(stats).writes).toBe(1);
    stats.recordFailure('d9', 'boom');
    const third = handleEmbedStatsRequest(stats);
    expect(third.writes).toBe(2);
    expect(third.failures).toBe(1);
  });
});

describe('embedStatsRouteHandler', () => {
  const fakeReq = {
    method: 'GET' as const,
    path: '/substrate/v1/embed-stats',
    headers: {},
    query: {},
    params: {},
    body: null
  };

  it('returns status 200 with JSON content-type', async () => {
    const handler = embedStatsRouteHandler(undefined);
    const res = await Promise.resolve(handler(fakeReq));
    expect(res.status).toBe(200);
    expect(res.headers?.['content-type']).toBe('application/json');
  });

  it('body is parseable JSON and contains enabled flag', async () => {
    const stats = createEmbedStats();
    stats.recordSuccess();
    const handler = embedStatsRouteHandler(stats);
    const res = await Promise.resolve(handler(fakeReq));
    const body = JSON.parse(Buffer.from(res.body as Buffer).toString('utf8'));
    expect(body.enabled).toBe(true);
    expect(body.writes).toBe(1);
    expect(body.successes).toBe(1);
  });

  it('returns enabled=false when stats is undefined', async () => {
    const handler = embedStatsRouteHandler(undefined);
    const res = await Promise.resolve(handler(fakeReq));
    const body = JSON.parse(Buffer.from(res.body as Buffer).toString('utf8'));
    expect(body.enabled).toBe(false);
    expect(body.writes).toBe(0);
  });
});

describe('lexicalEnabled — is the arm COMPOSED, as distinct from declared', () => {
  const fakeReq = {
    method: 'GET' as const,
    path: '/substrate/v1/embed-stats',
    headers: {},
    query: {},
    params: {},
    body: null
  };

  async function statsThrough(plugin: ReturnType<typeof createRecallPlugin>) {
    const route = plugin.kernelRoutes?.find((r) => r.path === 'embed-stats');
    const res = await Promise.resolve(route!.handler(fakeReq));
    return JSON.parse(String(res.body)) as Record<string, unknown>;
  }

  /**
   * `lexicalTypes: []` collapses two states with different fixes: no store
   * wired (fix the host's composition) and nothing declared (fix the
   * consumer's namespace). `lexicalEnabled` separates them.
   *
   * Asserted through the plugin's kernel route rather than the pure handler:
   * a flag reporting composition is worthless if it is not itself composed.
   */
  it('reports true when the plugin composed WITH a lexical store', async () => {
    const body = await statsThrough(
      createRecallPlugin({
        store: new InMemoryEmbeddingsStore(),
        lexicalStore: new InMemoryLexicalStore()
      })
    );
    expect(body.lexicalEnabled).toBe(true);
  });

  it('reports false when the plugin composed WITHOUT one', async () => {
    const body = await statsThrough(createRecallPlugin({ store: new InMemoryEmbeddingsStore() }));
    expect(body.lexicalEnabled).toBe(false);
  });

  /**
   * With a store wired and nothing declared, `lexicalTypes` is legitimately
   * empty AND the arm is on.
   */
  it('separates "arm is on" from "nothing declared"', async () => {
    const body = await statsThrough(
      createRecallPlugin({
        store: new InMemoryEmbeddingsStore(),
        lexicalStore: new InMemoryLexicalStore()
      })
    );
    expect(body.lexicalEnabled).toBe(true);
    expect(body.lexicalTypes).toEqual([]);
  });

  /**
   * Absent, not false, when nobody told the handler. Same two-empty-answers
   * rule as `lexicalTypes`: `undefined` means this server does not say,
   * `false` means it says the arm is off. A client collapsing them would
   * report a working arm as broken on any older server.
   */
  it('omits the field entirely when the caller supplies no opinion', () => {
    expect(handleEmbedStatsRequest(undefined)).not.toHaveProperty('lexicalEnabled');
  });
});

import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import { SubstrateClient } from '../src/client.js';
import { mockHandlers } from './_setup.js';

const ENDPOINT = 'http://substrate.test';

describe('SubstrateClient', () => {
  it('fetches federated schema on first query', async () => {
    let schemaFetches = 0;
    mockHandlers(
      http.get(`${ENDPOINT}/substrate/v1/federated-schema`, () => {
        schemaFetches += 1;
        return HttpResponse.json({ claude: { schemaVersion: 'v1', types: {}, mutations: {} } });
      }),
      http.post(`${ENDPOINT}/substrate/v1/query`, () =>
        HttpResponse.json({
          schemaVersion: 'v1',
          data: { 'claude/Todo': [] },
          shapes: { 'claude/Todo': 'list' }
        })
      )
    );

    const client = new SubstrateClient({ endpoint: ENDPOINT });
    const env = await client.query({ 'claude/Todo': { params: {}, fields: { id: true } } });
    expect(env.data['claude/Todo']).toEqual([]);
    expect(schemaFetches).toBe(1);
    await client.close();
  });

  it('caches schema; second query does not refetch', async () => {
    let schemaFetches = 0;
    mockHandlers(
      http.get(`${ENDPOINT}/substrate/v1/federated-schema`, () => {
        schemaFetches += 1;
        return HttpResponse.json({ claude: { schemaVersion: 'v1', types: {}, mutations: {} } });
      }),
      http.post(`${ENDPOINT}/substrate/v1/query`, () =>
        HttpResponse.json({ schemaVersion: 'v1', data: {}, shapes: {} })
      )
    );

    const client = new SubstrateClient({ endpoint: ENDPOINT });
    await client.query({ 'claude/Todo': { params: {}, fields: {} } });
    await client.query({ 'claude/Todo': { params: {}, fields: {} } });
    expect(schemaFetches).toBe(1);
    await client.close();
  });

  it('refetches schema once when envelope schemaVersion differs from cached version', async () => {
    // Drift behaviour: first envelope seeds the cache, a subsequent mismatch
    // triggers exactly one schema refetch and the new version becomes
    // authoritative (no SchemaDriftError thrown).
    let schemaFetches = 0;
    let queryCount = 0;
    mockHandlers(
      http.get(`${ENDPOINT}/substrate/v1/federated-schema`, () => {
        schemaFetches += 1;
        return HttpResponse.json({ claude: { schemaVersion: 'v2', types: {}, mutations: {} } });
      }),
      http.post(`${ENDPOINT}/substrate/v1/query`, () => {
        queryCount += 1;
        // First query: envelope v1 — seeds drift cache (mismatch with nothing, just seeds).
        // Second query: envelope v2 — mismatches v1 in cache, triggers refetch.
        // Third+ queries: envelope v2 — matches cached v2, no refetch.
        const version = queryCount === 1 ? 'v1' : 'v2';
        return HttpResponse.json({ schemaVersion: version, data: {}, shapes: {} });
      })
    );

    const client = new SubstrateClient({ endpoint: ENDPOINT });
    // First query: schema fetched once (schemaFetches=1), envelope v1 seeds drift cache.
    await client.query({ 'claude/Todo': { params: {}, fields: {} } });
    expect(schemaFetches).toBe(1);

    // Second query: envelope returns v2 (mismatch vs cached v1) → schema refetched once.
    await client.query({ 'claude/Todo': { params: {}, fields: {} } });
    expect(schemaFetches).toBe(2); // initial + drift refetch

    // Third query: envelope v2 matches cached v2 → no further refetch.
    await client.query({ 'claude/Todo': { params: {}, fields: {} } });
    expect(schemaFetches).toBe(2);

    await client.close();
  });

  it('throws if both token and getToken provided', () => {
    expect(
      () => new SubstrateClient({ endpoint: ENDPOINT, token: 'x', getToken: async () => 'y' })
    ).toThrow(/provide.*token.*or.*getToken/i);
  });

  it('invalidate is safe to call with no matching cache entries', () => {
    const client = new SubstrateClient({ endpoint: ENDPOINT });
    expect(() => client.invalidate('claude/Todo')).not.toThrow();
  });

  it('invalidate reaches the underlying cache', () => {
    const client = new SubstrateClient({ endpoint: ENDPOINT });
    const unsub = client.cache.subscribe('claude/Todo:{"limit":10}');
    client.cache.set('claude/Todo:{"limit":10}', [{ id: 1 }]);
    client.invalidate('claude/Todo');
    expect(client.cache.peek('claude/Todo:{"limit":10}')?.invalidatedAt).toBeGreaterThan(0);
    unsub();
  });

  it('throws if methods are called after close()', async () => {
    mockHandlers(
      http.get(`${ENDPOINT}/substrate/v1/federated-schema`, () =>
        HttpResponse.json({ claude: { schemaVersion: 'v1', types: {}, mutations: {} } })
      )
    );
    const client = new SubstrateClient({ endpoint: ENDPOINT });
    await client.close();
    await expect(client.query({})).rejects.toThrow(/already closed/);
    await expect(client.mutate({})).rejects.toThrow(/already closed/);
    expect(() => client.subscribe({})).toThrow(/already closed/);
    expect(() => client.stream({})).toThrow(/already closed/);
  });

  it('calling close() twice is a no-op', async () => {
    const client = new SubstrateClient({ endpoint: ENDPOINT });
    await client.close();
    await expect(client.close()).resolves.toBeUndefined();
  });
});

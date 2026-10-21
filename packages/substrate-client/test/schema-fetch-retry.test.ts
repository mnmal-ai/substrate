import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import { SubstrateClient } from '../src/client.js';
import { mockHandlers } from './_setup.js';

const E = 'http://substrate.test';

/**
 * A failed first federated-schema fetch must not be cached. It used to be: the rejected
 * promise stayed in place, every later federatedSchema() — and so every query/mutate, which
 * await it — rejected with the original error until the process restarted. A worker that came
 * up before its substrate had bound stayed dead against a Substrate that was up.
 */
describe('federatedSchema retries after a failed fetch', () => {
  it('a fetch that rejects once is retried on the next call', async () => {
    let calls = 0;
    mockHandlers(
      http.get(`${E}/substrate/v1/federated-schema`, () => {
        calls += 1;
        return calls === 1
          ? new HttpResponse(null, { status: 503 })
          : HttpResponse.json({ cortext: { schemaVersion: 'v1', types: {}, mutations: {} } });
      })
    );
    const c = new SubstrateClient({ endpoint: E, token: 't', onDiagnostics: () => {} });
    await expect(c.federatedSchema()).rejects.toThrow();
    await expect(c.federatedSchema()).resolves.toHaveProperty('cortext');
    expect(calls).toBe(2);
  });

  it('a query after a failed first fetch succeeds once the server answers', async () => {
    let schemaCalls = 0;
    mockHandlers(
      http.get(`${E}/substrate/v1/federated-schema`, () => {
        schemaCalls += 1;
        return schemaCalls === 1
          ? HttpResponse.error()
          : HttpResponse.json({ cortext: { schemaVersion: 'v1', types: {}, mutations: {} } });
      }),
      http.post(`${E}/substrate/v1/query`, () =>
        HttpResponse.json({ schemaVersion: 'v1', data: { 'cortext/Todo': [] }, errors: [] })
      )
    );
    const c = new SubstrateClient({ endpoint: E, token: 't', onDiagnostics: () => {} });
    await expect(
      c.query({ 'cortext/Todo': { params: {}, fields: { id: true } } })
    ).rejects.toThrow();
    const env = await c.query({ 'cortext/Todo': { params: {}, fields: { id: true } } });
    expect(env.data).toEqual({ 'cortext/Todo': [] });
  });

  it('concurrent callers still share one in-flight fetch', async () => {
    let calls = 0;
    mockHandlers(
      http.get(`${E}/substrate/v1/federated-schema`, async () => {
        calls += 1;
        await new Promise((r) => setTimeout(r, 20));
        return HttpResponse.json({ cortext: { schemaVersion: 'v1', types: {}, mutations: {} } });
      })
    );
    const c = new SubstrateClient({ endpoint: E, token: 't', onDiagnostics: () => {} });
    await Promise.all([c.federatedSchema(), c.federatedSchema(), c.federatedSchema()]);
    expect(calls).toBe(1);
  });
});

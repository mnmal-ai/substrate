import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import { SubstrateClient } from '../src/client.js';
import { AuthError } from '../src/errors.js';
import { mockHandlers } from './_setup.js';

const ENDPOINT = 'http://substrate.test';

describe('client.metrics', () => {
  it('metrics() GETs /substrate/v1/metrics with bearer token and returns the body', async () => {
    let auth: string | null = null;
    mockHandlers(
      http.get(`${ENDPOINT}/substrate/v1/metrics`, ({ request }) => {
        auth = request.headers.get('authorization');
        return HttpResponse.json({
          since: '2026-01-01T00:00:00Z',
          requests: {
            query: { total: 100, ok: 95, error: 5, durationMsSum: 500, durationMsMax: 50 },
            mutate: { total: 50, ok: 48, error: 2, durationMsSum: 200, durationMsMax: 40 }
          },
          subscriptions: { active: 3 },
          events: {}
        });
      })
    );
    const c = new SubstrateClient({ endpoint: ENDPOINT, token: 't' });
    const result = await c.metrics();
    expect(result.since).toBe('2026-01-01T00:00:00Z');
    expect(result.requests.query.total).toBe(100);
    expect(auth).toBe('Bearer t');
  });

  it('errors() GETs /substrate/v1/errors', async () => {
    let auth: string | null = null;
    mockHandlers(
      http.get(`${ENDPOINT}/substrate/v1/errors`, ({ request }) => {
        auth = request.headers.get('authorization');
        return HttpResponse.json({
          since: '2026-01-01T00:00:00Z',
          errors: [
            {
              at: '2026-01-01T00:00:10Z',
              op: 'query',
              key: 'ns/Type',
              code: 'validation_error',
              message: 'invalid field'
            }
          ]
        });
      })
    );
    const c = new SubstrateClient({ endpoint: ENDPOINT, token: 't' });
    const result = await c.errors();
    expect(result.since).toBe('2026-01-01T00:00:00Z');
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.code).toBe('validation_error');
    expect(auth).toBe('Bearer t');
  });

  it('a 403 on errors() raises AuthError', async () => {
    mockHandlers(
      http.get(`${ENDPOINT}/substrate/v1/errors`, () => new HttpResponse(null, { status: 403 }))
    );
    const c = new SubstrateClient({ endpoint: ENDPOINT });
    await expect(c.errors()).rejects.toBeInstanceOf(AuthError);
  });
});

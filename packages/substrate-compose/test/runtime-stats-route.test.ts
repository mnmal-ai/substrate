import { createRuntimeStats } from '@mnmal-ai/substrate-core';
import { describe, expect, it } from 'vitest';
import { handleMetricsRequest, metricsRouteHandler } from '../src/routes/runtime-stats.js';

describe('metrics route', () => {
  it('handleMetricsRequest returns the snapshot', () => {
    const stats = createRuntimeStats({ activeSubscriptions: () => 2 });
    stats.recordRequest('query', true, 12);
    const body = handleMetricsRequest(stats);
    expect(body.requests.query.total).toBe(1);
    expect(body.subscriptions.active).toBe(2);
  });

  it('metricsRouteHandler serialises a 200 JSON response', async () => {
    const stats = createRuntimeStats({ activeSubscriptions: () => 0 });
    const handler = metricsRouteHandler(stats);
    const res = await handler({
      method: 'GET',
      path: '/substrate/v1/metrics',
      headers: {},
      query: {},
      params: {},
      body: null
    });
    expect(res.status).toBe(200);
    const parsed = JSON.parse(String(res.body));
    expect(parsed).toHaveProperty('since');
    expect(parsed).toHaveProperty('requests.query');
    expect(parsed).toHaveProperty('subscriptions.active', 0);
    expect(parsed).toHaveProperty('events');
  });
});

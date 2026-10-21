import { MemoryDataset } from '@mnmal-ai/substrate-dataset-memory';
import { defineNamespace, field } from '@mnmal-ai/substrate-sdk';
import { MemorySubstrateServer } from '@mnmal-ai/substrate-server-memory';
import { describe, expect, it } from 'vitest';
import type { AuthConfig } from '../src/auth.js';
import { compose } from '../src/compose.js';

describe('GET /substrate/v1/metrics', () => {
  it('counts query throughput, fans engine events, and gauges subscriptions', async () => {
    const server = new MemorySubstrateServer();
    const dataset = new MemoryDataset({ namespace: 'default' });
    const composed = await compose({
      // Auth is off in this harness, so the deployment declares who it writes as.
      systemActor: 'test',
      server,
      dataset
    });

    // A well-formed (empty) query: 200 → counted as an ok query via the observer.
    await server.inject({ method: 'POST', path: '/substrate/v1/query', body: Buffer.from('{}') });

    // An unqualified frame key makes the engine emit `engine_unqualified_key`,
    // which proves the engineOpts.metric fan-out reaches stats.recordEvent.
    await server.inject({
      method: 'POST',
      path: '/substrate/v1/query',
      body: Buffer.from(JSON.stringify({ nokey: { params: {}, fields: { id: true } } }))
    });

    const res = await server.inject({ method: 'GET', path: '/substrate/v1/metrics' });
    expect(res.status).toBe(200);
    const body = JSON.parse(String(res.body));
    expect(typeof body.since).toBe('string');
    expect(body.requests.query.total).toBeGreaterThanOrEqual(2);
    expect(body.requests.query.ok).toBeGreaterThanOrEqual(1);
    expect(body.events.engine_unqualified_key).toBeGreaterThanOrEqual(1);
    expect(body.subscriptions.active).toBe(0);
    await composed.stop();
  });

  it('includes subscriptions superset fields (maxQueueDepth, entries) in snapshot', async () => {
    const server = new MemorySubstrateServer();
    const dataset = new MemoryDataset({ namespace: 'default' });
    const composed = await compose({
      // Auth is off in this harness, so the deployment declares who it writes as.
      systemActor: 'test',
      server,
      dataset
    });

    const res = await server.inject({ method: 'GET', path: '/substrate/v1/metrics' });
    expect(res.status).toBe(200);
    const body = JSON.parse(String(res.body));
    // When no subscriptions are active the superset fields are still present
    expect(body.subscriptions.active).toBe(0);
    expect(typeof body.subscriptions.maxQueueDepth).toBe('number');
    expect(Array.isArray(body.subscriptions.entries)).toBe(true);

    await composed.stop();
  });

  it('GET /substrate/v1/metrics returns 401 when auth is enabled and no bearer is supplied', async () => {
    // Auth config mirrors the canonical test fixture used in auth-integration.test.ts —
    // HS256 key so no key-gen is needed; the secret is test-only.
    const SECRET = 'metrics-gate-test-secret';
    const KID = 'metrics-gate';
    const auth: AuthConfig = { keys: [{ kid: KID, alg: 'HS256', publicKey: SECRET }] };

    const server = new MemorySubstrateServer();
    const dataset = new MemoryDataset({ namespace: 'default' });
    const composed = await compose({
      // Auth is off in this harness, so the deployment declares who it writes as.
      systemActor: 'test',
      server,
      dataset,
      auth,
      streamTicketSecret: 'test-stream-ticket-secret'
    });

    // No Authorization header → should be rejected as 401.
    const res = await server.inject({ method: 'GET', path: '/substrate/v1/metrics' });
    expect(res.status).toBe(401);

    await composed.stop();
  });
  it('reports per-key resolvers, process stats and slowest, with no error text', async () => {
    const server = new MemorySubstrateServer();
    const dataset = new MemoryDataset({ namespace: 'default' });
    const composed = await compose({
      systemActor: 'test',
      server,
      dataset,
      coordinators: [
        {
          name: 'widget-plugin',
          contractVersion: '*',
          namespaces: [
            defineNamespace('default', { Widget: { fields: { label: field.string() } } })
          ]
        }
      ]
    });

    await server.inject({
      method: 'POST',
      path: '/substrate/v1/query',
      body: Buffer.from(
        JSON.stringify({
          'default/Widget': { params: {}, fields: { id: true } },
          'secretns/Thing': { params: {}, fields: { id: true } }
        })
      )
    });

    const res = await server.inject({ method: 'GET', path: '/substrate/v1/metrics' });
    expect(res.status).toBe(200);
    const raw = String(res.body);
    const body = JSON.parse(raw);
    expect(Object.keys(body.resolvers)).toEqual(
      expect.arrayContaining(['default/Widget', '(unknown)'])
    );
    expect(body.resolvers['(unknown)'].errors).toBe(1);
    expect(body.resolvers['default/Widget'].errors).toBe(0);
    for (const f of [
      'rssMB',
      'heapUsedMB',
      'cpuUserMs',
      'cpuSystemMs',
      'eventLoopLagP99Ms',
      'inFlight'
    ]) {
      expect(typeof body.process[f]).toBe('number');
    }
    expect(body.process.inFlight).toBe(0);
    expect(Array.isArray(body.slowest)).toBe(true);
    // Error text names other callers' rows and values; it is /substrate/v1/errors only.
    expect(raw).not.toContain('unknown namespace');

    await composed.stop();
  });
});

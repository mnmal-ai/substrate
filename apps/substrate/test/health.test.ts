/**
 * GET /health — shallow liveness probe coverage. Verifies the endpoint returns
 * 200 + JSON `{ status, version, uptimeSeconds }` unconditionally (no auth),
 * consistent with `/substrate/v1/onboard`'s always-open contract.
 */

import { type ComposeResult, compose } from '@mnmal-ai/substrate-compose';
import { MemoryDataset } from '@mnmal-ai/substrate-dataset-memory';
import { MemorySubstrateServer } from '@mnmal-ai/substrate-server-memory';
import type { SubstrateResponse } from '@mnmal-ai/substrate-types';
import { afterEach, describe, expect, it } from 'vitest';

function bodyJson<T>(res: SubstrateResponse): T {
  const b = res.body;
  if (Buffer.isBuffer(b)) return JSON.parse(b.toString('utf8')) as T;
  if (b instanceof Uint8Array) return JSON.parse(Buffer.from(b).toString('utf8')) as T;
  if (typeof b === 'string') return JSON.parse(b) as T;
  throw new Error('unexpected body shape');
}

describe('GET /health', () => {
  let server: MemorySubstrateServer | null = null;
  let composed: ComposeResult | null = null;

  afterEach(async () => {
    if (composed !== null) {
      await composed.stop();
      composed = null;
      server = null;
    }
  });

  it('returns 200 with { status, version, uptimeSeconds }', async () => {
    server = new MemorySubstrateServer();
    const dataset = new MemoryDataset({ namespace: 'default' });
    composed = await compose({
      // Auth is off, so the deployment must declare who it writes as.
      systemActor: 'test',
      server,
      dataset,
      version: '2.0.0-test'
    });
    const res = await server.inject({ method: 'GET', path: '/health' });
    expect(res.status).toBe(200);
    const body = bodyJson<{ status: string; version: string; uptimeSeconds: number }>(res);
    expect(body.status).toBe('ok');
    expect(body.version).toBe('2.0.0-test');
    expect(typeof body.uptimeSeconds).toBe('number');
    expect(body.uptimeSeconds).toBeGreaterThanOrEqual(0);
  });

  it('is not gated by auth — returns 200 with no token even when AuthConfig is present', async () => {
    server = new MemorySubstrateServer();
    const dataset = new MemoryDataset({ namespace: 'default' });
    composed = await compose({
      systemActor: 'test',
      server,
      dataset,
      auth: {
        keys: [{ kid: 'k1', alg: 'HS256', publicKey: 'secret-test' }],
        adminCapability: 'admin'
      },
      streamTicketSecret: 'test-stream-ticket-secret'
    });
    const res = await server.inject({ method: 'GET', path: '/health' });
    expect(res.status).toBe(200);
  });
});

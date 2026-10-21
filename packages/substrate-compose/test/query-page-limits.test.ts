/**
 * `/substrate/v1/query` bounds list reads for remote callers: the default
 * page when no `limit` is named, a refusal above the configured maximum.
 */

import { MemoryDataset } from '@mnmal-ai/substrate-dataset-memory';
import { defineNamespace, field } from '@mnmal-ai/substrate-sdk';
import { MemorySubstrateServer } from '@mnmal-ai/substrate-server-memory';
import { describe, expect, it } from 'vitest';
import { compose } from '../src/compose.js';

async function query(params: Record<string, unknown>) {
  const server = new MemorySubstrateServer();
  const dataset = new MemoryDataset({ namespace: 'default' });
  await dataset.write(
    'Widget',
    Array.from({ length: 5 }, (_, i) => ({ id: `w${i}`, label: `l${i}` }))
  );
  const composed = await compose({
    systemActor: 'test',
    server,
    dataset,
    pageLimits: { defaultLimit: 2, maxLimit: 3 },
    coordinators: [
      {
        name: 'widgets',
        contractVersion: '*',
        namespaces: [defineNamespace('default', { Widget: { fields: { label: field.string() } } })]
      }
    ]
  });
  await server.start();
  try {
    const res = await server.inject({
      method: 'POST',
      path: '/substrate/v1/query',
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(JSON.stringify({ 'default/Widget': { params, fields: { id: true } } }))
    });
    return JSON.parse(String(res.body)) as {
      data: Record<string, unknown[]>;
      errors?: Array<{ code?: string }>;
      _pagination?: Record<string, { hasMore: boolean }>;
    };
  } finally {
    await composed.stop();
  }
}

describe('/substrate/v1/query page limits', () => {
  it('returns the default page, with more to come, when no limit is named', async () => {
    const body = await query({});
    expect(body.data['default/Widget']).toHaveLength(2);
    expect(body._pagination?.['default/Widget']?.hasMore).toBe(true);
  });

  it('refuses a limit above the maximum', async () => {
    const body = await query({ limit: 4 });
    expect(body.errors?.[0]?.code).toBe('limit_exceeds_max');
  });
});

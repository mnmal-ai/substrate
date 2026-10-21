/**
 * §5.13 — compose() idempotency wire-up.
 *
 * Proves the binary's composition root plumbs an `IdempotencyStore` through
 * to the engine end-to-end: two mutate frames that share an `idempotencyKey`
 * return byte-identical envelopes and land exactly one row in the dataset.
 *
 * The frame shape is the `mutateRoute` entry-point, not a hand-crafted engine
 * call — the point of this test is that the HTTP surface inherits dedup
 * automatically when compose() gets a store.
 */

import { type ComposeResult, compose } from '@mnmal-ai/substrate-compose';
import { MemoryIdempotencyStore } from '@mnmal-ai/substrate-core';
import { MemoryDataset } from '@mnmal-ai/substrate-dataset-memory';
import { MemorySubstrateServer } from '@mnmal-ai/substrate-server-memory';
import type { PackEnvelope, SubstrateResponse } from '@mnmal-ai/substrate-types';
import { afterEach, describe, expect, it } from 'vitest';
import { fixturePlugin } from './_fixtures/fixture-plugin.js';

function bodyToString(res: SubstrateResponse): string {
  const b = res.body;
  if (b === undefined || b === null) return '';
  if (typeof b === 'string') return b;
  if (Buffer.isBuffer(b)) return b.toString('utf8');
  if (b instanceof Uint8Array) return Buffer.from(b).toString('utf8');
  return '';
}

describe('compose — §5.13 idempotency wire-up', () => {
  let composed: ComposeResult | null = null;

  afterEach(async () => {
    if (composed !== null) {
      await composed.stop();
      composed = null;
    }
  });

  it('repeated mutate frame with the same idempotencyKey replays the cached envelope and writes exactly once', async () => {
    const server = new MemorySubstrateServer();
    const dataset = new MemoryDataset({ namespace: 'default' });
    const store = new MemoryIdempotencyStore();
    composed = await compose({
      // Auth is off, so the deployment must declare who it writes as.
      systemActor: 'test',
      server,
      dataset,
      idempotency: { store },
      coordinators: [fixturePlugin]
    });
    await server.start();

    const frame = {
      'default/createTodo': {
        params: { title: 'dedup-me', done: false },
        fields: { id: true, title: true },
        idempotencyKey: 'k-compose'
      }
    };

    const first = await server.inject({
      method: 'POST',
      path: '/substrate/v1/mutate',
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(JSON.stringify(frame))
    });
    expect(first.status).toBe(200);

    const second = await server.inject({
      method: 'POST',
      path: '/substrate/v1/mutate',
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(JSON.stringify(frame))
    });
    expect(second.status).toBe(200);

    // Byte-identical envelope replay is the core §5.13 contract.
    expect(bodyToString(second)).toBe(bodyToString(first));

    const firstEnv = JSON.parse(bodyToString(first)) as PackEnvelope;
    const secondEnv = JSON.parse(bodyToString(second)) as PackEnvelope;
    expect(secondEnv).toEqual(firstEnv);

    // And the underlying dataset holds exactly one row — the second mutate
    // short-circuited before the resolver ran.
    const { rows } = await dataset.read('Todo', {});
    expect(rows).toHaveLength(1);
    expect(rows[0]?.title).toBe('dedup-me');
  });
});

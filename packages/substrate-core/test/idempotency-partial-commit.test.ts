/**
 * A frame where one key commits and another is refused must still be cached
 * under its idempotency key. Caching only error-free replies made the retry
 * re-run the key that had already committed, which is the duplicate the key
 * exists to prevent. The retry gets the stored reply, refusal included; to try
 * the refused part again the caller sends it under a new key.
 */

import { MemoryDataset, MemoryDatasetRegistry } from '@mnmal-ai/substrate-dataset-memory';
import { denyAll } from '@mnmal-ai/substrate-policy';
import type { RequestContext, Row } from '@mnmal-ai/substrate-types';
import { describe, expect, it } from 'vitest';
import {
  Engine,
  MemoryEdgesStore,
  MemoryIdempotencyStore,
  type NamespaceConfig,
  Registry
} from '../src/index.js';

function bootstrap(): { engine: Engine; getRuns: () => number } {
  const dataset = new MemoryDataset({ namespace: 'default' });
  const registry = new Registry();
  const datasets = new MemoryDatasetRegistry();
  datasets.set('default', dataset);
  let runs = 0;
  registry.register('createTodo', {
    kind: 'mutation',
    resolver: async (_ctx, args) => {
      runs += 1;
      const row: Row = { id: String(args.params?.id ?? 'x') };
      await args.dataset?.write('Todo', [row]);
      return row;
    }
  });
  registry.register('createSecret', {
    kind: 'mutation',
    policy: denyAll(),
    resolver: async () => ({ id: 's' })
  });
  const engine = new Engine({
    namespaces: new Map<string, NamespaceConfig>([['default', { registry }]]),
    datasets,
    edges: new MemoryEdgesStore({ now: () => new Date('2026-10-22T00:00:00Z') }),
    metric: () => {},
    idempotency: { store: new MemoryIdempotencyStore() }
  });
  return { engine, getRuns: () => runs };
}

const ctx: Partial<RequestContext> = {
  identity: null,
  now: new Date('2026-10-22T00:00:00Z'),
  headers: {},
  meta: {}
};

describe('idempotency: a partly committed frame', () => {
  it('replays the stored reply on retry instead of re-running the committed key', async () => {
    const { engine, getRuns } = bootstrap();
    const frame = {
      'default/createTodo': { params: { id: 't1' }, fields: { id: true }, idempotencyKey: 'k' },
      'default/createSecret': { params: {}, fields: { id: true }, idempotencyKey: 'k' }
    };

    const first = await engine.mutate({ frame, ctx });
    expect(first.data['default/createTodo']).toBeDefined();
    expect(first.errors?.[0]?.code).toBe('policy_denied');

    const retry = await engine.mutate({ frame, ctx });
    expect(getRuns()).toBe(1);
    expect(retry.errors).toEqual(first.errors);
  });

  it('does not cache a frame where nothing ran, so the retry runs', async () => {
    const { engine } = bootstrap();
    const frame = {
      'default/createSecret': { params: {}, fields: { id: true }, idempotencyKey: 'k2' }
    };
    await engine.mutate({ frame, ctx });
    const retry = await engine.mutate({ frame, ctx });
    expect(retry.errors?.[0]?.code).toBe('policy_denied');
    expect(retry.data['default/createSecret']).toBeUndefined();
  });
});

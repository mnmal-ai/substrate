/**
 * A subscription `where` is matched against every write to its type, so its
 * size and the number of subscriptions on one type are capped.
 */

import { MemoryDataset, MemoryDatasetRegistry } from '@mnmal-ai/substrate-dataset-memory';
import type { WsResponseFrame } from '@mnmal-ai/substrate-types';
import { expect, it } from 'vitest';
import {
  MAX_SUBSCRIBE_LIST_VALUES,
  MAX_SUBSCRIBE_PREDICATES,
  MAX_SUBSCRIPTIONS_PER_TYPE
} from '../src/engine/subscribe.js';
import { Engine, MemoryEdgesStore, type NamespaceConfig, Registry } from '../src/index.js';

function boot() {
  const datasets = new MemoryDatasetRegistry();
  datasets.set('app', new MemoryDataset({ namespace: 'app' }));
  const registry = new Registry();
  registry.register('Thing', { kind: 'type', resolver: async () => [] });
  const engine = new Engine({
    namespaces: new Map<string, NamespaceConfig>([['app', { registry }]]),
    datasets,
    edges: new MemoryEdgesStore({ now: () => new Date() })
  });
  const subscribe = async (where?: unknown) => {
    const frames: WsResponseFrame[] = [];
    await engine.subscribe({
      id: 's',
      frame: {
        'app/Thing': { ...(where !== undefined ? { params: { where } } : {}), fields: { id: true } }
      },
      ctx: { identity: null },
      onFrame: (f) => {
        frames.push(f);
      }
    });
    return frames[0]?.kind === 'error' ? frames[0].errors?.[0]?.code : 'open';
  };
  return { engine, subscribe };
}

const or = (n: number) => ({
  OR: Array.from({ length: n }, (_, i) => ({ id: { eq: String(i) } }))
});
const list = (n: number) => ({ id: { in: Array.from({ length: n }, (_, i) => String(i)) } });

it('admits a where at the predicate cap and refuses one past it', async () => {
  const { subscribe } = boot();
  expect(await subscribe(or(MAX_SUBSCRIBE_PREDICATES))).toBe('open');
  expect(await subscribe(or(MAX_SUBSCRIBE_PREDICATES + 1))).toBe('invalid_logical');
});

it('admits a list at the value cap and refuses one past it', async () => {
  const { subscribe } = boot();
  expect(await subscribe(list(MAX_SUBSCRIBE_LIST_VALUES))).toBe('open');
  expect(await subscribe(list(MAX_SUBSCRIBE_LIST_VALUES + 1))).toBe('invalid_logical');
});

it('refuses a subscription once its type holds the store-wide maximum', async () => {
  const { engine, subscribe } = boot();
  for (let i = 0; i < MAX_SUBSCRIPTIONS_PER_TYPE; i++) expect(await subscribe()).toBe('open');
  expect(await subscribe()).toBe('too_many_subscriptions');
  expect(engine.activeSubscriptionCount()).toBe(MAX_SUBSCRIPTIONS_PER_TYPE);
});

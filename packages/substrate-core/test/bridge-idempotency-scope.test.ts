/**
 * Locally the idempotency cache is caller-scoped, but a peer sees every
 * forwarded write under the bridge's one credential. A key forwarded verbatim
 * let caller B's write hit caller A's cached reply on the peer: B got A's row
 * and its own write never ran. The forwarded key must be scoped to the caller.
 */

import { MemoryDataset, MemoryDatasetRegistry } from '@mnmal-ai/substrate-dataset-memory';
import type {
  BridgeClient,
  BridgeFrame,
  BridgeRegistry,
  Identity
} from '@mnmal-ai/substrate-types';
import { expect, it } from 'vitest';
import { Engine, MemoryEdgesStore, Registry } from '../src/index.js';

it('forwards an idempotency key scoped to the local caller', async () => {
  const forwarded: BridgeFrame[] = [];
  const client: BridgeClient = {
    name: 'orders',
    baseUrl: 'http://peer.test',
    federatedSchema: async () => ({}),
    query: async () => ({ schemaVersion: 't', data: {}, shapes: {} }),
    mutate: async (frame) => {
      forwarded.push(frame);
      return { schemaVersion: 't', data: { 'orders/createOrder': { id: 'o' } }, shapes: {} };
    },
    readRow: async () => null,
    isReachable: () => true,
    dispose: () => {}
  };
  const bridges: BridgeRegistry = {
    has: (n) => n === 'orders',
    get: (n) => (n === 'orders' ? client : undefined),
    isUnreachable: () => false,
    entries: () => [['orders', client]]
  };
  const datasets = new MemoryDatasetRegistry();
  datasets.set('notes', new MemoryDataset({ namespace: 'notes' }));
  const engine = new Engine({
    namespaces: new Map([['notes', { registry: new Registry() }]]),
    datasets,
    edges: new MemoryEdgesStore({ now: () => new Date() }),
    sweepHooks: { bridges }
  });
  const as = (id: string): Identity => ({ id, kind: 'agent', grants: { '*': ['read', 'mutate'] } });
  const frame = {
    'orders/createOrder': { params: {}, fields: { id: true }, idempotencyKey: 'retry-1' }
  };

  await engine.mutate({ frame, ctx: { identity: as('caller-a') } });
  await engine.mutate({ frame, ctx: { identity: as('caller-b') } });
  await engine.mutate({ frame, ctx: { identity: as('caller-a') } });

  const keys = forwarded.map((f) => f['orders/createOrder']?.idempotencyKey);
  expect(keys).toHaveLength(3);
  expect(keys[0]).not.toBe('retry-1');
  expect(keys[0]).not.toBe(keys[1]);
  // The same caller retrying gets the same forwarded key, so peer dedup still works.
  expect(keys[2]).toBe(keys[0]);
});

/**
 * A bridged namespace is gated by the caller's grant like a local one: a key
 * outside the grant is refused before anything reaches the bridge.
 */

import { MemoryDataset, MemoryDatasetRegistry } from '@mnmal-ai/substrate-dataset-memory';
import type { BridgeClient, BridgeRegistry, Identity } from '@mnmal-ai/substrate-types';
import { expect, it } from 'vitest';
import { Engine, MemoryEdgesStore, Registry } from '../src/index.js';

it('refuses bridged query and mutate keys outside the caller grant', async () => {
  const calls: string[] = [];
  const client: BridgeClient = {
    name: 'orders',
    baseUrl: 'http://peer.test',
    federatedSchema: async () => ({}),
    query: async () => {
      calls.push('query');
      return { schemaVersion: 't', data: { 'orders/Order': [{ id: 'x' }] }, shapes: {} };
    },
    mutate: async () => {
      calls.push('mutate');
      return { schemaVersion: 't', data: { 'orders/deleteOrder': { ok: true } }, shapes: {} };
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
  const identity: Identity = { id: 'low', kind: 'agent', grants: { notes: ['read', 'mutate'] } };

  const q = await engine.query({
    frame: { 'orders/Order': { fields: { id: true } } },
    ctx: { identity }
  });
  const m = await engine.mutate({
    frame: { 'orders/deleteOrder': { params: { id: '1' }, fields: { ok: true } } },
    ctx: { identity }
  });

  expect(calls).toEqual([]);
  expect(q.data['orders/Order']).toBeUndefined();
  expect(q.errors?.[0]?.code).toBe('unauthorized_namespace');
  expect(m.errors?.[0]?.code).toBe('unauthorized_namespace');
});

/**
 * A bridged namespace is gated by the caller's grant like a local one: a key
 * outside the grant is refused before anything reaches the bridge.
 */

import { MemoryDataset, MemoryDatasetRegistry } from '@mnmal-ai/substrate-dataset-memory';
import type { BridgeClient, BridgeRegistry, Identity } from '@mnmal-ai/substrate-types';
import { expect, it } from 'vitest';
import { Engine, MemoryEdgesStore, Registry } from '../src/index.js';

const ref = (ns: string, type: string) => ({ kind: 'crossRef', ns, type, onDelete: 'set_null' });
const str = { kind: 'scalar', type: 'string' };
/** What the peer serves: orders and app on one store, joined by references both ways. */
const PEER_SCHEMA = {
  orders: {
    schemaVersion: 'p',
    mutations: {},
    types: {
      Order: { fields: { customer: ref('orders', 'Customer'), part: ref('app', 'Part') } },
      Customer: { fields: { region: str } }
    }
  },
  app: {
    schemaVersion: 'p',
    mutations: {},
    types: { Part: { fields: { order: ref('orders', 'Order'), name: str } } }
  }
};

/** An engine with `aliases` bridged, each to its own peer url unless `peers` names one. */
function build(aliases: string[] = ['orders'], peers: Record<string, string> = {}) {
  const calls: string[] = [];
  const clientFor = (name: string): BridgeClient => ({
    name,
    baseUrl: peers[name] ?? 'http://peer.test',
    federatedSchema: async () => PEER_SCHEMA as never,
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
  });
  const clients = new Map(aliases.map((a) => [a, clientFor(a)]));
  const bridges: BridgeRegistry = {
    has: (n) => clients.has(n),
    get: (n) => clients.get(n),
    isUnreachable: () => false,
    entries: () => [...clients]
  };
  const datasets = new MemoryDatasetRegistry();
  datasets.set('notes', new MemoryDataset({ namespace: 'notes' }));
  const engine = new Engine({
    namespaces: new Map([['notes', { registry: new Registry() }]]),
    datasets,
    edges: new MemoryEdgesStore({ now: () => new Date() }),
    sweepHooks: { bridges }
  });
  return { engine, calls };
}

it('refuses bridged query and mutate keys outside the caller grant', async () => {
  const { engine, calls } = build();
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

/**
 * The peer answers a forwarded frame under the bridge's credential, so a walk
 * is forwarded only when every namespace it reaches is one the caller may read.
 */
const narrow: Identity = { id: 'narrow', kind: 'agent', grants: { orders: ['read'] } };
const both: Identity = { id: 'both', kind: 'agent', grants: { orders: ['read'], app: ['read'] } };
const INTO_APP = [
  { params: { where: { _walk: { in: 'app/Part.order' } } }, fields: { id: true } },
  { params: { where: { _walk: { out: 'part' } } }, fields: { id: true } },
  { fields: { id: true, parts: { _walk: { in: 'app/Part.order' }, fields: { name: true } } } },
  { fields: { id: true, _agg: { n: { in: 'app/Part.order', count: true } } } },
  { params: { aggregate: { n: { count: true } }, groupBy: { p: 'part.name' } } },
  // Reaches app one hop down, through a namespace the caller does read.
  {
    params: { where: { _walk: { out: 'customer', where: { _walk: { in: 'app/Part.order' } } } } },
    fields: { id: true }
  }
];
const WITHIN_ORDERS = [
  { params: { where: { _walk: { out: 'customer', where: { region: { eq: 'eu' } } } } } },
  { params: { aggregate: { n: { count: true } }, groupBy: { r: 'customer.region' } } },
  { params: { count: true, limit: 5 }, fields: { id: true } }
];

async function ask(engine: Engine, identity: Identity | null, entry: object) {
  const res = await engine.query({ frame: { 'orders/Order': entry as never }, ctx: { identity } });
  return res.errors?.map((e) => e.code) ?? [];
}

it('forwards a bridged walk that stays in namespaces the caller reads', async () => {
  for (const entry of WITHIN_ORDERS) {
    const { engine, calls } = build();
    await engine.refreshBridgeSchemas();
    expect(await ask(engine, narrow, entry)).toEqual([]);
    expect(calls).toEqual(['query']);
  }
  // app is bridged to the same peer under its own name, and the caller reads it.
  for (const entry of INTO_APP) {
    const { engine, calls } = build(['orders', 'app']);
    await engine.refreshBridgeSchemas();
    expect(await ask(engine, both, entry)).toEqual([]);
    expect(calls).toEqual(['query']);
  }
});

it('refuses a bridged walk into a namespace the caller cannot read here', async () => {
  for (const entry of INTO_APP) {
    for (const [identity, aliases, peers] of [
      // No grant on app.
      [narrow, ['orders', 'app'], {}],
      // A grant on app, which is not bridged here: the name means nothing locally.
      [both, ['orders'], {}],
      // A grant on app, bridged to a different peer: another namespace of that name.
      [both, ['orders', 'app'], { app: 'http://other.test' }]
    ] as const) {
      const { engine, calls } = build([...aliases], peers);
      await engine.refreshBridgeSchemas();
      expect(await ask(engine, identity, entry)).toEqual(['bridge_walk_refused']);
      expect(calls).toEqual([]);
    }
  }
});

it('refuses a bridged walk it cannot resolve', async () => {
  const unresolved = [
    { params: { where: { _walk: { out: 'nosuchfield' } } } },
    { params: { where: { _walk: { out: 'customer', in: 'app/Part.order' } } } },
    { fields: { id: true, _agg: { n: { count: true } } } },
    { params: { groupBy: ['customer.region'] } }
  ];
  for (const entry of unresolved) {
    const { engine, calls } = build();
    await engine.refreshBridgeSchemas();
    expect(await ask(engine, narrow, entry)).toEqual(['bridge_walk_refused']);
    expect(calls).toEqual([]);
  }
  // No schema cached for the bridge: any walk is unresolved, a plain read is not.
  const { engine, calls } = build();
  expect(await ask(engine, narrow, WITHIN_ORDERS[0] as object)).toEqual(['bridge_walk_refused']);
  expect(await ask(engine, narrow, { fields: { id: true } })).toEqual([]);
  expect(calls).toEqual(['query']);
});

it('forwards any bridged walk for a caller that reads every namespace', async () => {
  const wide: Identity = { id: 'wide', kind: 'agent', grants: { '*': ['read'] } };
  for (const identity of [wide, null]) {
    const { engine, calls } = build();
    expect(await ask(engine, identity, INTO_APP[0] as object)).toEqual([]);
    expect(calls).toEqual(['query']);
  }
  const shadowed: Identity = { id: 's', kind: 'agent', grants: { '*': ['read'], app: [] } };
  const { engine, calls } = build(['orders', 'app']);
  await engine.refreshBridgeSchemas();
  expect(await ask(engine, shadowed, INTO_APP[0] as object)).toEqual(['bridge_walk_refused']);
  expect(calls).toEqual([]);
});

/**
 * Virtual (dataset-less) namespace dispatch. A namespace registered
 * with `virtual: true` owns NO dataset: the engine skips the dataset-presence
 * check and leaves `args.dataset` undefined. Resolvers compute purely from
 * params/fields. This suite pins query + mutate dispatch, the mixed-payload
 * "ignore foreign tx" semantics, and the regression guards (non-virtual ns
 * without a dataset still rejects; unknown name still surfaces unknown_name).
 */

import { MemoryDataset, MemoryDatasetRegistry } from '@mnmal-ai/substrate-dataset-memory';
import type { BridgeClient, BridgeRegistry, Row } from '@mnmal-ai/substrate-types';
import { describe, expect, it } from 'vitest';
import { Engine, MemoryEdgesStore, type NamespaceConfig, Registry } from '../src/index.js';

function makeEdges(): MemoryEdgesStore {
  return new MemoryEdgesStore({ now: () => new Date('2026-06-11T00:00:00Z') });
}

/**
 * A bridge registry that claims `ns` and counts every proxy dispatch. Used to
 * prove a runtime-registered bridge does NOT shadow a boot-time local namespace
 * claim: when `recall` exists locally, the engine must route `recall/*` to the
 * local resolver and leave `bridgeHits` at zero.
 */
function bridgeClaiming(ns: string): { bridges: BridgeRegistry; hits: () => number } {
  let bridgeHits = 0;
  const stubClient: BridgeClient = {
    name: ns,
    baseUrl: 'http://never-called',
    federatedSchema: async () => ({}),
    query: async () => {
      bridgeHits += 1;
      return { schemaVersion: 'x', data: {}, shapes: {} };
    },
    mutate: async () => {
      bridgeHits += 1;
      return { schemaVersion: 'x', data: {}, shapes: {} };
    },
    readRow: async () => null,
    isReachable: () => true,
    dispose: () => {}
  };
  const bridges: BridgeRegistry = {
    has: (n) => n === ns,
    get: (n) => (n === ns ? stubClient : undefined),
    isUnreachable: () => false,
    entries: () => [[ns, stubClient]]
  };
  return { bridges, hits: () => bridgeHits };
}

describe('Engine — virtual (dataset-less) namespaces', () => {
  it('queries a virtual type with no dataset; resolver sees args.dataset === undefined', async () => {
    const appDs = new MemoryDataset({ namespace: 'app' });
    const datasets = new MemoryDatasetRegistry();
    datasets.set('app', appDs);

    const virtualRegistry = new Registry();
    virtualRegistry.register('Hit', {
      kind: 'type',
      resolver: async (_ctx, args) => {
        expect(args.dataset).toBeUndefined();
        const to = args.params?.to;
        return [{ id: 'h1', namespace: 'app', type: 'Thing', score: 0.9, echo: to }];
      }
    });

    const namespaces = new Map<string, NamespaceConfig>([
      ['app', { registry: new Registry() }],
      ['recall', { registry: virtualRegistry, virtual: true }]
    ]);
    const engine = new Engine({ namespaces, datasets, edges: makeEdges() });

    const envelope = await engine.query({
      frame: { 'recall/Hit': { params: { to: 'jazz' }, fields: { id: true } } },
      ctx: {}
    });

    expect(envelope.errors).toBeUndefined();
    expect(envelope.data['recall/Hit']).toEqual([
      { id: 'h1', namespace: 'app', type: 'Thing', score: 0.9, echo: 'jazz' }
    ]);
    expect(envelope.shapes['recall/Hit']).toBe('list');
  });

  it('mutates through a virtual mutation; resolver sees args.dataset === undefined', async () => {
    const datasets = new MemoryDatasetRegistry();
    datasets.set('app', new MemoryDataset({ namespace: 'app' }));

    const virtualRegistry = new Registry();
    virtualRegistry.register('boost', {
      kind: 'mutation',
      resolver: async (_ctx, args) => {
        expect(args.dataset).toBeUndefined();
        const targets = args.params?.targets as unknown[];
        return { id: 'ack', ok: true, requested: targets.length } satisfies Row;
      }
    });

    const namespaces = new Map<string, NamespaceConfig>([
      ['app', { registry: new Registry() }],
      ['recall', { registry: virtualRegistry, virtual: true }]
    ]);
    const engine = new Engine({ namespaces, datasets, edges: makeEdges() });

    const envelope = await engine.mutate({
      frame: { 'recall/boost': { params: { targets: ['a', 'b', 'c'] }, fields: { id: true } } },
      ctx: {}
    });

    expect(envelope.errors).toBeUndefined();
    expect(envelope.data['recall/boost']).toEqual({ id: 'ack', ok: true, requested: 3 });
    expect(envelope.shapes['recall/boost']).toBe('single');
  });

  it('mixed payload: dataset mutation + virtual mutation; virtual still sees no dataset', async () => {
    const appDs = new MemoryDataset({ namespace: 'app' });
    const datasets = new MemoryDatasetRegistry();
    datasets.set('app', appDs);

    // Dataset-backed mutation on 'app' — writes a row through args.dataset (the
    // tx view) so the shared-tx path is genuinely exercised.
    const appRegistry = new Registry();
    appRegistry.register('makeThing', {
      kind: 'mutation',
      resolver: async (_ctx, args) => {
        if (args.dataset === undefined) throw new Error('app mutation requires a dataset');
        const id = String(args.params?.id ?? 'x');
        await args.dataset.write('Thing', [{ id, label: 'made' }]);
        const {
          rows: [row]
        } = await args.dataset.read('Thing', { id });
        return row as Row;
      }
    });

    let virtualSawDataset: unknown = 'unset';
    const virtualRegistry = new Registry();
    virtualRegistry.register('boost', {
      kind: 'mutation',
      resolver: async (_ctx, args) => {
        // Pinned assertion: even riding inside the dataset branch's shared tx,
        // the virtual resolver must NOT receive the foreign tx as its dataset.
        virtualSawDataset = args.dataset;
        expect(args.dataset).toBeUndefined();
        const targets = args.params?.targets as unknown[];
        return { id: 'ack', ok: true, requested: targets.length } satisfies Row;
      }
    });

    const namespaces = new Map<string, NamespaceConfig>([
      ['app', { registry: appRegistry }],
      ['recall', { registry: virtualRegistry, virtual: true }]
    ]);
    const engine = new Engine({ namespaces, datasets, edges: makeEdges() });

    const envelope = await engine.mutate({
      frame: {
        'app/makeThing': { params: { id: 't1' }, fields: { id: true } },
        'recall/boost': { params: { targets: ['a', 'b'] }, fields: { id: true } }
      },
      ctx: {}
    });

    expect(envelope.errors).toBeUndefined();
    expect(envelope.data['app/makeThing']).toMatchObject({ id: 't1', label: 'made' });
    expect(envelope.data['recall/boost']).toEqual({ id: 'ack', ok: true, requested: 2 });
    expect(virtualSawDataset).toBeUndefined();

    // The dataset write actually landed.
    const { rows } = await appDs.read('Thing', { id: 't1' });
    expect(rows[0]).toMatchObject({ id: 't1', label: 'made' });
  });

  it('non-virtual namespace with no dataset still rejects with unknown_namespace', async () => {
    const datasets = new MemoryDatasetRegistry();
    const namespaces = new Map<string, NamespaceConfig>([
      // Registered in namespaces, NO dataset, NOT virtual — misconfiguration.
      ['ghost', { registry: new Registry() }]
    ]);
    const engine = new Engine({ namespaces, datasets, edges: makeEdges() });

    const envelope = await engine.query({
      frame: { 'ghost/Thing': { params: {}, fields: { id: true } } },
      ctx: {}
    });

    expect(envelope.errors?.[0]?.code).toBe('unknown_namespace');
  });

  it('batched array on virtual namespace rejects with batched_virtual_unsupported; resolver not invoked', async () => {
    const datasets = new MemoryDatasetRegistry();
    datasets.set('app', new MemoryDataset({ namespace: 'app' }));

    let resolverCallCount = 0;
    const virtualRegistry = new Registry();
    virtualRegistry.register('boost', {
      kind: 'mutation',
      resolver: async (_ctx, args) => {
        resolverCallCount++;
        const targets = args.params?.targets as unknown[];
        return { id: 'ack', ok: true, requested: targets.length } satisfies Row;
      }
    });

    const namespaces = new Map<string, NamespaceConfig>([
      ['app', { registry: new Registry() }],
      ['recall', { registry: virtualRegistry, virtual: true }]
    ]);
    const engine = new Engine({ namespaces, datasets, edges: makeEdges() });

    // Batched array under a virtual key — must refuse honestly, not dispatch.
    const envelope = await engine.mutate({
      frame: {
        'recall/boost': [
          { params: { targets: ['a', 'b'] }, fields: {} },
          { params: { targets: ['c'] }, fields: {} }
        ]
      },
      ctx: {}
    });

    expect(envelope.errors).toBeDefined();
    expect(envelope.errors).toHaveLength(1);
    const err = envelope.errors![0]!;
    expect(err.code).toBe('batched_virtual_unsupported');
    expect(err.message).toContain('recall');
    expect(err.message).toContain('virtual');
    // Resolver must not have been invoked.
    expect(resolverCallCount).toBe(0);
  });

  it('virtual namespace + unknown name surfaces unknown_name (lookup ordering survived)', async () => {
    const datasets = new MemoryDatasetRegistry();
    const virtualRegistry = new Registry();
    virtualRegistry.register('Hit', {
      kind: 'type',
      resolver: async () => null
    });

    const namespaces = new Map<string, NamespaceConfig>([
      ['recall', { registry: virtualRegistry, virtual: true }]
    ]);
    const engine = new Engine({ namespaces, datasets, edges: makeEdges() });

    const envelope = await engine.query({
      frame: { 'recall/Nope': { params: {}, fields: { id: true } } },
      ctx: {}
    });

    expect(envelope.errors?.[0]?.code).toBe('unknown_name');
  });

  it('a local virtual namespace wins over a runtime-registered bridge claiming the same alias (query)', async () => {
    // Bridges register at runtime via substrate-sentinel, AFTER boot-time collision
    // checks. A bridge claiming `recall` must NOT shadow the local virtual
    // surface — the local boot-time claim wins; the query dispatches locally.
    const datasets = new MemoryDatasetRegistry();
    datasets.set('app', new MemoryDataset({ namespace: 'app' }));

    let resolverInvoked = false;
    const virtualRegistry = new Registry();
    virtualRegistry.register('Hit', {
      kind: 'type',
      resolver: async (_ctx, args) => {
        resolverInvoked = true;
        const to = args.params?.to;
        return [{ id: 'h1', score: 0.9, echo: to }];
      }
    });

    const namespaces = new Map<string, NamespaceConfig>([
      ['app', { registry: new Registry() }],
      ['recall', { registry: virtualRegistry, virtual: true }]
    ]);
    const { bridges, hits } = bridgeClaiming('recall');
    const engine = new Engine({
      namespaces,
      datasets,
      edges: makeEdges(),
      sweepHooks: { bridges }
    });

    const envelope = await engine.query({
      frame: { 'recall/Hit': { params: { to: 'jazz' }, fields: { id: true } } },
      ctx: {}
    });

    expect(envelope.errors).toBeUndefined();
    expect(resolverInvoked).toBe(true);
    expect(hits()).toBe(0);
    expect(envelope.data['recall/Hit']).toEqual([{ id: 'h1', score: 0.9, echo: 'jazz' }]);
  });

  it('a local virtual namespace wins over a runtime-registered bridge claiming the same alias (mutate)', async () => {
    const datasets = new MemoryDatasetRegistry();
    datasets.set('app', new MemoryDataset({ namespace: 'app' }));

    let resolverInvoked = false;
    const virtualRegistry = new Registry();
    virtualRegistry.register('boost', {
      kind: 'mutation',
      resolver: async (_ctx, args) => {
        resolverInvoked = true;
        const targets = args.params?.targets as unknown[];
        return { id: 'ack', ok: true, requested: targets.length } satisfies Row;
      }
    });

    const namespaces = new Map<string, NamespaceConfig>([
      ['app', { registry: new Registry() }],
      ['recall', { registry: virtualRegistry, virtual: true }]
    ]);
    const { bridges, hits } = bridgeClaiming('recall');
    const engine = new Engine({
      namespaces,
      datasets,
      edges: makeEdges(),
      sweepHooks: { bridges }
    });

    const envelope = await engine.mutate({
      frame: { 'recall/boost': { params: { targets: ['a', 'b', 'c'] }, fields: { id: true } } },
      ctx: {}
    });

    expect(envelope.errors).toBeUndefined();
    expect(resolverInvoked).toBe(true);
    expect(hits()).toBe(0);
    expect(envelope.data['recall/boost']).toEqual({ id: 'ack', ok: true, requested: 3 });
  });

  it('control: a genuinely-bridged namespace (no local registration) still diverts to the bridge', async () => {
    // Guard against over-correcting: the divert must still fire when the ns is
    // absent from the local namespaces map.
    const datasets = new MemoryDatasetRegistry();
    datasets.set('app', new MemoryDataset({ namespace: 'app' }));

    const namespaces = new Map<string, NamespaceConfig>([['app', { registry: new Registry() }]]);
    const { bridges, hits } = bridgeClaiming('remote');
    const engine = new Engine({
      namespaces,
      datasets,
      edges: makeEdges(),
      sweepHooks: { bridges }
    });

    await engine.query({
      frame: { 'remote/Thing': { params: {}, fields: { id: true } } },
      ctx: {}
    });
    await engine.mutate({
      frame: { 'remote/makeThing': { params: { id: 'r1' }, fields: { id: true } } },
      ctx: {}
    });

    // One query divert + one mutate divert.
    expect(hits()).toBe(2);
  });

  it('schemaFor marks virtual namespaces', () => {
    const appDs = new MemoryDataset({ namespace: 'app' });
    const datasets = new MemoryDatasetRegistry();
    datasets.set('app', appDs);

    const virtualRegistry = new Registry();
    virtualRegistry.register('Hit', {
      kind: 'type',
      resolver: async () => []
    });

    const namespaces = new Map<string, NamespaceConfig>([
      ['app', { registry: new Registry() }],
      ['recall', { registry: virtualRegistry, virtual: true }]
    ]);
    const engine = new Engine({ namespaces, datasets, edges: makeEdges() });

    expect(engine.schemaFor('recall').virtual).toBe(true);
    expect(engine.schemaFor('app').virtual).toBeUndefined();
  });
});

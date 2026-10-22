/**
 * The single-frame mutate bucket shares one tx: every key dispatches (or
 * reports why not), and a resolver refusing through the envelope rolls the
 * whole bucket back.
 */

import { MemoryDataset, MemoryDatasetRegistry } from '@mnmal-ai/substrate-dataset-memory';
import { ResolverFrameError, type WriteEvent } from '@mnmal-ai/substrate-types';
import { describe, expect, it } from 'vitest';
import { Engine, MemoryEdgesStore, type NamespaceConfig, Registry } from '../src/index.js';

function makeEdges(): MemoryEdgesStore {
  return new MemoryEdgesStore({ now: () => new Date('2026-04-18T00:00:00Z') });
}

const ctx = { identity: null, headers: {}, meta: {} };

function writer(type: string): Registry {
  const reg = new Registry();
  reg.register('create', {
    resolver: async (_c, args) => {
      const row = { id: `${type}-1`, title: 't' };
      await args.dataset?.write(type, [row]);
      args.onWrite?.({ kind: 'add', namespace: 'x', type, row } as unknown as WriteEvent);
      return row;
    }
  });
  reg.register('refuse', {
    resolver: async () => {
      throw new ResolverFrameError('not_found', 'no such row');
    }
  });
  return reg;
}

/** Two namespaces on one substrate that can coalesce into one tx. */
function coalescing(): { engine: Engine; dsA: MemoryDataset; virtualRuns: () => number } {
  const SHARED = 'mem:shared';
  const dsA = new MemoryDataset({ namespace: 'a', txScopeId: SHARED });
  const dsB = new MemoryDataset({ namespace: 'b', txScopeId: SHARED });
  Object.assign(dsA, {
    withScopedTransaction: (
      nss: string[],
      fn: (h: { datasets: Map<string, MemoryDataset>; edges: null }) => Promise<unknown>
    ) =>
      dsA.withTransaction(() =>
        dsB.withTransaction(() =>
          fn({
            datasets: new Map(nss.map((n) => [n, n === 'a' ? dsA : dsB])),
            edges: null
          })
        )
      )
  });
  const datasets = new MemoryDatasetRegistry();
  datasets.set('a', dsA);
  datasets.set('b', dsB);
  let runs = 0;
  const v = new Registry();
  v.register('m', {
    resolver: async () => {
      runs += 1;
      return { id: 'v' };
    }
  });
  const namespaces = new Map<string, NamespaceConfig>([
    ['a', { registry: writer('A') }],
    ['b', { registry: writer('B') }],
    ['v', { registry: v, virtual: true }]
  ]);
  return {
    engine: new Engine({ namespaces, datasets, edges: makeEdges() }),
    dsA,
    virtualRuns: () => runs
  };
}

describe('single-frame mutate bucket', () => {
  it('a coalesced tx still dispatches virtual, unknown and unqualified keys', async () => {
    const { engine, virtualRuns } = coalescing();
    const env = await engine.mutate({
      frame: {
        'a/create': { params: {} },
        'b/create': { params: {} },
        'v/m': { params: {} },
        'nope/m': { params: {} },
        unqualified: { params: {} }
      },
      ctx
    });
    expect(virtualRuns()).toBe(1);
    expect(env.data['v/m']).toEqual({ id: 'v' });
    const codes = (env.errors ?? []).map((e) => [e.path?.[0], e.code]);
    expect(codes).toEqual(
      expect.arrayContaining([
        ['nope/m', 'unknown_namespace'],
        ['unqualified', 'unqualified_key']
      ])
    );
  });

  it('a ResolverFrameError rolls back earlier entries in a coalesced tx', async () => {
    const { engine, dsA } = coalescing();
    const env = await engine.mutate({
      frame: { 'a/create': { params: {} }, 'b/refuse': { params: {} } },
      ctx
    });
    expect(env.data['a/create']).toBeUndefined();
    expect((await dsA.read('A', {})).rows).toEqual([]);
    expect(env.errors?.map((e) => [e.path?.[0], e.code])).toEqual([
      ['b/refuse', 'not_found'],
      ['a/create', 'frame_rolled_back']
    ]);
  });

  it('marks entries after the refusal, which never ran, as rolled back', async () => {
    const { engine } = coalescing();
    const env = await engine.mutate({
      frame: {
        'a/create': { params: {} },
        'b/refuse': { params: {} },
        'b/create': { params: {} }
      },
      ctx
    });
    expect(env.data['b/create']).toBeUndefined();
    expect(env.errors?.map((e) => [e.path?.[0], e.code])).toEqual([
      ['b/refuse', 'not_found'],
      ['a/create', 'frame_rolled_back'],
      ['b/create', 'frame_rolled_back']
    ]);
  });

  it('a ResolverFrameError rolls back earlier entries on one dataset', async () => {
    const ds = new MemoryDataset({ namespace: 'a' });
    const datasets = new MemoryDatasetRegistry();
    datasets.set('a', ds);
    const engine = new Engine({
      namespaces: new Map([['a', { registry: writer('A') }]]),
      datasets,
      edges: makeEdges()
    });
    const env = await engine.mutate({
      frame: { 'a/create': { params: {} }, 'a/refuse': { params: {} } },
      ctx
    });
    expect((await ds.read('A', {})).rows).toEqual([]);
    expect(env.errors?.map((e) => e.code)).toEqual(['not_found', 'frame_rolled_back']);
  });

  it('afterTx work runs after the rollback, and its writes survive it', async () => {
    const ds = new MemoryDataset({ namespace: 'a' });
    const reg = writer('A');
    reg.register('refuseAndRecord', {
      resolver: async (_c, args) => {
        args.afterTx?.(async () => {
          await ds.write('Audit', [{ id: 'audit-1', note: 'refused' }]);
        });
        throw new ResolverFrameError('destructive_ops_disabled', 'refused');
      }
    });
    const datasets = new MemoryDatasetRegistry();
    datasets.set('a', ds);
    const engine = new Engine({
      namespaces: new Map([['a', { registry: reg }]]),
      datasets,
      edges: makeEdges()
    });
    await engine.mutate({
      frame: { 'a/create': { params: {} }, 'a/refuseAndRecord': { params: {} } },
      ctx
    });
    expect((await ds.read('A', {})).rows).toEqual([]);
    expect((await ds.read('Audit', {})).rows.map((r) => r.id)).toEqual(['audit-1']);
  });
});

/**
 * A retry that arrives while the first call is still running must not run the
 * mutate again, and a cache write that fails after commit must not fail the
 * call (the caller would retry a write that already landed).
 */

import { MemoryDataset, MemoryDatasetRegistry } from '@mnmal-ai/substrate-dataset-memory';
import type { IdempotencyStore } from '@mnmal-ai/substrate-types';
import { describe, expect, it } from 'vitest';
import {
  Engine,
  MemoryEdgesStore,
  MemoryIdempotencyStore,
  type NamespaceConfig,
  Registry
} from '../src/index.js';

function bootstrap(
  store: IdempotencyStore,
  gate?: Promise<void>
): { engine: Engine; runs: () => number } {
  const datasets = new MemoryDatasetRegistry();
  datasets.set('default', new MemoryDataset({ namespace: 'default' }));
  const registry = new Registry();
  let runs = 0;
  registry.register('createTodo', {
    kind: 'mutation',
    resolver: async () => {
      runs += 1;
      await gate;
      return { id: 'x' };
    }
  });
  const namespaces = new Map<string, NamespaceConfig>([['default', { registry }]]);
  const engine = new Engine({
    namespaces,
    datasets,
    edges: new MemoryEdgesStore({ now: () => new Date('2026-06-28T00:00:00Z') }),
    idempotency: { store }
  });
  return { engine, runs: () => runs };
}

const frame = { 'default/createTodo': { params: {}, idempotencyKey: 'k1' } };
const ctx = { identity: null };

describe('idempotency while the first call is running', () => {
  it('a concurrent duplicate joins the running call instead of writing again', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const { engine, runs } = bootstrap(new MemoryIdempotencyStore(), gate);
    const first = engine.mutate({ frame, ctx });
    const second = engine.mutate({ frame, ctx });
    release();
    const [a, b] = await Promise.all([first, second]);
    expect(runs()).toBe(1);
    expect(b.data).toEqual(a.data);
  });

  it('a failing cache write after commit still returns the envelope', async () => {
    const store = new MemoryIdempotencyStore();
    store.put = async () => {
      throw new Error('store down');
    };
    const { engine } = bootstrap(store);
    const env = await engine.mutate({ frame, ctx });
    expect(env.data['default/createTodo']).toEqual({ id: 'x' });
  });

  const batch = { 'default/createTodo': [{ params: {}, idempotencyKey: 'b1' }] };

  it('a concurrent duplicate batch joins the running call instead of writing again', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const { engine, runs } = bootstrap(new MemoryIdempotencyStore(), gate);
    const first = engine.mutate({ frame: batch, ctx });
    const second = engine.mutate({ frame: batch, ctx });
    release();
    await Promise.all([first, second]);
    expect(runs()).toBe(1);
  });

  it('a failing batched cache write after commit still returns the envelope', async () => {
    const store = new MemoryIdempotencyStore();
    store.put = async () => {
      throw new Error('store down');
    };
    const { engine } = bootstrap(store);
    const env = await engine.mutate({ frame: batch, ctx });
    expect(env.data['default/createTodo']).toEqual([{ id: 'x' }]);
  });

  it('concurrent batches sharing one slot key but differing elsewhere both run', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const { engine, runs } = bootstrap(new MemoryIdempotencyStore(), gate);
    const first = engine.mutate({
      frame: { 'default/createTodo': [{ params: {}, idempotencyKey: 'b2' }, { params: { n: 1 } }] },
      ctx
    });
    const second = engine.mutate({
      frame: { 'default/createTodo': [{ params: {}, idempotencyKey: 'b2' }, { params: { n: 2 } }] },
      ctx
    });
    release();
    await Promise.all([first, second]);
    expect(runs()).toBe(4);
  });
});

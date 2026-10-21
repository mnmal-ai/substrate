import { MemoryDataset, MemoryDatasetRegistry } from '@mnmal-ai/substrate-dataset-memory';
import type { RequestContext } from '@mnmal-ai/substrate-types';
import { describe, expect, it, vi } from 'vitest';
import { Engine } from '../src/engine/engine.js';
import { MemoryEdgesStore } from '../src/memory-edges-store.js';
import { Registry } from '../src/registry.js';

const NOW = (): Date => new Date('2026-05-07T00:00:00Z');

function ctx(): Partial<RequestContext> {
  return { identity: null, now: NOW() };
}

function buildEngine(...nss: string[]): {
  engine: Engine;
  datasets: MemoryDatasetRegistry;
} {
  const datasets = new MemoryDatasetRegistry();
  const namespaces = new Map<string, { registry: Registry }>();
  for (const ns of nss) {
    datasets.set(ns, new MemoryDataset({ namespace: ns }));
    const registry = new Registry();
    registry.register('Item', { resolver: async () => [] });
    registry.register('createItem', {
      kind: 'mutation',
      resolver: async () => ({ id: 'x' })
    });
    namespaces.set(ns, { registry });
  }
  const engine = new Engine({
    namespaces,
    datasets,
    edges: new MemoryEdgesStore({ now: NOW })
  });
  return { engine, datasets };
}

describe('Engine.tombstoneNamespace', () => {
  it('hides the namespace from federatedSchema()', () => {
    const { engine } = buildEngine('alpha', 'beta');
    expect(Object.keys(engine.federatedSchema()).sort()).toEqual(['alpha', 'beta']);

    engine.tombstoneNamespace('beta');

    expect(Object.keys(engine.federatedSchema()).sort()).toEqual(['alpha']);
  });

  it('makes schemaFor(ns) throw unknown-namespace', () => {
    const { engine } = buildEngine('alpha');
    expect(() => engine.schemaFor('alpha')).not.toThrow();

    engine.tombstoneNamespace('alpha');

    expect(() => engine.schemaFor('alpha')).toThrow(/unknown namespace/);
  });

  it('returns namespace_tombstoned per-key error on query', async () => {
    const { engine } = buildEngine('alpha');
    engine.tombstoneNamespace('alpha');

    const env = await engine.query({
      frame: { 'alpha/Item': { params: {}, fields: { id: true } } },
      ctx: ctx()
    });

    expect(env.errors).toHaveLength(1);
    expect(env.errors?.[0]?.code).toBe('namespace_tombstoned');
    expect(env.errors?.[0]?.path).toEqual(['alpha/Item']);
  });

  it('returns namespace_tombstoned per-key error on mutate', async () => {
    const { engine } = buildEngine('alpha');
    engine.tombstoneNamespace('alpha');

    const env = await engine.mutate({
      frame: { 'alpha/createItem': { params: {}, fields: {} } },
      ctx: ctx()
    });

    expect(env.errors).toHaveLength(1);
    expect(env.errors?.[0]?.code).toBe('namespace_tombstoned');
  });

  it('refuses addNamespace for a tombstoned ns', () => {
    const { engine } = buildEngine('alpha');
    engine.tombstoneNamespace('alpha');

    expect(() => engine.addNamespace('alpha', { registry: new Registry() })).toThrow(/tombstoned/);
  });

  it('closes existing subscriptions on tombstone with namespace_tombstoned error frame', async () => {
    const { engine } = buildEngine('alpha');
    const onFrame = vi.fn();
    const handle = await engine.subscribe({
      id: 'sub-1',
      frame: { 'alpha/Item': { params: {}, fields: { id: true } } },
      onFrame,
      ctx: ctx()
    });
    onFrame.mockClear();

    engine.tombstoneNamespace('alpha');

    expect(onFrame).toHaveBeenCalled();
    const errFrame = onFrame.mock.calls[0]?.[0];
    expect(errFrame?.kind).toBe('error');
    expect(errFrame?.errors?.[0]?.code).toBe('namespace_tombstoned');

    handle.cancel();
  });

  it('refuses new subscriptions on a tombstoned ns', async () => {
    const { engine } = buildEngine('alpha');
    engine.tombstoneNamespace('alpha');

    const onFrame = vi.fn();
    await engine.subscribe({
      id: 'sub-2',
      frame: { 'alpha/Item': { params: {}, fields: { id: true } } },
      onFrame,
      ctx: ctx()
    });

    expect(onFrame).toHaveBeenCalled();
    const frame = onFrame.mock.calls[0]?.[0];
    expect(frame?.kind).toBe('error');
    expect(frame?.errors?.[0]?.code).toBe('namespace_tombstoned');
  });

  it('tombstoneNamespace reachable through EngineHandle', async () => {
    const { engine } = buildEngine('alpha');
    const handle: import('@mnmal-ai/substrate-types').EngineHandle = engine;
    handle.tombstoneNamespace('alpha');
    // Observable effect: query against the tombstoned ns returns namespace_tombstoned.
    const env = await handle.query({
      frame: { 'alpha/Item': { params: {}, fields: { id: true } } },
      ctx: ctx()
    });
    expect(env.errors?.[0]?.code).toBe('namespace_tombstoned');
  });

  // cross-namespace sibling teardown
  it('tombstone tears down ALL entries of a multi-namespace subscription, not just the tombstoned ns', async () => {
    // Build an engine with two namespaces. Register a single logical
    // subscription spanning BOTH namespaces (one frame key per ns).
    const { engine } = buildEngine('alpha', 'beta');
    const frames: import('@mnmal-ai/substrate-types').WsResponseFrame[] = [];
    const onFrame = vi.fn((f: import('@mnmal-ai/substrate-types').WsResponseFrame): void => {
      frames.push(f);
    });

    const handle = await engine.subscribe({
      id: 'multi-ns-sub',
      frame: {
        'alpha/Item': { params: {}, fields: { id: true } },
        'beta/Item': { params: {}, fields: { id: true } }
      },
      onFrame,
      ctx: ctx()
    });

    // Clear the initial snapshot frames.
    onFrame.mockClear();
    frames.length = 0;

    // Tombstone alpha only.
    engine.tombstoneNamespace('alpha');

    // Should receive exactly ONE error frame for the logical subscription id.
    const errorFrames = frames.filter((f) => f.kind === 'error');
    expect(errorFrames).toHaveLength(1);
    expect(errorFrames[0]?.id).toBe('multi-ns-sub');

    // After tombstone, a WriteEvent on beta should NOT be delivered — the
    // beta entry must have been torn down too, not left as an orphan.
    onFrame.mockClear();
    frames.length = 0;

    // Mutate beta to produce a WriteEvent. If beta's entry were still live it
    // would deliver an 'add' frame; if correctly torn down, nothing arrives.
    await engine.mutate({
      frame: { 'beta/createItem': { params: {}, fields: { id: true } } },
      ctx: ctx()
    });

    // Give the microtask queue a tick to flush any queued drain.
    await Promise.resolve();

    const dataFrames = frames.filter((f) => f.kind === 'add' || f.kind === 'update');
    expect(dataFrames).toHaveLength(0);

    handle.cancel();
  });

  it('tombstone is idempotent when called twice for the same ns', async () => {
    const { engine } = buildEngine('alpha');
    const onFrame = vi.fn();

    const handle = await engine.subscribe({
      id: 'idem-sub',
      frame: { 'alpha/Item': { params: {}, fields: { id: true } } },
      onFrame,
      ctx: ctx()
    });
    onFrame.mockClear();

    engine.tombstoneNamespace('alpha');
    engine.tombstoneNamespace('alpha'); // second call — should be a no-op

    // Still exactly one error frame (from the first tombstone call).
    const errorCalls = onFrame.mock.calls.filter((c) => c[0]?.kind === 'error');
    expect(errorCalls).toHaveLength(1);

    handle.cancel();
  });

  // onFrame-throw emits metric, does not abort teardown
  it('emits subscribe_close_frame_throw metric when onFrame throws on tombstone close', async () => {
    const metricCalls: { name: string; attrs: Record<string, unknown> }[] = [];

    // Build an engine with a custom metric sink so we can assert the metric fires.
    const datasets = new MemoryDatasetRegistry();
    const namespaces = new Map<string, { registry: Registry }>();
    for (const ns of ['alpha', 'beta']) {
      datasets.set(ns, new MemoryDataset({ namespace: ns }));
      const registry = new Registry();
      registry.register('Item', { resolver: async () => [] });
      namespaces.set(ns, { registry });
    }
    const engineWithMetric = new Engine({
      namespaces,
      datasets,
      edges: new MemoryEdgesStore({ now: NOW }),
      metric: (name, attrs) =>
        metricCalls.push({ name, attrs: (attrs as Record<string, unknown>) ?? {} })
    });

    // onFrame throws on the error frame (simulates a broken consumer).
    const onFrame = vi.fn().mockImplementation((f: { kind: string }) => {
      if (f.kind === 'error') throw new Error('consumer exploded');
    });

    const handle = await engineWithMetric.subscribe({
      id: 'throwing-sub',
      frame: {
        'alpha/Item': { params: {}, fields: { id: true } },
        'beta/Item': { params: {}, fields: { id: true } }
      },
      onFrame,
      ctx: ctx()
    });

    metricCalls.length = 0; // clear snapshot-time metrics

    engineWithMetric.tombstoneNamespace('alpha');

    // The metric must have fired for the throwing close frame.
    const throwMetric = metricCalls.find((m) => m.name === 'subscribe_close_frame_throw');
    expect(throwMetric).toBeDefined();
    expect(throwMetric?.attrs.ns).toBe('alpha');

    // Despite the throw, beta's entry must also have been torn down.
    // A beta mutate must NOT deliver any frames after the tombstone.
    const afterFrames: unknown[] = [];
    onFrame.mockImplementation((f: unknown) => afterFrames.push(f));

    await engineWithMetric.mutate({
      frame: { 'beta/createItem': { params: {}, fields: { id: true } } },
      ctx: ctx()
    });
    await Promise.resolve();

    const dataAfter = afterFrames.filter(
      (f) => (f as { kind: string }).kind === 'add' || (f as { kind: string }).kind === 'update'
    );
    expect(dataAfter).toHaveLength(0);

    handle.cancel();
  });
});

describe('subscription teardown is per subscribe() call', () => {
  it("tombstoning one caller's namespace leaves another caller's same-id subscription live", async () => {
    const { engine } = buildEngine('x', 'y');
    const alice = vi.fn();
    const bob = vi.fn();
    await engine.subscribe({
      id: '1',
      frame: { 'x/Item': { fields: { id: true } } },
      onFrame: alice,
      ctx: ctx()
    });
    await engine.subscribe({
      id: '1',
      frame: { 'y/Item': { fields: { id: true } } },
      onFrame: bob,
      ctx: ctx()
    });
    alice.mockClear();
    bob.mockClear();

    engine.tombstoneNamespace('x');

    expect(alice).toHaveBeenCalledTimes(1);
    expect(bob).not.toHaveBeenCalled();
    expect(engine.activeSubscriptionCount()).toBe(1);
  });

  it('a subscribe that throws part-way unregisters the entries it already made', async () => {
    const { engine } = buildEngine('x', 'y');
    let snapshots = 0;
    const onFrame = (): void => {
      snapshots += 1;
      if (snapshots === 2) throw new Error('consumer failed');
    };
    await expect(
      engine.subscribe({
        id: 's',
        frame: { 'x/Item': { fields: { id: true } }, 'y/Item': { fields: { id: true } } },
        onFrame,
        ctx: ctx()
      })
    ).rejects.toThrow('consumer failed');
    expect(engine.activeSubscriptionCount()).toBe(0);
  });
});

describe('subscribe error text', () => {
  it("does not hand a resolver's internal error text to the subscriber", async () => {
    const datasets = new MemoryDatasetRegistry();
    datasets.set('x', new MemoryDataset({ namespace: 'x' }));
    const registry = new Registry();
    registry.register('Item', {
      resolver: async () => {
        throw new Error('relation "secret_table" does not exist');
      }
    });
    const engine = new Engine({
      namespaces: new Map([['x', { registry }]]),
      datasets,
      edges: new MemoryEdgesStore({ now: NOW })
    });
    const onFrame = vi.fn();
    await engine.subscribe({
      id: 's',
      frame: { 'x/Item': { fields: { id: true } } },
      onFrame,
      ctx: ctx()
    });
    expect(onFrame.mock.calls[0]?.[0]?.errors?.[0]).toMatchObject({
      code: 'resolver_error',
      message: 'internal error'
    });
  });
});

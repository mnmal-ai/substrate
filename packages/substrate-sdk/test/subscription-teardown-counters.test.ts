/**
 * §5.13 — subscription teardown counters by reason.
 *
 * Verifies that the engine emits exactly one `engine_subscription_closed_<reason>`
 * metric event per logical teardown, regardless of how many frame keys the
 * subscription spans. Five teardown paths are exercised:
 *
 *  1. cancel (default) — handle.cancel() with no argument → `_cancel`
 *  2. socket_close     — handle.cancel('socket_close') → `_socket_close`
 *  3. shutdown         — handle.cancel('shutdown') → `_shutdown`
 *  4. overload         — queue-limit breach → `_overloaded` + legacy `_overloaded` metric
 *  5. namespace tombstone — engine.tombstoneNamespace() → `_namespace_tombstoned`
 *
 * A two-key subscribe followed by cancel must count ONCE (not twice).
 */

import { Engine, MemoryEdgesStore, type NamespaceConfig, Registry } from '@mnmal-ai/substrate-core';
import { MemoryDataset, MemoryDatasetRegistry } from '@mnmal-ai/substrate-dataset-memory';
import type { FieldDef, RequestContext, WsResponseFrame } from '@mnmal-ai/substrate-types';
import { describe, expect, it } from 'vitest';
import { installAutoCrud } from '../src/index.js';

function makeEdges(nowMs = Date.parse('2026-04-18T00:00:00Z')): MemoryEdgesStore {
  return new MemoryEdgesStore({ now: () => new Date(nowMs) });
}

function makeCtx(overrides: Partial<RequestContext> = {}): Partial<RequestContext> {
  return {
    identity: { kind: 'system', id: 'test', grants: { '*': ['read', 'mutate'] } },
    now: new Date('2026-04-18T00:00:00Z'),
    headers: {},
    meta: {},
    ...overrides
  };
}

function todoFields(): Record<string, FieldDef> {
  return {
    id: { kind: 'scalar', type: 'string', indexed: true },
    title: { kind: 'scalar', type: 'string', indexed: true }
  };
}

interface Bootstrapped {
  engine: Engine;
  dataset: MemoryDataset;
  metrics: Array<{ name: string; payload: unknown }>;
}

function bootstrap(opts: { subscriptionQueueLimit?: number } = {}): Bootstrapped {
  const dataset = new MemoryDataset({ namespace: 'default' });
  const dataset2 = new MemoryDataset({ namespace: 'other' });
  const edges = makeEdges();
  const registry = new Registry();
  installAutoCrud(registry, 'Todo', dataset, edges, { fields: todoFields() });

  const registry2 = new Registry();
  installAutoCrud(registry2, 'Item', dataset2, edges, { fields: todoFields() });

  const datasets = new MemoryDatasetRegistry();
  datasets.set('default', dataset);
  datasets.set('other', dataset2);
  const namespaces = new Map<string, NamespaceConfig>([
    ['default', { registry }],
    ['other', { registry: registry2 }]
  ]);

  const metrics: Array<{ name: string; payload: unknown }> = [];
  const engine = new Engine({
    namespaces,
    datasets,
    edges,
    metric: (name, payload) => {
      metrics.push({ name, payload });
    },
    ...(opts.subscriptionQueueLimit !== undefined
      ? { subscriptions: { queueLimit: opts.subscriptionQueueLimit } }
      : {})
  });
  return { engine, dataset, metrics };
}

function countMetric(metrics: Array<{ name: string }>, name: string): number {
  return metrics.filter((m) => m.name === name).length;
}

describe('subscription teardown counters by reason', () => {
  it('cancel (default reason): single-key subscribe → cancel → exactly one engine_subscription_closed_cancel', async () => {
    const { engine, metrics } = bootstrap();

    const handle = await engine.subscribe({
      id: 'cancel-1',
      frame: { 'default/Todo': { params: {}, fields: { id: true } } },
      ctx: makeCtx(),
      onFrame: () => {}
    });
    handle.cancel();

    expect(countMetric(metrics, 'engine_subscription_closed_cancel')).toBe(1);
  });

  it('cancel (default reason): two-key subscribe counts ONCE, not twice', async () => {
    const { engine, metrics } = bootstrap();

    const handle = await engine.subscribe({
      id: 'cancel-multi',
      frame: {
        'default/Todo': { params: {}, fields: { id: true } },
        'other/Item': { params: {}, fields: { id: true } }
      },
      ctx: makeCtx(),
      onFrame: () => {}
    });
    handle.cancel();

    expect(countMetric(metrics, 'engine_subscription_closed_cancel')).toBe(1);
  });

  it('double cancel does not double-count', async () => {
    const { engine, metrics } = bootstrap();

    const handle = await engine.subscribe({
      id: 'cancel-double',
      frame: { 'default/Todo': { params: {}, fields: { id: true } } },
      ctx: makeCtx(),
      onFrame: () => {}
    });
    handle.cancel();
    handle.cancel(); // second call must be a no-op for metrics

    expect(countMetric(metrics, 'engine_subscription_closed_cancel')).toBe(1);
  });

  it('socket_close reason: handle.cancel("socket_close") → engine_subscription_closed_socket_close', async () => {
    const { engine, metrics } = bootstrap();

    const handle = await engine.subscribe({
      id: 'sc-1',
      frame: { 'default/Todo': { params: {}, fields: { id: true } } },
      ctx: makeCtx(),
      onFrame: () => {}
    });
    handle.cancel('socket_close');

    expect(countMetric(metrics, 'engine_subscription_closed_socket_close')).toBe(1);
    expect(countMetric(metrics, 'engine_subscription_closed_cancel')).toBe(0);
  });

  it('shutdown reason: handle.cancel("shutdown") → engine_subscription_closed_shutdown', async () => {
    const { engine, metrics } = bootstrap();

    const handle = await engine.subscribe({
      id: 'sd-1',
      frame: { 'default/Todo': { params: {}, fields: { id: true } } },
      ctx: makeCtx(),
      onFrame: () => {}
    });
    handle.cancel('shutdown');

    expect(countMetric(metrics, 'engine_subscription_closed_shutdown')).toBe(1);
    expect(countMetric(metrics, 'engine_subscription_closed_cancel')).toBe(0);
  });

  it('overload: queue-limit breach → engine_subscription_closed_overloaded AND legacy engine_subscription_overloaded', async () => {
    const limit = 3;
    const { engine, metrics } = bootstrap({ subscriptionQueueLimit: limit });

    const pendingResolves: Array<() => void> = [];
    const collected: WsResponseFrame[] = [];

    await engine.subscribe({
      id: 'overload-1',
      frame: { 'default/Todo': { params: {}, fields: { id: true } } },
      ctx: makeCtx(),
      onFrame: (f) => {
        collected.push(f);
        return new Promise<void>((resolve) => {
          pendingResolves.push(resolve);
        });
      }
    });

    // Fire limit + 2 mutations to breach the queue
    const mutPromises: Array<Promise<unknown>> = [];
    for (let i = 0; i < limit + 2; i++) {
      mutPromises.push(
        engine.mutate({
          frame: { 'default/createTodo': { params: { id: `o${i}`, title: `overload-${i}` } } },
          ctx: makeCtx()
        })
      );
      await Promise.resolve();
    }
    await Promise.all(mutPromises);

    // Drain pending callbacks to let terminal frames fire
    for (let tick = 0; tick < 20; tick++) {
      while (pendingResolves.length > 0) pendingResolves.shift()?.();
      await Promise.resolve();
      await Promise.resolve();
    }

    expect(countMetric(metrics, 'engine_subscription_closed_overloaded')).toBe(1);
    // Legacy metric must still fire (back-compat)
    expect(countMetric(metrics, 'engine_subscription_overloaded')).toBe(1);
  });

  it('overload: writes buffered behind a slow snapshot past the queue limit end the subscription', async () => {
    const limit = 3;
    const { engine, dataset, metrics } = bootstrap({ subscriptionQueueLimit: limit });
    let openGate = (): void => {};
    const gate = new Promise<void>((r) => {
      openGate = r;
    });
    const read = dataset.read.bind(dataset);
    let gated = true;
    dataset.read = async (...args: Parameters<MemoryDataset['read']>) => {
      // Only the snapshot read parks; the creates below must still commit.
      if (gated) {
        gated = false;
        await gate;
      }
      return read(...args);
    };

    const collected: WsResponseFrame[] = [];
    const subscribed = engine.subscribe({
      id: 'overload-pending',
      frame: { 'default/Todo': { params: {}, fields: { id: true } } },
      ctx: makeCtx(),
      onFrame: (f) => {
        collected.push(f);
      }
    });
    await Promise.resolve();
    for (let i = 0; i < limit + 2; i++) {
      await engine.mutate({
        frame: { 'default/createTodo': { params: { id: `p${i}`, title: `pending-${i}` } } },
        ctx: makeCtx()
      });
    }
    openGate();
    await subscribed;
    for (let tick = 0; tick < 10; tick++) await Promise.resolve();

    expect(countMetric(metrics, 'engine_subscription_overloaded')).toBe(1);
    expect(collected.map((f) => f.kind)).toEqual(['error', 'end']);
  });

  it('namespace tombstone: tombstoneNamespace → engine_subscription_closed_namespace_tombstoned once per subscription', async () => {
    const { engine, metrics } = bootstrap();

    await engine.subscribe({
      id: 'tomb-1',
      frame: { 'default/Todo': { params: {}, fields: { id: true } } },
      ctx: makeCtx(),
      onFrame: () => {}
    });

    engine.tombstoneNamespace('default');

    expect(countMetric(metrics, 'engine_subscription_closed_namespace_tombstoned')).toBe(1);
  });
});

describe('subscriptionStats()', () => {
  it('returns count=0, maxQueueDepth=0, entries=[] when no subscriptions are active', () => {
    const { engine } = bootstrap();
    const stats = engine.subscriptionStats();
    expect(stats.count).toBe(0);
    expect(stats.maxQueueDepth).toBe(0);
    expect(stats.entries).toEqual([]);
  });

  it('returns count and entries for active subscriptions', async () => {
    const { engine } = bootstrap();

    await engine.subscribe({
      id: 'stats-1',
      frame: {
        'default/Todo': { params: {}, fields: { id: true } },
        'other/Item': { params: {}, fields: { id: true } }
      },
      ctx: makeCtx(),
      onFrame: () => {}
    });

    const stats = engine.subscriptionStats();
    // Two entries for the two frame keys
    expect(stats.count).toBe(2);
    // No pending frames → queue is idle
    expect(stats.maxQueueDepth).toBe(0);
    expect(stats.entries).toHaveLength(2);
    const ids = stats.entries.map((e) => e.id);
    expect(ids).toContain('stats-1');
    const namespaces = stats.entries.map((e) => e.ns);
    expect(namespaces).toContain('default');
    expect(namespaces).toContain('other');
  });

  it('reflects non-zero queueLength and maxQueueDepth under a stalled consumer', async () => {
    const limit = 10;
    const { engine } = bootstrap({ subscriptionQueueLimit: limit });

    const pendingResolves: Array<() => void> = [];

    await engine.subscribe({
      id: 'stalled-1',
      frame: { 'default/Todo': { params: {}, fields: { id: true } } },
      ctx: makeCtx(),
      onFrame: (_f) => {
        return new Promise<void>((resolve) => {
          pendingResolves.push(resolve);
        });
      }
    });

    // Fire a few mutations to queue frames (consumer is stalled so they accumulate)
    const n = 3;
    for (let i = 0; i < n; i++) {
      await engine.mutate({
        frame: { 'default/createTodo': { params: { id: `q${i}`, title: `queued-${i}` } } },
        ctx: makeCtx()
      });
    }
    // Allow enqueue microtasks to run, but do NOT drain pendingResolves
    await Promise.resolve();
    await Promise.resolve();

    const stats = engine.subscriptionStats();
    expect(stats.count).toBe(1);
    // At least one frame should be queued (snapshot + mutate frames)
    expect(stats.maxQueueDepth).toBeGreaterThan(0);
    expect(stats.entries[0]!.queueLength).toBeGreaterThan(0);
    expect(stats.entries[0]!.id).toBe('stalled-1');
    expect(stats.entries[0]!.ns).toBe('default');
    expect(stats.entries[0]!.type).toBe('Todo');

    // Clean up: drain the consumer
    while (pendingResolves.length > 0) pendingResolves.shift()?.();
    await Promise.resolve();
  });
});

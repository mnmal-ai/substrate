/**
 * §5.13 Async & cancellation semantics.
 *
 * Covers:
 *   - AbortSignal threading through query and mutate resolvers
 *   - Pre-aborted signals short-circuit query entries
 *   - Mid-flight abort in mutate rolls back when a resolver throws on abort
 *   - Post-resolve signals do NOT undo committed writes
 *   - Idempotency dedup on mutate (hit, miss, expiry, error-no-cache)
 *   - Query ignores `idempotencyKey`
 *   - Conflicting idempotency keys within a frame surface as a top-level error
 *   - No idempotency engine config → no dedup
 *   - Subscription back-pressure: overloaded consumer is torn down with a
 *     dedicated error frame + end frame; fast consumer stays healthy
 *   - Custom queueLimit honoured
 */

import {
  Engine,
  MemoryEdgesStore,
  MemoryIdempotencyStore,
  type NamespaceConfig,
  Registry,
  type Resolver
} from '@mnmal-ai/substrate-core';
import { MemoryDataset, MemoryDatasetRegistry } from '@mnmal-ai/substrate-dataset-memory';
import type {
  FieldDef,
  RequestContext,
  ResolverArgs,
  Row,
  WsResponseFrame
} from '@mnmal-ai/substrate-types';
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
  edges: MemoryEdgesStore;
  registry: Registry;
  idempotency: MemoryIdempotencyStore | undefined;
  metrics: Array<{ name: string; payload: unknown }>;
}

function bootstrap(
  opts: {
    idempotency?: { ttlMs?: number; now?: () => number };
    subscriptionQueueLimit?: number;
    withAutoCrud?: boolean;
  } = {}
): Bootstrapped {
  const dataset = new MemoryDataset({ namespace: 'default' });
  const edges = makeEdges();
  const registry = new Registry();
  if (opts.withAutoCrud !== false) {
    installAutoCrud(registry, 'Todo', dataset, edges, { fields: todoFields() });
  }
  const datasets = new MemoryDatasetRegistry();
  datasets.set('default', dataset);
  const namespaces = new Map<string, NamespaceConfig>([['default', { registry }]]);

  const idempotency =
    opts.idempotency !== undefined
      ? new MemoryIdempotencyStore({
          ...(opts.idempotency.now !== undefined ? { now: opts.idempotency.now } : {})
        })
      : undefined;

  const metrics: Array<{ name: string; payload: unknown }> = [];
  const engine = new Engine({
    namespaces,
    datasets,
    edges,
    metric: (name, payload) => {
      metrics.push({ name, payload });
    },
    ...(idempotency !== undefined
      ? {
          idempotency: {
            store: idempotency,
            ...(opts.idempotency?.ttlMs !== undefined
              ? { defaultTtlMs: opts.idempotency.ttlMs }
              : {})
          }
        }
      : {}),
    ...(opts.subscriptionQueueLimit !== undefined
      ? { subscriptions: { queueLimit: opts.subscriptionQueueLimit } }
      : {})
  });
  return { engine, dataset, edges, registry, idempotency, metrics };
}

describe('§5.13 AbortSignal on query', () => {
  it('threads `signal` into the resolver via args.signal', async () => {
    const controller = new AbortController();
    const { engine, registry } = bootstrap({ withAutoCrud: false });
    let seenSignal: AbortSignal | undefined;
    const resolver: Resolver = async (_ctx, args: ResolverArgs) => {
      seenSignal = args.signal;
      return [];
    };
    registry.register('Todo', { resolver });

    await engine.query({
      frame: { 'default/Todo': { params: {}, fields: {} } },
      ctx: makeCtx(),
      signal: controller.signal
    });
    expect(seenSignal).toBe(controller.signal);
  });

  it('pre-aborted signal short-circuits remaining entries with `aborted` error code', async () => {
    const { engine, registry } = bootstrap({ withAutoCrud: false });
    let firstRan = 0;
    let secondRan = 0;
    registry.register('First', {
      resolver: async () => {
        firstRan++;
        return [];
      }
    });
    registry.register('Second', {
      resolver: async () => {
        secondRan++;
        return [];
      }
    });

    const controller = new AbortController();
    controller.abort();
    const envelope = await engine.query({
      frame: {
        'default/First': { params: {}, fields: {} },
        'default/Second': { params: {}, fields: {} }
      },
      ctx: makeCtx(),
      signal: controller.signal
    });
    expect(firstRan).toBe(0);
    expect(secondRan).toBe(0);
    expect(envelope.errors).toHaveLength(2);
    expect(envelope.errors?.map((e) => e.code)).toEqual(['aborted', 'aborted']);
  });

  it('signal aborted between entries stops subsequent dispatch', async () => {
    const { engine, registry } = bootstrap({ withAutoCrud: false });
    const controller = new AbortController();
    let firstRan = 0;
    let secondRan = 0;
    registry.register('First', {
      resolver: async () => {
        firstRan++;
        controller.abort();
        return [];
      }
    });
    registry.register('Second', {
      resolver: async () => {
        secondRan++;
        return [];
      }
    });
    const envelope = await engine.query({
      frame: {
        'default/First': { params: {}, fields: {} },
        'default/Second': { params: {}, fields: {} }
      },
      ctx: makeCtx(),
      signal: controller.signal
    });
    expect(firstRan).toBe(1);
    expect(secondRan).toBe(0);
    const abortedErr = envelope.errors?.find((e) => e.code === 'aborted');
    expect(abortedErr?.path).toEqual(['default/Second']);
  });
});

describe('§5.13 AbortSignal on mutate', () => {
  it('threads `signal` into the resolver via args.signal', async () => {
    const { engine, registry } = bootstrap({ withAutoCrud: false });
    let seenSignal: AbortSignal | undefined;
    const resolver: Resolver = async (_ctx, args: ResolverArgs) => {
      seenSignal = args.signal;
      return { id: 'x' } as Row;
    };
    registry.register('pokeThing', {
      kind: 'mutation',
      resolver,
      params: { id: { kind: 'scalar', type: 'string' } }
    });
    const controller = new AbortController();
    await engine.mutate({
      frame: { 'default/pokeThing': { params: { id: 'x' } } },
      ctx: makeCtx(),
      signal: controller.signal
    });
    expect(seenSignal).toBe(controller.signal);
  });

  it('resolver that throws on abort rolls back the transaction', async () => {
    const { engine, registry, dataset } = bootstrap({ withAutoCrud: false });
    // First resolver succeeds; second throws on abort. The whole frame must
    // roll back — neither write commits.
    registry.register('writeA', {
      kind: 'mutation',
      resolver: async (_ctx, args) => {
        await args.dataset?.write('Thing', [{ id: 'a' } as Row]);
        return { id: 'a' } as Row;
      },
      params: {}
    });
    registry.register('writeB', {
      kind: 'mutation',
      resolver: async (_ctx, args) => {
        args.signal?.throwIfAborted();
        await args.dataset?.write('Thing', [{ id: 'b' } as Row]);
        return { id: 'b' } as Row;
      },
      params: {}
    });

    const controller = new AbortController();
    controller.abort(new Error('caller aborted'));
    await expect(
      engine.mutate({
        frame: {
          'default/writeA': { params: {} },
          'default/writeB': { params: {} }
        },
        ctx: makeCtx(),
        signal: controller.signal
      })
    ).rejects.toThrow();

    const read = await dataset.read('Thing', {});
    expect(read.rows).toEqual([]);
  });

  it('signal aborted AFTER resolver returns does NOT undo the committed write', async () => {
    const { engine, registry, dataset } = bootstrap({ withAutoCrud: false });
    const controller = new AbortController();
    registry.register('writeSoon', {
      kind: 'mutation',
      resolver: async (_ctx, args) => {
        await args.dataset?.write('Thing', [{ id: 'z' } as Row]);
        // Fire abort AFTER the write resolves — must not affect the outcome.
        controller.abort();
        return { id: 'z' } as Row;
      },
      params: {}
    });

    const envelope = await engine.mutate({
      frame: { 'default/writeSoon': { params: {} } },
      ctx: makeCtx(),
      signal: controller.signal
    });
    expect(envelope.errors).toBeUndefined();
    const read = await dataset.read('Thing', {});
    expect(read.rows.map((r) => r.id)).toEqual(['z']);
  });
});

describe('§5.13 idempotency keys', () => {
  it('repeated frame with the same key returns the cached envelope verbatim', async () => {
    const { engine } = bootstrap({ idempotency: {} });
    const first = await engine.mutate({
      frame: {
        'default/createTodo': {
          params: { id: 't1', title: 'one' },
          idempotencyKey: 'k-alpha'
        }
      },
      ctx: makeCtx()
    });
    const second = await engine.mutate({
      frame: {
        'default/createTodo': {
          params: { id: 't1', title: 'whatever-ignored' },
          idempotencyKey: 'k-alpha'
        }
      },
      ctx: makeCtx()
    });
    expect(second).toBe(first);
  });

  it('expired cache entry re-executes the frame', async () => {
    let clock = 1_000_000_000;
    const { engine, registry, metrics } = bootstrap({
      idempotency: { ttlMs: 1000, now: () => clock },
      withAutoCrud: false
    });
    let executions = 0;
    registry.register('touch', {
      kind: 'mutation',
      resolver: async () => {
        executions++;
        return { id: `e${executions}` } as Row;
      },
      params: {}
    });

    await engine.mutate({
      frame: { 'default/touch': { params: {}, idempotencyKey: 'k-exp' } },
      ctx: makeCtx()
    });
    expect(executions).toBe(1);

    // Repeat inside TTL — must dedup.
    clock += 500;
    await engine.mutate({
      frame: { 'default/touch': { params: {}, idempotencyKey: 'k-exp' } },
      ctx: makeCtx()
    });
    expect(executions).toBe(1);
    expect(metrics.some((m) => m.name === 'engine_idempotency_hit')).toBe(true);

    // Past TTL — must re-execute.
    clock += 2000;
    await engine.mutate({
      frame: { 'default/touch': { params: {}, idempotencyKey: 'k-exp' } },
      ctx: makeCtx()
    });
    expect(executions).toBe(2);
  });

  it('two-key frame with matching keys dedups once', async () => {
    const { engine } = bootstrap({ idempotency: {} });
    const first = await engine.mutate({
      frame: {
        'default/createTodo': {
          params: { id: 't1', title: 'one' },
          idempotencyKey: 'k-two'
        },
        'default/updateTodo': {
          params: { id: 't1', title: 'one-edited' },
          idempotencyKey: 'k-two'
        }
      },
      ctx: makeCtx()
    });
    const second = await engine.mutate({
      frame: {
        'default/createTodo': {
          params: { id: 't1', title: 'one' },
          idempotencyKey: 'k-two'
        },
        'default/updateTodo': {
          params: { id: 't1', title: 'one-edited' },
          idempotencyKey: 'k-two'
        }
      },
      ctx: makeCtx()
    });
    expect(second).toBe(first);
  });

  it('two-key frame with conflicting idempotencyKey values yields idempotency_key_conflict', async () => {
    const { engine, dataset } = bootstrap({ idempotency: {} });
    const envelope = await engine.mutate({
      frame: {
        'default/createTodo': {
          params: { id: 't1', title: 'a' },
          idempotencyKey: 'k-x'
        },
        'default/updateTodo': {
          params: { id: 't1', title: 'b' },
          idempotencyKey: 'k-y'
        }
      },
      ctx: makeCtx()
    });
    expect(envelope.errors).toBeDefined();
    const err = envelope.errors?.[0];
    expect(err?.code).toBe('idempotency_key_conflict');
    // No resolver ran → no row persisted.
    const read = await dataset.read('Todo', {});
    expect(read.rows).toEqual([]);
  });

  it('frame with errors does NOT cache the envelope', async () => {
    const { engine } = bootstrap({ idempotency: {} });
    // Unknown name → envelope carries per-key error; mustn't cache.
    const first = await engine.mutate({
      frame: {
        'default/createGhost': {
          params: { id: 'g' },
          idempotencyKey: 'k-err'
        }
      },
      ctx: makeCtx()
    });
    expect(first.errors?.[0]?.code).toBe('unknown_name');
    const second = await engine.mutate({
      frame: {
        'default/createTodo': {
          params: { id: 't-ok', title: 'new' },
          idempotencyKey: 'k-err'
        }
      },
      ctx: makeCtx()
    });
    expect(second).not.toBe(first);
    expect(second.errors).toBeUndefined();
  });

  it('query silently ignores idempotencyKey', async () => {
    const { engine, metrics } = bootstrap({ idempotency: {} });
    const envelope = await engine.query({
      frame: {
        'default/Todo': {
          params: {},
          fields: { id: true },
          idempotencyKey: 'should-be-ignored'
        }
      },
      ctx: makeCtx()
    });
    expect(envelope.errors).toBeUndefined();
    expect(metrics.some((m) => m.name.startsWith('engine_idempotency'))).toBe(false);
  });

  it('no engine idempotency config = pre-§5.13 behaviour (every call executes)', async () => {
    const { engine, registry } = bootstrap({ withAutoCrud: false });
    let calls = 0;
    registry.register('tick', {
      kind: 'mutation',
      resolver: async () => {
        calls++;
        return { id: String(calls) } as Row;
      },
      params: {}
    });

    await engine.mutate({
      frame: {
        'default/tick': { params: {}, idempotencyKey: 'ignored-by-engine' }
      },
      ctx: makeCtx()
    });
    await engine.mutate({
      frame: {
        'default/tick': { params: {}, idempotencyKey: 'ignored-by-engine' }
      },
      ctx: makeCtx()
    });
    // Two calls executed — no dedup without the engine option.
    expect(calls).toBe(2);
  });
});

describe('§5.13 subscription back-pressure', () => {
  it('slow consumer that stalls past the threshold is torn down', async () => {
    const limit = 3;
    const slowCtx = bootstrap({ subscriptionQueueLimit: limit });

    const pendingResolves: Array<() => void> = [];
    const slowConsumer: (f: WsResponseFrame) => Promise<void> = () =>
      new Promise<void>((resolve) => {
        pendingResolves.push(resolve);
      });

    const collected: WsResponseFrame[] = [];
    await slowCtx.engine.subscribe({
      id: 'slow-1',
      frame: { 'default/Todo': { params: {}, fields: { id: true } } },
      ctx: makeCtx(),
      onFrame: (f) => {
        collected.push(f);
        return slowConsumer(f);
      }
    });

    // Fire `limit + 2` mutations — the first drain call stalls, the queue
    // fills, and the limit-breaching enqueue triggers teardown.
    const mutPromises: Array<Promise<unknown>> = [];
    for (let i = 0; i < limit + 2; i++) {
      mutPromises.push(
        slowCtx.engine.mutate({
          frame: {
            'default/createTodo': { params: { id: `s${i}`, title: `slow-${i}` } }
          },
          ctx: makeCtx()
        })
      );
      await Promise.resolve();
    }
    await Promise.all(mutPromises);

    // Drain pending callbacks in a polling loop — the terminal error+end
    // frames are fired via `await entry.onFrame(...)` so each one produces a
    // fresh pending callback after its predecessor resolves. Without the loop
    // we'd only release the first pending and leave the terminal frames
    // mid-flight.
    for (let tick = 0; tick < 20; tick++) {
      while (pendingResolves.length > 0) pendingResolves.shift()?.();
      await Promise.resolve();
      await Promise.resolve();
    }

    const errorFrame = collected.find(
      (f) => f.kind === 'error' && f.errors?.[0]?.code === 'subscription_overloaded'
    );
    expect(errorFrame).toBeDefined();
    const endFrame = collected.find((f) => f.kind === 'end' && f.final === true);
    expect(endFrame).toBeDefined();
    expect(slowCtx.metrics.some((m) => m.name === 'engine_subscription_overloaded')).toBe(true);
  });

  it('fast consumer under the threshold stays healthy', async () => {
    const fastCtx = bootstrap({ subscriptionQueueLimit: 4 });
    const collected: WsResponseFrame[] = [];
    await fastCtx.engine.subscribe({
      id: 'fast-1',
      frame: { 'default/Todo': { params: {}, fields: { id: true } } },
      ctx: makeCtx(),
      onFrame: (f) => {
        collected.push(f);
      }
    });
    for (let i = 0; i < 10; i++) {
      await fastCtx.engine.mutate({
        frame: { 'default/createTodo': { params: { id: `f${i}`, title: `fast-${i}` } } },
        ctx: makeCtx()
      });
    }
    expect(
      collected.some((f) => f.kind === 'error' && f.errors?.[0]?.code === 'subscription_overloaded')
    ).toBe(false);
    expect(collected.filter((f) => f.kind === 'add')).toHaveLength(10);
  });

  it('default queueLimit = 256: a 257th stall-queued frame triggers teardown', async () => {
    const defaultCtx = bootstrap();
    const collected: WsResponseFrame[] = [];
    const pending: Array<() => void> = [];
    const consumer: (f: WsResponseFrame) => Promise<void> = () =>
      new Promise<void>((resolve) => {
        pending.push(resolve);
      });

    await defaultCtx.engine.subscribe({
      id: 'def-1',
      frame: { 'default/Todo': { params: {}, fields: { id: true } } },
      ctx: makeCtx(),
      onFrame: (f) => {
        collected.push(f);
        return consumer(f);
      }
    });

    const mutPromises: Array<Promise<unknown>> = [];
    for (let i = 0; i < 258; i++) {
      mutPromises.push(
        defaultCtx.engine.mutate({
          frame: { 'default/createTodo': { params: { id: `d${i}`, title: `row-${i}` } } },
          ctx: makeCtx()
        })
      );
      await Promise.resolve();
    }
    await Promise.all(mutPromises);

    for (let tick = 0; tick < 20; tick++) {
      while (pending.length > 0) pending.shift()?.();
      await Promise.resolve();
      await Promise.resolve();
    }

    expect(
      collected.some((f) => f.kind === 'error' && f.errors?.[0]?.code === 'subscription_overloaded')
    ).toBe(true);
  });

  it('overload teardown: error code, then end {reason, final}, then nothing', async () => {
    const ctx = bootstrap(); // same engine bootstrap as the queueLimit test above
    const collected: WsResponseFrame[] = [];
    const pending: Array<() => void> = [];
    const consumer: (f: WsResponseFrame) => Promise<void> = () =>
      new Promise<void>((resolve) => {
        pending.push(resolve);
      });

    await ctx.engine.subscribe({
      id: 'reason-1',
      frame: { 'default/Todo': { params: {}, fields: { id: true } } },
      ctx: makeCtx(),
      onFrame: (f) => {
        collected.push(f);
        return consumer(f);
      }
    });

    const mutPromises: Array<Promise<unknown>> = [];
    for (let i = 0; i < 258; i++) {
      mutPromises.push(
        ctx.engine.mutate({
          frame: { 'default/createTodo': { params: { id: `r${i}`, title: `row-${i}` } } },
          ctx: makeCtx()
        })
      );
      await Promise.resolve();
    }
    await Promise.all(mutPromises);

    for (let tick = 0; tick < 20; tick++) {
      while (pending.length > 0) pending.shift()?.();
      await Promise.resolve();
      await Promise.resolve();
    }

    const errIdx = collected.findIndex(
      (f) => f.kind === 'error' && f.errors?.[0]?.code === 'subscription_overloaded'
    );
    const endIdx = collected.findIndex((f) => f.kind === 'end');
    expect(errIdx).toBeGreaterThan(-1);
    expect(endIdx).toBeGreaterThan(errIdx);
    const end = collected[endIdx]!;
    expect(end.final).toBe(true);
    expect(end.reason).toBe('subscription_overloaded');
    // Nothing follows the end frame for this id.
    expect(collected.length - 1).toBe(endIdx);
    // The entry is gone from the bus.
    expect(ctx.engine.activeSubscriptionCount()).toBe(0);
  });
});

describe('§5.13 MemoryIdempotencyStore', () => {
  it('lazy expiry: get after TTL returns undefined', async () => {
    let clock = 1000;
    const store = new MemoryIdempotencyStore({ now: () => clock });
    const envelope = {
      schemaVersion: 'v',
      data: {},
      shapes: {}
    } as const;
    await store.put('k', envelope, 500);
    expect(await store.get('k')).toBe(envelope);
    clock += 600;
    expect(await store.get('k')).toBeUndefined();
  });

  it('get before expiry returns the envelope; put overwrites TTL', async () => {
    let clock = 0;
    const store = new MemoryIdempotencyStore({ now: () => clock });
    const envelope = { schemaVersion: 'v', data: {}, shapes: {} } as const;
    await store.put('k', envelope, 100);
    clock += 50;
    expect(await store.get('k')).toBe(envelope);
    await store.put('k', envelope, 1000);
    clock += 200;
    expect(await store.get('k')).toBe(envelope);
  });

  it('reapExpired deletes expired entries, keeps live ones, returns count', async () => {
    let clock = 1000;
    const store = new MemoryIdempotencyStore({ now: () => clock });
    const envelope = { schemaVersion: 'v', data: {}, shapes: {} } as const;
    // Two short-TTL rows that will expire, one long-TTL row that won't.
    await store.put('short-1', envelope, 100);
    await store.put('short-2', envelope, 200);
    await store.put('long', envelope, 10_000);

    // Before any expiry: nothing to reap.
    expect(await store.reapExpired()).toEqual({ deleted: 0 });

    // Advance past both short TTLs but not the long one.
    clock += 500;
    const reaped = await store.reapExpired();
    expect(reaped).toEqual({ deleted: 2 });

    // Live row still readable; reaped keys are gone.
    expect(await store.get('long')).toBe(envelope);
    expect(await store.get('short-1')).toBeUndefined();
    expect(await store.get('short-2')).toBeUndefined();

    // Idempotent: second call on a cleaned store returns 0.
    expect(await store.reapExpired()).toEqual({ deleted: 0 });
  });
});

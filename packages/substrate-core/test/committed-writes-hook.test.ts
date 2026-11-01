/**
 * Coordinator `onCommittedWrites`: one call per (namespace, type, operation)
 * per committed transaction, at each commit, never awaited by the mutate.
 */

import { MemoryDataset, MemoryDatasetRegistry } from '@mnmal-ai/substrate-dataset-memory';
import {
  type CommittedWriteBatch,
  type CommittedWritesHook,
  type EngineHandle,
  type IdempotencyStore,
  type RequestContext,
  type Resolver,
  ResolverFrameError,
  type Row
} from '@mnmal-ai/substrate-types';
import { describe, expect, it } from 'vitest';
import type { NamespaceConfig } from '../src/index.js';
import { Engine, MemoryEdgesStore, Registry } from '../src/index.js';

const NS = 'default';

const ctx = {
  namespace: NS,
  identity: { id: 'caller', agentKeyId: 'agent-1', grants: { '*': ['read', 'mutate'] } }
} as unknown as RequestContext;

function boot(
  hooks: Array<{ plugin: string; hook: CommittedWritesHook }>,
  extra: Partial<ConstructorParameters<typeof Engine>[0]> = {}
): {
  engine: Engine;
  registry: Registry;
  metrics: Array<{ name: string; payload: unknown }>;
} {
  const dataset = new MemoryDataset({ namespace: NS });
  const datasets = new MemoryDatasetRegistry();
  datasets.set(NS, dataset);
  const registry = new Registry();
  const metrics: Array<{ name: string; payload: unknown }> = [];
  const engine = new Engine({
    namespaces: new Map<string, NamespaceConfig>([[NS, { registry }]]),
    datasets,
    edges: new MemoryEdgesStore({ now: () => new Date() }),
    metric: (name, payload) => metrics.push({ name, payload }),
    committedWritesHooks: hooks,
    ...extra
  });
  for (const type of ['Todo', 'Note']) {
    registry.register(type, {
      kind: 'type',
      fields: { id: { kind: 'scalar', type: 'string' } },
      resolver: (async () => []) as unknown as Resolver
    });
    const resolver: Resolver = async (_c, args) => {
      const params = (args.params ?? {}) as { id?: string };
      if (params.id === 'boom') throw new Error('explodes');
      const row = { id: params.id ?? 'x' } as Row;
      args.onWrite?.({ ns: NS, type, id: row.id as string, operation: 'create', row });
      return row;
    };
    registry.register(`create${type}`, { kind: 'mutation', resolver });
    if (type === 'Todo') registry.register('createTodoBulk', { kind: 'mutation', resolver });
  }
  return { engine, registry, metrics };
}

const ids = (n: number): Array<{ params: { id: string } }> =>
  Array.from({ length: n }, (_, i) => ({ params: { id: `t${i}` } }));

describe('onCommittedWrites', () => {
  it('batch of 20 creates → one call with 20 ids, actor from ctx', async () => {
    const calls: CommittedWriteBatch[] = [];
    const { engine } = boot([{ plugin: 'p', hook: (b) => void calls.push(b) }]);
    await engine.mutate({ frame: { [`${NS}/createTodo`]: ids(20) }, ctx });
    await engine.hooksSettled();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.ids).toHaveLength(20);
    expect(calls[0]).toMatchObject({
      namespace: NS,
      type: 'Todo',
      operation: 'create',
      actor: { kind: 'agent', id: 'agent-1' }
    });
  });

  it('single-frame mutate over two types → two calls', async () => {
    const calls: CommittedWriteBatch[] = [];
    const { engine } = boot([{ plugin: 'p', hook: (b) => void calls.push(b) }]);
    await engine.mutate({
      frame: {
        [`${NS}/createTodo`]: { params: { id: 'a' } },
        [`${NS}/createNote`]: { params: { id: 'b' } }
      },
      ctx
    });
    await engine.hooksSettled();
    expect(calls.map((c) => c.type)).toEqual(['Todo', 'Note']);
  });

  it('rolled-back array → no call', async () => {
    const calls: CommittedWriteBatch[] = [];
    const { engine } = boot([{ plugin: 'p', hook: (b) => void calls.push(b) }]);
    const env = await engine.mutate({
      frame: { [`${NS}/createTodo`]: [{ params: { id: 'ok' } }, { params: { id: 'boom' } }] },
      ctx
    });
    expect(env.errors?.[0]?.code).toBe('batched_frame_rolled_back');
    await engine.hooksSettled();
    expect(calls).toEqual([]);
  });

  it('throwing hook: write succeeds, warning names the plugin; next success clears it', async () => {
    let fail = true;
    const { engine, metrics } = boot([
      {
        plugin: 'flaky',
        hook: () => {
          if (fail) throw new Error('hook broke');
        }
      }
    ]);
    const env = await engine.mutate({
      frame: { [`${NS}/createTodo`]: { params: { id: 'a' } } },
      ctx
    });
    expect(env.errors ?? []).toEqual([]);
    await engine.hooksSettled();
    expect(engine.postWriteWarnings()).toHaveLength(1);
    // /health is unauthenticated: the warning names the plugin, never the message.
    expect(engine.postWriteWarnings()[0]).toMatch(/^post-write hook flaky failed at \S+$/);
    expect(engine.postWriteWarnings()[0]).not.toContain('hook broke');
    // The operator still gets the message, through the metric sink.
    expect(metrics.find((m) => m.name === 'engine_post_write_hook_error')?.payload).toEqual({
      plugin: 'flaky',
      error: 'hook broke'
    });

    fail = false;
    await engine.mutate({ frame: { [`${NS}/createTodo`]: { params: { id: 'b' } } }, ctx });
    await engine.hooksSettled();
    expect(engine.postWriteWarnings()).toEqual([]);
  });

  it('an async rejection is recorded too', async () => {
    const { engine } = boot([{ plugin: 'async', hook: () => Promise.reject(new Error('late')) }]);
    await engine.mutate({ frame: { [`${NS}/createTodo`]: { params: { id: 'a' } } }, ctx });
    await engine.hooksSettled();
    expect(engine.postWriteWarnings()[0]).toMatch(/^post-write hook async failed at \S+$/);
  });

  it('hung hook: mutate returns first; the next write runs after it, in order', async () => {
    const order: string[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const { engine } = boot([
      {
        plugin: 'slow',
        hook: async (b) => {
          order.push(`start:${b.ids[0]}`);
          if (b.ids[0] === 'a') await gate;
          order.push(`end:${b.ids[0]}`);
        }
      }
    ]);
    await engine.mutate({ frame: { [`${NS}/createTodo`]: { params: { id: 'a' } } }, ctx });
    await engine.mutate({ frame: { [`${NS}/createTodo`]: { params: { id: 'b' } } }, ctx });
    // Both mutates returned while the first hook is still hung.
    await new Promise((r) => setTimeout(r, 10));
    expect(order).toEqual(['start:a']);
    release();
    await engine.hooksSettled();
    expect(order).toEqual(['start:a', 'end:a', 'start:b', 'end:b']);
  });

  it('with no hooks, hooksSettled resolves and warnings are empty', async () => {
    const { engine } = boot([]);
    await engine.mutate({ frame: { [`${NS}/createTodo`]: { params: { id: 'a' } } }, ctx });
    await engine.hooksSettled();
    expect(engine.postWriteWarnings()).toEqual([]);
  });

  it('announceWrites through an EngineHandle reaches subscribers and hooks', async () => {
    const calls: CommittedWriteBatch[] = [];
    const { engine } = boot([{ plugin: 'p', hook: (b) => void calls.push(b) }]);
    const pushed: unknown[] = [];
    let onPush: () => void = () => {};
    const pushSeen = new Promise<void>((r) => {
      onPush = r;
    });
    await engine.subscribe({
      id: 'sub',
      frame: { [`${NS}/Todo`]: { params: {}, fields: { id: true } } },
      ctx,
      onFrame: (f: { kind: string }) => {
        if (f.kind === 'snapshot') return;
        pushed.push(f);
        onPush();
      }
    });
    const handle: EngineHandle = engine;
    const row = { id: 'z' } as Row;
    await handle.announceWrites([{ ns: NS, type: 'Todo', id: 'z', operation: 'create', row }], {
      kind: 'system',
      id: 'sweeper'
    });
    await engine.hooksSettled();
    await pushSeen;
    expect(calls).toEqual([
      {
        namespace: NS,
        type: 'Todo',
        operation: 'create',
        actor: { kind: 'system', id: 'sweeper' },
        ids: ['z']
      }
    ]);
    expect(pushed.length).toBeGreaterThan(0);
  });

  it('a single-frame create and an array create of one type in one mutate → two calls', async () => {
    const calls: CommittedWriteBatch[] = [];
    const { engine } = boot([{ plugin: 'p', hook: (b) => void calls.push(b) }]);
    await engine.mutate({
      frame: {
        [`${NS}/createTodo`]: { params: { id: 'a' } },
        [`${NS}/createTodoBulk`]: [{ params: { id: 'b' } }, { params: { id: 'c' } }]
      },
      ctx
    });
    await engine.hooksSettled();
    expect(calls.map((c) => c.ids)).toEqual([['a'], ['b', 'c']]);
  });

  it('plugins are called in registration order, each with the same frozen ids', async () => {
    const order: string[] = [];
    const seen: Array<readonly unknown[]> = [];
    const mk = (plugin: string): { plugin: string; hook: CommittedWritesHook } => ({
      plugin,
      hook: (b) => {
        order.push(plugin);
        seen.push(b.ids);
      }
    });
    const { engine } = boot([mk('first'), mk('second')]);
    await engine.mutate({ frame: { [`${NS}/createTodo`]: ids(3) }, ctx });
    await engine.hooksSettled();
    expect(order).toEqual(['first', 'second']);
    expect(Object.isFrozen(seen[0])).toBe(true);
    expect(seen[0]).toBe(seen[1]);
  });

  it("Task 5's retry: a bare batch refusal re-runs per element; one call carries the final ids", async () => {
    const calls: CommittedWriteBatch[] = [];
    const { engine, registry } = boot([{ plugin: 'p', hook: (b) => void calls.push(b) }]);
    const emit = (a: { onWrite?: (e: never) => void }, id: string): void =>
      a.onWrite?.({ ns: NS, type: 'Todo', id, operation: 'create', row: { id } } as never);
    registry.register('createRetry', {
      kind: 'mutation',
      resolver: async (_c, args) => {
        const id = String((args.params as { id: string }).id);
        emit(args, `final-${id}`);
        return { id } as Row;
      },
      batch: async (_c, argsList) => {
        for (const a of argsList) emit(a, `first-${String((a.params as { id: string }).id)}`);
        throw new ResolverFrameError('unique_violation', 'somewhere in the batch');
      }
    });
    const env = await engine.mutate({ frame: { [`${NS}/createRetry`]: ids(3) }, ctx });
    expect(env.errors ?? []).toEqual([]);
    await engine.hooksSettled();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.ids).toEqual(['final-t0', 'final-t1', 'final-t2']);
  });

  it('an array key that throws after the single-frame bucket committed still calls the hook', async () => {
    const calls: CommittedWriteBatch[] = [];
    const store: IdempotencyStore = {
      get: () => Promise.reject(new Error('idempotency store down')),
      put: async () => {},
      reapExpired: async () => ({ deleted: 0 })
    };
    const { engine } = boot([{ plugin: 'p', hook: (b) => void calls.push(b) }], {
      idempotency: { store }
    });
    await expect(
      engine.mutate({
        frame: {
          [`${NS}/createNote`]: { params: { id: 'n1' } },
          [`${NS}/createTodo`]: [{ params: { id: 't1' }, idempotencyKey: 'k' }]
        },
        ctx
      })
    ).rejects.toThrow('idempotency store down');
    await engine.hooksSettled();
    expect(calls.map((c) => [c.type, c.ids])).toEqual([['Note', ['n1']]]);
  });
});

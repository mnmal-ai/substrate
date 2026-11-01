/**
 * Coordinator `onCommittedWrites`: one call per (namespace, type, operation)
 * per committed transaction, after the response, never awaited by the mutate.
 */

import { MemoryDataset, MemoryDatasetRegistry } from '@mnmal-ai/substrate-dataset-memory';
import type {
  CommittedWriteBatch,
  CommittedWritesHook,
  EngineHandle,
  RequestContext,
  Resolver,
  Row
} from '@mnmal-ai/substrate-types';
import { describe, expect, it } from 'vitest';
import type { NamespaceConfig } from '../src/index.js';
import { Engine, MemoryEdgesStore, Registry } from '../src/index.js';

const NS = 'default';

const ctx = {
  namespace: NS,
  identity: { id: 'caller', agentKeyId: 'agent-1', grants: { '*': ['read', 'mutate'] } }
} as unknown as RequestContext;

function boot(hooks: Array<{ plugin: string; hook: CommittedWritesHook }>): {
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
    committedWritesHooks: hooks
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
    expect(engine.postWriteWarnings()[0]).toMatch(
      /^post-write hook flaky failed at .+: hook broke$/
    );
    expect(metrics.find((m) => m.name === 'engine_post_write_hook_error')?.payload).toMatchObject({
      plugin: 'flaky'
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
    expect(engine.postWriteWarnings()[0]).toMatch(/post-write hook async failed .*: late$/);
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
    await engine.subscribe({
      id: 'sub',
      frame: { [`${NS}/Todo`]: { params: {}, fields: { id: true } } },
      ctx,
      onFrame: (f: { kind: string }) => {
        if (f.kind !== 'snapshot') pushed.push(f);
      }
    });
    const handle: EngineHandle = engine;
    const row = { id: 'z' } as Row;
    await handle.announceWrites([{ ns: NS, type: 'Todo', id: 'z', operation: 'create', row }], {
      kind: 'system',
      id: 'sweeper'
    });
    await engine.hooksSettled();
    await new Promise((r) => setTimeout(r, 20));
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
});

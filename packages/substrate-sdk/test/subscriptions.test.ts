import { Engine, MemoryEdgesStore, type NamespaceConfig, Registry } from '@mnmal-ai/substrate-core';
import { MemoryDataset, MemoryDatasetRegistry } from '@mnmal-ai/substrate-dataset-memory';
import { denyAll, row } from '@mnmal-ai/substrate-policy';
import type { FieldDef, Policy, RequestContext, WsResponseFrame } from '@mnmal-ai/substrate-types';
import { beforeEach, describe, expect, it } from 'vitest';
import { installAutoCrud } from '../src/index.js';

interface Ctx {
  engine: Engine;
  dataset: MemoryDataset;
  edges: MemoryEdgesStore;
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

function standardTodoFields(): Record<string, FieldDef> {
  return {
    id: { kind: 'scalar', type: 'string', indexed: true },
    title: { kind: 'scalar', type: 'string', indexed: true },
    done: { kind: 'scalar', type: 'boolean', indexed: true, default: false }
  };
}

function bootstrap(options: { policy?: Policy } = {}): Ctx {
  const dataset = new MemoryDataset({ namespace: 'default' });
  const edges = new MemoryEdgesStore({ now: () => new Date('2026-04-18T00:00:00Z') });
  const registry = new Registry();
  installAutoCrud(registry, 'Todo', dataset, edges, {
    fields: standardTodoFields(),
    ...(options.policy !== undefined ? { policy: options.policy } : {})
  });
  const datasets = new MemoryDatasetRegistry();
  datasets.set('default', dataset);
  const namespaces = new Map<string, NamespaceConfig>([['default', { registry }]]);
  const engine = new Engine({ namespaces, datasets, edges });
  return { engine, dataset, edges };
}

async function createTodo(
  engine: Engine,
  todo: { id: string; title: string; done?: boolean }
): Promise<void> {
  await engine.mutate({
    frame: {
      'default/createTodo': {
        params: { id: todo.id, title: todo.title, done: todo.done ?? false }
      }
    },
    ctx: makeCtx()
  });
}

describe('Engine.subscribe — snapshot + live updates (§5.4)', () => {
  let ctx: Ctx;
  let frames: WsResponseFrame[];
  let recordFrame: (f: WsResponseFrame) => void;

  beforeEach(() => {
    ctx = bootstrap();
    frames = [];
    recordFrame = (f: WsResponseFrame): void => {
      frames.push(f);
    };
  });

  it('emits an initial snapshot frame synchronously (after await)', async () => {
    await createTodo(ctx.engine, { id: 't1', title: 'one' });
    await ctx.engine.subscribe({
      id: 'sub-1',
      frame: { 'default/Todo': { params: {}, fields: { id: true, title: true } } },
      ctx: makeCtx(),
      onFrame: recordFrame
    });
    expect(frames).toHaveLength(1);
    const snap = frames[0];
    expect(snap?.kind).toBe('snapshot');
    expect(snap?.id).toBe('sub-1');
    expect(snap?.shapes).toEqual({ 'default/Todo': 'list' });
    const rows = (snap!.data as Record<string, unknown>)['default/Todo'] as Array<{ id: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe('t1');
    expect(typeof snap?.schemaVersion).toBe('string');
  });

  it('mutate adding a matching row fires an `add` frame', async () => {
    await ctx.engine.subscribe({
      id: 'sub-1',
      frame: { 'default/Todo': { params: {}, fields: { id: true, title: true } } },
      ctx: makeCtx(),
      onFrame: recordFrame
    });
    expect(frames).toHaveLength(1); // snapshot
    await createTodo(ctx.engine, { id: 't1', title: 'fresh' });
    expect(frames).toHaveLength(2);
    const add = frames[1];
    expect(add?.kind).toBe('add');
    expect(add?.id).toBe('sub-1');
    const data = (add!.data as Record<string, unknown>)['default/Todo'] as {
      id: string;
      title: string;
    };
    expect(data.id).toBe('t1');
    expect(data.title).toBe('fresh');
  });

  it('mutate updating a matching row fires an `update` frame', async () => {
    await createTodo(ctx.engine, { id: 't1', title: 'orig' });
    await ctx.engine.subscribe({
      id: 'sub-1',
      frame: { 'default/Todo': { params: {}, fields: { id: true, title: true } } },
      ctx: makeCtx(),
      onFrame: recordFrame
    });
    frames.length = 0;
    await ctx.engine.mutate({
      frame: { 'default/updateTodo': { params: { id: 't1', title: 'changed' } } },
      ctx: makeCtx()
    });
    expect(frames).toHaveLength(1);
    expect(frames[0]?.kind).toBe('update');
    const data = (frames[0]!.data as Record<string, unknown>)['default/Todo'] as {
      id: string;
      title: string;
    };
    expect(data.title).toBe('changed');
  });

  it('mutate making a matching row un-match fires a `remove` frame', async () => {
    await createTodo(ctx.engine, { id: 't1', title: 'open', done: false });
    await ctx.engine.subscribe({
      id: 'sub-1',
      frame: {
        'default/Todo': {
          params: { where: { done: { eq: false } } },
          fields: { id: true, done: true }
        }
      },
      ctx: makeCtx(),
      onFrame: recordFrame
    });
    // The snapshot included t1.
    frames.length = 0;
    await ctx.engine.mutate({
      frame: { 'default/updateTodo': { params: { id: 't1', done: true } } },
      ctx: makeCtx()
    });
    expect(frames).toHaveLength(1);
    expect(frames[0]?.kind).toBe('remove');
    expect(frames[0]?.removedId).toBe('t1');
  });

  it('mutate on a never-matching row fires no frame', async () => {
    await ctx.engine.subscribe({
      id: 'sub-1',
      frame: {
        'default/Todo': {
          params: { where: { done: { eq: false } } },
          fields: { id: true, done: true }
        }
      },
      ctx: makeCtx(),
      onFrame: recordFrame
    });
    frames.length = 0;
    await createTodo(ctx.engine, { id: 't1', title: 'completed', done: true });
    expect(frames).toHaveLength(0);
  });

  it('delete of a subscribed row fires a `remove` frame with the id', async () => {
    await createTodo(ctx.engine, { id: 't1', title: 'gone' });
    await ctx.engine.subscribe({
      id: 'sub-1',
      frame: { 'default/Todo': { params: {}, fields: { id: true, title: true } } },
      ctx: makeCtx(),
      onFrame: recordFrame
    });
    frames.length = 0;
    await ctx.engine.mutate({
      frame: { 'default/deleteTodo': { params: { id: 't1' } } },
      ctx: makeCtx()
    });
    expect(frames).toHaveLength(1);
    expect(frames[0]?.kind).toBe('remove');
    expect(frames[0]?.removedId).toBe('t1');
  });

  it('cancel() removes the subscription; further mutations emit no frames', async () => {
    const handle = await ctx.engine.subscribe({
      id: 'sub-1',
      frame: { 'default/Todo': { params: {}, fields: { id: true } } },
      ctx: makeCtx(),
      onFrame: recordFrame
    });
    frames.length = 0;
    handle.cancel();
    await createTodo(ctx.engine, { id: 't1', title: 'after-cancel' });
    expect(frames).toHaveLength(0);
  });

  it('transaction rollback: failing mutate emits no subscription pushes', async () => {
    // A restrict edge planted against a non-existent row forces RestrictViolation
    // on a subsequent delete. Create a fresh row first so that updateTodo in the
    // same frame would otherwise succeed — we assert the partial-frame behaviour.
    await createTodo(ctx.engine, { id: 't1', title: 'rollback' });
    await ctx.engine.subscribe({
      id: 'sub-1',
      frame: { 'default/Todo': { params: {}, fields: { id: true, title: true } } },
      ctx: makeCtx(),
      onFrame: recordFrame
    });
    frames.length = 0;

    // Cause the tx to throw by feeding _deletedAt to updateTodo (ReservedField).
    // Thrown errors surface out of withTransaction and roll back the tx; no
    // onWrite events should fan out.
    await expect(
      ctx.engine.mutate({
        frame: {
          'default/updateTodo': { params: { id: 't1', _deletedAt: new Date() } }
        },
        ctx: makeCtx()
      })
    ).rejects.toThrow();
    expect(frames).toHaveLength(0);
  });
});

describe('Engine.subscribe — error paths (§5.4)', () => {
  it('policy deny emits an error frame and does NOT register the subscription', async () => {
    const ctx = bootstrap({ policy: denyAll('forbidden') });
    const frames: WsResponseFrame[] = [];
    const handle = await ctx.engine.subscribe({
      id: 'sub-1',
      frame: { 'default/Todo': { params: {}, fields: { id: true } } },
      ctx: makeCtx(),
      onFrame: (f) => {
        frames.push(f);
      }
    });
    expect(frames).toHaveLength(1);
    expect(frames[0]?.kind).toBe('error');
    expect(frames[0]?.errors?.[0]?.code).toBe('policy_denied');
    // Since nothing registered, a subsequent mutate should fire nothing.
    frames.length = 0;
    await createTodo(ctx.engine, { id: 't1', title: 'ignored' });
    expect(frames).toHaveLength(0);
    // cancel is a no-op.
    handle.cancel();
  });

  it('filter validation failure emits an error frame and does NOT register', async () => {
    const ctx = bootstrap();
    const frames: WsResponseFrame[] = [];
    await ctx.engine.subscribe({
      id: 'sub-1',
      frame: {
        'default/Todo': {
          params: { where: { ghost: { eq: 'x' } } },
          fields: { id: true }
        }
      },
      ctx: makeCtx(),
      onFrame: (f) => {
        frames.push(f);
      }
    });
    expect(frames).toHaveLength(1);
    expect(frames[0]?.kind).toBe('error');
    expect(frames[0]?.errors?.[0]?.code).toBe('unknown_field');
    frames.length = 0;
    await createTodo(ctx.engine, { id: 't1', title: 'ignored' });
    expect(frames).toHaveLength(0);
  });

  it('unknown name emits an error frame', async () => {
    const ctx = bootstrap();
    const frames: WsResponseFrame[] = [];
    await ctx.engine.subscribe({
      id: 'sub-1',
      frame: { 'default/Mystery': { params: {}, fields: {} } },
      ctx: makeCtx(),
      onFrame: (f) => {
        frames.push(f);
      }
    });
    expect(frames).toHaveLength(1);
    expect(frames[0]?.kind).toBe('error');
    expect(frames[0]?.errors?.[0]?.code).toBe('unknown_name');
  });

  it('subscribing to a mutation name is rejected', async () => {
    const ctx = bootstrap();
    const frames: WsResponseFrame[] = [];
    await ctx.engine.subscribe({
      id: 'sub-1',
      frame: { 'default/createTodo': { params: {}, fields: {} } },
      ctx: makeCtx(),
      onFrame: (f) => {
        frames.push(f);
      }
    });
    expect(frames[0]?.errors?.[0]?.code).toBe('subscribe_on_mutation');
  });

  it('unqualified key emits an error frame', async () => {
    const ctx = bootstrap();
    const frames: WsResponseFrame[] = [];
    await ctx.engine.subscribe({
      id: 'sub-1',
      frame: { Todo: { params: {}, fields: {} } },
      ctx: makeCtx(),
      onFrame: (f) => {
        frames.push(f);
      }
    });
    expect(frames[0]?.errors?.[0]?.code).toBe('unqualified_key');
  });

  it('unknown top-level param emits unknown_param error frame', async () => {
    const ctx = bootstrap();
    const frames: WsResponseFrame[] = [];
    await ctx.engine.subscribe({
      id: 'sub-1',
      frame: {
        'default/Todo': {
          // typo: `order` for `orderBy`, on the subscribe path
          params: { order: [{ title: 'asc' }] },
          fields: { id: true, title: true }
        }
      },
      ctx: makeCtx(),
      onFrame: (f) => {
        frames.push(f);
      }
    });
    expect(frames).toHaveLength(1);
    expect(frames[0]?.kind).toBe('error');
    expect(frames[0]?.errors?.[0]?.code).toBe('unknown_param');
    expect(frames[0]?.errors?.[0]?.path).toEqual(['default/Todo', 'params', 'order']);
    // Subscription must not have registered — a subsequent mutate fires nothing.
    frames.length = 0;
    await createTodo(ctx.engine, { id: 't1', title: 'ignored' });
    expect(frames).toHaveLength(0);
  });
});

describe('Engine.subscribe — row-filter obligations (§4.4)', () => {
  it('row-filter obligation silently filters the snapshot AND live pushes', async () => {
    // Policy hides any Todo whose title starts with "secret:".
    const policy = row<{ title?: string }>((_ctx, r) => !(r.title ?? '').startsWith('secret:'));
    const ctx = bootstrap({ policy });
    const frames: WsResponseFrame[] = [];
    await createTodo(ctx.engine, { id: 't-public', title: 'public' });
    await createTodo(ctx.engine, { id: 't-secret', title: 'secret: hidden' });

    await ctx.engine.subscribe({
      id: 'sub-1',
      frame: { 'default/Todo': { params: {}, fields: { id: true, title: true } } },
      ctx: makeCtx(),
      onFrame: (f) => {
        frames.push(f);
      }
    });
    const snap = frames[0];
    const rows = (snap!.data as Record<string, unknown>)['default/Todo'] as Array<{ id: string }>;
    expect(rows.map((r) => r.id)).toEqual(['t-public']);

    frames.length = 0;
    await createTodo(ctx.engine, { id: 't-public-2', title: 'more' });
    expect(frames).toHaveLength(1);
    expect(frames[0]?.kind).toBe('add');

    frames.length = 0;
    await createTodo(ctx.engine, { id: 't-secret-2', title: 'secret: also hidden' });
    expect(frames).toHaveLength(0);
  });
});

describe('Engine.subscribe — multi-key frame (§4.7)', () => {
  it('one subscription id fans across multiple (ns, type) entries; cancel tears all down', async () => {
    // Two types in the same namespace so the same engine can address both.
    const dataset = new MemoryDataset({ namespace: 'default' });
    const edges = new MemoryEdgesStore({ now: () => new Date() });
    const registry = new Registry();
    installAutoCrud(registry, 'Todo', dataset, edges, { fields: standardTodoFields() });
    installAutoCrud(registry, 'Tag', dataset, edges, {
      fields: {
        id: { kind: 'scalar', type: 'string', indexed: true },
        label: { kind: 'scalar', type: 'string', indexed: true }
      }
    });
    const datasets = new MemoryDatasetRegistry();
    datasets.set('default', dataset);
    const namespaces = new Map<string, NamespaceConfig>([['default', { registry }]]);
    const engine = new Engine({ namespaces, datasets, edges });

    const frames: WsResponseFrame[] = [];
    const handle = await engine.subscribe({
      id: 'sub-multi',
      frame: {
        'default/Todo': { params: {}, fields: { id: true, title: true } },
        'default/Tag': { params: {}, fields: { id: true, label: true } }
      },
      ctx: makeCtx(),
      onFrame: (f) => {
        frames.push(f);
      }
    });
    // One snapshot per key.
    expect(frames.filter((f) => f.kind === 'snapshot')).toHaveLength(2);
    frames.length = 0;

    await engine.mutate({
      frame: { 'default/createTodo': { params: { id: 't1', title: 'x' } } },
      ctx: makeCtx()
    });
    await engine.mutate({
      frame: { 'default/createTag': { params: { id: 'tag1', label: 'blue' } } },
      ctx: makeCtx()
    });
    expect(frames.map((f) => f.kind)).toEqual(['add', 'add']);

    handle.cancel();
    frames.length = 0;
    await engine.mutate({
      frame: { 'default/createTodo': { params: { id: 't2', title: 'y' } } },
      ctx: makeCtx()
    });
    await engine.mutate({
      frame: { 'default/createTag': { params: { id: 'tag2', label: 'red' } } },
      ctx: makeCtx()
    });
    expect(frames).toHaveLength(0);
  });
});

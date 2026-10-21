import { MemoryEdgesStore } from '@mnmal-ai/substrate-core';
import { MemoryDataset } from '@mnmal-ai/substrate-dataset-memory';
import type { RequestContext } from '@mnmal-ai/substrate-types';
import { describe, expect, it, vi } from 'vitest';
import { defineNamespace, field } from '../src/index.js';

// Minimal registry stub — stores each registered entry by key. The
// `register` call shape mirrors AutoCrudRegistry: `{ resolver, kind, ... }`.
function makeRegistry(): {
  register: ReturnType<typeof vi.fn>;
  resolvers: Map<string, { resolver: (ctx: RequestContext, args: unknown) => Promise<unknown> }>;
} {
  const resolvers = new Map<
    string,
    { resolver: (ctx: RequestContext, args: unknown) => Promise<unknown> }
  >();
  return {
    register: vi.fn((key: string, entry: unknown) => {
      resolvers.set(
        key,
        entry as { resolver: (ctx: RequestContext, args: unknown) => Promise<unknown> }
      );
    }),
    resolvers
  };
}

function makeCtx(): RequestContext {
  return {
    identity: { kind: 'system', id: 'test', grants: { '*': ['read', 'mutate'] } },
    namespace: 'test',
    operation: 'mutate',
    now: new Date(),
    headers: {},
    meta: {}
  };
}

describe('TypeInput.postWrite hook', () => {
  it('createResolver calls postWrite with the written row after success', async () => {
    const dataset = new MemoryDataset({ namespace: 'test' });
    const edges = new MemoryEdgesStore({ now: () => new Date() });
    const registry = makeRegistry();
    const postWrite = vi.fn().mockResolvedValue(undefined);

    const ns = defineNamespace('test', {
      Widget: {
        fields: { name: field.string() },
        postWrite
      }
    });
    ns.install({ registry: registry as never, dataset, edges });

    const createEntry = registry.resolvers.get('createWidget');
    if (!createEntry) throw new Error('createWidget resolver not registered');

    const result = await createEntry.resolver(makeCtx(), {
      params: { name: 'w1' },
      fields: { id: true, name: true }
    });

    expect(postWrite).toHaveBeenCalledTimes(1);
    // The hook receives the actual persisted row as first arg.
    const firstCall = postWrite.mock.calls[0] as [unknown, unknown];
    const [row, _ctx] = firstCall;
    expect(row).toMatchObject({ name: 'w1' });
    expect(row).toHaveProperty('id');
    // Resolver returns the result to the caller unchanged.
    expect(result).toMatchObject({ name: 'w1' });
  });

  it('updateResolver calls postWrite with the updated row after success', async () => {
    const dataset = new MemoryDataset({ namespace: 'test' });
    const edges = new MemoryEdgesStore({ now: () => new Date() });
    const registry = makeRegistry();
    const postWrite = vi.fn().mockResolvedValue(undefined);

    const ns = defineNamespace('test', {
      Widget: {
        fields: { name: field.string(), color: field.string() },
        postWrite
      }
    });
    ns.install({ registry: registry as never, dataset, edges });

    // Create a Widget first (postWrite fires on create — clear count after).
    const createEntry = registry.resolvers.get('createWidget');
    if (!createEntry) throw new Error('createWidget resolver not registered');
    const created = (await createEntry.resolver(makeCtx(), {
      params: { name: 'w1', color: 'red' },
      fields: { id: true }
    })) as { id: string };

    // Now update. postWrite must fire again with the updated row.
    postWrite.mockClear();
    const updateEntry = registry.resolvers.get('updateWidget');
    if (!updateEntry) throw new Error('updateWidget resolver not registered');
    await updateEntry.resolver(makeCtx(), {
      params: { id: created.id, color: 'blue' },
      fields: { id: true, color: true }
    });
    expect(postWrite).toHaveBeenCalledTimes(1);
    const updateCall = postWrite.mock.calls[0] as [unknown, unknown];
    expect(updateCall[0]).toMatchObject({ id: created.id, color: 'blue' });
  });

  it('deleteResolver does NOT call postWrite', async () => {
    const dataset = new MemoryDataset({ namespace: 'test' });
    const edges = new MemoryEdgesStore({ now: () => new Date() });
    const registry = makeRegistry();
    const postWrite = vi.fn().mockResolvedValue(undefined);

    const ns = defineNamespace('test', {
      Widget: {
        fields: { name: field.string() },
        postWrite
      }
    });
    ns.install({ registry: registry as never, dataset, edges });

    const createEntry = registry.resolvers.get('createWidget');
    if (!createEntry) throw new Error('createWidget resolver not registered');
    const created = (await createEntry.resolver(makeCtx(), {
      params: { name: 'w1' },
      fields: { id: true }
    })) as { id: string };

    postWrite.mockClear();
    const deleteEntry = registry.resolvers.get('deleteWidget');
    if (!deleteEntry) throw new Error('deleteWidget resolver not registered');
    await deleteEntry.resolver(makeCtx(), { params: { id: created.id }, fields: { id: true } });
    expect(postWrite).not.toHaveBeenCalled();
  });

  it('postWrite error propagates to the caller (SDK does not swallow)', async () => {
    const dataset = new MemoryDataset({ namespace: 'test' });
    const edges = new MemoryEdgesStore({ now: () => new Date() });
    const registry = makeRegistry();
    const postWrite = vi.fn().mockRejectedValue(new Error('hook failed'));

    const ns = defineNamespace('test', {
      Widget: {
        fields: { name: field.string() },
        postWrite
      }
    });
    ns.install({ registry: registry as never, dataset, edges });

    const createEntry = registry.resolvers.get('createWidget');
    if (!createEntry) throw new Error('createWidget resolver not registered');
    await expect(
      createEntry.resolver(makeCtx(), { params: { name: 'w1' }, fields: { id: true } })
    ).rejects.toThrow(/hook failed/);
  });

  it('types without postWrite work unchanged', async () => {
    const dataset = new MemoryDataset({ namespace: 'test' });
    const edges = new MemoryEdgesStore({ now: () => new Date() });
    const registry = makeRegistry();

    const ns = defineNamespace('test', {
      Widget: {
        fields: { name: field.string() }
        // No postWrite.
      }
    });
    ns.install({ registry: registry as never, dataset, edges });

    const createEntry = registry.resolvers.get('createWidget');
    if (!createEntry) throw new Error('createWidget resolver not registered');
    const result = await createEntry.resolver(makeCtx(), {
      params: { name: 'w1' },
      fields: { id: true, name: true }
    });
    expect(result).toMatchObject({ name: 'w1' });
  });
});

describe('postWrite chain (postWriteContributions)', () => {
  it('runs inline hook before kernel contributions', async () => {
    const order: string[] = [];
    const dataset = new MemoryDataset({ namespace: 'test' });
    const edges = new MemoryEdgesStore({ now: () => new Date() });
    const registry = makeRegistry();

    const ns = defineNamespace('test', {
      Widget: {
        fields: { name: field.string() },
        postWrite: async () => {
          order.push('inline');
        }
      }
    });
    ns.install({
      registry: registry as never,
      dataset,
      edges,
      postWriteContributions: {
        Widget: [
          async () => {
            order.push('kernel');
          }
        ]
      }
    });

    const createEntry = registry.resolvers.get('createWidget');
    if (!createEntry) throw new Error('createWidget resolver not registered');
    await createEntry.resolver(makeCtx(), { params: { name: 'w1' }, fields: { id: true } });

    expect(order).toEqual(['inline', 'kernel']);
  });

  it('propagates inline hook error and stops the chain', async () => {
    const order: string[] = [];
    const dataset = new MemoryDataset({ namespace: 'test' });
    const edges = new MemoryEdgesStore({ now: () => new Date() });
    const registry = makeRegistry();

    const ns = defineNamespace('test', {
      Widget: {
        fields: { name: field.string() },
        postWrite: async () => {
          order.push('inline');
          throw new Error('inline fail');
        }
      }
    });
    ns.install({
      registry: registry as never,
      dataset,
      edges,
      postWriteContributions: {
        Widget: [
          async () => {
            order.push('substrate-should-not-run');
          }
        ]
      }
    });

    const createEntry = registry.resolvers.get('createWidget');
    if (!createEntry) throw new Error('createWidget resolver not registered');
    await expect(
      createEntry.resolver(makeCtx(), { params: { name: 'w1' }, fields: { id: true } })
    ).rejects.toThrow('inline fail');
    expect(order).toEqual(['inline']);
  });

  it('runs only contributions when no inline postWrite', async () => {
    const calls: string[] = [];
    const dataset = new MemoryDataset({ namespace: 'test' });
    const edges = new MemoryEdgesStore({ now: () => new Date() });
    const registry = makeRegistry();

    const ns = defineNamespace('test', {
      Widget: { fields: { name: field.string() } }
    });
    ns.install({
      registry: registry as never,
      dataset,
      edges,
      postWriteContributions: {
        Widget: [
          async () => {
            calls.push('a');
          },
          async () => {
            calls.push('b');
          }
        ]
      }
    });

    const createEntry = registry.resolvers.get('createWidget');
    if (!createEntry) throw new Error('createWidget resolver not registered');
    await createEntry.resolver(makeCtx(), { params: { name: 'w1' }, fields: { id: true } });

    expect(calls).toEqual(['a', 'b']);
  });

  it('contributions for other types do not affect unrelated types', async () => {
    const calls: string[] = [];
    const dataset = new MemoryDataset({ namespace: 'test' });
    const edges = new MemoryEdgesStore({ now: () => new Date() });
    const registry = makeRegistry();

    const ns = defineNamespace('test', {
      Widget: { fields: { name: field.string() } },
      Gadget: { fields: { name: field.string() } }
    });
    ns.install({
      registry: registry as never,
      dataset,
      edges,
      postWriteContributions: {
        Gadget: [
          async () => {
            calls.push('gadget-contrib');
          }
        ]
      }
    });

    // Write a Widget — no contributions for Widget, so calls must stay empty.
    const createWidget = registry.resolvers.get('createWidget');
    if (!createWidget) throw new Error('createWidget resolver not registered');
    await createWidget.resolver(makeCtx(), { params: { name: 'w1' }, fields: { id: true } });
    expect(calls).toEqual([]);

    // Write a Gadget — contribution fires.
    const createGadget = registry.resolvers.get('createGadget');
    if (!createGadget) throw new Error('createGadget resolver not registered');
    await createGadget.resolver(makeCtx(), { params: { name: 'g1' }, fields: { id: true } });
    expect(calls).toEqual(['gadget-contrib']);
  });

  it('no contributions and no inline postWrite leaves the type unaffected', async () => {
    const dataset = new MemoryDataset({ namespace: 'test' });
    const edges = new MemoryEdgesStore({ now: () => new Date() });
    const registry = makeRegistry();

    const ns = defineNamespace('test', {
      Widget: { fields: { name: field.string() } }
    });
    // Empty contributions map — should behave identically to no postWriteContributions.
    ns.install({
      registry: registry as never,
      dataset,
      edges,
      postWriteContributions: {}
    });

    const createEntry = registry.resolvers.get('createWidget');
    if (!createEntry) throw new Error('createWidget resolver not registered');
    const result = await createEntry.resolver(makeCtx(), {
      params: { name: 'w1' },
      fields: { id: true, name: true }
    });
    expect(result).toMatchObject({ name: 'w1' });
  });
});

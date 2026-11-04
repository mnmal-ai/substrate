/**
 * `updateMany<T>` / `deleteMany<T>` resolvers called directly, plus the
 * install-time refusal of a namespace whose `X` and `ManyX` keys collide.
 * The memory-vs-pg answers live in substrate-dataset-pg's
 * `filter-writes-parity.test.ts`.
 */

import { MemoryEdgesStore, Registry } from '@mnmal-ai/substrate-core';
import { MemoryDataset } from '@mnmal-ai/substrate-dataset-memory';
import type { FieldDef, RequestContext, ResolverArgs, WriteEvent } from '@mnmal-ai/substrate-types';
import { describe, expect, it } from 'vitest';
import { AutoCrudNameCollisionError, installAutoCrud } from '../../src/autocrud/index.js';
import { field } from '../../src/field.js';
import { defineNamespace } from '../../src/namespace.js';

const NOW = new Date('2026-11-01T12:00:00.000Z');
const ITEM: Record<string, FieldDef> = {
  id: field.string(),
  title: field.string(),
  status: field.enum(['open', 'closed'])
};

function ctx(verb: 'update' | 'delete'): RequestContext {
  return {
    identity: { kind: 'agent', id: 'tester', agentKeyId: 'tester', grants: { '*': ['mutate'] } },
    namespace: 'app',
    operation: 'mutate',
    verb,
    now: NOW,
    headers: {},
    meta: {}
  };
}

async function seeded() {
  const dataset = new MemoryDataset({ namespace: 'app' });
  const edges = new MemoryEdgesStore({ now: () => NOW });
  const registry = new Registry();
  installAutoCrud(registry, 'Item', dataset, edges, { fields: ITEM });
  await dataset.write('Item', [
    { id: 'a', title: 'a', status: 'open' },
    { id: 'b', title: 'b', status: 'open' },
    { id: 'c', title: 'c', status: 'closed' }
  ]);
  const call = (name: string, verb: 'update' | 'delete', args: ResolverArgs) => {
    const entry = registry.get(name);
    if (entry === undefined) throw new Error(`${name} not registered`);
    return entry.resolver(ctx(verb), { dataset, edges, ...args });
  };
  return { dataset, registry, call };
}

describe('updateMany / deleteMany resolvers', () => {
  it('no subscriber registered: onWrite still fires once per changed row, and the rows are returned', async () => {
    const { call } = await seeded();
    const events: WriteEvent[] = [];
    const onWrite = (e: WriteEvent) => void events.push(e);
    const up = await call('updateManyItem', 'update', {
      params: { where: { status: { eq: 'open' } }, set: { title: 'z' } },
      onWrite
    });
    expect(up).toEqual({ count: 2, ids: ['a', 'b'], idsTruncated: false });
    expect(events.map((e) => [e.operation, e.id, e.row?.title])).toEqual([
      ['update', 'a', 'z'],
      ['update', 'b', 'z']
    ]);

    events.length = 0;
    const del = await call('deleteManyItem', 'delete', {
      params: { where: { title: { eq: 'z' } } },
      onWrite
    });
    expect(del).toEqual({ count: 2, ids: ['a', 'b'], idsTruncated: false });
    // Pre-images: the rows as they were before the tombstone.
    expect(events.map((e) => [e.operation, e.id, e.row?._deletedAt ?? null])).toEqual([
      ['delete', 'a', null],
      ['delete', 'b', null]
    ]);
  });

  it('refuses a set it would refuse on update<T>, and an id in set', async () => {
    const { call, dataset } = await seeded();
    const where = { status: { eq: 'open' } };
    await expect(
      call('updateManyItem', 'update', { params: { where, set: { status: 'nope' } } })
    ).rejects.toMatchObject({ code: 'invalid_enum_value' });
    await expect(
      call('updateManyItem', 'update', { params: { where, set: { bogus: 1 } } })
    ).rejects.toMatchObject({ code: 'unknown_field' });
    await expect(
      call('updateManyItem', 'update', { params: { where, set: { id: 'x' } } })
    ).rejects.toMatchObject({ code: 'invalid_params' });
    await expect(call('updateManyItem', 'update', { params: { where } })).rejects.toMatchObject({
      code: 'invalid_params'
    });
    await expect(call('deleteManyItem', 'delete', { params: {} })).rejects.toMatchObject({
      code: 'invalid_params'
    });
    expect((await dataset.read('Item', {})).rows.map((r) => r.title)).toEqual(['a', 'b', 'c']);
  });

  it('refuses past maxMatch with filter_too_broad, naming the cap', async () => {
    const { call } = await seeded();
    await expect(
      call('updateManyItem', 'update', {
        params: { where: {}, set: { title: 'all' } },
        filterWriteLimits: { maxMatch: 2, idsCap: 10 }
      })
    ).rejects.toMatchObject({ code: 'filter_too_broad', details: { maxMatch: 2 } });
  });
});

describe('by filter refuses what update<T> refuses, and what a plugin took over', () => {
  it('a readonly or server-managed field in set is refused as update<T> refuses it', async () => {
    const dataset = new MemoryDataset({ namespace: 'app' });
    const edges = new MemoryEdgesStore({ now: () => NOW });
    const registry = new Registry();
    installAutoCrud(registry, 'Item', dataset, edges, {
      fields: {
        ...ITEM,
        shortId: { kind: 'scalar', type: 'number', readonly: true },
        closedAt: { kind: 'scalar', type: 'date', serverSet: 'update', nullable: true }
      }
    });
    await dataset.write('Item', [{ id: 'a', title: 'a', status: 'open' }]);
    const codeOf = async (name: string, params: Record<string, unknown>) => {
      try {
        await registry.get(name)?.resolver(ctx('update'), { dataset, edges, params });
        return 'accepted';
      } catch (err) {
        return (err as { code?: string }).code;
      }
    };
    // update<T> accepts a readonly field in a patch today; by filter matches it.
    expect(await codeOf('updateManyItem', { where: {}, set: { shortId: 7 } })).toBe(
      await codeOf('updateItem', { id: 'a', shortId: 7 })
    );
    for (const patch of [
      { createdAt: '2026-01-01T00:00:00.000Z' },
      { _metadata: {} },
      { closedAt: '2026-01-01T00:00:00.000Z' },
      { _deletedAt: '2026-01-01T00:00:00.000Z' }
    ]) {
      const byId = await codeOf('updateItem', { id: 'a', ...patch });
      const byFilter = await codeOf('updateManyItem', { where: { id: { eq: 'a' } }, set: patch });
      expect(byFilter, JSON.stringify(patch)).toBe(byId);
      expect(byFilter, JSON.stringify(patch)).not.toBe('accepted');
    }
  });

  for (const [replaced, other] of [
    ['update', 'delete'],
    ['delete', 'update']
  ] as const) {
    it(`replacing ${replaced}<T> refuses ${replaced}Many<T> and leaves ${other}Many<T> working`, async () => {
      const { registry, call, dataset } = await seeded();
      const own = registry.get(`${replaced}Item`);
      if (own === undefined) throw new Error('not installed');
      registry.replace(`${replaced}Item`, { ...own, resolver: async () => null });
      const paramsFor = (verb: 'update' | 'delete', status: string) => ({
        where: { status: { eq: status } },
        ...(verb === 'update' ? { set: { title: 'x' } } : {})
      });
      await expect(
        call(`${replaced}ManyItem`, replaced, { params: paramsFor(replaced, 'open') })
      ).rejects.toMatchObject({ code: 'capability_unsupported' });
      expect((await dataset.read('Item', {})).rows.map((r) => r.title)).toEqual(['a', 'b', 'c']);
      await expect(
        call(`${other}ManyItem`, other, { params: paramsFor(other, 'closed') })
      ).resolves.toMatchObject({ count: 1, ids: ['c'] });
      // Putting autoCRUD's own entry back serves it again.
      registry.replace(`${replaced}Item`, own);
      await expect(
        call(`${replaced}ManyItem`, replaced, { params: paramsFor(replaced, 'open') })
      ).resolves.toMatchObject({ count: 2 });
    });
  }

  it('a registry without get fails closed', async () => {
    const dataset = new MemoryDataset({ namespace: 'app' });
    const edges = new MemoryEdgesStore({ now: () => NOW });
    const entries = new Map<
      string,
      { resolver: (c: RequestContext, a: ResolverArgs) => unknown }
    >();
    installAutoCrud(
      { register: (k, input) => void entries.set(k, input) },
      'Item',
      dataset,
      edges,
      {
        fields: ITEM
      }
    );
    await expect(
      Promise.resolve(
        entries.get('deleteManyItem')?.resolver(ctx('delete'), {
          dataset,
          edges,
          params: { where: {} }
        })
      )
    ).rejects.toMatchObject({ code: 'capability_unsupported' });
  });
});

describe('X and ManyX in one namespace', () => {
  const fields = { id: field.string(), title: field.string() };

  it('namespace declaring X and ManyX refused at install with AutoCrudNameCollisionError naming both', () => {
    for (const order of [
      ['Todo', 'ManyTodo'],
      ['ManyTodo', 'Todo']
    ]) {
      const registry = new Registry();
      const dataset = new MemoryDataset({ namespace: 'app' });
      const edges = new MemoryEdgesStore({ now: () => NOW });
      const [first, second] = order as [string, string];
      installAutoCrud(registry, first, dataset, edges, { fields });
      let thrown: unknown;
      try {
        installAutoCrud(registry, second, dataset, edges, { fields });
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(AutoCrudNameCollisionError);
      expect(String((thrown as Error).message)).toContain("'Todo'");
      expect(String((thrown as Error).message)).toContain("'ManyTodo'");
      expect(thrown).toMatchObject({ namespace: 'app', type: second, other: first });
    }

    // Through defineNamespace, as a plugin declares it.
    const ns = defineNamespace('app', { Todo: { fields }, ManyTodo: { fields } });
    const registry = new Registry();
    expect(() =>
      ns.install({
        registry,
        dataset: new MemoryDataset({ namespace: 'app' }),
        edges: new MemoryEdgesStore({ now: () => NOW })
      } as unknown as Parameters<typeof ns.install>[0])
    ).toThrow(AutoCrudNameCollisionError);
  });
});

/**
 * autoCRUD batch resolvers: a mutate array of generated create/update/delete
 * does per-batch work, and every slot answers as sequential dispatch would.
 */

import { Engine, MemoryEdgesStore, type NamespaceConfig, Registry } from '@mnmal-ai/substrate-core';
import { MemoryDataset, MemoryDatasetRegistry } from '@mnmal-ai/substrate-dataset-memory';
import { row as rowPolicy } from '@mnmal-ai/substrate-policy';
import type {
  Dataset,
  Edge,
  EdgesStore,
  FieldDef,
  Policy,
  RequestContext,
  ResolverArgs,
  Row
} from '@mnmal-ai/substrate-types';
import { describe, expect, it } from 'vitest';
import {
  createBatchResolver,
  deleteBatchResolver,
  updateBatchResolver
} from '../../src/autocrud/batch.js';
import { installAutoCrud } from '../../src/autocrud/index.js';
import { field } from '../../src/field.js';
import { resolveEntityRow, resolveEntityRows } from '../../src/short-id-resolver.js';

const NOW = new Date('2026-11-01T12:00:00.000Z');
const OWNER: Record<string, FieldDef> = { id: field.string(), name: field.string() };
const ITEM: Record<string, FieldDef> = {
  id: field.string(),
  title: field.string(),
  owner: field.crossRef('app', 'Owner', { onDelete: 'restrict' }),
  parent: field.crossRef('app', 'Item'),
  shortId: { kind: 'scalar', type: 'number', readonly: true }
};
const ITEM_SEL = { id: true, title: true, owner: true, parent: true, shortId: true };
const DEL_SEL = { id: true, deleted: true };

function ctx(id = 'tester'): RequestContext {
  return {
    identity: { kind: 'agent', id, agentKeyId: id, grants: { '*': ['read', 'mutate'] } },
    namespace: 'app',
    operation: 'mutate',
    now: NOW,
    headers: {},
    meta: {}
  };
}

type Params = Record<string, unknown>;

function stack(itemPolicy?: Policy) {
  const dataset = new MemoryDataset({ namespace: 'app' });
  const edges = new MemoryEdgesStore({ now: () => NOW });
  const registry = new Registry();
  installAutoCrud(registry, 'Owner', dataset, edges, { fields: OWNER });
  installAutoCrud(registry, 'Item', dataset, edges, {
    fields: ITEM,
    ...(itemPolicy !== undefined ? { policy: itemPolicy } : {})
  });
  const datasets = new MemoryDatasetRegistry();
  datasets.set('app', dataset);
  const engine = new Engine({
    namespaces: new Map<string, NamespaceConfig>([['app', { registry }]]),
    datasets,
    edges
  });
  const sel = (op: string) => (op.startsWith('delete') ? DEL_SEL : ITEM_SEL);
  /** One mutate: an array when `params` is an array, else a single frame. */
  const mutate = (op: string, params: Params | Params[], as = 'tester') =>
    engine.mutate({
      frame: {
        [`app/${op}`]: Array.isArray(params)
          ? params.map((p) => ({ params: p, fields: sel(op) }))
          : { params, fields: sel(op) }
      },
      ctx: ctx(as)
    });
  /** Each element as its own mutate, in order: the sequential reference. */
  const sequential = async (op: string, params: Params[], as = 'tester') => {
    const out: unknown[] = [];
    for (const p of params) out.push((await mutate(op, p, as)).data[`app/${op}`] ?? null);
    return out;
  };
  return { dataset, edges, engine, mutate, sequential };
}

async function seedOwners(s: ReturnType<typeof stack>, n = 10): Promise<void> {
  const env = await s.mutate(
    'createOwner',
    Array.from({ length: n }, (_, i) => ({ id: `o${i}`, name: `owner ${i}` }))
  );
  expect(env.errors).toBeUndefined();
}

function codes(env: { errors?: Array<{ code?: string; path?: string[] }> }) {
  return (env.errors ?? []).map((e) => ({ code: e.code, path: e.path }));
}

async function allRows(ds: Dataset, type: string): Promise<Row[]> {
  const { rows } = await ds.read(type, { includeDeleted: true });
  return [...rows].sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

async function allEdges(edges: EdgesStore) {
  const { edges: list } = await edges.readNextBatch(null, 100_000);
  return list
    .map((e: Edge) => ({
      from: String(e.from.id),
      to: `${e.to.type}:${String(e.to.id)}`,
      fieldName: e.fieldName,
      policy: e.policy,
      live: e.deletedAt === undefined
    }))
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

const items = (n: number): Params[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `i${String(i).padStart(3, '0')}`,
    title: `item ${i}`,
    owner: `o${i % 10}`,
    ...(i > 0 ? { parent: `i${String(i - 1).padStart(3, '0')}` } : {})
  }));

/** A dataset/edges pair that counts every method call made on it. */
function spied<T extends object>(target: T): { proxy: T; calls: Map<string, number> } {
  const calls = new Map<string, number>();
  const proxy = new Proxy(target, {
    get(t, prop, recv) {
      const v = Reflect.get(t, prop, recv);
      if (typeof v !== 'function' || typeof prop !== 'string') return v;
      return (...a: unknown[]) => {
        calls.set(prop, (calls.get(prop) ?? 0) + 1);
        return (v as (...x: unknown[]) => unknown).apply(t, a);
      };
    }
  });
  return { proxy, calls };
}

describe('autoCRUD batch resolvers (memory, through Engine)', () => {
  it('createBatch of 500 equals 500 sequential creates (rows, shortIds, edges)', async () => {
    const a = stack();
    const b = stack();
    await seedOwners(a);
    await seedOwners(b);
    const params = items(500);

    const env = await a.mutate('createItem', params);
    expect(env.errors).toBeUndefined();
    const seq = await b.sequential('createItem', params);

    expect(env.data['app/createItem']).toEqual(seq);
    expect(await allRows(a.dataset, 'Item')).toEqual(await allRows(b.dataset, 'Item'));
    expect(await allEdges(a.edges)).toEqual(await allEdges(b.edges));
    expect((await allEdges(a.edges)).length).toBe(999);
  });

  it('duplicate id in a create batch → id_exists present, batched_frame_rolled_back at [key,"<second index>"], nothing written', async () => {
    const s = stack();
    await seedOwners(s);
    const [p0, p1] = items(2) as [Params, Params];
    const env = await s.mutate('createItem', [p0, p1, { ...p0, title: 'again' }]);
    expect(codes(env)).toContainEqual({ code: 'id_exists', path: ['app/createItem'] });
    expect(codes(env)).toContainEqual({
      code: 'batched_frame_rolled_back',
      path: ['app/createItem', '2']
    });
    expect(await allRows(s.dataset, 'Item')).toEqual([]);
    expect(await allEdges(s.edges)).toHaveLength(0);
  });

  it('an id that already exists in the store refuses at its own index', async () => {
    const s = stack();
    await seedOwners(s);
    const [p0, p1, p2] = items(3) as [Params, Params, Params];
    expect((await s.mutate('createItem', { ...p1, parent: undefined })).errors).toBeUndefined();
    const env = await s.mutate('createItem', [p0, { ...p1, parent: undefined }, p2]);
    expect(codes(env)).toContainEqual({ code: 'id_exists', path: ['app/createItem'] });
    expect(codes(env)).toContainEqual({
      code: 'batched_frame_rolled_back',
      path: ['app/createItem', '1']
    });
  });

  it('two updates to one id equal sequential, slot by slot', async () => {
    const a = stack();
    const b = stack();
    for (const s of [a, b]) {
      await seedOwners(s);
      expect((await s.mutate('createItem', items(3))).errors).toBeUndefined();
    }
    // The second names the same row by its shortId: the repeat shows only after resolution.
    const ups = [
      { id: 'i001', title: 'one', owner: 'o5' },
      { id: '2', title: 'two' },
      { id: 'i002', title: 'three' }
    ];
    const env = await a.mutate('updateItem', ups);
    expect(env.errors).toBeUndefined();
    expect(env.data['app/updateItem']).toEqual(await b.sequential('updateItem', ups));
    expect(await allRows(a.dataset, 'Item')).toEqual(await allRows(b.dataset, 'Item'));
    expect(await allEdges(a.edges)).toEqual(await allEdges(b.edges));
  });

  it('two deletes of one id: deleted true then false, as sequential', async () => {
    const a = stack();
    const b = stack();
    for (const s of [a, b]) await seedOwners(s);
    const dels = [{ id: 'o3' }, { id: 'o3' }, { id: 'o4' }];
    const env = await a.mutate('deleteOwner', dels);
    expect(env.errors).toBeUndefined();
    expect(env.data['app/deleteOwner']).toEqual([
      { id: 'o3', deleted: true },
      { id: 'o3', deleted: false },
      { id: 'o4', deleted: true }
    ]);
    expect(env.data['app/deleteOwner']).toEqual(await b.sequential('deleteOwner', dels));
  });

  it("self-referencing crossRef to an earlier element's id is accepted", async () => {
    const s = stack();
    await seedOwners(s);
    const env = await s.mutate('createItem', [
      { id: 'p', title: 'parent', owner: 'o0' },
      { id: 'c', title: 'child', owner: 'o0', parent: 'p' }
    ]);
    expect(env.errors).toBeUndefined();
    expect(await allEdges(s.edges)).toContainEqual({
      from: 'c',
      to: 'Item:p',
      fieldName: 'parent',
      policy: 'set_null',
      live: true
    });
  });

  it('forward reference to a later element → missing_referent, rolled back at that index', async () => {
    const s = stack();
    await seedOwners(s);
    const env = await s.mutate('createItem', [
      { id: 'c', title: 'child', owner: 'o0', parent: 'p' },
      { id: 'p', title: 'parent', owner: 'o0' }
    ]);
    expect(codes(env)).toContainEqual({ code: 'missing_referent', path: ['app/createItem'] });
    expect(codes(env)).toContainEqual({
      code: 'batched_frame_rolled_back',
      path: ['app/createItem', '0']
    });
    // A row naming itself: sequential checks before its own write, so it is missing too.
    const self = await s.mutate('createItem', [
      { id: 'p', title: 'parent', owner: 'o0' },
      { id: 's', title: 'self', owner: 'o0', parent: 's' }
    ]);
    expect(codes(self)).toContainEqual({
      code: 'batched_frame_rolled_back',
      path: ['app/createItem', '1']
    });
    expect(await allRows(s.dataset, 'Item')).toEqual([]);
  });

  it('missing crossRef target at index 4 → missing_referent present, batched_frame_rolled_back at [key,"4"]', async () => {
    const s = stack();
    await seedOwners(s);
    const params = items(8);
    params[4] = { ...params[4], owner: 'nobody' };
    const env = await s.mutate('createItem', params);
    expect(codes(env)).toContainEqual({ code: 'missing_referent', path: ['app/createItem'] });
    expect(codes(env)).toContainEqual({
      code: 'batched_frame_rolled_back',
      path: ['app/createItem', '4']
    });
    expect(await allRows(s.dataset, 'Item')).toEqual([]);
  });

  it('the lowest failing index wins, whichever check it fails', async () => {
    const a = stack();
    const b = stack();
    for (const s of [a, b]) await seedOwners(s);
    // Create checks crossRefs before validating, so each case mixes the two.
    const first = items(5);
    first[1] = { id: 'i001', title: 't', owner: 'o1', bogus: true };
    first[3] = { ...first[3], owner: 'nobody' };
    const second = items(5);
    second[1] = { id: 'i001', title: 't', owner: 'nobody' };
    second[3] = { ...second[3], bogus: true };
    for (const params of [first, second]) {
      const env = await a.mutate('createItem', params);
      const alone = await b.mutate('createItem', params[1] as Params);
      expect(codes(env)).toContainEqual({
        code: 'batched_frame_rolled_back',
        path: ['app/createItem', '1']
      });
      expect(codes(env)[0]).toEqual(codes(alone)[0]);
    }
    expect(await allRows(a.dataset, 'Item')).toEqual([]);
  });

  it('updateBatch on a tombstoned id → not_found at its index, row stays tombstoned; on a purged id → not_found, nothing re-created', async () => {
    const s = stack();
    await seedOwners(s);
    expect((await s.mutate('createItem', items(4))).errors).toBeUndefined();
    await s.dataset.tombstone('Item', ['i002']);
    await s.dataset.purge('Item', ['i003']);

    const dead = await s.mutate('updateItem', [
      { id: 'i000', title: 'x' },
      { id: 'i001', title: 'x' },
      { id: 'i002', title: 'revived?' }
    ]);
    expect(codes(dead)).toContainEqual({ code: 'not_found', path: ['app/updateItem'] });
    expect(codes(dead)).toContainEqual({
      code: 'batched_frame_rolled_back',
      path: ['app/updateItem', '2']
    });
    const tomb = (await allRows(s.dataset, 'Item')).find((r) => r.id === 'i002');
    expect(tomb?._deletedAt).toBeDefined();
    expect(tomb?.title).toBe('item 2');

    const purged = await s.mutate('updateItem', [
      { id: 'i000', title: 'x' },
      { id: 'i003', title: 'back?' }
    ]);
    expect(codes(purged)).toContainEqual({
      code: 'batched_frame_rolled_back',
      path: ['app/updateItem', '1']
    });
    expect((await allRows(s.dataset, 'Item')).map((r) => r.id)).toEqual(['i000', 'i001', 'i002']);
    expect((await allRows(s.dataset, 'Item'))[0]?.title).toBe('item 0');
  });

  it('updateBatch on a row-policy type hides a row the caller cannot read, as sequential does', async () => {
    const mine = rowPolicy(
      (c, r) => (r as { title?: string }).title !== `hidden from ${c.identity?.id}`
    );
    const a = stack(mine);
    const b = stack(mine);
    for (const s of [a, b]) {
      await seedOwners(s);
      const seed = items(3);
      seed[1] = { ...seed[1], title: 'hidden from bob' };
      expect((await s.mutate('createItem', seed, 'alice')).errors).toBeUndefined();
    }
    const ups = [
      { id: 'i000', title: 'bob 0' },
      { id: 'i001', title: 'bob 1' },
      { id: 'i002', title: 'bob 2' }
    ];
    const env = await a.mutate('updateItem', ups, 'bob');
    const seq = await b.sequential('updateItem', ups, 'bob');
    expect(env.errors).toBeUndefined();
    expect(env.data['app/updateItem']).toEqual(seq);
    expect((env.data['app/updateItem'] as unknown[])[1] ?? null).toBeNull();
    expect(await allRows(a.dataset, 'Item')).toEqual(await allRows(b.dataset, 'Item'));

    const del = await a.mutate('deleteItem', [{ id: 'i001' }, { id: 'i002' }], 'bob');
    expect(del.data['app/deleteItem']).toEqual(
      await b.sequential('deleteItem', [{ id: 'i001' }, { id: 'i002' }], 'bob')
    );
  });

  it('deleteBatch with a restrict edge on element 2 → restrict_violation present, batched_frame_rolled_back at [key,"2"]', async () => {
    const s = stack();
    await seedOwners(s);
    expect(
      (await s.mutate('createItem', { id: 'x', title: 'x', owner: 'o2' })).errors
    ).toBeUndefined();
    const env = await s.mutate('deleteOwner', [
      { id: 'o0' },
      { id: 'o1' },
      { id: 'o2' },
      { id: 'o3' }
    ]);
    expect(codes(env)).toContainEqual({ code: 'restrict_violation', path: ['app/deleteOwner'] });
    expect(codes(env)).toContainEqual({
      code: 'batched_frame_rolled_back',
      path: ['app/deleteOwner', '2']
    });
    expect((await allRows(s.dataset, 'Owner')).filter((r) => r._deletedAt != null)).toEqual([]);
  });
});

describe('autoCRUD batch resolvers: per-batch dataset calls', () => {
  async function seeded() {
    const s = stack();
    await seedOwners(s);
    expect((await s.mutate('createItem', items(5))).errors).toBeUndefined();
    const ds = spied<Dataset>(s.dataset);
    const edges = spied<EdgesStore>(s.edges);
    const argsOf = (params: Params): ResolverArgs => ({
      params,
      dataset: ds.proxy,
      edges: edges.proxy
    });
    return { s, ds, edges, argsOf };
  }

  it('createBatch issues one ds.write and one allocateShortIds', async () => {
    const { ds, edges, argsOf } = await seeded();
    const batch = createBatchResolver('Item', ds.proxy, edges.proxy, { fields: ITEM });
    const params = items(55).slice(5);
    const out = await batch(ctx(), params.map(argsOf));
    expect(out).toHaveLength(50);
    expect(ds.calls.get('write')).toBe(1);
    expect(ds.calls.get('allocateShortIds')).toBe(1);
    expect(ds.calls.get('bindShortIds')).toBe(1);
    expect(ds.calls.get('allocateShortId')).toBeUndefined();
    expect(ds.calls.get('bindShortId')).toBeUndefined();
    // One existence read per crossRef target type (Owner, Item).
    expect(ds.calls.get('read')).toBe(2);
    expect(edges.calls.get('writeMany')).toBe(1);
    expect(edges.calls.get('write')).toBeUndefined();
  });

  it('updateBatch issues one patchRows and no ds.write', async () => {
    const { ds, edges, argsOf } = await seeded();
    const batch = updateBatchResolver('Item', ds.proxy, edges.proxy, { fields: ITEM });
    const out = await batch(
      ctx(),
      ['i000', 'i001', 'i002', 'i003'].map((id, i) => argsOf({ id, owner: `o${i + 5}` }))
    );
    expect(out.map((r) => r?.owner)).toEqual(['o5', 'o6', 'o7', 'o8']);
    expect(ds.calls.get('patchRows')).toBe(1);
    expect(ds.calls.get('write')).toBeUndefined();
    expect(ds.calls.get('conditionalUpdate')).toBeUndefined();
    // Target rows, then one existence read for the Owner targets.
    expect(ds.calls.get('read')).toBe(2);
    expect(edges.calls.get('findEdgesFromMany')).toBe(1);
    expect(edges.calls.get('tombstoneMany')).toBe(1);
    expect(edges.calls.get('writeMany')).toBe(1);
    expect(edges.calls.get('findEdgesFrom')).toBeUndefined();
    expect(edges.calls.get('tombstone')).toBeUndefined();
    expect(edges.calls.get('write')).toBeUndefined();
  });

  it('update and delete by shortId: one resolveShortIds per batch', async () => {
    const { ds, edges, argsOf } = await seeded();
    const upd = updateBatchResolver('Item', ds.proxy, edges.proxy, { fields: ITEM });
    const updated = await upd(
      ctx(),
      ['1', '2', '3'].map((id) => argsOf({ id, title: `short ${id}` }))
    );
    expect(updated.map((r) => r?.id)).toEqual(['i000', 'i001', 'i002']);
    expect(ds.calls.get('resolveShortIds')).toBe(1);
    expect(ds.calls.get('resolveShortId')).toBeUndefined();

    ds.calls.clear();
    const del = deleteBatchResolver('Item', ds.proxy, edges.proxy, { fields: ITEM });
    const deleted = await del(
      ctx(),
      ['4', '5'].map((id) => argsOf({ id }))
    );
    expect(deleted).toEqual([
      { id: 'i003', deleted: true },
      { id: 'i004', deleted: true }
    ]);
    expect(ds.calls.get('resolveShortIds')).toBe(1);
    expect(ds.calls.get('resolveShortId')).toBeUndefined();
    expect(ds.calls.get('tombstone')).toBe(1);
    expect(edges.calls.get('findEdgesToMany')).toBe(1);
    expect(edges.calls.get('canDelete')).toBeUndefined();
  });
});

describe('resolveEntityRows agrees with resolveEntityRow', () => {
  it('on a raw uuid, a shortId, a tombstoned shortId and a numeric-looking id', async () => {
    const ds = new MemoryDataset({ namespace: 'app' });
    const uuid = '0190f5f2-0000-7000-8000-000000000001';
    await ds.write('T', [{ id: uuid }, { id: 'dead' }, { id: 'x7' }, { id: '3' }]);
    // '3' is a raw id AND the shortId of row 'x7'; 'dead' (shortId 2) is tombstoned.
    for (const [short, id] of [
      [1, uuid],
      [2, 'dead'],
      [3, 'x7'],
      [4, '3']
    ] as const) {
      expect(await ds.allocateShortId('T')).toBe(short);
      await ds.bindShortId('T', short, id);
    }
    await ds.tombstone('T', ['dead']);
    const inputs = [uuid, '1', 'dead', '2', '3', '4', 'nope', '99'];
    const single = await Promise.all(inputs.map((i) => resolveEntityRow(ds, 'T', i)));
    const many = await resolveEntityRows(ds, 'T', inputs);
    expect(many.map((r) => r?.id ?? null)).toEqual(single.map((r) => r?.id ?? null));
    expect(many.map((r) => r?.id ?? null)).toEqual([uuid, uuid, null, null, '3', '3', null, null]);
  });
});

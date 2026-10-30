import { Engine, MemoryEdgesStore, type NamespaceConfig, Registry } from '@mnmal-ai/substrate-core';
import { MemoryDataset, MemoryDatasetRegistry } from '@mnmal-ai/substrate-dataset-memory';
import type {
  FieldDef,
  Policy,
  ReadParams,
  RequestContext,
  WriteEvent
} from '@mnmal-ai/substrate-types';
import { ResolverFrameError } from '@mnmal-ai/substrate-types';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  createResolver,
  deleteResolver,
  getResolver,
  installAutoCrud,
  listResolver,
  purgeResolver,
  updateResolver
} from '../src/autocrud/index.js';
import { useEnvSnapshot } from './_env-override.js';

function makeEdges(): MemoryEdgesStore {
  return new MemoryEdgesStore({ now: () => new Date('2026-04-18T00:00:00Z') });
}

function makeCtx(): RequestContext {
  return {
    identity: { kind: 'system', id: 'test', grants: { '*': ['read', 'mutate'] } },
    namespace: 'default',
    operation: 'query',
    now: new Date('2026-04-18T00:00:00Z'),
    headers: {},
    meta: {}
  };
}

describe('autocrud.listResolver', () => {
  it('returns all rows when no limit is supplied', async () => {
    const dataset = new MemoryDataset({ namespace: 'default' });
    await dataset.write('Todo', [
      { id: 1, title: 'a' },
      { id: 2, title: 'b' },
      { id: 3, title: 'c' }
    ]);
    const res = await listResolver('Todo', dataset)(makeCtx(), {});
    expect(res.rows).toHaveLength(3);
  });

  it('honors params.limit', async () => {
    const dataset = new MemoryDataset({ namespace: 'default' });
    await dataset.write('Todo', [
      { id: 1, title: 'a' },
      { id: 2, title: 'b' },
      { id: 3, title: 'c' }
    ]);
    const res = await listResolver('Todo', dataset)(makeCtx(), { params: { limit: 2 } });
    expect(res.rows).toHaveLength(2);
    expect(res.hasMore).toBe(true);
  });

  it('forwards args.signal into ReadParams', async () => {
    const dataset = new MemoryDataset({ namespace: 'default' });
    let seen: ReadParams | undefined;
    const spy = Object.create(dataset) as MemoryDataset;
    spy.read = (type, params) => {
      seen = params;
      return dataset.read(type, params);
    };
    const controller = new AbortController();
    await listResolver('Todo', spy)(makeCtx(), { signal: controller.signal });
    expect(seen?.signal).toBe(controller.signal);
  });

  it('returns [] for unknown type', async () => {
    const dataset = new MemoryDataset({ namespace: 'default' });
    const res = await listResolver('Missing', dataset)(makeCtx(), {});
    expect(res.rows).toEqual([]);
    expect(res.hasMore).toBe(false);
  });

  it('threads where/orderBy/cursor through to dataset.read', async () => {
    const dataset = new MemoryDataset({ namespace: 'default' });
    await dataset.write('Todo', [
      { id: 1, n: 10, done: true },
      { id: 2, n: 20, done: false },
      { id: 3, n: 30, done: true }
    ]);
    const res = await listResolver('Todo', dataset)(makeCtx(), {
      params: { where: { done: { eq: true } }, orderBy: [{ n: 'desc' }] }
    });
    expect(res.rows.map((r) => r.id)).toEqual([3, 1]);
  });

  it('threads params.includeDeleted through to dataset.read', async () => {
    const dataset = new MemoryDataset({ namespace: 'default' });
    await dataset.write('Todo', [
      { id: 1, title: 'live' },
      { id: 2, title: 'gone' }
    ]);
    await dataset.tombstone('Todo', [2]);

    const live = await listResolver('Todo', dataset)(makeCtx(), {});
    expect(live.rows.map((r) => r.id)).toEqual([1]);

    const all = await listResolver('Todo', dataset)(makeCtx(), {
      params: { includeDeleted: true }
    });
    expect(all.rows.map((r) => r.id).sort()).toEqual([1, 2]);
  });

  it('threads params.id through to dataset.read (single-row shortcut)', async () => {
    const dataset = new MemoryDataset({ namespace: 'default' });
    await dataset.write('Todo', [
      { id: 1, title: 'a' },
      { id: 2, title: 'b' },
      { id: 3, title: 'c' }
    ]);
    const res = await listResolver('Todo', dataset)(makeCtx(), { params: { id: 2 } });
    expect(res.rows.map((r) => r.id)).toEqual([2]);
  });

  it('threads params.ids through to dataset.read (multi-row shortcut)', async () => {
    const dataset = new MemoryDataset({ namespace: 'default' });
    await dataset.write('Todo', [
      { id: 1, title: 'a' },
      { id: 2, title: 'b' },
      { id: 3, title: 'c' }
    ]);
    const res = await listResolver('Todo', dataset)(makeCtx(), { params: { ids: [1, 3] } });
    expect(res.rows.map((r) => r.id).sort()).toEqual([1, 3]);
  });

  it('rejects unknown top-level param (typo of `order` for `orderBy`) with unknown_param', async () => {
    // A silently dropped `order` would return rows in arbitrary order, so any
    // "find newest X" query depends on unknown params failing loud.
    const dataset = new MemoryDataset({ namespace: 'default' });
    await dataset.write('Todo', [
      { id: 1, n: 10 },
      { id: 2, n: 20 }
    ]);
    await expect(
      listResolver('Todo', dataset)(makeCtx(), {
        params: { order: [{ n: 'desc' }] }
      })
    ).rejects.toThrow(expect.objectContaining({ code: 'unknown_param' }));
  });

  it('attaches the rejected param name in error.details for programmatic dispatch', async () => {
    const dataset = new MemoryDataset({ namespace: 'default' });
    try {
      await listResolver('Todo', dataset)(makeCtx(), {
        params: { order: [{ n: 'desc' }] }
      });
      expect.fail('expected listResolver to reject');
    } catch (err) {
      expect(err).toBeInstanceOf(ResolverFrameError);
      expect((err as ResolverFrameError).code).toBe('unknown_param');
      expect((err as ResolverFrameError).details).toMatchObject({ field: 'order' });
    }
  });
});

describe('autocrud.getResolver', () => {
  it('returns the matching row', async () => {
    const dataset = new MemoryDataset({ namespace: 'default' });
    await dataset.write('Todo', [{ id: 't1', title: 'a' }]);
    const row = await getResolver('Todo', dataset)(makeCtx(), { params: { id: 't1' } });
    expect(row).toMatchObject({ id: 't1', title: 'a' });
  });

  it('returns null when id does not exist', async () => {
    const dataset = new MemoryDataset({ namespace: 'default' });
    const row = await getResolver('Todo', dataset)(makeCtx(), { params: { id: 'missing' } });
    expect(row).toBeNull();
  });

  it('throws when params.id is missing', async () => {
    const dataset = new MemoryDataset({ namespace: 'default' });
    await expect(getResolver('Todo', dataset)(makeCtx(), {})).rejects.toThrow(
      /params\.id is required/
    );
  });

  it('rejects unknown top-level param with unknown_param', async () => {
    const dataset = new MemoryDataset({ namespace: 'default' });
    await expect(
      getResolver('Todo', dataset)(makeCtx(), { params: { idd: 't1' } })
    ).rejects.toThrow(expect.objectContaining({ code: 'unknown_param' }));
  });
});

describe('autocrud.createResolver', () => {
  it('writes the row and returns it', async () => {
    const dataset = new MemoryDataset({ namespace: 'default' });
    const row = await createResolver('Todo', dataset)(makeCtx(), {
      params: { id: 'fixed', title: 'hello', done: false }
    });
    expect(row).toMatchObject({ id: 'fixed', title: 'hello', done: false });
    const {
      rows: [stored]
    } = await dataset.read('Todo', { id: 'fixed' });
    expect(stored).toMatchObject({ id: 'fixed', title: 'hello' });
  });

  it('generates an id when none is supplied', async () => {
    const dataset = new MemoryDataset({ namespace: 'default' });
    const row = await createResolver('Todo', dataset)(makeCtx(), { params: { title: 'x' } });
    expect(typeof row.id).toBe('string');
    expect((row.id as string).length).toBeGreaterThan(0);
  });

  it('lets exactly one of two concurrent creates with one id land', async () => {
    const dataset = new MemoryDataset({ namespace: 'default' });
    const create = createResolver('Todo', dataset);
    const results = await Promise.allSettled([
      create(makeCtx(), { params: { id: 'dup', title: 'first' } }),
      create(makeCtx(), { params: { id: 'dup', title: 'second' } })
    ]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected']);
    expect(results[1]).toMatchObject({ reason: { code: 'id_exists' } });
    const { rows } = await dataset.read('Todo', { id: 'dup' });
    expect(rows[0]).toMatchObject({ title: 'first' });
  });
});

describe('autoCRUD create — shortId (Task 9)', () => {
  const FIELDS_WITH_SHORT_ID: Record<string, FieldDef> = {
    id: { kind: 'scalar', type: 'string' },
    title: { kind: 'scalar', type: 'string' },
    shortId: { kind: 'scalar', type: 'number', readonly: true }
  };

  function buildShortIdEngine(): { engine: Engine; dataset: MemoryDataset } {
    const dataset = new MemoryDataset({ namespace: 'app' });
    const edges = new MemoryEdgesStore({ now: () => new Date('2026-04-20T00:00:00Z') });
    const registry = new Registry();
    installAutoCrud(registry, 'Todo', dataset, edges, { fields: FIELDS_WITH_SHORT_ID });
    const datasets = new MemoryDatasetRegistry();
    datasets.set('app', dataset);
    const engine = new Engine({
      namespaces: new Map<string, NamespaceConfig>([['app', { registry }]]),
      datasets,
      edges
    });
    return { engine, dataset };
  }

  function ctxForApp(): RequestContext {
    return {
      identity: { kind: 'system', id: 'test', grants: { '*': ['read', 'mutate'] } },
      namespace: 'app',
      operation: 'mutate',
      now: new Date('2026-04-20T00:00:00Z'),
      headers: {},
      meta: {}
    };
  }

  it('populates shortId on create and persists it to the sidecar', async () => {
    const { engine, dataset } = buildShortIdEngine();

    const r1 = await engine.mutate({
      frame: {
        'app/createTodo': { params: { title: 'first' }, fields: { id: true, shortId: true } }
      },
      ctx: ctxForApp()
    });
    const r2 = await engine.mutate({
      frame: {
        'app/createTodo': { params: { title: 'second' }, fields: { id: true, shortId: true } }
      },
      ctx: ctxForApp()
    });

    expect(r1.errors).toBeUndefined();
    expect(r2.errors).toBeUndefined();

    const todo1 = r1.data['app/createTodo'] as { id: string; shortId: number };
    const todo2 = r2.data['app/createTodo'] as { id: string; shortId: number };

    expect(todo1.shortId).toBe(1);
    expect(todo2.shortId).toBe(2);

    // Round-trip: sidecar binding is present
    const resolved = await dataset.resolveShortId('Todo', 1);
    expect(resolved).toBe(todo1.id);
  });

  it('rejects caller-supplied shortId on create', async () => {
    const { engine } = buildShortIdEngine();

    const env = await engine.mutate({
      frame: {
        'app/createTodo': { params: { title: 'x', shortId: 42 }, fields: { id: true } }
      },
      ctx: ctxForApp()
    });

    expect(env.errors).toBeDefined();
    const err = env.errors?.[0];
    expect(JSON.stringify(err)).toMatch(/shortId|readonly/i);
  });

  it('createResolver allocates shortId when fields map has readonly shortId', async () => {
    const dataset = new MemoryDataset({ namespace: 'default' });
    const fields: Record<string, FieldDef> = {
      title: { kind: 'scalar', type: 'string' },
      shortId: { kind: 'scalar', type: 'number', readonly: true }
    };
    const row = await createResolver('Todo', dataset, { fields })(makeCtx(), {
      params: { id: 'x', title: 'direct' }
    });
    expect(typeof (row as { shortId?: number }).shortId).toBe('number');
    expect((row as { shortId?: number }).shortId).toBe(1);

    // Sidecar binding exists
    const resolved = await dataset.resolveShortId('Todo', 1);
    expect(resolved).toBe('x');
  });
});

describe('installAutoCrud + engine round-trip', () => {
  let dataset: MemoryDataset;
  let edges: MemoryEdgesStore;
  let engine: Engine;

  beforeEach(() => {
    dataset = new MemoryDataset({ namespace: 'default' });
    edges = makeEdges();
    const registry = new Registry();
    installAutoCrud(registry, 'Todo', dataset, edges, {
      fields: {
        id: { kind: 'scalar', type: 'string' },
        title: { kind: 'scalar', type: 'string' },
        done: { kind: 'scalar', type: 'boolean' }
      }
    });
    const namespaces = new Map<string, NamespaceConfig>([['default', { registry }]]);
    const datasets = new MemoryDatasetRegistry();
    datasets.set('default', dataset);
    engine = new Engine({ namespaces, datasets, edges });
  });

  it('exposes deleteTodo in engine.schemaFor("default").mutations', () => {
    const schema = engine.schemaFor('default');
    expect(schema.mutations.deleteTodo).toBeDefined();
  });

  it('registers list/get/create under canonical names', async () => {
    // list (type key)
    const listed = await engine.query({
      frame: { 'default/Todo': { params: { limit: 10 } } },
      ctx: makeCtx()
    });
    expect(listed.data['default/Todo']).toEqual([]);
    expect(listed.shapes['default/Todo']).toBe('list');

    // create
    const created = await engine.mutate({
      frame: { 'default/createTodo': { params: { id: 't1', title: 'first', done: false } } },
      ctx: makeCtx()
    });
    expect(created.data['default/createTodo']).toMatchObject({ id: 't1', title: 'first' });
    expect(created.shapes['default/createTodo']).toBe('single');

    // get
    const gotten = await engine.query({
      frame: { 'default/getTodo': { params: { id: 't1' } } },
      ctx: makeCtx()
    });
    expect(gotten.data['default/getTodo']).toMatchObject({ id: 't1' });
    expect(gotten.shapes['default/getTodo']).toBe('single');

    // list again — now non-empty
    const listed2 = await engine.query({
      frame: { 'default/Todo': {} },
      ctx: makeCtx()
    });
    expect(listed2.data['default/Todo']).toHaveLength(1);
  });

  it('getTodo surfaces null when id is not found', async () => {
    const gotten = await engine.query({
      frame: { 'default/getTodo': { params: { id: 'does-not-exist' } } },
      ctx: makeCtx()
    });
    expect(gotten.data['default/getTodo']).toBeNull();
    expect(gotten.shapes['default/getTodo']).toBe('single');
  });
});

describe('autocrud resolvers prefer args.dataset over the closure', () => {
  it('createResolver writes through args.dataset when provided', async () => {
    const closedOver = new MemoryDataset({ namespace: 'default' });
    const injected = new MemoryDataset({ namespace: 'default' });
    const resolver = createResolver('Todo', closedOver);

    await resolver(makeCtx(), {
      params: { id: 'x', title: 'via-args' },
      dataset: injected
    });

    // Write landed in the injected dataset — closure is untouched.
    const { rows: injectedRows } = await injected.read('Todo', {});
    expect(injectedRows).toHaveLength(1);
    const { rows: closedRows } = await closedOver.read('Todo', {});
    expect(closedRows).toHaveLength(0);
  });

  it('listResolver reads through args.dataset when provided', async () => {
    const closedOver = new MemoryDataset({ namespace: 'default' });
    const injected = new MemoryDataset({ namespace: 'default' });
    await closedOver.write('Todo', [{ id: 1, title: 'closure' }]);
    await injected.write('Todo', [{ id: 2, title: 'injected-a' }]);
    await injected.write('Todo', [{ id: 3, title: 'injected-b' }]);

    const resolver = listResolver('Todo', closedOver);
    const res = await resolver(makeCtx(), { dataset: injected });
    expect(res.rows.map((r) => r.id).sort()).toEqual([2, 3]);
  });

  it('getResolver reads through args.dataset when provided', async () => {
    const closedOver = new MemoryDataset({ namespace: 'default' });
    const injected = new MemoryDataset({ namespace: 'default' });
    await closedOver.write('Todo', [{ id: 't1', title: 'closure' }]);
    await injected.write('Todo', [{ id: 't1', title: 'injected' }]);

    const resolver = getResolver('Todo', closedOver);
    const row = await resolver(makeCtx(), { params: { id: 't1' }, dataset: injected });
    expect(row?.title).toBe('injected');
  });

  it('createResolver falls back to closed-over dataset when args.dataset absent', async () => {
    const closedOver = new MemoryDataset({ namespace: 'default' });
    const resolver = createResolver('Todo', closedOver);
    await resolver(makeCtx(), { params: { id: 'x', title: 'fallback' } });
    const { rows } = await closedOver.read('Todo', {});
    expect(rows).toHaveLength(1);
  });
});

describe('autocrud.deleteResolver (direct-call)', () => {
  it('throws when params.id is missing', async () => {
    const dataset = new MemoryDataset({ namespace: 'default' });
    const edges = makeEdges();
    const resolver = deleteResolver('Todo', dataset, edges);
    await expect(resolver(makeCtx(), {})).rejects.toThrow(/params\.id is required/);
  });

  it('rejects unknown top-level param with unknown_param', async () => {
    const dataset = new MemoryDataset({ namespace: 'default' });
    const edges = makeEdges();
    const resolver = deleteResolver('Todo', dataset, edges);
    await expect(resolver(makeCtx(), { params: { idd: 't1' } })).rejects.toThrow(
      expect.objectContaining({ code: 'unknown_param' })
    );
  });

  it('returns { deleted: false } for a non-existent id', async () => {
    const dataset = new MemoryDataset({ namespace: 'default' });
    const edges = makeEdges();
    const resolver = deleteResolver('Todo', dataset, edges);
    const res = await resolver(makeCtx(), { params: { id: 'ghost' } });
    expect(res).toEqual({ id: 'ghost', deleted: false });
  });

  it('tombstones the row and returns { deleted: true } for an existing id', async () => {
    const dataset = new MemoryDataset({ namespace: 'default' });
    const edges = makeEdges();
    await dataset.write('Todo', [{ id: 't1', title: 'keep' }]);
    const resolver = deleteResolver('Todo', dataset, edges);
    const res = await resolver(makeCtx(), { params: { id: 't1' } });
    expect(res).toEqual({ id: 't1', deleted: true });
    const {
      rows: [row]
    } = await dataset.read('Todo', { id: 't1', includeDeleted: true });
    expect(row?._deletedAt).toBeInstanceOf(Date);
    const { rows: liveRows } = await dataset.read('Todo', { id: 't1' });
    expect(liveRows).toHaveLength(0);
  });

  it('throws RestrictViolation when a live restrict edge points at the target', async () => {
    const dataset = new MemoryDataset({ namespace: 'default' });
    const edges = makeEdges();
    await dataset.write('Todo', [{ id: 't1', title: 'blocked' }]);
    // Hand-write a restrict edge pointing at t1 — no source row needed for
    // this unit slice; the sweep would police orphan 'from' refs separately.
    await edges.write({
      from: { ns: 'default', type: 'RestrictTag', id: 'rt1' },
      to: { ns: 'default', type: 'Todo', id: 't1' },
      fieldName: 'todoId',
      policy: 'restrict'
    });
    const resolver = deleteResolver('Todo', dataset, edges);
    await expect(resolver(makeCtx(), { params: { id: 't1' } })).rejects.toThrow(
      /restrict.*cannot delete/
    );
    // Row still live — Phase 0 gate prevented the tombstone.
    const { rows: liveRows } = await dataset.read('Todo', { id: 't1' });
    expect(liveRows).toHaveLength(1);
  });
});

describe('autocrud.purgeResolver (direct-call)', () => {
  it('throws when params.id is missing', async () => {
    const dataset = new MemoryDataset({ namespace: 'default' });
    const resolver = purgeResolver('Todo', dataset);
    await expect(resolver(makeCtx(), {})).rejects.toThrow(/params\.id is required/);
  });

  it('rejects unknown top-level param with unknown_param', async () => {
    const dataset = new MemoryDataset({ namespace: 'default' });
    const resolver = purgeResolver('Todo', dataset);
    await expect(resolver(makeCtx(), { params: { idd: 't1' } })).rejects.toThrow(
      expect.objectContaining({ code: 'unknown_param' })
    );
  });

  it('returns { purged: false } for a non-existent id', async () => {
    const dataset = new MemoryDataset({ namespace: 'default' });
    const resolver = purgeResolver('Todo', dataset);
    const res = await resolver(makeCtx(), { params: { id: 'ghost' } });
    expect(res).toEqual({ id: 'ghost', purged: false });
  });

  it('hard-deletes the row for an existing id (no tombstone left behind)', async () => {
    const dataset = new MemoryDataset({ namespace: 'default' });
    await dataset.write('Todo', [{ id: 't1', title: 'gdpr-me' }]);
    const resolver = purgeResolver('Todo', dataset);
    const res = await resolver(makeCtx(), { params: { id: 't1' } });
    expect(res).toEqual({ id: 't1', purged: true });
    // Row is gone — purge bypasses _deletedAt, so includeDeleted also sees nothing.
    const { rows: anyState } = await dataset.read('Todo', { id: 't1', includeDeleted: true });
    expect(anyState).toHaveLength(0);
  });

  it('purges a tombstoned row (admin compliance path)', async () => {
    const dataset = new MemoryDataset({ namespace: 'default' });
    await dataset.write('Todo', [{ id: 't1', title: 'tombstoned' }]);
    await dataset.tombstone('Todo', ['t1']);
    const resolver = purgeResolver('Todo', dataset);
    const res = await resolver(makeCtx(), { params: { id: 't1' } });
    expect(res).toEqual({ id: 't1', purged: true });
  });

  it('fires onWrite with pre-purge row body', async () => {
    const dataset = new MemoryDataset({ namespace: 'default' });
    await dataset.write('Todo', [{ id: 't1', title: 'fleeting' }]);
    const resolver = purgeResolver('Todo', dataset);
    const events: WriteEvent[] = [];
    await resolver(makeCtx(), { params: { id: 't1' }, onWrite: (e) => events.push(e) });
    expect(events).toHaveLength(1);
    expect(events[0]?.operation).toBe('delete');
    expect(events[0]?.row).toMatchObject({ id: 't1', title: 'fleeting' });
  });
});

describe('autocrud.purgeResolver kill-switch (SUBSTRATE_HARD_DELETE)', () => {
  useEnvSnapshot('SUBSTRATE_HARD_DELETE');

  it('throws ResolverFrameError(destructive_ops_disabled) when SUBSTRATE_HARD_DELETE=refuse', async () => {
    process.env.SUBSTRATE_HARD_DELETE = 'refuse';
    const dataset = new MemoryDataset({ namespace: 'default' });
    await dataset.write('Todo', [{ id: 't1', title: 'protected' }]);
    const resolver = purgeResolver('Todo', dataset);
    // Idiomatic Vitest: chain `.rejects` to assert both shape (frame error
    // code) and class without manually catching + casting the rejection.
    await expect(resolver(makeCtx(), { params: { id: 't1' } })).rejects.toBeInstanceOf(
      ResolverFrameError
    );
    await expect(resolver(makeCtx(), { params: { id: 't1' } })).rejects.toMatchObject({
      code: 'destructive_ops_disabled'
    });
    // Refusal short-circuits before the dataset.purge call — row is still there.
    const { rows } = await dataset.read('Todo', { id: 't1' });
    expect(rows).toHaveLength(1);
  });

  it('proceeds when SUBSTRATE_HARD_DELETE=allow', async () => {
    process.env.SUBSTRATE_HARD_DELETE = 'allow';
    const dataset = new MemoryDataset({ namespace: 'default' });
    const resolver = purgeResolver('Todo', dataset);
    const res = await resolver(makeCtx(), { params: { id: 'ghost' } });
    expect(res).toEqual({ id: 'ghost', purged: false });
  });

  it('proceeds when SUBSTRATE_HARD_DELETE is unset (default)', async () => {
    delete process.env.SUBSTRATE_HARD_DELETE;
    const dataset = new MemoryDataset({ namespace: 'default' });
    await dataset.write('Todo', [{ id: 't1', title: 'fleeting' }]);
    const resolver = purgeResolver('Todo', dataset);
    const res = await resolver(makeCtx(), { params: { id: 't1' } });
    expect(res).toEqual({ id: 't1', purged: true });
  });
});

describe('installAutoCrud — purge via engine', () => {
  function mutationNames(registry: Registry): string[] {
    const names: string[] = [];
    for (const [name, entry] of registry.all()) {
      if (entry.kind === 'mutation') names.push(name);
    }
    return names;
  }

  function ctxWithCaps(id: string, caps: string[]): RequestContext {
    return {
      identity: { id, grants: { default: caps } },
      namespace: 'default',
      operation: 'mutate',
      now: new Date('2026-04-19T00:00:00Z'),
      headers: {},
      meta: {}
    };
  }

  it('does NOT install purgeTodo by default', async () => {
    const dataset = new MemoryDataset({ namespace: 'default' });
    const edges = makeEdges();
    const registry = new Registry();
    installAutoCrud(registry, 'Todo', dataset, edges, {
      fields: { id: { kind: 'scalar', type: 'string' } }
    });
    const names = mutationNames(registry);
    expect(names).toContain('deleteTodo');
    expect(names).not.toContain('purgeTodo');
  });

  it('installs purgeTodo when { purgeable: true } with an admin-capability gate', async () => {
    const dataset = new MemoryDataset({ namespace: 'default' });
    const edges = makeEdges();
    const registry = new Registry();
    installAutoCrud(registry, 'Todo', dataset, edges, {
      fields: { id: { kind: 'scalar', type: 'string' }, title: { kind: 'scalar', type: 'string' } },
      purgeable: true
    });
    const entry = registry.get('purgeTodo');
    expect(entry).toBeDefined();
    expect(entry?.returns).toEqual({
      kind: 'struct',
      fields: {
        id: { kind: 'scalar', type: 'string' },
        purged: { kind: 'scalar', type: 'boolean' }
      }
    });
    const deny = await entry?.policy(ctxWithCaps('alice', ['user']), {});
    expect(deny).toEqual({
      allow: false,
      reason: "requireCapability(admin): not granted in namespace 'default'"
    });
    const allow = await entry?.policy(ctxWithCaps('root', ['user', 'admin']), {});
    expect(allow).toEqual({ allow: true });
  });

  it('honours options.adminCapability so deployments can rename the claim', async () => {
    const dataset = new MemoryDataset({ namespace: 'default' });
    const edges = makeEdges();
    const registry = new Registry();
    installAutoCrud(registry, 'Todo', dataset, edges, {
      fields: { id: { kind: 'scalar', type: 'string' } },
      purgeable: true,
      adminCapability: 'substrate:root'
    });
    const entry = registry.get('purgeTodo');
    const ok = await entry?.policy(ctxWithCaps('root', ['substrate:root']), {});
    expect(ok).toEqual({ allow: true });
  });

  it('composes purge policy with caller-supplied policy via and(...)', async () => {
    const dataset = new MemoryDataset({ namespace: 'default' });
    const edges = makeEdges();
    const registry = new Registry();
    const allowListPolicy: Policy = (ctx) =>
      ctx.identity?.id === 'ops-bot' ? { allow: true } : { allow: false, reason: 'not allowlist' };
    installAutoCrud(registry, 'Todo', dataset, edges, {
      fields: { id: { kind: 'scalar', type: 'string' } },
      purgeable: true,
      policy: allowListPolicy
    });
    const entry = registry.get('purgeTodo');
    // Admin capability alone is not enough — also needs the allow-list id.
    const rejected = await entry?.policy(ctxWithCaps('somebody-else', ['admin']), {});
    expect(rejected?.allow).toBe(false);
    const accepted = await entry?.policy(ctxWithCaps('ops-bot', ['admin']), {});
    expect(accepted).toEqual({ allow: true });
  });
});

describe('installAutoCrud — delete via engine', () => {
  it('deleteTodo returns { deleted: true } and tombstones the row', async () => {
    const dataset = new MemoryDataset({ namespace: 'default' });
    const edges = makeEdges();
    const registry = new Registry();
    installAutoCrud(registry, 'Todo', dataset, edges, {
      fields: {
        id: { kind: 'scalar', type: 'string' },
        title: { kind: 'scalar', type: 'string' }
      }
    });
    const datasets = new MemoryDatasetRegistry();
    datasets.set('default', dataset);
    const engine = new Engine({
      namespaces: new Map([['default', { registry }]]),
      datasets,
      edges
    });

    await engine.mutate({
      frame: { 'default/createTodo': { params: { id: 't1', title: 'delete-me' } } },
      ctx: makeCtx()
    });

    const res = await engine.mutate({
      frame: { 'default/deleteTodo': { params: { id: 't1' } } },
      ctx: makeCtx()
    });
    expect(res.data['default/deleteTodo']).toEqual({ id: 't1', deleted: true });
    expect(res.errors).toBeUndefined();

    const got = await engine.query({
      frame: { 'default/getTodo': { params: { id: 't1' } } },
      ctx: makeCtx()
    });
    expect(got.data['default/getTodo']).toBeNull();
  });

  it('deleteTodo surfaces RestrictViolation as an envelope error; row is not tombstoned', async () => {
    const dataset = new MemoryDataset({ namespace: 'default' });
    const edges = makeEdges();
    const registry = new Registry();
    installAutoCrud(registry, 'Todo', dataset, edges, {
      fields: {
        id: { kind: 'scalar', type: 'string' },
        title: { kind: 'scalar', type: 'string' }
      }
    });
    const datasets = new MemoryDatasetRegistry();
    datasets.set('default', dataset);
    const engine = new Engine({
      namespaces: new Map([['default', { registry }]]),
      datasets,
      edges
    });

    await engine.mutate({
      frame: { 'default/createTodo': { params: { id: 't1', title: 'stuck' } } },
      ctx: makeCtx()
    });
    await edges.write({
      from: { ns: 'default', type: 'RestrictTag', id: 'rt1' },
      to: { ns: 'default', type: 'Todo', id: 't1' },
      fieldName: 'todoId',
      policy: 'restrict'
    });

    const res = await engine.mutate({
      frame: { 'default/deleteTodo': { params: { id: 't1' } } },
      ctx: makeCtx()
    });
    expect(res.errors).toBeDefined();
    expect(res.errors?.[0]?.code).toBe('restrict_violation');
    // Row remains live — Phase 0 refused before Phase 1 could fire.
    const got = await engine.query({
      frame: { 'default/getTodo': { params: { id: 't1' } } },
      ctx: makeCtx()
    });
    expect(got.data['default/getTodo']).toMatchObject({ id: 't1', title: 'stuck' });
  });
});

describe('autocrud.updateResolver (direct-call)', () => {
  it('throws when params.id is missing', async () => {
    const dataset = new MemoryDataset({ namespace: 'default' });
    const resolver = updateResolver('Todo', dataset, makeEdges());
    await expect(resolver(makeCtx(), {})).rejects.toThrow(/params\.id is required/);
  });

  it('REPORTS an id that matched nothing, rather than no-opping silently', async () => {
    // A null result beside an empty `errors` reads exactly like a successful
    // write, so a miss must throw. `get` still returns null for a missing row:
    // asking about an absent row has a true answer; writing to one does not.
    const dataset = new MemoryDataset({ namespace: 'default' });
    const resolver = updateResolver('Todo', dataset, makeEdges());
    await expect(
      resolver(makeCtx(), { params: { id: 'missing', title: 'x' } })
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('updates fields and returns the merged row', async () => {
    const dataset = new MemoryDataset({ namespace: 'default' });
    await dataset.write('Todo', [{ id: 't1', title: 'orig', done: false }]);
    const resolver = updateResolver('Todo', dataset, makeEdges());
    const res = await resolver(makeCtx(), {
      params: { id: 't1', title: 'new', done: true }
    });
    expect(res).toMatchObject({ id: 't1', title: 'new', done: true });
  });

  it('reports not_found and re-creates nothing when the row is purged mid-update', async () => {
    const dataset = new MemoryDataset({ namespace: 'default' });
    await dataset.write('Todo', [{ id: 't1', title: 'orig', done: false }]);
    // The purge lands after the resolver has resolved the id.
    const racing = Object.create(dataset) as MemoryDataset;
    racing.read = async (type, params) => {
      const res = await dataset.read(type, params);
      await dataset.purge('Todo', ['t1']);
      return res;
    };
    const resolver = updateResolver('Todo', racing, makeEdges());
    await expect(resolver(makeCtx(), { params: { id: 't1', title: 'new' } })).rejects.toMatchObject(
      { code: 'not_found' }
    );
    expect((await dataset.read('Todo', { id: 't1', includeDeleted: true })).rows).toEqual([]);
  });

  it('surfaces ReservedField when _deletedAt appears in params', async () => {
    const dataset = new MemoryDataset({ namespace: 'default' });
    await dataset.write('Todo', [{ id: 't1', title: 'a' }]);
    const resolver = updateResolver('Todo', dataset, makeEdges());
    await expect(
      resolver(makeCtx(), { params: { id: 't1', _deletedAt: new Date() } })
    ).rejects.toThrow(/reserved/);
  });
});

describe('installAutoCrud — update via engine', () => {
  it('updateTodo updates the row and returns it; getTodo reflects the change', async () => {
    const dataset = new MemoryDataset({ namespace: 'default' });
    const edges = makeEdges();
    const registry = new Registry();
    installAutoCrud(registry, 'Todo', dataset, edges, {
      fields: {
        id: { kind: 'scalar', type: 'string' },
        title: { kind: 'scalar', type: 'string' },
        done: { kind: 'scalar', type: 'boolean' }
      }
    });
    const datasets = new MemoryDatasetRegistry();
    datasets.set('default', dataset);
    const engine = new Engine({
      namespaces: new Map([['default', { registry }]]),
      datasets,
      edges
    });

    await engine.mutate({
      frame: { 'default/createTodo': { params: { id: 't1', title: 'orig', done: false } } },
      ctx: makeCtx()
    });

    const up = await engine.mutate({
      frame: { 'default/updateTodo': { params: { id: 't1', title: 'updated', done: true } } },
      ctx: makeCtx()
    });
    expect(up.data['default/updateTodo']).toMatchObject({
      id: 't1',
      title: 'updated',
      done: true
    });

    const got = await engine.query({
      frame: { 'default/getTodo': { params: { id: 't1' } } },
      ctx: makeCtx()
    });
    expect(got.data['default/getTodo']).toMatchObject({ id: 't1', title: 'updated', done: true });
  });

  it('updateTodo is transactional — mid-update failure rolls back prior field writes', async () => {
    const dataset = new MemoryDataset({ namespace: 'default' });
    const edges = makeEdges();
    const registry = new Registry();
    installAutoCrud(registry, 'Todo', dataset, edges, {
      fields: {
        id: { kind: 'scalar', type: 'string' },
        title: { kind: 'scalar', type: 'string' }
      }
    });
    const datasets = new MemoryDatasetRegistry();
    datasets.set('default', dataset);
    const engine = new Engine({
      namespaces: new Map([['default', { registry }]]),
      datasets,
      edges
    });

    await engine.mutate({
      frame: { 'default/createTodo': { params: { id: 't1', title: 'orig' } } },
      ctx: makeCtx()
    });

    // Frame pairs updateTodo with a synthetic throw. The update's field write
    // landed inside the tx; the throw unwinds the whole frame — orig should
    // survive.
    registry.register('boom', {
      resolver: async () => {
        throw new Error('frame-level failure');
      }
    });

    await expect(
      engine.mutate({
        frame: {
          'default/updateTodo': { params: { id: 't1', title: 'mutated' } },
          'default/boom': {}
        },
        ctx: makeCtx()
      })
    ).rejects.toThrow('frame-level failure');

    const {
      rows: [row]
    } = await dataset.read('Todo', { id: 't1' });
    expect(row?.title).toBe('orig');
  });

  it('schemaFor exposes updateTodo as a mutation', () => {
    const dataset = new MemoryDataset({ namespace: 'default' });
    const edges = makeEdges();
    const registry = new Registry();
    installAutoCrud(registry, 'Todo', dataset, edges, {
      fields: { id: { kind: 'scalar', type: 'string' } }
    });
    const datasets = new MemoryDatasetRegistry();
    datasets.set('default', dataset);
    const engine = new Engine({
      namespaces: new Map([['default', { registry }]]),
      datasets,
      edges
    });
    const schema = engine.schemaFor('default');
    expect(schema.mutations.updateTodo).toBeDefined();
  });
});

describe('installAutoCrud — mutation schema metadata (params + returns)', () => {
  function buildEngine(): Engine {
    const dataset = new MemoryDataset({ namespace: 'default' });
    const edges = makeEdges();
    const registry = new Registry();
    installAutoCrud(registry, 'Todo', dataset, edges, {
      fields: {
        id: { kind: 'scalar', type: 'string' },
        title: { kind: 'scalar', type: 'string' },
        done: { kind: 'scalar', type: 'boolean' }
      }
    });
    const datasets = new MemoryDatasetRegistry();
    datasets.set('default', dataset);
    return new Engine({
      namespaces: new Map([['default', { registry }]]),
      datasets,
      edges
    });
  }

  it('getTodo declares params.id as a scalar and returns a nullable struct', () => {
    const schema = buildEngine().schemaFor('default');
    const get = schema.mutations.getTodo;
    expect(get).toBeDefined();
    expect(get?.params.id).toEqual({ kind: 'scalar', type: 'string' });
    expect(get?.returns.kind).toBe('struct');
    if (get?.returns.kind === 'struct') {
      expect(get.returns.nullable).toBe(true);
      expect(get.returns.fields.title).toEqual({ kind: 'scalar', type: 'string' });
    }
  });

  it('createTodo params mirror the type fields; returns is a non-nullable struct', () => {
    const schema = buildEngine().schemaFor('default');
    const create = schema.mutations.createTodo;
    expect(create).toBeDefined();
    expect(create?.params.title).toEqual({ kind: 'scalar', type: 'string' });
    expect(create?.params.done).toEqual({ kind: 'scalar', type: 'boolean' });
    expect(create?.returns.kind).toBe('struct');
    if (create?.returns.kind === 'struct') {
      expect(create.returns.nullable).toBeFalsy();
    }
  });

  it('updateTodo returns a nullable struct (id-miss surfaces as null)', () => {
    const schema = buildEngine().schemaFor('default');
    const update = schema.mutations.updateTodo;
    expect(update).toBeDefined();
    expect(update?.params.id).toEqual({ kind: 'scalar', type: 'string' });
    expect(update?.returns.kind).toBe('struct');
    if (update?.returns.kind === 'struct') {
      expect(update.returns.nullable).toBe(true);
    }
  });

  it('deleteTodo returns { id, deleted } — not the type field map', () => {
    const schema = buildEngine().schemaFor('default');
    const del = schema.mutations.deleteTodo;
    expect(del).toBeDefined();
    expect(del?.params.id).toEqual({ kind: 'scalar', type: 'string' });
    expect(del?.returns.kind).toBe('struct');
    if (del?.returns.kind === 'struct') {
      expect(del.returns.fields.deleted).toEqual({ kind: 'scalar', type: 'boolean' });
      expect(del.returns.fields.id).toEqual({ kind: 'scalar', type: 'string' });
      // The type's `title` / `done` fields should NOT leak into delete's return shape.
      expect(del.returns.fields.title).toBeUndefined();
    }
  });
});

describe('autocrud resolvers — onWrite emission (§5.4)', () => {
  it('createResolver calls onWrite with operation=create + the committed row', async () => {
    const dataset = new MemoryDataset({ namespace: 'default' });
    const resolver = createResolver('Todo', dataset);
    const events: WriteEvent[] = [];
    await resolver(makeCtx(), {
      params: { id: 't1', title: 'a', done: false },
      onWrite: (e) => events.push(e)
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      ns: 'default',
      type: 'Todo',
      id: 't1',
      operation: 'create'
    });
    expect(events[0]?.row).toMatchObject({ id: 't1', title: 'a', done: false });
  });

  it('updateResolver calls onWrite with operation=update and merged row', async () => {
    const dataset = new MemoryDataset({ namespace: 'default' });
    await dataset.write('Todo', [{ id: 't1', title: 'orig', done: false }]);
    const resolver = updateResolver('Todo', dataset, makeEdges());
    const events: WriteEvent[] = [];
    await resolver(makeCtx(), {
      params: { id: 't1', title: 'new' },
      onWrite: (e) => events.push(e)
    });
    expect(events).toHaveLength(1);
    expect(events[0]?.operation).toBe('update');
    expect(events[0]?.row).toMatchObject({ id: 't1', title: 'new' });
  });

  it('updateResolver does NOT emit onWrite when the target id is missing', async () => {
    const dataset = new MemoryDataset({ namespace: 'default' });
    const resolver = updateResolver('Todo', dataset, makeEdges());
    // A miss must not look like a write to downstream side effects: onWrite
    // stays silent, or an embedding/audit hook would fire for an untouched row.
    const events: WriteEvent[] = [];
    await expect(
      resolver(makeCtx(), {
        params: { id: 'missing', title: 'x' },
        onWrite: (e) => events.push(e)
      })
    ).rejects.toMatchObject({ code: 'not_found' });
    expect(events).toHaveLength(0);
  });

  it('deleteResolver calls onWrite with operation=delete + pre-tombstone row', async () => {
    const dataset = new MemoryDataset({ namespace: 'default' });
    const edges = makeEdges();
    await dataset.write('Todo', [{ id: 't1', title: 'pre-delete' }]);
    const resolver = deleteResolver('Todo', dataset, edges);
    const events: WriteEvent[] = [];
    await resolver(makeCtx(), { params: { id: 't1' }, onWrite: (e) => events.push(e) });
    expect(events).toHaveLength(1);
    expect(events[0]?.operation).toBe('delete');
    expect(events[0]?.id).toBe('t1');
    expect(events[0]?.row).toMatchObject({ id: 't1', title: 'pre-delete' });
  });

  it('deleteResolver does NOT emit onWrite when the target id does not exist', async () => {
    const dataset = new MemoryDataset({ namespace: 'default' });
    const edges = makeEdges();
    const resolver = deleteResolver('Todo', dataset, edges);
    const events: WriteEvent[] = [];
    await resolver(makeCtx(), { params: { id: 'ghost' }, onWrite: (e) => events.push(e) });
    expect(events).toHaveLength(0);
  });

  it('resolvers tolerate a missing onWrite — no crash, no side effects', async () => {
    const dataset = new MemoryDataset({ namespace: 'default' });
    const edges = makeEdges();
    await dataset.write('Todo', [{ id: 't1', title: 'x' }]);
    await expect(
      createResolver('Todo', dataset)(makeCtx(), { params: { id: 't2', title: 'y' } })
    ).resolves.toBeDefined();
    await expect(
      updateResolver('Todo', dataset, makeEdges())(makeCtx(), { params: { id: 't1', title: 'z' } })
    ).resolves.toBeDefined();
    await expect(
      deleteResolver('Todo', dataset, edges)(makeCtx(), { params: { id: 't1' } })
    ).resolves.toMatchObject({ deleted: true });
  });
});

describe('autoCRUD get/update/delete — shortId resolution (Task 10)', () => {
  const FIELDS_WITH_SHORT_ID: Record<string, FieldDef> = {
    id: { kind: 'scalar', type: 'string' },
    title: { kind: 'scalar', type: 'string' },
    shortId: { kind: 'scalar', type: 'number', readonly: true }
  };

  function buildShortIdEngine(): { engine: Engine; dataset: MemoryDataset } {
    const dataset = new MemoryDataset({ namespace: 'app' });
    const edges = new MemoryEdgesStore({ now: () => new Date('2026-04-20T00:00:00Z') });
    const registry = new Registry();
    installAutoCrud(registry, 'Todo', dataset, edges, { fields: FIELDS_WITH_SHORT_ID });
    const datasets = new MemoryDatasetRegistry();
    datasets.set('app', dataset);
    const engine = new Engine({
      namespaces: new Map<string, NamespaceConfig>([['app', { registry }]]),
      datasets,
      edges
    });
    return { engine, dataset };
  }

  function ctxForApp(operation: 'query' | 'mutate' = 'mutate'): RequestContext {
    return {
      identity: { kind: 'system', id: 'test', grants: { '*': ['read', 'mutate'] } },
      namespace: 'app',
      operation,
      now: new Date('2026-04-20T00:00:00Z'),
      headers: {},
      meta: {}
    };
  }

  it('get resolves a short-form id to the UUID row', async () => {
    const { engine } = buildShortIdEngine();

    const created = await engine.mutate({
      frame: {
        'app/createTodo': { params: { title: 'short-get' }, fields: { id: true, shortId: true } }
      },
      ctx: ctxForApp()
    });
    expect(created.errors).toBeUndefined();
    const { id: uuid, shortId } = created.data['app/createTodo'] as {
      id: string;
      shortId: number;
    };

    // Query using string-form shortId (e.g. "1")
    const got = await engine.query({
      frame: {
        'app/getTodo': {
          params: { id: String(shortId) },
          fields: { id: true, title: true }
        }
      },
      ctx: ctxForApp('query')
    });
    expect(got.errors).toBeUndefined();
    const row = got.data['app/getTodo'] as { id: string; title: string };
    expect(row.id).toBe(uuid);
    expect(row.title).toBe('short-get');
  });

  it('get with a raw UUID id still works (no regression)', async () => {
    const { engine } = buildShortIdEngine();

    const created = await engine.mutate({
      frame: {
        'app/createTodo': { params: { title: 'raw-get' }, fields: { id: true } }
      },
      ctx: ctxForApp()
    });
    const { id: uuid } = created.data['app/createTodo'] as { id: string };

    const got = await engine.query({
      frame: { 'app/getTodo': { params: { id: uuid }, fields: { id: true, title: true } } },
      ctx: ctxForApp('query')
    });
    expect(got.errors).toBeUndefined();
    expect((got.data['app/getTodo'] as { id: string }).id).toBe(uuid);
  });

  it('get returns null when neither raw nor short-form resolves', async () => {
    const { engine } = buildShortIdEngine();

    const got = await engine.query({
      frame: { 'app/getTodo': { params: { id: '99999' }, fields: { id: true } } },
      ctx: ctxForApp('query')
    });
    expect(got.errors).toBeUndefined();
    expect(got.data['app/getTodo']).toBeNull();
  });

  it('update resolves a short-form id and applies field changes', async () => {
    const { engine } = buildShortIdEngine();

    const created = await engine.mutate({
      frame: {
        'app/createTodo': { params: { title: 'original' }, fields: { id: true, shortId: true } }
      },
      ctx: ctxForApp()
    });
    expect(created.errors).toBeUndefined();
    const { id: uuid, shortId } = created.data['app/createTodo'] as {
      id: string;
      shortId: number;
    };

    const updated = await engine.mutate({
      frame: {
        'app/updateTodo': {
          params: { id: String(shortId), title: 'updated' },
          fields: { id: true, title: true }
        }
      },
      ctx: ctxForApp()
    });
    expect(updated.errors).toBeUndefined();
    const row = updated.data['app/updateTodo'] as { id: string; title: string };
    expect(row.id).toBe(uuid);
    expect(row.title).toBe('updated');
  });

  it('update REPORTS in errors when neither raw nor short-form resolves', async () => {
    const { engine } = buildShortIdEngine();

    const updated = await engine.mutate({
      frame: {
        'app/updateTodo': {
          params: { id: '99999999', title: 'nope' },
          fields: { id: true }
        }
      },
      ctx: ctxForApp()
    });
    // A rejected frame comes back with its key ABSENT from `data` and the
    // reason in `errors`; a null in `data` beside an empty `errors` reads as
    // success. Envelope-level counterpart to the direct resolver tests.
    expect('app/updateTodo' in updated.data).toBe(false);
    expect(updated.errors?.some((e) => e.code === 'not_found')).toBe(true);
  });

  it('delete resolves a short-form id and tombstones the row', async () => {
    const { engine, dataset } = buildShortIdEngine();

    const created = await engine.mutate({
      frame: {
        'app/createTodo': { params: { title: 'to-delete' }, fields: { id: true, shortId: true } }
      },
      ctx: ctxForApp()
    });
    expect(created.errors).toBeUndefined();
    const { id: uuid, shortId } = created.data['app/createTodo'] as {
      id: string;
      shortId: number;
    };

    const deleted = await engine.mutate({
      frame: {
        'app/deleteTodo': {
          params: { id: String(shortId) },
          fields: { id: true, deleted: true }
        }
      },
      ctx: ctxForApp()
    });
    expect(deleted.errors).toBeUndefined();
    const res = deleted.data['app/deleteTodo'] as { id: string; deleted: boolean };
    expect(res.deleted).toBe(true);
    expect(res.id).toBe(uuid);

    // Row is gone from live reads
    const { rows } = await dataset.read('Todo', { id: uuid });
    expect(rows).toHaveLength(0);
  });

  it('delete returns { deleted: false } when neither raw nor short-form resolves', async () => {
    const { engine } = buildShortIdEngine();

    const deleted = await engine.mutate({
      frame: {
        'app/deleteTodo': {
          params: { id: '99999999' },
          fields: { id: true, deleted: true }
        }
      },
      ctx: ctxForApp()
    });
    expect(deleted.errors).toBeUndefined();
    expect((deleted.data['app/deleteTodo'] as { deleted: boolean }).deleted).toBe(false);
  });
});

describe('autoCRUD list — shortId projection + where filters (Task 11)', () => {
  const FIELDS_WITH_SHORT_ID: Record<string, FieldDef> = {
    id: { kind: 'scalar', type: 'string' },
    title: { kind: 'scalar', type: 'string' },
    // indexed: true is required for where.shortId filters to pass the validator
    shortId: { kind: 'scalar', type: 'number', readonly: true, indexed: true }
  };

  function buildShortIdEngine(): { engine: Engine; dataset: MemoryDataset } {
    const dataset = new MemoryDataset({ namespace: 'app' });
    const edges = new MemoryEdgesStore({ now: () => new Date('2026-04-20T00:00:00Z') });
    const registry = new Registry();
    installAutoCrud(registry, 'Todo', dataset, edges, { fields: FIELDS_WITH_SHORT_ID });
    const datasets = new MemoryDatasetRegistry();
    datasets.set('app', dataset);
    const engine = new Engine({
      namespaces: new Map<string, NamespaceConfig>([['app', { registry }]]),
      datasets,
      edges
    });
    return { engine, dataset };
  }

  function ctxForApp(operation: 'query' | 'mutate' = 'mutate'): RequestContext {
    return {
      identity: { kind: 'system', id: 'test', grants: { '*': ['read', 'mutate'] } },
      namespace: 'app',
      operation,
      now: new Date('2026-04-20T00:00:00Z'),
      headers: {},
      meta: {}
    };
  }

  async function create(
    engine: Engine,
    params: { title: string }
  ): Promise<{ id: string; shortId: number; title: string }> {
    const r = await engine.mutate({
      frame: {
        'app/createTodo': { params, fields: { id: true, shortId: true, title: true } }
      },
      ctx: ctxForApp()
    });
    expect(r.errors).toBeUndefined();
    return r.data['app/createTodo'] as { id: string; shortId: number; title: string };
  }

  async function list(
    engine: Engine,
    params: { where?: Record<string, unknown> } = {}
  ): Promise<Array<{ id: string; shortId: number; title: string }>> {
    const r = await engine.query({
      frame: {
        'app/Todo': {
          params,
          fields: { id: true, shortId: true, title: true }
        }
      },
      ctx: ctxForApp('query')
    });
    expect(r.errors).toBeUndefined();
    return r.data['app/Todo'] as Array<{ id: string; shortId: number; title: string }>;
  }

  it('includes shortId in list results', async () => {
    const { engine } = buildShortIdEngine();
    await create(engine, { title: 'first' });
    await create(engine, { title: 'second' });

    const rows = await list(engine);
    expect(rows.length).toBe(2);
    for (const row of rows) {
      expect(typeof row.shortId).toBe('number');
      expect(row.shortId).toBeGreaterThanOrEqual(1);
    }
  });

  it('filters by shortId.eq', async () => {
    const { engine } = buildShortIdEngine();
    await create(engine, { title: 'a' });
    const c2 = await create(engine, { title: 'b' });
    await create(engine, { title: 'c' });

    const rows = await list(engine, { where: { shortId: { eq: c2.shortId } } });
    expect(rows.length).toBe(1);
    expect(rows[0]?.id).toBe(c2.id);
  });

  it('filters by shortId.in', async () => {
    const { engine } = buildShortIdEngine();
    const c1 = await create(engine, { title: 'a' });
    await create(engine, { title: 'b' });
    const c3 = await create(engine, { title: 'c' });

    const rows = await list(engine, { where: { shortId: { in: [c1.shortId, c3.shortId] } } });
    expect(rows.map((r) => r.shortId).sort((a, b) => a - b)).toEqual([1, 3]);
  });

  it('filters by shortId range (gte + lt)', async () => {
    const { engine } = buildShortIdEngine();
    await create(engine, { title: 'a' }); // shortId 1
    await create(engine, { title: 'b' }); // shortId 2
    await create(engine, { title: 'c' }); // shortId 3
    await create(engine, { title: 'd' }); // shortId 4
    await create(engine, { title: 'e' }); // shortId 5

    const rows = await list(engine, { where: { shortId: { gte: 2, lt: 5 } } });
    expect(rows.map((r) => r.shortId).sort((a, b) => a - b)).toEqual([2, 3, 4]);
  });

  it('filters by shortId.neq', async () => {
    const { engine } = buildShortIdEngine();
    await create(engine, { title: 'a' }); // shortId 1
    await create(engine, { title: 'b' }); // shortId 2
    await create(engine, { title: 'c' }); // shortId 3

    const rows = await list(engine, { where: { shortId: { neq: 2 } } });
    expect(rows.map((r) => r.shortId).sort((a, b) => a - b)).toEqual([1, 3]);
  });

  it('filters by shortId.gt', async () => {
    const { engine } = buildShortIdEngine();
    await create(engine, { title: 'a' }); // shortId 1
    await create(engine, { title: 'b' }); // shortId 2
    await create(engine, { title: 'c' }); // shortId 3

    const rows = await list(engine, { where: { shortId: { gt: 1 } } });
    expect(rows.map((r) => r.shortId).sort((a, b) => a - b)).toEqual([2, 3]);
  });

  it('filters by shortId.lte', async () => {
    const { engine } = buildShortIdEngine();
    await create(engine, { title: 'a' }); // shortId 1
    await create(engine, { title: 'b' }); // shortId 2
    await create(engine, { title: 'c' }); // shortId 3

    const rows = await list(engine, { where: { shortId: { lte: 2 } } });
    expect(rows.map((r) => r.shortId).sort((a, b) => a - b)).toEqual([1, 2]);
  });

  it('returns empty array when no rows match shortId.eq', async () => {
    const { engine } = buildShortIdEngine();
    await create(engine, { title: 'a' });

    const rows = await list(engine, { where: { shortId: { eq: 9999 } } });
    expect(rows.length).toBe(0);
  });
});

describe('autoCRUD verb stamping', () => {
  it('stamps get/create/update/delete verbs; purge stamps delete; type entry has none', () => {
    const dataset = new MemoryDataset({ namespace: 'default' });
    const edges = makeEdges();
    const registry = new Registry();
    installAutoCrud(registry, 'Todo', dataset, edges, { purgeable: true });
    expect(registry.get('getTodo')?.verb).toBe('get');
    expect(registry.get('createTodo')?.verb).toBe('create');
    expect(registry.get('updateTodo')?.verb).toBe('update');
    expect(registry.get('deleteTodo')?.verb).toBe('delete');
    expect(registry.get('purgeTodo')?.verb).toBe('delete');
    expect(registry.get('Todo')?.verb).toBeUndefined();
  });
});

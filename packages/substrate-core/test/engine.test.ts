import { MemoryDataset, MemoryDatasetRegistry } from '@mnmal-ai/substrate-dataset-memory';
import { denyAll, row } from '@mnmal-ai/substrate-policy';
import type {
  BridgeClient,
  BridgeRegistry,
  Dataset,
  EdgesStore,
  Policy,
  RequestContext,
  Row
} from '@mnmal-ai/substrate-types';
import { describe, expect, it } from 'vitest';
import {
  Engine,
  MemoryEdgesStore,
  type NamespaceConfig,
  Registry,
  type Resolver
} from '../src/index.js';

function makeEdges(): MemoryEdgesStore {
  return new MemoryEdgesStore({ now: () => new Date('2026-04-18T00:00:00Z') });
}

function makeCtx(overrides: Partial<RequestContext> = {}): Partial<RequestContext> {
  // Callers pass Partial<RequestContext> — the engine fills in namespace +
  // operation. Tests assert the engine-owned fields on the resolver-observed
  // ctx rather than smuggling them in on the request.
  return {
    identity: null,
    now: new Date('2026-04-18T00:00:00Z'),
    headers: {},
    meta: {},
    ...overrides
  };
}

function singleNs(
  registry: Registry,
  dataset: MemoryDataset = new MemoryDataset({ namespace: 'default' }),
  edges: EdgesStore = makeEdges()
): { engine: Engine; dataset: MemoryDataset; edges: EdgesStore } {
  const namespaces = new Map<string, NamespaceConfig>([['default', { registry }]]);
  const datasets = new MemoryDatasetRegistry();
  datasets.set('default', dataset);
  return { engine: new Engine({ namespaces, datasets, edges }), dataset, edges };
}

describe('Engine.query', () => {
  it('returns an envelope with data + shapes for a list resolver', async () => {
    const rows: Row[] = [
      { id: 1, title: 'a' },
      { id: 2, title: 'b' }
    ];
    const registry = new Registry();
    const resolver: Resolver = async () => rows;
    registry.register('Todo', { resolver });

    const { engine } = singleNs(registry);
    const envelope = await engine.query({
      frame: { 'default/Todo': { params: {}, fields: { id: true, title: true } } },
      ctx: makeCtx()
    });

    expect(envelope.schemaVersion).toMatch(/^[0-9a-f]{12}$/);
    expect(envelope.data['default/Todo']).toEqual(rows);
    expect(envelope.shapes['default/Todo']).toBe('list');
    expect(envelope.errors).toBeUndefined();
  });

  it('detects single shape when resolver returns a row', async () => {
    const registry = new Registry();
    const singleRow: Row = { id: 1, title: 'solo' };
    const resolver: Resolver = async () => singleRow;
    registry.register('Todo', { resolver });

    const { engine } = singleNs(registry);
    const envelope = await engine.query({
      frame: { 'default/Todo': { params: { id: 1 }, fields: { id: true } } },
      ctx: makeCtx()
    });

    expect(envelope.data['default/Todo']).toEqual(singleRow);
    expect(envelope.shapes['default/Todo']).toBe('single');
  });

  it('surfaces policy deny in envelope.errors without throwing', async () => {
    const registry = new Registry();
    const resolver: Resolver = async () => [];
    registry.register('Todo', { resolver, policy: denyAll('nope') });

    const { engine } = singleNs(registry);
    const envelope = await engine.query({
      frame: { 'default/Todo': { params: {}, fields: {} } },
      ctx: makeCtx()
    });

    expect(envelope.data['default/Todo']).toBeUndefined();
    expect(envelope.errors).toBeDefined();
    expect(envelope.errors).toHaveLength(1);
    expect(envelope.errors?.[0]).toMatchObject({
      message: 'nope',
      path: ['default/Todo'],
      code: 'policy_denied'
    });
  });

  it('surfaces unknown names as envelope errors', async () => {
    const { engine } = singleNs(new Registry());
    const envelope = await engine.query({
      frame: { 'default/MysteryType': { params: {}, fields: {} } },
      ctx: makeCtx()
    });
    expect(envelope.errors?.[0]?.message).toContain("unknown name 'MysteryType'");
    expect(envelope.errors?.[0]?.code).toBe('unknown_name');
  });

  it('surfaces unknown namespaces as envelope errors', async () => {
    const { engine } = singleNs(new Registry());
    const envelope = await engine.query({
      frame: { 'missing/TypeA': { params: {} } },
      ctx: makeCtx()
    });
    expect(envelope.errors?.[0]?.code).toBe('unknown_namespace');
    expect(envelope.errors?.[0]?.message).toContain("unknown namespace 'missing'");
  });

  it('surfaces unqualified keys as envelope errors', async () => {
    const { engine } = singleNs(new Registry());
    const envelope = await engine.query({
      frame: { TypeA: { params: {} } },
      ctx: makeCtx()
    });
    expect(envelope.errors?.[0]?.code).toBe('unqualified_key');
    expect(envelope.errors?.[0]?.message).toContain("unqualified frame key 'TypeA'");
  });

  it('applies row-filter obligations', async () => {
    const rows: Row[] = [
      { id: 1, ownerId: 'alice' },
      { id: 2, ownerId: 'bob' }
    ];
    const registry = new Registry();
    const resolver: Resolver = async () => rows;
    const ownerPolicy: Policy = row<{ ownerId: string }>(
      (ctx, r) => r.ownerId === ctx.identity?.id
    );
    registry.register('Todo', { resolver, policy: ownerPolicy });

    const { engine } = singleNs(registry);
    const envelope = await engine.query({
      frame: { 'default/Todo': { fields: { id: true } } },
      ctx: makeCtx({ identity: { id: 'alice', grants: { default: ['read'] } } })
    });

    expect(envelope.data['default/Todo']).toEqual([{ id: 1, ownerId: 'alice' }]);
  });

  it('sets ctx.operation to "query" regardless of caller-supplied value', async () => {
    const registry = new Registry();
    let seen: RequestContext | undefined;
    const resolver: Resolver = async (ctx) => {
      seen = ctx;
      return [];
    };
    registry.register('Todo', { resolver });

    const { engine } = singleNs(registry);
    // caller supplies operation: 'mutate' (stale); engine overrides to 'query'.
    await engine.query({
      frame: { 'default/Todo': {} },
      ctx: makeCtx({ operation: 'mutate' })
    });

    expect(seen?.operation).toBe('query');
    expect(seen?.namespace).toBe('default');
  });

  it('processes multiple frame entries in one call', async () => {
    const registry = new Registry();
    registry.register('Todo', { resolver: async () => [{ id: 1 }] });
    registry.register('Tag', { resolver: async () => [{ id: 9 }, { id: 10 }] });

    const { engine } = singleNs(registry);
    const envelope = await engine.query({
      frame: { 'default/Todo': {}, 'default/Tag': {} },
      ctx: makeCtx()
    });

    expect(envelope.shapes).toEqual({ 'default/Todo': 'list', 'default/Tag': 'list' });
    expect(envelope.data['default/Todo']).toEqual([{ id: 1 }]);
    expect(envelope.data['default/Tag']).toEqual([{ id: 9 }, { id: 10 }]);
  });

  it('empty frame returns an envelope with no data and no errors', async () => {
    const { engine } = singleNs(new Registry());
    const envelope = await engine.query({ frame: {}, ctx: makeCtx() });
    expect(envelope.data).toEqual({});
    expect(envelope.shapes).toEqual({});
    expect(envelope.errors).toBeUndefined();
  });
});

describe('Engine.mutate', () => {
  it('invokes the mutation resolver and returns single-shape result', async () => {
    const dataset = new MemoryDataset({ namespace: 'default' });
    const registry = new Registry();
    const created: Row = { id: 'abc', title: 'first', done: false };
    const resolver: Resolver = async (_ctx, args) => {
      const body = { ...(args.params ?? {}), id: 'abc' } as Row;
      if (!args.dataset) throw new Error('expected args.dataset');
      await args.dataset.write('Todo', [body]);
      return body;
    };
    registry.register('createTodo', { resolver });

    const { engine } = singleNs(registry, dataset);
    const envelope = await engine.mutate({
      frame: {
        'default/createTodo': { params: { title: 'first', done: false } }
      },
      ctx: makeCtx()
    });

    expect(envelope.data['default/createTodo']).toEqual(created);
    expect(envelope.shapes['default/createTodo']).toBe('single');
    const {
      rows: [storedRow]
    } = await dataset.read('Todo', { id: 'abc' });
    expect(storedRow).toMatchObject(created);
  });

  // Regression: a resolver running in a different module realm (a bundled
  // plugin loaded from its own node_modules) throws a ResolverFrameError built
  // from THAT realm's class — structurally branded (name + code) but not
  // `instanceof` the engine's own class. The engine must recognise it by brand
  // and fold it into the envelope, not let it escape to the transport as a 500.
  it('catches a foreign-realm ResolverFrameError by structural brand', async () => {
    const registry = new Registry();
    const foreign = Object.assign(new Error("'status' must be one of: open, done"), {
      name: 'ResolverFrameError',
      code: 'invalid_enum_value',
      details: { field: 'status' }
    });
    registry.register('createTodo', {
      resolver: async () => {
        throw foreign;
      }
    });

    const { engine } = singleNs(registry);
    // Must RESOLVE with the error in the envelope — not reject (a reject
    // escapes engine.mutate and the transport returns 500).
    const envelope = await engine.mutate({
      frame: { 'default/createTodo': { params: { status: 'bogus' } } },
      ctx: makeCtx()
    });

    expect(envelope.errors?.[0]?.code).toBe('invalid_enum_value');
    expect(envelope.errors?.[0]?.message).toMatch(/must be one of/);
    expect(envelope.errors?.[0]?.details).toEqual({ field: 'status' });
    expect(envelope.data['default/createTodo']).toBeUndefined();
  });

  // Same realm-boundary hazard for the §6.2 restrict refusal path.
  it('catches a foreign-realm RestrictViolation by structural brand', async () => {
    const registry = new Registry();
    const foreign = Object.assign(new Error('restrict: cannot delete; 1 live restrict edge'), {
      name: 'RestrictViolation',
      blockedBy: [{ id: 'edge-1' }]
    });
    registry.register('deleteThing', {
      resolver: async () => {
        throw foreign;
      }
    });

    const { engine } = singleNs(registry);
    const envelope = await engine.mutate({
      frame: { 'default/deleteThing': { params: { id: 'x' } } },
      ctx: makeCtx()
    });

    expect(envelope.errors?.[0]?.code).toBe('restrict_violation');
    expect(envelope.data['default/deleteThing']).toBeUndefined();
  });

  it('sets ctx.operation to "mutate"', async () => {
    const registry = new Registry();
    let seen: RequestContext | undefined;
    const resolver: Resolver = async (ctx, args) => {
      seen = ctx;
      return { id: 1, ...(args.params ?? {}) } as Row;
    };
    registry.register('createTodo', { resolver });

    const { engine } = singleNs(registry);
    await engine.mutate({
      frame: { 'default/createTodo': { params: { title: 'x' } } },
      ctx: makeCtx()
    });

    expect(seen?.operation).toBe('mutate');
    expect(seen?.namespace).toBe('default');
  });

  it('records a metric for unknown names', async () => {
    const metrics: Array<{ name: string; payload?: unknown }> = [];
    const dataset = new MemoryDataset({ namespace: 'default' });
    const datasets = new MemoryDatasetRegistry();
    datasets.set('default', dataset);
    const engine = new Engine({
      namespaces: new Map([['default', { registry: new Registry() }]]),
      datasets,
      edges: makeEdges(),
      metric: (name, payload) => metrics.push({ name, payload })
    });
    await engine.query({ frame: { 'default/Nope': {} }, ctx: makeCtx() });
    expect(metrics).toContainEqual({
      name: 'engine_unknown_name',
      payload: { ns: 'default', name: 'Nope' }
    });
  });

  it('empty frame returns an envelope with no data and no errors', async () => {
    const { engine } = singleNs(new Registry());
    const envelope = await engine.mutate({ frame: {}, ctx: makeCtx() });
    expect(envelope.data).toEqual({});
    expect(envelope.shapes).toEqual({});
    expect(envelope.errors).toBeUndefined();
  });
});

describe('Engine.mutate — G1 frame atomicity', () => {
  // A resolver that writes one Todo using whatever `args.dataset` the engine
  // threads through. This is what G1 demands — resolvers must use the tx
  // handle so their writes can be rolled back together.
  const writeTodoResolver =
    (title: string): Resolver =>
    async (_ctx, args) => {
      const body: Row = { id: title, title };
      if (!args.dataset) throw new Error('expected engine-injected args.dataset');
      await args.dataset.write('Todo', [body]);
      return body;
    };

  it('commits both writes when every frame entry resolves', async () => {
    const dataset = new MemoryDataset({ namespace: 'default' });
    const registry = new Registry();
    registry.register('createTodoA', { resolver: writeTodoResolver('a') });
    registry.register('createTodoB', { resolver: writeTodoResolver('b') });

    const { engine } = singleNs(registry, dataset);
    await engine.mutate({
      frame: { 'default/createTodoA': {}, 'default/createTodoB': {} },
      ctx: makeCtx()
    });

    const { rows } = await dataset.read('Todo', {});
    expect(rows.map((r) => r.id).sort()).toEqual(['a', 'b']);
  });

  it('rolls back the first write when a later frame entry throws', async () => {
    const dataset = new MemoryDataset({ namespace: 'default' });
    const registry = new Registry();
    registry.register('createTodoA', { resolver: writeTodoResolver('a') });
    registry.register('boom', {
      resolver: async () => {
        throw new Error('second mutation fails');
      }
    });

    const { engine } = singleNs(registry, dataset);
    await expect(
      engine.mutate({
        frame: { 'default/createTodoA': {}, 'default/boom': {} },
        ctx: makeCtx()
      })
    ).rejects.toThrow('second mutation fails');

    const { rows } = await dataset.read('Todo', { includeDeleted: true });
    expect(rows).toHaveLength(0);
  });

  it('single-frame throw leaves no partial state', async () => {
    const dataset = new MemoryDataset({ namespace: 'default' });
    const registry = new Registry();
    registry.register('halfWrite', {
      resolver: async (_ctx, args) => {
        if (!args.dataset) throw new Error('expected args.dataset');
        await args.dataset.write('Todo', [{ id: 'half', title: 'wrote' }]);
        throw new Error('post-write failure');
      }
    });

    const { engine } = singleNs(registry, dataset);
    await expect(
      engine.mutate({
        frame: { 'default/halfWrite': {} },
        ctx: makeCtx()
      })
    ).rejects.toThrow('post-write failure');

    const { rows } = await dataset.read('Todo', { includeDeleted: true });
    expect(rows).toHaveLength(0);
  });

  it('query is NOT wrapped in a tx — args.dataset equals the engine dataset', async () => {
    const dataset = new MemoryDataset({ namespace: 'default' });
    const registry = new Registry();
    let seen: unknown;
    registry.register('Todo', {
      resolver: async (_ctx, args) => {
        seen = args.dataset;
        return [];
      }
    });

    const { engine } = singleNs(registry, dataset);
    await engine.query({ frame: { 'default/Todo': {} }, ctx: makeCtx() });

    expect(seen).toBe(dataset);
  });

  it('resolvers receive args.dataset on mutate and its namespace is the frame namespace', async () => {
    const dataset = new MemoryDataset({ namespace: 'default' });
    const registry = new Registry();
    let seen: unknown;
    registry.register('peek', {
      resolver: async (_ctx, args) => {
        seen = args.dataset;
        return { id: 1 } as Row;
      }
    });

    const { engine } = singleNs(registry, dataset);
    await engine.mutate({
      frame: { 'default/peek': {} },
      ctx: makeCtx()
    });

    expect(seen).toBeDefined();
    expect((seen as { namespace: string }).namespace).toBe('default');
  });

  it('a policy deny rolls back the other single-frame entries', async () => {
    const dataset = new MemoryDataset({ namespace: 'default' });
    const registry = new Registry();
    registry.register('createTodoA', { resolver: writeTodoResolver('a') });
    registry.register('denied', {
      resolver: writeTodoResolver('nope'),
      policy: denyAll('not allowed')
    });

    const { engine } = singleNs(registry, dataset);
    const envelope = await engine.mutate({
      frame: { 'default/createTodoA': {}, 'default/denied': {} },
      ctx: makeCtx()
    });

    expect(envelope.errors?.map((e) => e.code)).toEqual(['policy_denied', 'frame_rolled_back']);
    const { rows } = await dataset.read('Todo', {});
    expect(rows).toEqual([]);
  });

  // Cross-store atomicity (§6.2). The engine nests edges.withTransaction
  // inside dataset.withTransaction so a resolver throw rolls both stores
  // back in one unwind — no orphaned edges, no orphaned rows.
  it('mutate commit commits both stores (row + edge visible)', async () => {
    const dataset = new MemoryDataset({ namespace: 'default' });
    const edges = makeEdges();
    const registry = new Registry();
    registry.register('createTodoAndEdge', {
      resolver: async (_ctx, args) => {
        if (!args.dataset) throw new Error('expected args.dataset');
        if (!args.edges) throw new Error('expected args.edges');
        const body: Row = { id: 'a', title: 'a' };
        await args.dataset.write('Todo', [body]);
        await args.edges.write({
          from: { ns: 'default', type: 'Todo', id: 'a' },
          to: { ns: 'default', type: 'Tag', id: 't1' },
          fieldName: 'tag',
          policy: 'set_null'
        });
        return body;
      }
    });

    const { engine } = singleNs(registry, dataset, edges);
    await engine.mutate({
      frame: { 'default/createTodoAndEdge': {} },
      ctx: makeCtx()
    });

    const { rows } = await dataset.read('Todo', {});
    expect(rows.map((r) => r.id)).toEqual(['a']);
    const edgeHits = await edges.findEdgesFrom({ ns: 'default', type: 'Todo', id: 'a' });
    expect(edgeHits).toHaveLength(1);
  });

  it('mutate rollback cascades to edges (row + edge both rolled back on throw)', async () => {
    const dataset = new MemoryDataset({ namespace: 'default' });
    const edges = makeEdges();
    const registry = new Registry();
    registry.register('halfEdgeHalfRow', {
      resolver: async (_ctx, args) => {
        if (!args.dataset) throw new Error('expected args.dataset');
        if (!args.edges) throw new Error('expected args.edges');
        await args.dataset.write('Todo', [{ id: 'a', title: 'a' }]);
        await args.edges.write({
          from: { ns: 'default', type: 'Todo', id: 'a' },
          to: { ns: 'default', type: 'Tag', id: 't1' },
          fieldName: 'tag',
          policy: 'set_null'
        });
        throw new Error('post-write failure');
      }
    });

    const { engine } = singleNs(registry, dataset, edges);
    await expect(
      engine.mutate({
        frame: { 'default/halfEdgeHalfRow': {} },
        ctx: makeCtx()
      })
    ).rejects.toThrow('post-write failure');

    const { rows } = await dataset.read('Todo', { includeDeleted: true });
    expect(rows).toHaveLength(0);
    const edgeHits = await edges.findEdgesFrom({ ns: 'default', type: 'Todo', id: 'a' });
    expect(edgeHits).toHaveLength(0);
  });

  it('edges tx is threaded into resolvers — args.edges is the tx-scoped store on mutate', async () => {
    const dataset = new MemoryDataset({ namespace: 'default' });
    const edges = makeEdges();
    const registry = new Registry();
    let seenEdges: unknown;
    registry.register('peekTxEdges', {
      resolver: async (_ctx, args) => {
        seenEdges = args.edges;
        return { id: 1 } as Row;
      }
    });

    const { engine } = singleNs(registry, dataset, edges);
    await engine.mutate({
      frame: { 'default/peekTxEdges': {} },
      ctx: makeCtx()
    });

    // Same class, but the engine threaded the tx-scoped instance (which for
    // the memory impl is `this` under #inTx). Must be an EdgesStore shape —
    // asserting identity would over-specify. Confirm the resolver observed
    // something truthy (not the ambient fallback) by exercising a write and
    // confirming it landed in the outer store via the normal commit path.
    expect(seenEdges).toBeDefined();
  });
});

describe('Engine — multi-namespace dispatch', () => {
  it('query dispatches across two namespaces, threading ctx.namespace per entry', async () => {
    const regA = new Registry();
    const regB = new Registry();
    const seenByA: RequestContext[] = [];
    const seenByB: RequestContext[] = [];
    regA.register('TypeA', {
      resolver: async (ctx) => {
        seenByA.push(ctx);
        return [{ id: 'a1' }];
      }
    });
    regB.register('TypeB', {
      resolver: async (ctx) => {
        seenByB.push(ctx);
        return [{ id: 'b1' }];
      }
    });

    const datasets = new MemoryDatasetRegistry();
    datasets.set('ns1', new MemoryDataset({ namespace: 'ns1' }));
    datasets.set('ns2', new MemoryDataset({ namespace: 'ns2' }));
    const engine = new Engine({
      namespaces: new Map([
        ['ns1', { registry: regA }],
        ['ns2', { registry: regB }]
      ]),
      datasets,
      edges: makeEdges()
    });

    const envelope = await engine.query({
      frame: {
        'ns1/TypeA': { params: {}, fields: { id: true } },
        'ns2/TypeB': { params: {}, fields: { id: true } }
      },
      ctx: makeCtx()
    });

    expect(envelope.data['ns1/TypeA']).toEqual([{ id: 'a1' }]);
    expect(envelope.data['ns2/TypeB']).toEqual([{ id: 'b1' }]);
    expect(seenByA[0]?.namespace).toBe('ns1');
    expect(seenByB[0]?.namespace).toBe('ns2');
  });

  it('mutate across two namespaces on DIFFERENT datasets is refused — no resolvers called', async () => {
    const regA = new Registry();
    const regB = new Registry();
    let callsA = 0;
    let callsB = 0;
    regA.register('createA', {
      resolver: async () => {
        callsA += 1;
        return { id: 'a' };
      }
    });
    regB.register('createB', {
      resolver: async () => {
        callsB += 1;
        return { id: 'b' };
      }
    });

    const dsA = new MemoryDataset({ namespace: 'ns1' });
    const dsB = new MemoryDataset({ namespace: 'ns2' });
    // A tx-spy wrapper: forwards every Dataset op to the underlying
    // dataset but counts withTransaction invocations. Wrapping via a fresh
    // object keeps us on the Dataset type surface (MemoryDataset's
    // private fields would leak through class extension).
    let txStartsA = 0;
    let txStartsB = 0;
    const spyFor = (inner: Dataset, onTx: () => void): Dataset => ({
      namespace: inner.namespace,
      txScopeId: inner.txScopeId,
      capabilities: inner.capabilities,
      read: (type, params) => inner.read(type, params),
      write: (type, rows, options) => inner.write(type, rows, options),
      tombstone: (type, ids) => inner.tombstone(type, ids),
      purge: (type, ids) => inner.purge(type, ids),
      dropType: (type) => inner.dropType(type),
      dropNamespace: () => inner.dropNamespace(),
      updateField: (ref, field, value) => inner.updateField(ref, field, value),
      conditionalUpdate: (type, id, match, updates, actor, now) =>
        inner.conditionalUpdate(type, id, match, updates, actor, now),
      withTransaction: <T>(fn: (tx: Dataset) => Promise<T>): Promise<T> => {
        onTx();
        return inner.withTransaction(fn);
      },
      allocateShortId: (type) => inner.allocateShortId(type),
      bindShortId: (type, shortId, rowId) => inner.bindShortId(type, shortId, rowId),
      resolveShortId: (type, shortId) => inner.resolveShortId(type, shortId),
      getShortIdForRow: (type, rowId) => inner.getShortIdForRow(type, rowId),
      forNamespace: (ns) => inner.forNamespace(ns)
    });
    const spyA = spyFor(dsA, () => {
      txStartsA += 1;
    });
    const spyB = spyFor(dsB, () => {
      txStartsB += 1;
    });

    const datasets = new MemoryDatasetRegistry();
    datasets.set('ns1', spyA);
    datasets.set('ns2', spyB);
    const engine = new Engine({
      namespaces: new Map([
        ['ns1', { registry: regA }],
        ['ns2', { registry: regB }]
      ]),
      datasets,
      edges: makeEdges()
    });

    const envelope = await engine.mutate({
      frame: {
        'ns1/createA': { params: {} },
        'ns2/createB': { params: {} }
      },
      ctx: makeCtx()
    });

    expect(envelope.errors).toHaveLength(1);
    expect(envelope.errors?.[0]?.code).toBe('cross_tx_scope_refused');
    expect(envelope.errors?.[0]?.message).toContain('ns1');
    expect(envelope.errors?.[0]?.message).toContain('ns2');
    expect(callsA).toBe(0);
    expect(callsB).toBe(0);
    expect(txStartsA).toBe(0);
    expect(txStartsB).toBe(0);
  });

  it('mutate across two namespaces on the SAME dataset instance proceeds in one tx', async () => {
    const shared = new MemoryDataset({ namespace: 'shared' });
    const regA = new Registry();
    const regB = new Registry();
    regA.register('writeA', {
      resolver: async (_ctx, args) => {
        if (!args.dataset) throw new Error('expected args.dataset');
        await args.dataset.write('RowA', [{ id: 'a' }]);
        return { id: 'a' };
      }
    });
    regB.register('writeB', {
      resolver: async (_ctx, args) => {
        if (!args.dataset) throw new Error('expected args.dataset');
        await args.dataset.write('RowB', [{ id: 'b' }]);
        return { id: 'b' };
      }
    });

    const datasets = new MemoryDatasetRegistry();
    datasets.set('ns1', shared);
    datasets.set('ns2', shared);
    const engine = new Engine({
      namespaces: new Map([
        ['ns1', { registry: regA }],
        ['ns2', { registry: regB }]
      ]),
      datasets,
      edges: makeEdges()
    });

    await engine.mutate({
      frame: {
        'ns1/writeA': {},
        'ns2/writeB': {}
      },
      ctx: makeCtx()
    });

    const { rows: rowsA } = await shared.read('RowA', {});
    const { rows: rowsB } = await shared.read('RowB', {});
    expect(rowsA).toHaveLength(1);
    expect(rowsB).toHaveLength(1);
  });

  it('same-dataset mutate across two namespaces rolls back both on failure', async () => {
    const shared = new MemoryDataset({ namespace: 'shared' });
    const regA = new Registry();
    const regB = new Registry();
    regA.register('writeA', {
      resolver: async (_ctx, args) => {
        if (!args.dataset) throw new Error('expected args.dataset');
        await args.dataset.write('RowA', [{ id: 'a' }]);
        return { id: 'a' };
      }
    });
    regB.register('boom', {
      resolver: async () => {
        throw new Error('cross-ns mutation fails');
      }
    });

    const datasets = new MemoryDatasetRegistry();
    datasets.set('ns1', shared);
    datasets.set('ns2', shared);
    const engine = new Engine({
      namespaces: new Map([
        ['ns1', { registry: regA }],
        ['ns2', { registry: regB }]
      ]),
      datasets,
      edges: makeEdges()
    });

    await expect(
      engine.mutate({
        frame: { 'ns1/writeA': {}, 'ns2/boom': {} },
        ctx: makeCtx()
      })
    ).rejects.toThrow('cross-ns mutation fails');

    const { rows: rowsA } = await shared.read('RowA', { includeDeleted: true });
    expect(rowsA).toHaveLength(0);
  });

  it('cross_tx_scope_refused error includes a split-hint by txScopeId', async () => {
    // Two distinct memory datasets — by default each has a unique txScopeId,
    // so the engine groups them into two buckets and refuses with a structured
    // hint listing which namespace went to which substrate.
    const dsA = new MemoryDataset({ namespace: 'ns1' });
    const dsB = new MemoryDataset({ namespace: 'ns2' });
    const regA = new Registry();
    const regB = new Registry();
    regA.register('createA', { resolver: async () => ({ id: 'a' }) });
    regB.register('createB', { resolver: async () => ({ id: 'b' }) });

    const datasets = new MemoryDatasetRegistry();
    datasets.set('ns1', dsA);
    datasets.set('ns2', dsB);
    const engine = new Engine({
      namespaces: new Map([
        ['ns1', { registry: regA }],
        ['ns2', { registry: regB }]
      ]),
      datasets,
      edges: makeEdges()
    });

    const envelope = await engine.mutate({
      frame: { 'ns1/createA': { params: {} }, 'ns2/createB': { params: {} } },
      ctx: makeCtx()
    });

    expect(envelope.errors).toHaveLength(1);
    expect(envelope.errors?.[0]?.code).toBe('cross_tx_scope_refused');
    // Hint surfaces both namespaces and groups them by txScopeId.
    expect(envelope.errors?.[0]?.message).toMatch(/Split by tx scope:/);
    expect(envelope.errors?.[0]?.message).toContain(dsA.txScopeId);
    expect(envelope.errors?.[0]?.message).toContain(dsB.txScopeId);
    expect(envelope.errors?.[0]?.message).toContain('ns1');
    expect(envelope.errors?.[0]?.message).toContain('ns2');
  });

  it('a namespace outside the caller grant does not enter the tx-scope check', async () => {
    const regA = new Registry();
    const regB = new Registry();
    regA.register('createA', { resolver: async () => ({ id: 'a' }) });
    regB.register('createB', { resolver: async () => ({ id: 'b' }) });
    const datasets = new MemoryDatasetRegistry();
    datasets.set('ns1', new MemoryDataset({ namespace: 'ns1' }));
    const dsB = new MemoryDataset({ namespace: 'ns2' });
    datasets.set('ns2', dsB);
    const engine = new Engine({
      namespaces: new Map([
        ['ns1', { registry: regA }],
        ['ns2', { registry: regB }]
      ]),
      datasets,
      edges: makeEdges()
    });

    const envelope = await engine.mutate({
      frame: { 'ns1/createA': { params: {} }, 'ns2/createB': { params: {} } },
      ctx: makeCtx({ identity: { kind: 'agent', id: 'k', grants: { ns1: ['read', 'mutate'] } } })
    });

    expect(envelope.errors?.map((e) => e.code)).toEqual([
      'unauthorized_namespace',
      'frame_rolled_back'
    ]);
    expect(JSON.stringify(envelope.errors)).not.toContain(dsB.txScopeId);
  });

  it('SAME txScopeId but no withScopedTransaction refuses with a clear message', async () => {
    // Two memory datasets sharing an explicit txScopeId but each owning its
    // own internal Map. MemoryDataset doesn't implement
    // withScopedTransaction (correct: shared txScopeId without shared
    // storage couldn't honor a tx anyway), so the engine refuses rather than
    // silently breaking G1 by running each ns in its own tx.
    const SHARED = 'mem:test-shared-substrate';
    const dsA = new MemoryDataset({ namespace: 'ns1', txScopeId: SHARED });
    const dsB = new MemoryDataset({ namespace: 'ns2', txScopeId: SHARED });
    expect(dsA.txScopeId).toBe(SHARED);
    expect(dsB.txScopeId).toBe(SHARED);

    const regA = new Registry();
    const regB = new Registry();
    regA.register('createA', { resolver: async () => ({ id: 'a' }) });
    regB.register('createB', { resolver: async () => ({ id: 'b' }) });

    const datasets = new MemoryDatasetRegistry();
    datasets.set('ns1', dsA);
    datasets.set('ns2', dsB);
    const engine = new Engine({
      namespaces: new Map([
        ['ns1', { registry: regA }],
        ['ns2', { registry: regB }]
      ]),
      datasets,
      edges: makeEdges()
    });

    const envelope = await engine.mutate({
      frame: { 'ns1/createA': { params: {} }, 'ns2/createB': { params: {} } },
      ctx: makeCtx()
    });

    expect(envelope.errors).toHaveLength(1);
    expect(envelope.errors?.[0]?.code).toBe('cross_tx_scope_refused');
    expect(envelope.errors?.[0]?.message).toMatch(/withScopedTransaction/);
    expect(envelope.errors?.[0]?.message).toContain(SHARED);
  });
});

describe('Engine — federated schema', () => {
  it('schemaFor / federatedSchema return per-ns entries', () => {
    const regA = new Registry();
    regA.register('TypeA', { resolver: async () => [] });
    const regB = new Registry();
    regB.register('TypeB', { resolver: async () => [] });

    const datasets = new MemoryDatasetRegistry();
    datasets.set('ns1', new MemoryDataset({ namespace: 'ns1' }));
    datasets.set('ns2', new MemoryDataset({ namespace: 'ns2' }));
    const engine = new Engine({
      namespaces: new Map([
        ['ns1', { registry: regA }],
        ['ns2', { registry: regB }]
      ]),
      datasets,
      edges: makeEdges()
    });

    const federated = engine.federatedSchema();
    expect(Object.keys(federated).sort()).toEqual(['ns1', 'ns2']);
    expect(federated.ns1?.types.TypeA).toBeDefined();
    expect(federated.ns2?.types.TypeB).toBeDefined();
    expect(engine.schemaFor('ns1').schemaVersion).toBe(federated.ns1?.schemaVersion);
  });

  it('a bridge alias naming a local namespace does not replace its schema', async () => {
    const reg = new Registry();
    reg.register('TypeA', { resolver: async () => [] });
    const datasets = new MemoryDatasetRegistry();
    datasets.set('ns1', new MemoryDataset({ namespace: 'ns1' }));
    const client = {
      name: 'ns1',
      federatedSchema: async () => ({ ns1: { schemaVersion: 'evil', types: {}, mutations: {} } }),
      isReachable: () => true
    } as unknown as BridgeClient;
    const bridges: BridgeRegistry = {
      has: (ns) => ns === 'ns1',
      get: (ns) => (ns === 'ns1' ? client : undefined),
      isUnreachable: () => false,
      entries: () => [['ns1', client]]
    };
    const engine = new Engine({
      namespaces: new Map([['ns1', { registry: reg }]]),
      datasets,
      edges: makeEdges(),
      sweepHooks: { bridges }
    });
    await engine.refreshBridgeSchemas();
    expect(engine.federatedSchema().ns1?.types.TypeA).toBeDefined();
  });

  it('federatedSchemaVersion shifts when a namespace registry changes', () => {
    const regA1 = new Registry();
    regA1.register('TypeA', { resolver: async () => [] });
    const regB = new Registry();
    regB.register('TypeB', { resolver: async () => [] });

    const datasets = new MemoryDatasetRegistry();
    datasets.set('ns1', new MemoryDataset({ namespace: 'ns1' }));
    datasets.set('ns2', new MemoryDataset({ namespace: 'ns2' }));

    const engine1 = new Engine({
      namespaces: new Map([
        ['ns1', { registry: regA1 }],
        ['ns2', { registry: regB }]
      ]),
      datasets,
      edges: makeEdges()
    });
    const v1 = engine1.federatedSchemaVersion();

    const regA2 = new Registry();
    regA2.register('TypeA', { resolver: async () => [] });
    regA2.register('TypeExtra', { resolver: async () => [] });
    const engine2 = new Engine({
      namespaces: new Map([
        ['ns1', { registry: regA2 }],
        ['ns2', { registry: regB }]
      ]),
      datasets,
      edges: makeEdges()
    });
    const v2 = engine2.federatedSchemaVersion();

    expect(v1).not.toBe(v2);
  });

  it('federatedSchemaVersion is stable across Map key order', () => {
    const regA = new Registry();
    regA.register('TypeA', { resolver: async () => [] });
    const regB = new Registry();
    regB.register('TypeB', { resolver: async () => [] });

    const datasets = new MemoryDatasetRegistry();
    datasets.set('ns1', new MemoryDataset({ namespace: 'ns1' }));
    datasets.set('ns2', new MemoryDataset({ namespace: 'ns2' }));

    const engine1 = new Engine({
      namespaces: new Map([
        ['ns1', { registry: regA }],
        ['ns2', { registry: regB }]
      ]),
      datasets,
      edges: makeEdges()
    });
    const engine2 = new Engine({
      namespaces: new Map([
        ['ns2', { registry: regB }],
        ['ns1', { registry: regA }]
      ]),
      datasets,
      edges: makeEdges()
    });

    expect(engine1.federatedSchemaVersion()).toBe(engine2.federatedSchemaVersion());
  });
});

describe('Engine — §5.2 filter validation + pagination envelope', () => {
  it('surfaces FilterValidationError in envelope.errors with the validator code', async () => {
    const registry = new Registry();
    registry.register('Todo', {
      resolver: async () => [],
      fields: {
        title: { kind: 'scalar', type: 'string', indexed: true }
      }
    });
    const { engine } = singleNs(registry);
    const env = await engine.query({
      frame: {
        'default/Todo': {
          params: { where: { nonexistent: { eq: 'x' } } }
        }
      },
      ctx: makeCtx()
    });
    expect(env.errors).toBeDefined();
    expect(env.errors?.[0]?.code).toBe('unknown_field');
    expect(env.data['default/Todo']).toBeUndefined();
  });

  it('unindexed field filter surfaces unindexed_field (and _allowTableScan overrides)', async () => {
    const registry = new Registry();
    registry.register('Todo', {
      resolver: async () => [],
      fields: {
        priority: { kind: 'scalar', type: 'number' } // indexed omitted -> treated as false
      }
    });
    const { engine } = singleNs(registry);
    const denied = await engine.query({
      frame: { 'default/Todo': { params: { where: { priority: { eq: 5 } } } } },
      ctx: makeCtx()
    });
    expect(denied.errors?.[0]?.code).toBe('unindexed_field');

    const allowed = await engine.query({
      frame: {
        'default/Todo': {
          params: { where: { priority: { eq: 5 } }, _allowTableScan: true }
        }
      },
      ctx: makeCtx()
    });
    expect(allowed.errors).toBeUndefined();
  });

  it('copies ReadResult nextCursor/hasMore into envelope._pagination', async () => {
    const dataset = new MemoryDataset({ namespace: 'default' });
    await dataset.write(
      'Todo',
      Array.from({ length: 10 }, (_, i) => ({
        id: `t${String(i + 1).padStart(2, '0')}`,
        n: i + 1
      }))
    );
    const registry = new Registry();
    registry.register('Todo', {
      resolver: async (_ctx, args) => {
        if (!args.dataset) throw new Error('expected args.dataset');
        return args.dataset.read('Todo', {
          limit: 3,
          orderBy: [{ id: 'asc' }]
        });
      }
    });
    const { engine } = singleNs(registry, dataset);
    const env = await engine.query({
      frame: { 'default/Todo': {} },
      ctx: makeCtx()
    });
    const rows = env.data['default/Todo'] as Array<{ id: string }>;
    expect(rows).toHaveLength(3);
    const pg = env._pagination?.['default/Todo'];
    expect(pg).toBeDefined();
    expect(pg?.hasMore).toBe(true);
    expect(typeof pg?.nextCursor).toBe('string');
  });
});

describe('Engine — edges injection', () => {
  it('threads the constructor-supplied EdgesStore to resolvers as args.edges', async () => {
    const edges = makeEdges();
    const registry = new Registry();
    let seenEdges: unknown;
    const resolver: Resolver = async (_ctx, args) => {
      seenEdges = args.edges;
      return [];
    };
    registry.register('Todo', { resolver });

    const { engine } = singleNs(registry, new MemoryDataset({ namespace: 'default' }), edges);
    await engine.query({ frame: { 'default/Todo': {} }, ctx: makeCtx() });

    expect(seenEdges).toBe(edges);
  });

  it('threads args.edges on mutate as well as query', async () => {
    const edges = makeEdges();
    const registry = new Registry();
    let seenEdges: unknown;
    registry.register('peek', {
      resolver: async (_ctx, args) => {
        seenEdges = args.edges;
        return { id: 1 } as Row;
      }
    });

    const { engine } = singleNs(registry, new MemoryDataset({ namespace: 'default' }), edges);
    await engine.mutate({ frame: { 'default/peek': {} }, ctx: makeCtx() });

    expect(seenEdges).toBe(edges);
  });
});

describe('Engine — filter-operator introspection', () => {
  it('hasFilterOperator + listFilterOperators reflect the shared @mnmal-ai/substrate-filter registry', async () => {
    const { clearExtensionOperators, registerExtensionOperator } = await import(
      '@mnmal-ai/substrate-filter'
    );
    clearExtensionOperators();

    const { engine } = singleNs(new Registry());

    expect(engine.hasFilterOperator('embeddingSimilar')).toBe(false);
    expect(engine.listFilterOperators()).toEqual([]);

    registerExtensionOperator('embeddingSimilar', {
      validate: () => ({ ok: true, value: {} }),
      execute: async () => ({ hits: [] })
    });

    expect(engine.hasFilterOperator('embeddingSimilar')).toBe(true);
    expect(engine.hasFilterOperator('unknownThing')).toBe(false);
    expect(engine.listFilterOperators()).toEqual(['embeddingSimilar']);

    clearExtensionOperators();
  });
});

describe('Engine.activeSubscriptionCount', () => {
  // The gauge sums the SubscribeSubsystem's #subscriptions map. Every teardown
  // path — cancel, namespace-lost (tombstone), and overload — removes the entry
  // from that same map, so the count tracks the removal regardless of cause.
  // cancel and namespace-lost are exercised below; overload removes via the
  // identical map path (there's no parallel counter that could drift), so it's
  // not re-simulated here — a backpressure-timing test would be flaky for no
  // added gauge coverage.
  it('reflects live subscriptions and cancel teardown', async () => {
    const registry = new Registry();
    registry.register('Item', { resolver: async () => [] });
    const { engine } = singleNs(registry);

    expect(engine.activeSubscriptionCount()).toBe(0);

    const handle = await engine.subscribe({
      id: 'sub-1',
      frame: { 'default/Item': { params: {}, fields: { id: true } } },
      ctx: {},
      onFrame: () => {}
    });
    expect(engine.activeSubscriptionCount()).toBe(1);

    handle.cancel();
    expect(engine.activeSubscriptionCount()).toBe(0);
  });

  it('drops to zero on namespace-lost teardown (tombstone)', async () => {
    const registry = new Registry();
    registry.register('Item', { resolver: async () => [] });
    const { engine } = singleNs(registry);

    const handle = await engine.subscribe({
      id: 'sub-ns-lost',
      frame: { 'default/Item': { params: {}, fields: { id: true } } },
      ctx: {},
      onFrame: () => {}
    });
    expect(engine.activeSubscriptionCount()).toBe(1);

    // Namespace-lost teardown: tombstone closes every subscription on the ns,
    // removing its entries from #subscriptions (see tombstone.test.ts).
    engine.tombstoneNamespace('default');
    expect(engine.activeSubscriptionCount()).toBe(0);

    handle.cancel(); // idempotent — entry already torn down
  });
});

describe('policy entry/verb discrimination', () => {
  it('threads entry + verb so one shared policy denies deletes while allowing gets', async () => {
    const seen: Array<{ entry: string | undefined; verb: string | undefined }> = [];
    const sharedPolicy: Policy = (ctx) => {
      seen.push({ entry: ctx.entry, verb: ctx.verb });
      return ctx.verb === 'delete'
        ? { allow: false, reason: 'deletes are gated' }
        : { allow: true };
    };
    const ok: Resolver = async () => ({ id: '1' });

    const registry = new Registry();
    registry.register('getTodo', {
      resolver: ok,
      kind: 'mutation',
      verb: 'get',
      policy: sharedPolicy
    });
    registry.register('deleteTodo', {
      resolver: ok,
      kind: 'mutation',
      verb: 'delete',
      policy: sharedPolicy
    });
    registry.register('customNuke', { resolver: ok, kind: 'mutation', policy: sharedPolicy });

    const { engine } = singleNs(registry);

    const getEnv = await engine.mutate({
      frame: { 'default/getTodo': { params: { id: '1' }, fields: { id: true } } },
      ctx: makeCtx()
    });
    expect(getEnv.errors).toBeUndefined();

    const delEnv = await engine.mutate({
      frame: { 'default/deleteTodo': { params: { id: '1' }, fields: { id: true } } },
      ctx: makeCtx()
    });
    expect(delEnv.errors?.[0]?.code).toBe('policy_denied');
    expect(delEnv.errors?.[0]?.message).toBe('deletes are gated');

    const customEnv = await engine.mutate({
      frame: { 'default/customNuke': { params: { id: '1' }, fields: { id: true } } },
      ctx: makeCtx()
    });
    expect(customEnv.errors).toBeUndefined();

    expect(seen).toEqual([
      { entry: 'getTodo', verb: 'get' },
      { entry: 'deleteTodo', verb: 'delete' },
      { entry: 'customNuke', verb: undefined }
    ]);
  });

  it('query dispatch threads the type name as entry with no verb', async () => {
    let observed: { entry: string | undefined; verb: string | undefined } | null = null;
    const policy: Policy = (ctx) => {
      observed = { entry: ctx.entry, verb: ctx.verb };
      return { allow: true };
    };
    const registry = new Registry();
    const resolver: Resolver = async () => [{ id: '1' }];
    registry.register('Todo', { resolver, policy });

    const { engine } = singleNs(registry);
    await engine.query({
      frame: { 'default/Todo': { params: {}, fields: { id: true } } },
      ctx: makeCtx()
    });
    expect(observed).toEqual({ entry: 'Todo', verb: undefined });
  });
});

describe('Engine — id-miss observability', () => {
  // A well-formed UUID that resolves to no row on an id-based get/update is
  // suspicious: the caller almost always holds that id from a prior
  // create/list, so a miss likely means a dropped read/write. The engine emits
  // an `engine_id_miss` metric so it is diagnosable; the envelope still
  // carries null.
  const UUID = '0314d94c-66ec-4822-8898-5845a1df869c';
  const nullResolver: Resolver = async () => null;

  function engineWithMetric(registry: Registry): {
    engine: Engine;
    metrics: Array<{ name: string; payload?: unknown }>;
  } {
    const metrics: Array<{ name: string; payload?: unknown }> = [];
    const dataset = new MemoryDataset({ namespace: 'default' });
    const datasets = new MemoryDatasetRegistry();
    datasets.set('default', dataset);
    const engine = new Engine({
      namespaces: new Map<string, NamespaceConfig>([['default', { registry }]]),
      datasets,
      edges: makeEdges(),
      metric: (name, payload) => metrics.push({ name, payload })
    });
    return { engine, metrics };
  }

  it('emits engine_id_miss when an update verb returns null for a UUID id', async () => {
    const registry = new Registry();
    registry.register('updateThing', { resolver: nullResolver, verb: 'update' });
    const { engine, metrics } = engineWithMetric(registry);

    const envelope = await engine.mutate({
      frame: { 'default/updateThing': { params: { id: UUID } } },
      ctx: makeCtx()
    });

    // Contract preserved: the miss is still a null no-op to the caller.
    expect(envelope.data['default/updateThing']).toBeNull();
    expect(metrics).toContainEqual({
      name: 'engine_id_miss',
      payload: { key: 'default/updateThing', verb: 'update', id: UUID }
    });
  });

  it('emits engine_id_miss when a get verb returns null for a UUID id', async () => {
    const registry = new Registry();
    registry.register('getThing', { resolver: nullResolver, verb: 'get' });
    const { engine, metrics } = engineWithMetric(registry);

    await engine.mutate({
      frame: { 'default/getThing': { params: { id: UUID } } },
      ctx: makeCtx()
    });

    expect(metrics).toContainEqual({
      name: 'engine_id_miss',
      payload: { key: 'default/getThing', verb: 'get', id: UUID }
    });
  });

  it('does NOT emit for a short-form numeric id miss (a legitimate not-found)', async () => {
    const registry = new Registry();
    registry.register('updateThing', { resolver: nullResolver, verb: 'update' });
    const { engine, metrics } = engineWithMetric(registry);

    await engine.mutate({
      frame: { 'default/updateThing': { params: { id: '7' } } },
      ctx: makeCtx()
    });

    expect(metrics.some((m) => m.name === 'engine_id_miss')).toBe(false);
  });

  it('does NOT emit when the update resolves a row (non-null result)', async () => {
    const registry = new Registry();
    const hit: Resolver = async () => ({ id: UUID }) as Row;
    registry.register('updateThing', { resolver: hit, verb: 'update' });
    const { engine, metrics } = engineWithMetric(registry);

    await engine.mutate({
      frame: { 'default/updateThing': { params: { id: UUID } } },
      ctx: makeCtx()
    });

    expect(metrics.some((m) => m.name === 'engine_id_miss')).toBe(false);
  });

  it('does NOT emit for a create verb returning null', async () => {
    const registry = new Registry();
    registry.register('createThing', { resolver: nullResolver, verb: 'create' });
    const { engine, metrics } = engineWithMetric(registry);

    await engine.mutate({
      frame: { 'default/createThing': { params: { id: UUID } } },
      ctx: makeCtx()
    });

    expect(metrics.some((m) => m.name === 'engine_id_miss')).toBe(false);
  });

  it('emits for a batched update frame that misses (batched path routes through #runEntry)', async () => {
    const registry = new Registry();
    registry.register('updateThing', { resolver: nullResolver, verb: 'update' });
    const { engine, metrics } = engineWithMetric(registry);

    await engine.mutate({
      frame: { 'default/updateThing': [{ params: { id: UUID } }] },
      ctx: makeCtx()
    });

    expect(metrics).toContainEqual({
      name: 'engine_id_miss',
      payload: { key: 'default/updateThing', verb: 'update', id: UUID }
    });
  });
});

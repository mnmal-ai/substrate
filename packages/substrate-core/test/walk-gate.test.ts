import { MemoryDataset, MemoryDatasetRegistry } from '@mnmal-ai/substrate-dataset-memory';
import { describe, expect, it } from 'vitest';
import { Engine, MemoryEdgesStore, type NamespaceConfig, Registry } from '../src/index.js';
import { usesWalkGrammar, walkGrammarPath } from '../src/walk-gate.js';

describe('usesWalkGrammar', () => {
  const where = (w: unknown) => usesWalkGrammar({ params: { where: w }, fields: { id: true } });

  it('finds _walk under AND/OR/NOT, $ref in a predicate, _agg in fields, and count/aggregate/bucket/derive params', () => {
    expect(where({ _walk: { edge: 'x' } })).toBe(true);
    expect(where({ AND: [{ a: { eq: 1 } }, { OR: [{ NOT: [{ _walk: {} }] }] }] })).toBe(true);
    expect(where({ a: { gt: { $ref: 'b' } } })).toBe(true);
    expect(where({ _walk: { where: { _agg: {} } } })).toBe(true);
    expect(usesWalkGrammar({ params: {}, fields: { _agg: { n: 1 } } })).toBe(true);
    expect(usesWalkGrammar({ params: {}, fields: { kids: { _walk: {} } } })).toBe(true);
    for (const k of ['count', 'aggregate', 'bucket', 'derive'])
      expect(usesWalkGrammar({ params: { [k]: true }, fields: { id: true } })).toBe(true);
  });

  it('finds _agg and { _walk } selections nested inside field sub-selections', () => {
    expect(walkGrammarPath({ fields: { owner: { inner: { kids: { _walk: {} } } } } })).toEqual([
      'fields',
      'owner',
      'inner',
      'kids',
      '_walk'
    ]);
    expect(walkGrammarPath({ fields: { owner: { _agg: {} } } })).toEqual([
      'fields',
      'owner',
      '_agg'
    ]);
  });

  it('is false for an ordinary list frame', () => {
    expect(
      usesWalkGrammar({
        params: { where: { AND: [{ a: { eq: 1 } }, { b: { in: [1, 2] } }] }, limit: 5 },
        fields: { id: true, owner: { name: true } }
      })
    ).toBe(false);
  });
});

function build(walksEnabled?: boolean, walkReference = true) {
  const registry = new Registry();
  let reached = 0;
  registry.register('Part', {
    fields: { thing: { kind: 'crossRef', ns: 'ns', type: 'Thing', onDelete: 'set_null' } },
    resolver: async () => []
  });
  registry.register('Thing', {
    resolver: async () => {
      reached++;
      return [];
    }
  });
  const datasets = new MemoryDatasetRegistry();
  datasets.set('ns', new MemoryDataset({ namespace: 'ns', walkReference }));
  const engine = new Engine({
    namespaces: new Map<string, NamespaceConfig>([['ns', { registry }]]),
    datasets,
    edges: new MemoryEdgesStore({ now: () => new Date('2026-04-18T00:00:00Z') }),
    ...(walksEnabled !== undefined ? { walksEnabled } : {})
  });
  return { engine, reached: () => reached };
}

const frame = {
  'ns/Thing': { params: { where: { _walk: { in: 'ns/Part.thing' } } }, fields: { id: true } }
};
const ctx = { identity: null, now: new Date(), headers: {}, meta: {} };

describe('engine walk gate', () => {
  it("a walk frame with the flag off is refused walks_disabled at path [key, 'where', '_walk']", async () => {
    const { engine, reached } = build();
    const res = await engine.query({ frame, ctx });
    expect(res.errors?.[0]).toMatchObject({
      code: 'walks_disabled',
      path: ['ns/Thing', 'where', '_walk']
    });
    expect(reached()).toBe(0);
  });

  it('the same frame with the flag on passes the gate and validation and reaches the resolver', async () => {
    const { engine, reached } = build(true);
    const res = await engine.query({ frame, ctx });
    expect(res.errors ?? []).toEqual([]);
    expect(reached()).toBe(1);
  });

  it('validates frame params and selections without a where', async () => {
    const { engine, reached } = build(true);
    const res = await engine.query({
      frame: { 'ns/Thing': { params: { count: true }, fields: { id: true, _agg: {} } } },
      ctx
    });
    expect(res.errors?.[0]).toMatchObject({
      code: 'count_conflict',
      path: ['ns/Thing', 'fields', '_agg']
    });
    expect(reached()).toBe(0);
  });

  it('refuses a nested limit above the page max with limit_exceeds_max', async () => {
    const { engine, reached } = build(true);
    const parts = { _walk: { in: 'ns/Part.thing' }, fields: { id: true }, limit: 11 };
    const res = await engine.query({
      frame: { 'ns/Thing': { fields: { id: true, parts } } },
      ctx,
      pageLimits: { defaultLimit: 5, maxLimit: 10 }
    });
    expect(res.errors?.[0]).toMatchObject({
      code: 'limit_exceeds_max',
      path: ['ns/Thing', 'fields', 'parts', 'limit']
    });
    expect(reached()).toBe(0);
  });

  it('a store that does not declare walks refuses a walk frame with walks_unsupported_store', async () => {
    const { engine, reached } = build(true, false);
    for (const f of [
      frame,
      { 'ns/Thing': { params: { count: true }, fields: { id: true } } },
      {
        'ns/Thing': {
          fields: { id: true, parts: { _walk: { in: 'ns/Part.thing' }, fields: { id: true } } }
        }
      }
    ]) {
      const res = await engine.query({ frame: f, ctx });
      expect(res.errors?.[0]?.code).toBe('walks_unsupported_store');
    }
    expect(reached()).toBe(0);
    // A plain read still answers.
    const plain = await engine.query({ frame: { 'ns/Thing': { fields: { id: true } } }, ctx });
    expect(plain.errors ?? []).toEqual([]);
    expect(reached()).toBe(1);
  });

  it('the flag gate runs first: flag off answers walks_disabled whatever the store', async () => {
    const { engine } = build(false, false);
    const res = await engine.query({ frame, ctx });
    expect(res.errors?.[0]?.code).toBe('walks_disabled');
  });
});

describe('memory walk reference through the engine', () => {
  function engineFor(walkReference: boolean) {
    const registry = new Registry();
    const ds = new MemoryDataset({ namespace: 'ns', walkReference });
    registry.register('Thing', {
      resolver: async (_c, args) => ds.read('Thing', args.params ?? {})
    });
    registry.register('Part', {
      fields: { thing: { kind: 'crossRef', ns: 'ns', type: 'Thing', onDelete: 'set_null' } },
      resolver: async () => []
    });
    const datasets = new MemoryDatasetRegistry();
    datasets.set('ns', ds);
    const engine = new Engine({
      namespaces: new Map<string, NamespaceConfig>([['ns', { registry }]]),
      datasets,
      edges: new MemoryEdgesStore({ now: () => new Date('2026-04-18T00:00:00Z') }),
      walksEnabled: true
    });
    return { engine, ds };
  }

  it('without walkReference memory refuses a walk; with it, the walk answers', async () => {
    for (const walkReference of [false, true]) {
      const { engine, ds } = engineFor(walkReference);
      await ds.write('Thing', [{ id: 't1' }, { id: 't2' }]);
      await ds.write('Part', [{ id: 'p1', thing: 't2' }]);
      const res = await engine.query({ frame, ctx });
      if (walkReference) {
        expect(res.errors ?? []).toEqual([]);
        expect((res.data['ns/Thing'] as Array<{ id: string }>).map((r) => r.id)).toEqual(['t2']);
      } else {
        expect(res.errors?.[0]).toMatchObject({
          code: 'walks_unsupported_store',
          path: ['ns/Thing', 'where', '_walk']
        });
      }
    }
  });
});

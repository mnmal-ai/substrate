import { MemoryDataset, MemoryDatasetRegistry } from '@mnmal-ai/substrate-dataset-memory';
import { describe, expect, it } from 'vitest';
import { Engine, MemoryEdgesStore, type NamespaceConfig, Registry } from '../src/index.js';
import { usesWalkGrammar } from '../src/walk-gate.js';

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

  it('is false for an ordinary list frame', () => {
    expect(
      usesWalkGrammar({
        params: { where: { AND: [{ a: { eq: 1 } }, { b: { in: [1, 2] } }] }, limit: 5 },
        fields: { id: true, owner: { name: true } }
      })
    ).toBe(false);
  });
});

function build(walksEnabled?: boolean) {
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
  datasets.set('ns', new MemoryDataset({ namespace: 'ns' }));
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
});

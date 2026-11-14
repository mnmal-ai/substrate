/**
 * Policy on walked types (typed edge walks spec §2, §3): a walk is a read of
 * every type it touches, so each walked, aggregated or nested type's read
 * policy gates the frame, fail-closed.
 */

import { MemoryDataset, MemoryDatasetRegistry } from '@mnmal-ai/substrate-dataset-memory';
import { requireCapability, row } from '@mnmal-ai/substrate-policy';
import type { Policy, RegistryEntry, ResolverArgs } from '@mnmal-ai/substrate-types';
import { describe, expect, it } from 'vitest';
import { Engine, MemoryEdgesStore, type NamespaceConfig, Registry } from '../src/index.js';
import { hopResolver, walkedTypes } from '../src/walk-types.js';

const allow: Policy = () => ({ allow: true });

/** A registry whose `hidden` type resolves but is absent from the published schema. */
class HidingRegistry extends Registry {
  constructor(private readonly hidden: string) {
    super();
  }
  override *all(): IterableIterator<[string, RegistryEntry]> {
    for (const e of super.all()) if (e[0] !== this.hidden) yield e;
  }
}

function build(policies: { Thing?: Policy; Part?: Policy; Note?: Policy } = {}, hidden?: string) {
  const registry = hidden === undefined ? new Registry() : new HidingRegistry(hidden);
  let reached = 0;
  const resolver = async () => {
    reached++;
    return [];
  };
  registry.register('Thing', {
    fields: { label: { kind: 'scalar', type: 'string' } },
    resolver,
    policy: policies.Thing ?? allow
  });
  registry.register('Part', {
    fields: {
      thing: { kind: 'crossRef', ns: 'ns', type: 'Thing', onDelete: 'set_null' },
      n: { kind: 'scalar', type: 'number' }
    },
    resolver,
    policy: policies.Part ?? allow
  });
  registry.register('Note', {
    fields: { part: { kind: 'crossRef', ns: 'ns', type: 'Part', onDelete: 'set_null' } },
    resolver,
    policy: policies.Note ?? allow
  });
  registry.register('touchThing', { kind: 'mutation', resolver: async () => ({ id: 't1' }) });
  const datasets = new MemoryDatasetRegistry();
  datasets.set('ns', new MemoryDataset({ namespace: 'ns', walkReference: true }));
  const engine = new Engine({
    namespaces: new Map<string, NamespaceConfig>([['ns', { registry }]]),
    datasets,
    edges: new MemoryEdgesStore({ now: () => new Date('2026-04-18T00:00:00Z') })
  });
  return { engine, reached: () => reached };
}

const ctx = { identity: null, now: new Date(), headers: {}, meta: {} };
const walkFrame = {
  'ns/Thing': {
    params: { where: { _walk: { in: 'ns/Part.thing', where: { n: { gt: 2 } } } } },
    fields: { id: true }
  }
};
const aggFrame = {
  'ns/Thing': {
    params: {},
    fields: { id: true, _agg: { parts: { in: 'ns/Part.thing', count: true } } }
  }
};
const countFrame = { 'ns/Part': { params: { count: true }, fields: { id: true } } };

describe('policy on walked types', () => {
  it('a walked type whose policy denies makes the frame denied at the walk path', async () => {
    const { engine, reached } = build({ Part: () => ({ allow: false, reason: 'no parts' }) });
    const res = await engine.query({ frame: walkFrame, ctx });
    expect(res.data).not.toHaveProperty('ns/Thing');
    expect(res.errors).toEqual([
      expect.objectContaining({
        code: 'policy_denied',
        message: 'no parts',
        path: ['ns/Thing', 'where', '_walk']
      })
    ]);
    expect(reached()).toBe(0);
  });

  it('a walk from a type absent from the schema is refused as walk_unknown_ref (#1824)', async () => {
    const { engine, reached } = build({}, 'Thing');
    for (const [frame, path] of [
      [walkFrame, ['ns/Thing', 'where', '_walk']],
      [aggFrame, ['ns/Thing', 'fields', '_agg']]
    ] as const) {
      const res = await engine.query({ frame, ctx });
      expect(res.data).not.toHaveProperty('ns/Thing');
      expect(res.errors).toEqual([expect.objectContaining({ code: 'walk_unknown_ref', path })]);
    }
    expect(reached()).toBe(0);
  });

  it('row policy on a walked type blocks walk, _agg and count', async () => {
    const { engine, reached } = build({ Part: row(() => true) });
    const res = await engine.query({ frame: walkFrame, ctx });
    expect(res.errors?.[0]).toMatchObject({
      code: 'row_policy_blocks_walk',
      path: ['ns/Thing', 'where', '_walk']
    });
    const agg = await engine.query({ frame: aggFrame, ctx });
    expect(agg.errors?.[0]).toMatchObject({
      code: 'row_policy_blocks_walk',
      path: ['ns/Thing', 'fields', '_agg', 'parts']
    });
    const count = await engine.query({ frame: countFrame, ctx });
    expect(count.errors?.[0]).toMatchObject({
      code: 'row_policy_blocks_walk',
      path: ['ns/Part', 'count']
    });
    expect(reached()).toBe(0);
  });

  it('a seed under a row policy is refused for a plain walk, and for nested selections', async () => {
    const { engine } = build({ Thing: row(() => true) });
    const res = await engine.query({ frame: walkFrame, ctx });
    expect(res.errors?.[0]).toMatchObject({
      code: 'row_policy_blocks_walk',
      path: ['ns/Thing', 'where', '_walk']
    });
    const nested = await engine.query({
      frame: {
        'ns/Thing': {
          params: {},
          fields: { id: true, parts: { _walk: { in: 'ns/Part.thing' }, fields: { id: true } } }
        }
      },
      ctx
    });
    expect(nested.errors?.[0]).toMatchObject({
      code: 'row_policy_blocks_walk',
      path: ['ns/Thing', 'fields', 'parts', '_walk']
    });
  });

  it('a seed type under a row policy still reads without walks', async () => {
    const { engine, reached } = build({ Part: row(() => true) });
    const res = await engine.query({
      frame: { 'ns/Part': { params: { where: { n: { gt: 1 } } }, fields: { id: true } } },
      ctx
    });
    expect(res.errors ?? []).toEqual([]);
    expect(res.data['ns/Part']).toEqual([]);
    expect(reached()).toBe(1);
  });

  it("the walked type's policy sees args.where equal to the walk's own where", async () => {
    const seen: ResolverArgs[] = [];
    const spy: Policy = (_ctx, args) => {
      seen.push(args);
      return { allow: true };
    };
    const { engine } = build({ Part: spy });
    const res = await engine.query({ frame: walkFrame, ctx });
    expect(res.errors ?? []).toEqual([]);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.params?.where).toEqual({ n: { gt: 2 } });
  });

  it('a capability-denying policy on the walked type refuses the walk (policy_denied)', async () => {
    const { engine, reached } = build({ Part: requireCapability('parts') });
    const identity = { id: 'agent-1', grants: { ns: ['read'] } };
    const res = await engine.query({ frame: walkFrame, ctx: { ...ctx, identity } });
    expect(res.errors?.[0]).toMatchObject({
      code: 'policy_denied',
      path: ['ns/Thing', 'where', '_walk']
    });
    expect(reached()).toBe(0);

    const granted = { id: 'agent-1', grants: { ns: ['read', 'parts'] } };
    const ok = await engine.query({ frame: walkFrame, ctx: { ...ctx, identity: granted } });
    expect(ok.errors ?? []).toEqual([]);
  });

  it('row policy on a walked type blocks a where-side _agg and a nested selection', async () => {
    const { engine } = build({ Part: row(() => true) });
    const agg = await engine.query({
      frame: {
        'ns/Thing': {
          params: { where: { _agg: { in: 'ns/Part.thing', count: true }, gt: 1 } },
          fields: { id: true }
        }
      },
      ctx
    });
    expect(agg.errors?.[0]).toMatchObject({
      code: 'row_policy_blocks_walk',
      path: ['ns/Thing', 'where', '_agg']
    });
    const nested = await engine.query({
      frame: {
        'ns/Thing': {
          params: {},
          fields: { id: true, parts: { _walk: { in: 'ns/Part.thing' }, fields: { id: true } } }
        }
      },
      ctx
    });
    expect(nested.errors?.[0]).toMatchObject({
      code: 'row_policy_blocks_walk',
      path: ['ns/Thing', 'fields', 'parts', '_walk']
    });
  });

  it('a seed under a row policy is refused for aggregate alone', async () => {
    const { engine, reached } = build({ Part: row(() => true) });
    const res = await engine.query({
      frame: { 'ns/Part': { params: { aggregate: { c: { count: true } } }, fields: { id: true } } },
      ctx
    });
    expect(res.errors?.[0]).toMatchObject({
      code: 'row_policy_blocks_walk',
      path: ['ns/Part', 'aggregate']
    });
    expect(reached()).toBe(0);
  });

  it('all and pick walks are judged as unfiltered reads; any keeps its where', async () => {
    const pub = { n: { gt: 2 } };
    const seen: unknown[] = [];
    const publicOnly: Policy = (_ctx, args) => {
      seen.push(args.params);
      return JSON.stringify(args.params?.where) === JSON.stringify(pub)
        ? { allow: true }
        : { allow: false, reason: 'public parts only' };
    };
    const { engine } = build({ Part: publicOnly });
    const q = (walk: Record<string, unknown>) =>
      engine.query({
        frame: {
          'ns/Thing': {
            params: { where: { _walk: { in: 'ns/Part.thing', where: pub, ...walk } } },
            fields: { id: true }
          }
        },
        ctx
      });
    expect((await q({})).errors ?? []).toEqual([]);
    for (const walk of [{ quantifier: 'all' }, { pick: { max: 'n' } }]) {
      expect((await q(walk)).errors?.[0]).toMatchObject({
        code: 'policy_denied',
        path: ['ns/Thing', 'where', '_walk']
      });
    }
    expect(seen).toEqual([{ where: pub }, {}, {}]);
  });

  it('checks a type walked at depth, inside OR/NOT and in a far-side where', async () => {
    const { engine } = build({ Note: () => ({ allow: false, reason: 'no notes' }) });
    const res = await engine.query({
      frame: {
        'ns/Thing': {
          params: {
            where: {
              OR: [
                { label: { eq: 'x' } },
                {
                  NOT: { _walk: { in: 'ns/Part.thing', where: { _walk: { in: 'ns/Note.part' } } } }
                }
              ]
            }
          },
          fields: { id: true }
        }
      },
      ctx
    });
    expect(res.errors?.[0]).toMatchObject({
      code: 'policy_denied',
      path: ['ns/Thing', 'where', 'OR', '1', 'NOT', '_walk', 'where', '_walk']
    });
  });
});

describe('walkedTypes', () => {
  const { engine } = build();
  const types = engine.schemaFor('ns').types;
  const resolve = hopResolver('ns', (t) => (Object.hasOwn(types, t) ? types[t] : undefined));

  it('lists walks, _agg and nested selections at any depth, deduplicated by (type, where)', () => {
    const got = walkedTypes(
      {
        params: {
          where: {
            AND: [
              { _walk: { in: 'ns/Part.thing' } },
              { _agg: { in: 'ns/Part.thing', count: true }, gt: 1 }
            ]
          }
        },
        fields: {
          parts: {
            _walk: { in: 'ns/Part.thing', where: { n: { gt: 1 } } },
            fields: { notes: { _walk: { in: 'ns/Note.part' }, fields: { id: true } } }
          }
        }
      },
      'Thing',
      resolve
    );
    expect(got).toEqual([
      { type: 'Part', path: ['where', 'AND', '0', '_walk'] },
      { type: 'Part', where: { n: { gt: 1 } }, path: ['fields', 'parts', '_walk'] },
      { type: 'Note', path: ['fields', 'parts', 'fields', 'notes', '_walk'] }
    ]);
  });

  it('keeps an any and an all walk over the same (type, where) apart', () => {
    const w = { n: { gt: 1 } };
    const got = walkedTypes(
      {
        params: {
          where: {
            AND: [
              { _walk: { in: 'ns/Part.thing', where: w } },
              { _walk: { in: 'ns/Part.thing', where: w, quantifier: 'all' } }
            ]
          }
        }
      },
      'Thing',
      resolve
    );
    expect(got).toEqual([
      { type: 'Part', where: w, path: ['where', 'AND', '0', '_walk'] },
      { type: 'Part', where: w, unfiltered: true, path: ['where', 'AND', '1', '_walk'] }
    ]);
  });

  it('resolves out-walks to the crossRef target', () => {
    expect(
      walkedTypes({ params: { where: { _walk: { out: 'thing' } } } }, 'Part', resolve)
    ).toEqual([{ type: 'Thing', path: ['where', '_walk'] }]);
  });
});

describe('walk grammar outside validated query paths', () => {
  it('a mutation selecting _agg or a nested walk is refused walks_in_mutation', async () => {
    const { engine } = build();
    for (const fields of [
      { id: true, _agg: { parts: { in: 'ns/Part.thing', count: true } } },
      { id: true, parts: { _walk: { in: 'ns/Part.thing' }, fields: { id: true } } }
    ]) {
      const res = await engine.mutate({
        frame: { 'ns/touchThing': { params: {}, fields } },
        ctx
      });
      expect(res.data).not.toHaveProperty('ns/touchThing');
      expect(res.errors?.[0]?.code).toBe('walks_in_mutation');
      expect(res.errors?.[0]?.path?.slice(0, 2)).toEqual(['ns/touchThing', 'fields']);
    }
  });

  it('a virtual type refuses walk grammar with walk_unsupported_ref', async () => {
    let reached = 0;
    const registry = new Registry();
    registry.register('Hit', {
      resolver: async () => {
        reached++;
        return [];
      }
    });
    const engine = new Engine({
      namespaces: new Map<string, NamespaceConfig>([['v', { registry, virtual: true }]]),
      datasets: new MemoryDatasetRegistry(),
      edges: new MemoryEdgesStore({ now: () => new Date('2026-04-18T00:00:00Z') })
    });
    const res = await engine.query({
      frame: {
        'v/Hit': { params: { where: { _walk: { in: 'v/Part.thing' } } }, fields: { id: true } }
      },
      ctx
    });
    expect(res.errors?.[0]).toMatchObject({
      code: 'walk_unsupported_ref',
      message: 'walks are not available on virtual types',
      path: ['v/Hit', 'where', '_walk']
    });
    expect(reached).toBe(0);
  });

  it("a virtual type's own params named like walk params reach its resolver (#1822)", async () => {
    let got: unknown;
    const registry = new Registry();
    registry.register('Hit', {
      resolver: async (_ctx, args) => {
        got = args.params;
        return [];
      }
    });
    const engine = new Engine({
      namespaces: new Map<string, NamespaceConfig>([['v', { registry, virtual: true }]]),
      datasets: new MemoryDatasetRegistry(),
      edges: new MemoryEdgesStore({ now: () => new Date('2026-04-18T00:00:00Z') })
    });
    const params = { count: true, aggregate: 'sum', groupBy: 'day', having: 1, offset: 2 };
    const res = await engine.query({ frame: { 'v/Hit': { params, fields: { id: true } } }, ctx });
    expect(res.errors).toBeUndefined();
    expect(got).toMatchObject(params);
    const agg = await engine.query({
      frame: {
        'v/Hit': { params: {}, fields: { id: true, _agg: { n: { in: 'v/X.y', count: true } } } }
      },
      ctx
    });
    expect(agg.errors?.[0]).toMatchObject({
      code: 'walk_unsupported_ref',
      path: ['v/Hit', 'fields', '_agg']
    });
  });
});

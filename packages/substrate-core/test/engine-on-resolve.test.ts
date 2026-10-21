import { MemoryDataset, MemoryDatasetRegistry } from '@mnmal-ai/substrate-dataset-memory';
import {
  type RequestContext,
  type ResolveObservation,
  ResolverFrameError
} from '@mnmal-ai/substrate-types';
import { describe, expect, it } from 'vitest';
import {
  createRuntimeStats,
  Engine,
  MemoryEdgesStore,
  type NamespaceConfig,
  Registry,
  type Resolver
} from '../src/index.js';

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function makeCtx(): Partial<RequestContext> {
  return { identity: null, now: new Date('2026-04-18T00:00:00Z'), headers: {}, meta: {} };
}

function build(onResolve?: (o: ResolveObservation) => void, extra?: (r: Registry) => void) {
  const registry = new Registry();
  const ok: Resolver = async () => {
    await delay(5);
    return [{ id: 1 }];
  };
  registry.register('Ok', { resolver: ok });
  // Ok2 resolves last, so Bad's error lands while Ok2 is still in flight.
  registry.register('Ok2', {
    resolver: async () => {
      await delay(25);
      return [{ id: 2 }];
    }
  });
  registry.register('Bad', {
    resolver: async () => {
      await delay(10);
      throw new ResolverFrameError('policy_denied', 'nope');
    }
  });
  registry.register('Boom', {
    resolver: async () => {
      throw new Error('boom');
    }
  });
  registry.register('createOk', { resolver: async () => ({ id: 1 }) });
  extra?.(registry);
  const namespaces = new Map<string, NamespaceConfig>([['ns', { registry }]]);
  const datasets = new MemoryDatasetRegistry();
  datasets.set('ns', new MemoryDataset({ namespace: 'ns' }));
  const edges = new MemoryEdgesStore({ now: () => new Date('2026-04-18T00:00:00Z') });
  return new Engine({
    namespaces,
    datasets,
    edges,
    ...(onResolve !== undefined ? { onResolve } : {})
  });
}

const f = { params: {}, fields: { id: true } };

describe('Engine onResolve', () => {
  it('observes each query key with its outcome', async () => {
    const seen: ResolveObservation[] = [];
    const engine = build((o) => seen.push(o));
    await engine.query({ frame: { 'ns/Ok': f, 'ns/Bad': f }, ctx: makeCtx() });
    expect(seen).toHaveLength(2);
    const ok = seen.find((o) => o.key === 'ns/Ok');
    const bad = seen.find((o) => o.key === 'ns/Bad');
    expect(ok).toMatchObject({ kind: 'query', ok: true });
    expect(bad).toMatchObject({ ok: false, code: 'policy_denied', message: 'nope' });
    for (const o of seen) expect(o.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('carries the caller identity id, and no caller when anonymous', async () => {
    const seen: ResolveObservation[] = [];
    const engine = build((o) => seen.push(o));
    await engine.query({
      frame: { 'ns/Bad': f },
      ctx: { ...makeCtx(), identity: { id: 'labs-claude@host', grants: {} } }
    });
    await engine.query({ frame: { 'ns/Bad': f }, ctx: makeCtx() });
    expect(seen[0]?.caller).toBe('labs-claude@host');
    expect(seen[1]).not.toHaveProperty('caller');
  });

  it('attributes errors by key under concurrency (50 iterations, overlapping delays)', async () => {
    for (let i = 0; i < 50; i++) {
      const seen: ResolveObservation[] = [];
      const engine = build((o) => seen.push(o));
      await engine.query({
        frame: { 'ns/Ok2': f, 'ns/Bad': f, 'ns/Ok': f },
        ctx: makeCtx()
      });
      expect(seen).toHaveLength(3);
      expect(seen.find((o) => o.key === 'ns/Ok')?.ok).toBe(true);
      // Ok2 finishes after Bad's error is already on the envelope.
      expect(seen.find((o) => o.key === 'ns/Ok2')?.ok).toBe(true);
      expect(seen.find((o) => o.key === 'ns/Bad')?.ok).toBe(false);
    }
  });

  it('observes an unknown name as unknown_name', async () => {
    const seen: ResolveObservation[] = [];
    const engine = build((o) => seen.push(o));
    await engine.query({ frame: { 'ns/Nope': f }, ctx: makeCtx() });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ key: '(unknown)', ok: false, code: 'unknown_name' });
  });

  it('observes each element of a batched mutate under the op key', async () => {
    const seen: ResolveObservation[] = [];
    const engine = build((o) => seen.push(o));
    await engine.mutate({ frame: { 'ns/createOk': [f, f] }, ctx: makeCtx() });
    expect(seen).toHaveLength(2);
    for (const o of seen) expect(o).toMatchObject({ key: 'ns/createOk', kind: 'mutate', ok: true });
  });

  it('observes a throwing resolver as exception and still rethrows', async () => {
    const seen: ResolveObservation[] = [];
    const engine = build((o) => seen.push(o));
    await expect(engine.query({ frame: { 'ns/Boom': f }, ctx: makeCtx() })).rejects.toThrow('boom');
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ ok: false, code: 'exception', message: 'boom' });
  });

  it('swallows a throwing hook', async () => {
    const engine = build(() => {
      throw new Error('sink down');
    });
    const env = await engine.query({ frame: { 'ns/Ok': f }, ctx: makeCtx() });
    expect(env.data['ns/Ok']).toEqual([{ id: 1 }]);
    expect(env.errors).toBeUndefined();
  });

  it('is inert without a hook', async () => {
    const engine = build();
    const env = await engine.query({ frame: { 'ns/Ok': f }, ctx: makeCtx() });
    expect(env.data['ns/Ok']).toEqual([{ id: 1 }]);
  });

  it('swallows a rejecting async hook without an unhandled rejection', async () => {
    const unhandled: unknown[] = [];
    const h = (e: unknown): void => {
      unhandled.push(e);
    };
    process.on('unhandledRejection', h);
    try {
      const engine = build(async () => {
        throw new Error('async sink down');
      });
      const env = await engine.query({ frame: { 'ns/Ok': f }, ctx: makeCtx() });
      expect(env.data['ns/Ok']).toEqual([{ id: 1 }]);
      await delay(20);
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', h);
    }
  });

  it('serial mutate: observes keys up to and including the throwing one, none after', async () => {
    const seen: ResolveObservation[] = [];
    const engine = build(
      (o) => seen.push(o),
      (r) =>
        r.register('createBoom', {
          resolver: async () => {
            throw new Error('mid');
          }
        })
    );
    await expect(
      engine.mutate({
        frame: { 'ns/createOk': f, 'ns/createBoom': f, 'ns/createAfter': f },
        ctx: makeCtx()
      })
    ).rejects.toThrow('mid');
    expect(seen.map((o) => o.key)).toEqual(['ns/createOk', 'ns/createBoom']);
    expect(seen[0]?.ok).toBe(true);
    expect(seen[1]).toMatchObject({ ok: false, code: 'exception' });
  });

  it('cross_tx_scope_refused yields no observations', async () => {
    const seen: ResolveObservation[] = [];
    const regA = new Registry();
    regA.register('createA', { resolver: async () => ({ id: 1 }) });
    const regB = new Registry();
    regB.register('createB', { resolver: async () => ({ id: 1 }) });
    const datasets = new MemoryDatasetRegistry();
    datasets.set('n1', new MemoryDataset({ namespace: 'n1' }));
    datasets.set('n2', new MemoryDataset({ namespace: 'n2' }));
    const engine = new Engine({
      namespaces: new Map([
        ['n1', { registry: regA }],
        ['n2', { registry: regB }]
      ]),
      datasets,
      edges: new MemoryEdgesStore({ now: () => new Date('2026-04-18T00:00:00Z') }),
      onResolve: (o) => seen.push(o)
    });
    const env = await engine.mutate({
      frame: { 'n1/createA': f, 'n2/createB': f },
      ctx: makeCtx()
    });
    expect(env.errors?.[0]?.code).toBe('cross_tx_scope_refused');
    expect(seen).toEqual([]);
  });

  it('batched refusal: one observation per element run, failing element carries its code', async () => {
    const seen: ResolveObservation[] = [];
    const engine = build(
      (o) => seen.push(o),
      (r) =>
        r.register('createMaybe', {
          resolver: async (_c, args) => {
            if ((args.params as { id?: unknown }).id === 'refuse') {
              throw new ResolverFrameError('not_found', 'gone');
            }
            return { id: 1 };
          }
        })
    );
    await engine.mutate({
      frame: {
        'ns/createMaybe': [
          { params: { id: 'a' } },
          { params: { id: 'refuse' } },
          { params: { id: 'c' } }
        ]
      },
      ctx: makeCtx()
    });
    expect(seen).toHaveLength(2);
    expect(seen[0]).toMatchObject({ key: 'ns/createMaybe', kind: 'mutate', ok: true });
    expect(seen[1]).toMatchObject({ ok: false, code: 'not_found' });
  });

  it('records unknown namespace, unknown name and unqualified keys under one sentinel, keeping kind', async () => {
    const seen: ResolveObservation[] = [];
    const engine = build((o) => seen.push(o));
    await engine.query({
      frame: { 'nope/X': f, 'ns/Missing': f, plain: f, 'ns/Ok': f },
      ctx: makeCtx()
    });
    await engine.mutate({ frame: { 'zzz/createX': f }, ctx: makeCtx() });
    const keys = seen.map((o) => o.key).sort();
    expect(keys).toEqual(['(unknown)', '(unknown)', '(unknown)', '(unknown)', 'ns/Ok']);
    expect(
      seen
        .filter((o) => o.key === '(unknown)')
        .map((o) => o.kind)
        .sort()
    ).toEqual(['mutate', 'query', 'query', 'query']);
    expect(seen.find((o) => o.key === '(unknown)' && o.kind === 'query')?.code).toMatch(
      /^unknown_|unqualified_key/
    );
  });

  it('600 hostile 4 KB keys leave real rows intact and retain little', async () => {
    const stats = createRuntimeStats({ activeSubscriptions: () => 0 });
    const engine = build((o) => stats.recordResolve(o));
    await engine.query({ frame: { 'ns/Ok': f }, ctx: makeCtx() });
    const frame: Record<string, typeof f> = {};
    for (let i = 0; i < 600; i++) frame[`x${i}\u001b[31m/${'A'.repeat(4096)}`] = f;
    await engine.query({ frame, ctx: makeCtx() });
    const snap = stats.snapshot();
    expect(snap.resolvers?.['ns/Ok']).toBeDefined();
    expect(Object.keys(snap.resolvers ?? {}).sort()).toEqual(['(unknown)', 'ns/Ok']);
    expect(snap.resolvers?.['(unknown)']?.calls).toBe(600);
    const blob = JSON.stringify([snap, stats.errors()]);
    expect(blob.length).toBeLessThan(64 * 1024);
    expect(blob).not.toContain('\\u001b');
    const errs = stats.errors().errors;
    expect(errs).toHaveLength(1);
    expect(errs[0]).toMatchObject({ key: '(unknown)', count: 600 });
    expect(snap.slowest?.some((x) => x.key === '(unknown)')).toBe(false);
  });

  it('one request of invented keys leaves 49 older real error entries intact', async () => {
    const stats = createRuntimeStats({ activeSubscriptions: () => 0 });
    for (let i = 0; i < 49; i++)
      stats.recordResolve({
        key: 'ns/Real',
        kind: 'query',
        durationMs: 1,
        ok: false,
        code: 'policy_denied',
        message: `m${i}`
      });
    const engine = build((o) => stats.recordResolve(o));
    const frame: Record<string, typeof f> = {};
    for (let i = 0; i < 600; i++) frame[`x${i}/${'A'.repeat(4096)}`] = f;
    await engine.query({ frame, ctx: makeCtx() });
    const errs = stats.errors().errors;
    expect(errs).toHaveLength(50);
    expect(errs.filter((e) => e.key === 'ns/Real')).toHaveLength(49);
    expect(errs[0]).toMatchObject({ key: '(unknown)', count: 600 });
    expect(stats.snapshot().slowest?.some((x) => x.key === '(unknown)')).toBe(false);
  });
});

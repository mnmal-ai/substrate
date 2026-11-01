/**
 * Batch resolvers (typed-tables Task 4): a mutate array whose registry entry
 * carries `batch` runs per-element preparation (grant, policy, pre-resolver
 * refusals, arg building) and then calls `batch` ONCE inside the array's
 * transaction. Post-commit subscription fanout groups events by type and
 * keeps each subscriber's frames exactly as per-event dispatch emits them.
 */

import { MemoryDataset, MemoryDatasetRegistry } from '@mnmal-ai/substrate-dataset-memory';
import { row } from '@mnmal-ai/substrate-policy';
import {
  BatchElementError,
  type BatchResolver,
  type Policy,
  type RequestContext,
  type ResolveObservation,
  type ResolverArgs,
  ResolverFrameError,
  type Row,
  type WsResponseFrame
} from '@mnmal-ai/substrate-types';
import { describe, expect, it } from 'vitest';
import {
  Engine,
  MemoryEdgesStore,
  MemoryIdempotencyStore,
  type NamespaceConfig,
  Registry
} from '../src/index.js';

const NS = 'default';
const KEY = `${NS}/createThing`;
const NOW = (): Date => new Date('2026-11-01T00:00:00Z');

function ctxFor(kid: string | null = null): Partial<RequestContext> {
  return {
    identity: kid === null ? null : { id: kid, grants: { '*': ['read', 'mutate'] } },
    now: NOW(),
    headers: {},
    meta: {}
  };
}

interface Counters {
  batchCalls: number;
  resolverCalls: number;
  seen: Array<readonly ResolverArgs[]>;
}

function thingOf(args: ResolverArgs): Row {
  const p = (args.params ?? {}) as Record<string, unknown>;
  const r: Row = { id: String(p.id) };
  for (const f of ['title', 'owner', 'kind']) if (p[f] !== undefined) r[f] = p[f];
  return r;
}

/** Projects `r` onto the caller's selection, as a real resolver narrows its RETURNING list. */
function project(r: Row, fields: ResolverArgs['fields']): Row {
  if (fields === undefined) return r;
  const out: Row = { id: r.id };
  for (const f of Object.keys(fields)) if (f in r) out[f] = r[f];
  return out;
}

interface Built {
  engine: Engine;
  dataset: MemoryDataset;
  counters: Counters;
}

function build(
  opts: {
    batch?: BatchResolver;
    /** No `batch` on the entry: the per-element loop, as a reference. */
    noBatch?: boolean;
    /** The per-element resolver; by default it must never run. */
    resolver?: (args: ResolverArgs) => Promise<Row>;
    policy?: Policy;
    typePolicy?: Policy;
    idempotency?: boolean;
    onResolve?: (o: ResolveObservation) => void;
  } = {}
): Built {
  const counters: Counters = { batchCalls: 0, resolverCalls: 0, seen: [] };
  const dataset = new MemoryDataset({ namespace: NS });
  const registry = new Registry();

  // Writes every element in one dataset call and announces each row, the
  // shape a set-wise create takes. kind 'log' rows go to a second type so
  // one batch emits events of two types, interleaved.
  const defaultBatch: BatchResolver = async (_ctx, argsList) => {
    const ds = argsList[0]?.dataset;
    if (ds === undefined) throw new Error('expected engine-injected args.dataset');
    const rows = argsList.map(thingOf);
    const existing = new Set((await ds.read('Thing', {})).rows.map((r) => r.id as string));
    await ds.write('Thing', rows);
    argsList.forEach((a, i) => {
      const r = rows[i] as Row;
      a.onWrite?.({
        ns: NS,
        type: 'Thing',
        id: r.id,
        operation: existing.has(r.id as string) ? 'update' : 'create',
        row: r
      });
      if (r.kind === 'log') {
        a.onWrite?.({
          ns: NS,
          type: 'Log',
          id: `log-${r.id}`,
          operation: 'create',
          row: { id: `log-${r.id}` }
        });
      }
    });
    return rows.map((r, i) => project(r, argsList[i]?.fields));
  };
  const inner = opts.batch ?? defaultBatch;
  const batch: BatchResolver = async (ctx, argsList) => {
    counters.batchCalls++;
    counters.seen.push(argsList);
    return inner(ctx, argsList);
  };

  registry.register('Thing', {
    fields: { title: { kind: 'scalar', type: 'string', indexed: true } },
    resolver: async (_ctx, args) => (await (args.dataset as MemoryDataset).read('Thing', {})).rows,
    ...(opts.typePolicy !== undefined ? { policy: opts.typePolicy } : {})
  });
  registry.register('Log', {
    resolver: async (_ctx, args) => (await (args.dataset as MemoryDataset).read('Log', {})).rows
  });
  registry.register('createThing', {
    kind: 'mutation',
    resolver: async (_ctx, args) => {
      counters.resolverCalls++;
      if (opts.resolver !== undefined) return opts.resolver(args);
      throw new Error('per-element resolver must not run when batch is registered');
    },
    ...(opts.noBatch === true ? {} : { batch }),
    ...(opts.policy !== undefined ? { policy: opts.policy } : {})
  });

  const datasets = new MemoryDatasetRegistry();
  datasets.set(NS, dataset);
  const engine = new Engine({
    namespaces: new Map<string, NamespaceConfig>([[NS, { registry }]]),
    datasets,
    edges: new MemoryEdgesStore({ now: NOW }),
    ...(opts.idempotency === true ? { idempotency: { store: new MemoryIdempotencyStore() } } : {}),
    ...(opts.onResolve !== undefined ? { onResolve: opts.onResolve } : {})
  });
  return { engine, dataset, counters };
}

const frames = (n: number, extra: (i: number) => Record<string, unknown> = () => ({})) =>
  Array.from({ length: n }, (_, i) => ({ params: { id: `t${i}`, title: `n${i}`, ...extra(i) } }));

async function ids(ds: MemoryDataset): Promise<string[]> {
  return (await ds.read('Thing', {})).rows.map((r) => r.id as string).sort();
}

function codesAt(errors: Array<{ code?: string; path?: string[] }> | undefined) {
  return (errors ?? []).map((e) => ({ code: e.code, path: e.path }));
}

describe('batch resolvers: one call per mutate array', () => {
  it('array of 50 calls batch once and resolver never', async () => {
    const { engine, dataset, counters } = build();
    const env = await engine.mutate({ frame: { [KEY]: frames(50) }, ctx: ctxFor() });

    expect(env.errors).toBeUndefined();
    expect(counters.batchCalls).toBe(1);
    expect(counters.resolverCalls).toBe(0);
    expect(counters.seen[0]).toHaveLength(50);
    const data = env.data[KEY] as Row[];
    expect(data).toHaveLength(50);
    expect(data[0]).toEqual({ id: 't0', title: 'n0' });
    expect(data[49]).toEqual({ id: 't49', title: 'n49' });
    expect(env.shapes[KEY]).toEqual(Array(50).fill('single'));
    expect(await ids(dataset)).toHaveLength(50);
  });

  it('per-element fields shape each slot', async () => {
    // A row policy on the mutation: each slot is shaped under its own
    // decision, so the hidden row empties only its own slot.
    const policy = row<Row>((_c, r) => r.title !== 'hidden');
    const { engine, counters } = build({ policy });
    const env = await engine.mutate({
      frame: {
        [KEY]: [
          { params: { id: 'a', title: 'A', owner: 'x' }, fields: { title: true } },
          { params: { id: 'b', title: 'hidden', owner: 'y' }, fields: { owner: true } },
          { params: { id: 'c', title: 'C', owner: 'z' }, fields: { owner: true, title: true } }
        ]
      },
      ctx: ctxFor()
    });

    expect(env.errors).toBeUndefined();
    // Under a row filter the engine drops `fields` so the filter sees whole rows.
    expect(counters.seen[0]?.map((a) => a.fields)).toEqual([undefined, undefined, undefined]);
    expect(env.data[KEY]).toEqual([
      { id: 'a', title: 'A', owner: 'x' },
      null,
      { id: 'c', title: 'C', owner: 'z' }
    ]);
    expect(env.shapes[KEY]).toEqual(['single', 'single', 'single']);

    // Without a row filter each element's own selection reaches its args.
    const plain = build();
    const env2 = await plain.engine.mutate({
      frame: {
        [KEY]: [
          { params: { id: 'a', title: 'A', owner: 'x' }, fields: { title: true } },
          { params: { id: 'b', title: 'B', owner: 'y' }, fields: { owner: true } }
        ]
      },
      ctx: ctxFor()
    });
    expect(plain.counters.seen[0]?.map((a) => a.fields)).toEqual([
      { title: true },
      { owner: true }
    ]);
    expect(env2.data[KEY]).toEqual([
      { id: 'a', title: 'A' },
      { id: 'b', owner: 'y' }
    ]);
  });

  it('BatchElementError(7) rolls back all: cause code at [key], batched_frame_rolled_back at [key,"7"]', async () => {
    const { engine, dataset, counters } = build({
      batch: async (_ctx, argsList) => {
        await argsList[0]?.dataset?.write('Thing', argsList.map(thingOf));
        throw new BatchElementError(7, new ResolverFrameError('id_exists', 'id t7 exists'));
      }
    });
    const env = await engine.mutate({ frame: { [KEY]: frames(10) }, ctx: ctxFor() });

    expect(counters.batchCalls).toBe(1);
    expect(codesAt(env.errors)).toEqual([
      { code: 'id_exists', path: [KEY] },
      { code: 'batched_frame_rolled_back', path: [KEY, '7'] }
    ]);
    expect(env.errors?.[1]?.message).toContain('at frame[7]');
    expect(env.errors?.[1]?.message).toContain('id t7 exists');
    expect(env.data[KEY]).toBeUndefined();
    expect(await ids(dataset)).toEqual([]);
  });

  it('any other throw from batch rolls back all as an internal error at [key], observed once', async () => {
    const seen: ResolveObservation[] = [];
    const { engine, dataset } = build({
      onResolve: (o) => void seen.push(o),
      batch: async (_ctx, argsList) => {
        await argsList[0]?.dataset?.write('Thing', argsList.map(thingOf));
        throw new Error('connection reset');
      }
    });
    const env = await engine.mutate({ frame: { [KEY]: frames(50) }, ctx: ctxFor() });

    expect(codesAt(env.errors)).toEqual([{ code: 'batched_frame_rolled_back', path: [KEY] }]);
    expect(env.errors?.[0]?.message).toContain('internal error');
    expect(await ids(dataset)).toEqual([]);
    // One failure, not 50: a failed batch must not flush the runtime error ring.
    expect(seen.map((o) => ({ ok: o.ok, code: o.code, batchSize: o.batchSize }))).toEqual([
      { ok: false, code: 'exception', batchSize: 50 }
    ]);
  });

  /** Writes its element; refuses `t2` when `refuse` is set, as a unique index would. */
  const perElement =
    (refuse: boolean) =>
    async (args: ResolverArgs): Promise<Row> => {
      const r = thingOf(args);
      if (refuse && r.id === 't2') throw new ResolverFrameError('unique_violation', 'dup t2');
      await args.dataset?.write('Thing', [r]);
      args.onWrite?.({ ns: NS, type: 'Thing', id: r.id, operation: 'create', row: r });
      return r;
    };
  const bareRefusal =
    (code: string): BatchResolver =>
    async (_ctx, argsList) => {
      await argsList[0]?.dataset?.write('Thing', argsList.map(thingOf));
      throw new ResolverFrameError(code, `${code} somewhere in the batch`);
    };

  it("a bare ResolverFrameError from batch re-runs the array per element: the envelope is the loop's", async () => {
    const seen: ResolveObservation[] = [];
    const batched = build({
      onResolve: (o) => void seen.push(o),
      batch: bareRefusal('unique_violation'),
      resolver: perElement(true)
    });
    const loop = build({ noBatch: true, resolver: perElement(true) });
    const env = await batched.engine.mutate({ frame: { [KEY]: frames(5) }, ctx: ctxFor() });
    const ref = await loop.engine.mutate({ frame: { [KEY]: frames(5) }, ctx: ctxFor() });

    expect(env).toEqual(ref);
    expect(codesAt(env.errors)).toEqual([
      { code: 'unique_violation', path: [KEY] },
      { code: 'batched_frame_rolled_back', path: [KEY, '2'] }
    ]);
    expect(batched.counters.batchCalls).toBe(1);
    expect(batched.counters.resolverCalls).toBe(3);
    expect(await ids(batched.dataset)).toEqual([]);
    // The failed batch call keeps its one observation; the re-run reports per element.
    expect(seen[0]).toMatchObject({ ok: false, code: 'unique_violation', batchSize: 5 });
    expect(seen.slice(1).map((o) => ({ ok: o.ok, batchSize: o.batchSize }))).toEqual([
      { ok: true, batchSize: undefined },
      { ok: true, batchSize: undefined },
      { ok: false, batchSize: undefined }
    ]);
  });

  it("a re-run the first attempt's fault does not hit commits, as the loop would", async () => {
    const seen: ResolveObservation[] = [];
    const writes: WsResponseFrame[] = [];
    const batched = build({
      onResolve: (o) => void seen.push(o),
      batch: bareRefusal('query_timeout'),
      resolver: perElement(false)
    });
    const loop = build({ noBatch: true, resolver: perElement(false) });
    const handle = await batched.engine.subscribe({
      id: 's',
      frame: { 'default/Thing': { params: {}, fields: { id: true } } },
      ctx: ctxFor(),
      onFrame: (f) => void writes.push(f)
    });
    const env = await batched.engine.mutate({ frame: { [KEY]: frames(5) }, ctx: ctxFor() });
    const ref = await loop.engine.mutate({ frame: { [KEY]: frames(5) }, ctx: ctxFor() });
    handle.cancel();

    expect(env).toEqual(ref);
    expect(env.errors).toBeUndefined();
    expect(await ids(batched.dataset)).toEqual(['t0', 't1', 't2', 't3', 't4']);
    // Only the committed re-run's writes reach subscribers, once each.
    expect(writes.filter((f) => f.kind === 'add')).toHaveLength(5);
    expect(seen.map((o) => o.ok)).toEqual([false, true, true, true, true, true]);
    expect(seen[0]).toMatchObject({ code: 'query_timeout', batchSize: 5 });
  });

  it('a wrong-length result or an out-of-range element index is one exception observation', async () => {
    for (const batch of [
      async () => [] as Row[],
      async () => {
        throw new BatchElementError(9, new ResolverFrameError('id_exists', 'dup'));
      }
    ] satisfies BatchResolver[]) {
      const seen: ResolveObservation[] = [];
      const { engine } = build({ onResolve: (o) => void seen.push(o), batch });
      const env = await engine.mutate({ frame: { [KEY]: frames(3) }, ctx: ctxFor() });

      expect(codesAt(env.errors)).toEqual([{ code: 'batched_frame_rolled_back', path: [KEY] }]);
      expect(env.errors?.[0]?.message).toContain('internal error');
      expect(seen.map((o) => ({ ok: o.ok, code: o.code, batchSize: o.batchSize }))).toEqual([
        { ok: false, code: 'exception', batchSize: 3 }
      ]);
    }
  });

  it('policy deny on element 3 refuses at index 3 before batch runs', async () => {
    const policy: Policy = (_ctx, args) =>
      args.params?.title === 'deny' ? { allow: false, reason: 'no' } : { allow: true };
    const { engine, dataset, counters } = build({ policy });
    const env = await engine.mutate({
      frame: { [KEY]: frames(6, (i) => (i === 3 ? { title: 'deny' } : {})) },
      ctx: ctxFor()
    });

    expect(counters.batchCalls).toBe(0);
    expect(codesAt(env.errors)).toEqual([
      { code: 'policy_denied', path: [KEY] },
      { code: 'batched_frame_rolled_back', path: [KEY, '3'] }
    ]);
    expect(await ids(dataset)).toEqual([]);
  });

  it('a pre-resolver refusal on element 2 (walk in a mutation) refuses at index 2 before batch runs', async () => {
    // F26: the brief names the filter guard, which only runs on type reads; on
    // a mutation the pre-resolver refusals are policy, the walk refusal and
    // the cursor check. This pins the walk refusal.
    const { engine, dataset, counters } = build();
    const fs = frames(5) as Array<Record<string, unknown>>;
    fs[2] = { ...fs[2], fields: { _agg: { n: { count: true } } } };
    const env = await engine.mutate({ frame: { [KEY]: fs }, ctx: ctxFor() });

    expect(counters.batchCalls).toBe(0);
    expect(codesAt(env.errors)).toEqual([
      { code: 'walks_in_mutation', path: [KEY, 'fields', '_agg'] },
      { code: 'batched_frame_rolled_back', path: [KEY, '2'] }
    ]);
    expect(await ids(dataset)).toEqual([]);
  });

  it('onResolve gets one ResolveObservation per element', async () => {
    const seen: ResolveObservation[] = [];
    const { engine } = build({ onResolve: (o) => void seen.push(o) });
    await engine.mutate({ frame: { [KEY]: frames(4) }, ctx: ctxFor('alice@host') });

    expect(seen).toHaveLength(4);
    for (const o of seen) {
      expect(o).toMatchObject({
        key: KEY,
        kind: 'mutate',
        ok: true,
        caller: 'alice@host',
        batchSize: 4
      });
      // The batch call's real time, not a 1/N share.
      expect(o.durationMs).toBe(seen[0]?.durationMs);
      expect(o.durationMs).toBeGreaterThanOrEqual(0);
    }
    expect(seen.map((o) => o.batchIndex)).toEqual([0, 1, 2, 3]);
  });

  it('onResolve reports the refusing element of a rolled-back batch', async () => {
    const seen: ResolveObservation[] = [];
    const { engine } = build({
      onResolve: (o) => void seen.push(o),
      batch: async () => {
        throw new BatchElementError(1, new ResolverFrameError('id_exists', 'dup'));
      }
    });
    await engine.mutate({ frame: { [KEY]: frames(3) }, ctx: ctxFor() });

    expect(seen.map((o) => ({ ok: o.ok, code: o.code }))).toEqual([
      { ok: true, code: undefined },
      { ok: false, code: 'id_exists' }
    ]);
  });

  it('cached idempotency slots skip batch; slot order preserved', async () => {
    const { engine, counters } = build({ idempotency: true });
    const first = await engine.mutate({
      frame: {
        [KEY]: [
          { params: { id: 'a', title: 'A1' }, idempotencyKey: 'k0' },
          { params: { id: 'b', title: 'B1' } },
          { params: { id: 'c', title: 'C1' }, idempotencyKey: 'k2' }
        ]
      },
      ctx: ctxFor()
    });
    expect(first.errors).toBeUndefined();
    expect(counters.batchCalls).toBe(1);

    // Slots 0 and 2 replay; 1 and 3 run. Replays return the FIRST call's rows.
    const second = await engine.mutate({
      frame: {
        [KEY]: [
          { params: { id: 'a', title: 'A2' }, idempotencyKey: 'k0' },
          { params: { id: 'd', title: 'D2' } },
          { params: { id: 'c', title: 'C2' }, idempotencyKey: 'k2' },
          { params: { id: 'e', title: 'E2' } }
        ]
      },
      ctx: ctxFor()
    });
    expect(second.errors).toBeUndefined();
    expect(counters.batchCalls).toBe(2);
    expect(counters.seen[1]?.map((a) => a.params?.id)).toEqual(['d', 'e']);
    expect(second.data[KEY]).toEqual([
      { id: 'a', title: 'A1' },
      { id: 'd', title: 'D2' },
      { id: 'c', title: 'C1' },
      { id: 'e', title: 'E2' }
    ]);

    // Every slot cached: batch is not called at all.
    const third = await engine.mutate({
      frame: {
        [KEY]: [{ params: { id: 'a' }, idempotencyKey: 'k0' }]
      },
      ctx: ctxFor()
    });
    expect(third.errors).toBeUndefined();
    expect(counters.batchCalls).toBe(2);
    expect(third.data[KEY]).toEqual([{ id: 'a', title: 'A1' }]);
  });
});

interface Collector {
  frames: WsResponseFrame[];
  onFrame: (f: WsResponseFrame) => void;
}

function collector(): Collector {
  const out: WsResponseFrame[] = [];
  return { frames: out, onFrame: (f): void => void out.push(f) };
}

async function subscribe(
  engine: Engine,
  id: string,
  type: string,
  kid: string | null,
  where?: Record<string, unknown>
): Promise<Collector> {
  const c = collector();
  await engine.subscribe({
    id,
    frame: { [`${NS}/${type}`]: { params: where !== undefined ? { where } : {} } },
    ctx: ctxFor(kid),
    onFrame: c.onFrame
  });
  return c;
}

/** Frame delivery is enqueue + lazy drain: wait until the queues are quiet. */
async function quiesce(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 2));
}

/** Push frames as (subscriber, op, id), snapshots dropped. */
function pushes(sub: string, c: Collector, type: string): Array<[string, string, unknown]> {
  return c.frames
    .filter((f) => f.kind !== 'snapshot')
    .map((f) => [
      sub,
      f.kind,
      f.kind === 'remove'
        ? f.removedId
        : (f.data as Record<string, Row> | undefined)?.[`${NS}/${type}`]?.id
    ]);
}

describe('dispatchWrites: post-commit fanout', () => {
  it('one subscription over two types gets frames in emit order', async () => {
    // One subscribe() with two keys shares one id and one onFrame. Events:
    // Thing a (no match), Log log-a, Thing b (match).
    const { engine } = build();
    const c = collector();
    await engine.subscribe({
      id: 's1',
      frame: {
        [`${NS}/Thing`]: { params: { where: { title: { eq: 'x' } } } },
        [`${NS}/Log`]: {}
      },
      ctx: ctxFor(),
      onFrame: c.onFrame
    });

    const env = await engine.mutate({
      frame: {
        [KEY]: [
          { params: { id: 'a', title: 'y', kind: 'log' } },
          { params: { id: 'b', title: 'x' } }
        ]
      },
      ctx: ctxFor()
    });
    expect(env.errors).toBeUndefined();
    await quiesce();

    const wire = c.frames
      .filter((f) => f.kind !== 'snapshot')
      .map((f) => {
        const data = (f.data ?? {}) as Record<string, Row>;
        return `${f.kind}:${(data[`${NS}/Thing`] ?? data[`${NS}/Log`])?.id}`;
      });
    expect(wire).toEqual(['add:log-a', 'add:b']);
  });

  it('row-policy subscriber gets frames only for rows it may see', async () => {
    const { engine } = build({
      typePolicy: row<Row>((c, r) => r.owner === c.identity?.id)
    });
    const alice = await subscribe(engine, 's-alice', 'Thing', 'alice@host');
    const bob = await subscribe(engine, 's-bob', 'Thing', 'bob@host');

    const env = await engine.mutate({
      frame: { [KEY]: frames(10, (i) => ({ owner: i % 2 === 0 ? 'alice@host' : 'bob@host' })) },
      ctx: ctxFor()
    });
    expect(env.errors).toBeUndefined();
    await quiesce();

    expect(pushes('alice', alice, 'Thing')).toEqual(
      [0, 2, 4, 6, 8].map((i) => ['alice', 'add', `t${i}`])
    );
    expect(pushes('bob', bob, 'Thing')).toEqual(
      [1, 3, 5, 7, 9].map((i) => ['bob', 'add', `t${i}`])
    );
  });

  it('dispatchWrites over one batch emits the expected frames', async () => {
    const { engine, dataset } = build();
    await dataset.write('Thing', [
      { id: 't1', title: 'open' },
      { id: 't3', title: 'open' }
    ]);
    const all = await subscribe(engine, 's-all', 'Thing', null);
    const open = await subscribe(engine, 's-open', 'Thing', null, { title: { eq: 'open' } });
    const log = await subscribe(engine, 's-log', 'Log', null);

    // One batch: creates and updates of Thing, with Log events interleaved
    // between them (kind 'log' emits a Log create right after its Thing event).
    const env = await engine.mutate({
      frame: {
        [KEY]: [
          { params: { id: 't0', title: 'open', kind: 'log' } },
          { params: { id: 't1', title: 'closed' } },
          { params: { id: 't2', title: 'draft', kind: 'log' } },
          { params: { id: 't3', title: 'open' } },
          { params: { id: 't4', title: 'open', kind: 'log' } }
        ]
      },
      ctx: ctxFor()
    });
    expect(env.errors).toBeUndefined();
    await quiesce();

    // Today's per-event behaviour, written out: each event in emit order,
    // judged against each subscriber's where and the ids it already holds.
    expect(pushes('all', all, 'Thing')).toEqual([
      ['all', 'add', 't0'],
      ['all', 'update', 't1'],
      ['all', 'add', 't2'],
      ['all', 'update', 't3'],
      ['all', 'add', 't4']
    ]);
    expect(pushes('open', open, 'Thing')).toEqual([
      ['open', 'add', 't0'],
      ['open', 'remove', 't1'],
      ['open', 'update', 't3'],
      ['open', 'add', 't4']
    ]);
    expect(pushes('log', log, 'Log')).toEqual([
      ['log', 'add', 'log-t0'],
      ['log', 'add', 'log-t2'],
      ['log', 'add', 'log-t4']
    ]);
  });
});

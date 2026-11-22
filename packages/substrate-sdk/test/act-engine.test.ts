/**
 * `Engine.act` over memory datasets: one transaction per sketch, every step
 * through the caller's grants and policies, hooks on commit only, and result
 * records only their owner can read.
 */

import { Engine, MemoryEdgesStore, type NamespaceConfig, Registry } from '@mnmal-ai/substrate-core';
import { MemoryDataset, MemoryDatasetRegistry } from '@mnmal-ai/substrate-dataset-memory';
import type {
  ActionDecl,
  ActResponse,
  ActResultRecord,
  ActResultStore,
  CommittedWriteBatch,
  Identity,
  Row,
  WsResponseFrame
} from '@mnmal-ai/substrate-types';
import { describe, expect, it } from 'vitest';
import { defineNamespace, field } from '../src/index.js';

const NOW = new Date('2026-05-01T12:00:00.000Z');
const both = ['read', 'mutate'];
const caller = (id: string, grants: Identity['grants']): Identity => ({
  id,
  agentKeyId: `${id}-key`,
  grants
});
const alice = caller('alice', { work: both, journal: both });
const dan = caller('dan', { work: both, journal: both });
const bob = caller('bob', { work: ['read'], journal: both });
const carol = caller('carol', { journal: both });
const admin = caller('admin', { '*': both });
const as = (identity: Identity) => ({ identity, now: NOW });

const todoFields = {
  title: field.string(),
  status: field.vocab(['open', 'closed', 'deferred'], {
    default: 'open',
    aliases: { done: 'closed' },
    implies: { done: { resolution: 'completed' } }
  }),
  resolution: field.enum(['completed', 'wont_do'], { nullable: true }),
  archived: field.boolean({ default: false }),
  priority: field.enum(['low', 'medium', 'high'], { default: 'medium' }),
  big: field.int64({ nullable: true })
};
const close: ActionDecl = { past: 'closed', set: { status: 'closed', archived: true } };
const log: ActionDecl = {
  kind: 'create',
  past: 'logged',
  params: {
    summary: { type: field.string() },
    branch: { type: field.string() },
    closes: { list: 'work/Todo', optional: true }
  },
  set: { summary: { param: 'summary' }, branch: { param: 'branch' }, startedAt: { now: true } },
  // biome-ignore lint/suspicious/noThenProperty: `then` is the action declaration's key
  then: [{ action: 'work/Todo.close', each: { param: 'closes' } }]
};

interface Booted {
  engine: Engine;
  work: MemoryDataset;
  journal: MemoryDataset;
  batches: CommittedWriteBatch[];
  metrics: string[];
}

/** `coalesce: false` puts the two namespaces on separate substrates. */
function boot(opts: { coalesce?: boolean; results?: ActResultStore } = {}): Booted {
  const coalesce = opts.coalesce ?? true;
  const edges = new MemoryEdgesStore({ now: () => NOW });
  // `walkReference` answers `count: true`, which is walk grammar.
  const dsOpts = { walkReference: true, ...(coalesce ? { txScopeId: 'mem:act' } : {}) };
  const work = new MemoryDataset({ namespace: 'work', ...dsOpts });
  const journal = new MemoryDataset({ namespace: 'journal', ...dsOpts });
  if (coalesce) {
    // One transaction over both namespaces, as one pg substrate gives.
    const withScopedTransaction = (
      nss: string[],
      fn: (h: { datasets: Map<string, MemoryDataset>; edges: null }) => Promise<unknown>
    ) =>
      work.withTransaction(() =>
        journal.withTransaction(() =>
          fn({
            datasets: new Map(nss.map((n) => [n, n === 'work' ? work : journal])),
            edges: null
          })
        )
      );
    Object.assign(work, { withScopedTransaction });
    Object.assign(journal, { withScopedTransaction });
  }
  const workReg = new Registry();
  const journalReg = new Registry();
  defineNamespace('work', {
    Todo: { fields: todoFields, actions: { close } },
    Note: { fields: { title: field.string(), todo: field.crossRef('work', 'Todo') } }
  }).install({ registry: workReg, dataset: work, edges });
  defineNamespace('journal', {
    SessionLog: {
      fields: { summary: field.string(), branch: field.string(), startedAt: field.date() },
      actions: { log }
    }
  }).install({ registry: journalReg, dataset: journal, edges });
  const calc = new Registry();
  calc.register('Sum', {
    kind: 'type',
    fields: { total: field.number() },
    resolver: async () => []
  });
  const datasets = new MemoryDatasetRegistry();
  datasets.set('work', work);
  datasets.set('journal', journal);
  const batches: CommittedWriteBatch[] = [];
  const metrics: string[] = [];
  const engine = new Engine({
    namespaces: new Map<string, NamespaceConfig>([
      ['work', { registry: workReg }],
      ['journal', { registry: journalReg }],
      ['calc', { registry: calc, virtual: true }]
    ]),
    datasets,
    edges,
    metric: (name) => metrics.push(name),
    committedWritesHooks: [{ plugin: 'test', hook: (b) => void batches.push(b) }],
    ...(opts.results !== undefined ? { act: { results: opts.results } } : {})
  });
  return { engine, work, journal, batches, metrics };
}

async function seedTodos(engine: Engine, n: number): Promise<void> {
  for (let i = 1; i <= n; i++) {
    const env = await engine.mutate({
      frame: { 'work/createTodo': { params: { title: `t${i}` }, fields: { id: true } } },
      ctx: as(alice)
    });
    expect(env.errors).toBeUndefined();
  }
}

async function todo(work: MemoryDataset, shortId: number): Promise<Row> {
  const { rows } = await work.read('Todo', { where: { shortId: { eq: shortId } } });
  return rows[0] as Row;
}

const all = async (ds: MemoryDataset, type: string): Promise<Row[]> =>
  (await ds.read(type, { limit: 5000 })).rows;

function resultOf(r: ActResponse): string {
  if (!('result' in r) || r.result === null) throw new Error(`no result: ${JSON.stringify(r)}`);
  return r.result;
}

async function recordOf(engine: Engine, r: ActResponse, who = alice): Promise<ActResultRecord> {
  const rec = await engine.actResult(resultOf(r), who);
  if (rec === undefined) throw new Error('no record');
  return rec;
}

describe('Engine.act', () => {
  it('runs a composite across namespaces and keeps its record', async () => {
    const { engine, work } = boot();
    await seedTodos(engine, 2);
    const r = await engine.act({
      sketch: 'log SessionLog summary=s branch=b closes=#1,#2',
      ctx: as(alice)
    });
    expect(r).toEqual({
      ok: true,
      ack: 'logged journal/SessionLog #1; closed work/Todo #1 #2',
      result: expect.stringMatching(/^r_/)
    });
    for (const n of [1, 2]) {
      expect(await todo(work, n)).toMatchObject({ status: 'closed', archived: true });
    }
    const rec = await recordOf(engine, r);
    expect(rec.ok).toBe(true);
    expect(rec.steps).toHaveLength(3);
    expect(rec.plan.steps).toHaveLength(3);
  });

  it('commits nothing when a later step fails', async () => {
    const { engine, work } = boot();
    await seedTodos(engine, 1);
    const r = await engine.act({ sketch: 'close Todo #1; close Todo #999999', ctx: as(alice) });
    // `not_found` is autoCRUD update's code for a missing row.
    expect(r).toMatchObject({ ok: false, error: { step: 2, code: 'not_found' } });
    // The resolver's `where: { shortId }` hint names a query shape no sketch writes.
    expect('error' in r && r.error.message).not.toContain('shortId');
    expect(await todo(work, 1)).toMatchObject({ status: 'open', archived: false });
    expect((await recordOf(engine, r)).error?.step).toBe(2);
  });

  it('a dry run reports the plan, writes nothing and dispatches nothing', async () => {
    const { engine, work, batches } = boot();
    await seedTodos(engine, 1);
    await engine.hooksSettled();
    batches.length = 0;
    const frames: WsResponseFrame[] = [];
    for (const type of ['Todo', 'Note']) {
      await engine.subscribe({
        id: type,
        frame: { [`work/${type}`]: { params: {}, fields: { id: true } } },
        ctx: as(alice),
        onFrame: (f) => void frames.push(f)
      });
    }
    expect(frames.map((f) => f.kind)).toEqual(['snapshot', 'snapshot']);
    const r = await engine.act({
      sketch: 'create Note title=x; close Todo #1',
      mode: 'dry-run',
      ctx: as(alice)
    });
    expect(r).toMatchObject({
      ok: true,
      ack: expect.stringMatching(/^dry run: created work\/Note/)
    });
    expect(await all(work, 'Note')).toEqual([]);
    expect(await todo(work, 1)).toMatchObject({ status: 'open' });
    await engine.hooksSettled();
    expect(frames).toHaveLength(2);
    expect(batches).toEqual([]);
  });

  it('dispatches subscribers and committed-write hooks once a write commits', async () => {
    const { engine, batches } = boot();
    const frames: WsResponseFrame[] = [];
    await engine.subscribe({
      id: 'notes',
      frame: { 'work/Note': { params: {}, fields: { id: true } } },
      ctx: as(alice),
      onFrame: (f) => void frames.push(f)
    });
    await engine.act({ sketch: 'create Note title=x', ctx: as(alice) });
    await engine.hooksSettled();
    expect(frames.map((f) => f.kind)).toEqual(['snapshot', 'add']);
    expect(batches).toHaveLength(1);
  });

  it('runs each step under the caller grant', async () => {
    const { engine, journal } = boot();
    await seedTodos(engine, 1);
    const r = await engine.act({
      sketch: 'log SessionLog summary=s branch=b closes=#1',
      ctx: as(bob)
    });
    // checkIdentityGrant's code for a namespace granted without `mutate`.
    expect(r).toMatchObject({ ok: false, error: { step: 2, code: 'unauthorized_capability' } });
    expect(await all(journal, 'SessionLog')).toEqual([]);
  });

  it('find reads what query reads, and an unreadable namespace is not in the schema', async () => {
    const { engine } = boot();
    await seedTodos(engine, 3);
    await engine.act({ sketch: 'close Todo #2', ctx: as(alice) });
    const r = await engine.act({ sketch: 'find Todo status=open', ctx: as(bob) });
    expect(r).toMatchObject({ ok: true, ack: '2 work/Todo rows' });
    const env = await engine.query({
      frame: {
        'work/Todo': {
          params: { where: { status: { eq: 'open' } }, limit: 1000 },
          fields: { id: true, shortId: true }
        }
      },
      ctx: as(bob)
    });
    const rows = (env.data['work/Todo'] as Row[]).map(({ id, shortId }) => ({ id, shortId }));
    expect((await recordOf(engine, r, bob)).steps[0]?.rows).toEqual(rows);

    const refused = await engine.act({ sketch: 'find Todo', ctx: as(carol) });
    expect(refused).toMatchObject({ ok: false, refusal: { problem: "unknown type 'Todo'" } });
  });

  it('stores and answers only the fields a find selects', async () => {
    const { engine } = boot();
    await seedTodos(engine, 2);
    const r = await engine.act({ sketch: 'find Todo #2 fields=title', ctx: as(alice) });
    const row = { id: expect.any(String), shortId: 2, title: 't2' };
    expect(r).toEqual({
      ok: true,
      ack: '1 work/Todo rows',
      result: expect.stringMatching(/^r_/),
      found: [{ step: 1, action: 'find', type: 'work/Todo', rows: [row], truncated: false }]
    });
    expect((await recordOf(engine, r)).steps[0]?.rows).toEqual([row]);
  });

  it('closes the records a bracketed list names', async () => {
    const { engine, work } = boot();
    await seedTodos(engine, 2);
    const r = await engine.act({
      sketch: 'log SessionLog summary=s branch=b closes=[#2]',
      ctx: as(alice)
    });
    expect(r).toMatchObject({ ok: true, ack: 'logged journal/SessionLog #1; closed work/Todo #2' });
    expect(await todo(work, 2)).toMatchObject({ status: 'closed', archived: true });
  });

  it('answers several help steps at once', async () => {
    const { engine } = boot();
    const r = await engine.act({ sketch: '? Todo; ? SessionLog', ctx: as(alice) });
    expect(r).toMatchObject({
      ok: true,
      help: [{ type: 'work/Todo' }, { type: 'journal/SessionLog' }]
    });
  });

  it('count reports the number of matches', async () => {
    const { engine } = boot();
    await seedTodos(engine, 3);
    expect(await engine.act({ sketch: 'count Todo', ctx: as(alice) })).toMatchObject({
      ok: true,
      ack: 'work/Todo count 3'
    });
  });

  it('fills a binding with the id an earlier step touched', async () => {
    const { engine, work } = boot();
    const r = await engine.act({
      sketch: 'create Todo title=x as $t; update Todo $t priority=high',
      ctx: as(alice)
    });
    expect(r).toMatchObject({ ok: true, ack: 'created work/Todo #1; updated work/Todo #1' });
    expect(await all(work, 'Todo')).toMatchObject([{ title: 'x', priority: 'high' }]);
  });

  it('fills now with the request time', async () => {
    const { engine, journal } = boot();
    await engine.act({ sketch: 'log SessionLog summary=s branch=b', ctx: as(alice) });
    expect((await all(journal, 'SessionLog'))[0]?.startedAt).toBe(NOW.toISOString());
  });

  it('writes an int64 past 2^53 exactly', async () => {
    const { engine, work } = boot();
    await seedTodos(engine, 1);
    const r = await engine.act({ sketch: 'update Todo #1 big=9007199254740993', ctx: as(alice) });
    expect(r).toMatchObject({ ok: true });
    expect((await todo(work, 1)).big).toBe(9007199254740993n);
  });

  it('writes a vocab alias raw, so the write path fills what it implies', async () => {
    const { engine, work } = boot();
    await seedTodos(engine, 1);
    const r = await engine.act({ sketch: 'update Todo #1 status=done', ctx: as(alice) });
    expect(r).toMatchObject({ ok: true });
    expect(await todo(work, 1)).toMatchObject({ status: 'closed', resolution: 'completed' });
  });

  it('resolves a crossRef shortId to the record id inside the transaction', async () => {
    const { engine, work } = boot();
    await seedTodos(engine, 1);
    const r = await engine.act({ sketch: 'create Note todo=#1 title=x', ctx: as(alice) });
    expect(r).toMatchObject({ ok: true });
    expect((await all(work, 'Note'))[0]?.todo).toBe((await todo(work, 1)).id);

    const missing = await engine.act({
      sketch: 'close Todo #1; create Note todo=#99 title=y',
      ctx: as(alice)
    });
    expect(missing).toMatchObject({ ok: false, error: { step: 2, code: 'not_found' } });
    expect(await todo(work, 1)).toMatchObject({ status: 'open' });
    expect(await all(work, 'Note')).toHaveLength(1);
  });

  it('refuses an anonymous caller', async () => {
    const { engine } = boot();
    expect(await engine.act({ sketch: 'find Todo', ctx: { identity: null } })).toEqual({
      ok: false,
      error: { code: 'unauthorized', message: 'act needs a signed caller' },
      result: null
    });
  });

  it('refuses a virtual namespace', async () => {
    const { engine } = boot();
    expect(await engine.act({ sketch: 'find Sum', ctx: as(admin) })).toMatchObject({
      ok: false,
      refusal: { problem: 'calc is bridged or virtual; act runs on local stores only' }
    });
  });

  it('fails a plan that spans tx scopes, with a record', async () => {
    const { engine } = boot({ coalesce: false });
    await seedTodos(engine, 1);
    const r = await engine.act({
      sketch: 'log SessionLog summary=s branch=b closes=#1',
      ctx: as(alice)
    });
    expect(r).toMatchObject({
      ok: false,
      error: { code: 'cross_tx_scope_refused' },
      result: expect.stringMatching(/^r_/)
    });
    expect((await recordOf(engine, r)).error?.code).toBe('cross_tx_scope_refused');
  });

  describe('idempotency', () => {
    const note = { sketch: 'create Note title=x', idempotencyKey: 'k' };

    it('replays a sequential retry', async () => {
      const { engine, work } = boot();
      const first = await engine.act({ ...note, ctx: as(alice) });
      const second = await engine.act({ ...note, ctx: as(alice) });
      expect(second).toEqual(first);
      expect(await all(work, 'Note')).toHaveLength(1);
    });

    it('joins a concurrent retry', async () => {
      const { engine, work } = boot();
      const [a, b] = await Promise.all([
        engine.act({ ...note, ctx: as(alice) }),
        engine.act({ ...note, ctx: as(alice) })
      ]);
      expect(resultOf(b)).toBe(resultOf(a));
      expect(await all(work, 'Note')).toHaveLength(1);
    });

    it('never replays a dry run', async () => {
      const { engine, work } = boot();
      const a = await engine.act({ ...note, mode: 'dry-run', ctx: as(alice) });
      const b = await engine.act({ ...note, mode: 'dry-run', ctx: as(alice) });
      expect(resultOf(b)).not.toBe(resultOf(a));
      const written = await engine.act({ ...note, ctx: as(alice) });
      expect(written).toMatchObject({ ok: true, ack: expect.stringMatching(/^created/) });
      expect(await all(work, 'Note')).toHaveLength(1);
    });

    it('scopes a key to its caller', async () => {
      const { engine, work } = boot();
      const a = await engine.act({ ...note, ctx: as(alice) });
      const d = await engine.act({ ...note, ctx: as(dan) });
      expect(resultOf(d)).not.toBe(resultOf(a));
      expect(await all(work, 'Note')).toHaveLength(2);
    });
  });

  it('shows a record to its owner only', async () => {
    const { engine } = boot();
    const r = await engine.act({ sketch: 'create Note title=x', ctx: as(alice) });
    expect(await engine.actResult(resultOf(r), alice)).toBeDefined();
    expect(await engine.actResult(resultOf(r), bob)).toBeUndefined();
    expect(await engine.actResult('r_unknown', alice)).toBeUndefined();
    expect(await engine.actResult(resultOf(r), null)).toBeUndefined();
  });

  it('scopes records and idempotency keys to the whole credential, not the id alone', async () => {
    const { engine, work } = boot();
    const broad = caller('agent', { work: both, journal: both });
    const narrow = caller('agent', { work: ['read'] });
    const note = { sketch: 'create Note title=x', idempotencyKey: 'k' };
    const r = await engine.act({ ...note, ctx: as(broad) });
    expect(r).toMatchObject({ ok: true });
    expect(await engine.actResult(resultOf(r), broad)).toBeDefined();
    expect(await engine.actResult(resultOf(r), narrow)).toBeUndefined();

    // No replay: the narrower credential runs its own plan, and its grant refuses the write.
    const replay = await engine.act({ ...note, ctx: as(narrow) });
    expect(replay).toMatchObject({
      ok: false,
      error: { step: 1, code: 'unauthorized_capability' }
    });
    expect(resultOf(replay)).not.toBe(resultOf(r));
    expect(await all(work, 'Note')).toHaveLength(1);
  });

  it('caps stored rows at 1000 across the record and says so', async () => {
    const { engine, work } = boot();
    const notes = (n: number) => Array.from({ length: n }, (_, i) => ({ title: `n${i}` }));
    await work.write('Note', notes(1001));
    const r = await engine.act({ sketch: 'find Note', ctx: as(alice) });
    expect(r).toMatchObject({ ok: true, ack: '1000 work/Note rows (truncated)' });
    expect(r).not.toHaveProperty('found');
    const step = (await recordOf(engine, r)).steps[0];
    expect(step?.rows).toHaveLength(1000);
    expect(step?.truncated).toBe(true);

    const small = boot();
    await small.work.write('Note', notes(600));
    const twice = await small.engine.act({ sketch: 'find Note; find Note', ctx: as(alice) });
    expect(twice).toMatchObject({
      ok: true,
      ack: '600 work/Note rows; 400 work/Note rows (truncated)'
    });
  });

  it("caps a find at the transport's page maximum", async () => {
    const { engine, work } = boot();
    await work.write(
      'Note',
      Array.from({ length: 25 }, (_, i) => ({ title: `n${i}` }))
    );
    const r = await engine.act({
      sketch: 'find Note',
      ctx: as(alice),
      pageLimits: { defaultLimit: 5, maxLimit: 10 }
    });
    expect(r).toMatchObject({ ok: true, ack: '10 work/Note rows (truncated)' });
    const step = (await recordOf(engine, r)).steps[0];
    expect(step?.rows).toHaveLength(10);
    expect(step?.truncated).toBe(true);
  });

  it('refuses a mode it does not know before running anything', async () => {
    const { engine, work } = boot();
    const mode = 'commit' as unknown as 'write';
    expect(await engine.act({ sketch: 'create Note title=x', mode, ctx: as(alice) })).toEqual({
      ok: false,
      error: { code: 'bad_request', message: "mode must be 'write' or 'dry-run'" },
      result: null
    });
    expect(await all(work, 'Note')).toHaveLength(0);
  });

  it('answers a committed write without a result when the store fails', async () => {
    const failing: ActResultStore = {
      put: async () => {
        throw new Error('store down');
      },
      get: async () => undefined,
      findByIdempotencyKey: async () => undefined,
      reapExpired: async () => ({ deleted: 0 })
    };
    const { engine, work, metrics } = boot({ results: failing });
    const r = await engine.act({ sketch: 'create Note title=x', ctx: as(alice) });
    expect(r).toEqual({ ok: true, ack: 'created work/Note #1', result: null });
    expect(await all(work, 'Note')).toHaveLength(1);
    expect(metrics).toContain('engine_act_result_store_failed');
  });
});

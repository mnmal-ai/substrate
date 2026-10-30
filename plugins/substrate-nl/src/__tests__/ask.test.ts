import type { NlOutcome, PlanClause, Query, SubstrateRequest } from '@mnmal-ai/substrate/sdk';
import { describe, expect, it, vi } from 'vitest';
import type { NlEngineAccess, NlEnvelope } from '../access.js';
import { toSseStream } from '../ask/encode.js';
import type { NlEvent } from '../ask/events.js';
import { mergePlan, runAsk } from '../ask/run.js';
import type { Judge } from '../judge/judge.js';
import { buildNamespacePack } from '../pack/build.js';
import type { ServedPack } from '../pack/service.js';
import { pack as basePack, OPERATORS, rulings } from './_fixture.js';

const pack: ServedPack = { ...basePack, rulings, warnings: [] };
const http: SubstrateRequest = {
  method: 'POST',
  path: '/substrate/v1/nl',
  headers: {},
  query: {},
  params: {},
  body: null
};

function engine(
  reply: (frame: Query) => NlEnvelope = (f) => ({
    data: { [Object.keys(f)[0] as string]: [{ id: '1' }] }
  })
) {
  const query = vi.fn(async (frame: Query) => reply(frame));
  const e: NlEngineAccess = { federatedSchema: () => ({}), operators: () => ({}), query };
  return { e, query };
}
async function collect(gen: AsyncGenerator<NlEvent>): Promise<NlEvent[]> {
  const out: NlEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}
const outcome = (evs: NlEvent[]) =>
  (evs.find((e) => e.event === 'outcome') as Extract<NlEvent, { event: 'outcome' }>).outcome;
const judge = (...replies: unknown[]): Judge => ({ decide: vi.fn(async () => replies.shift()) });

describe('runAsk', () => {
  it('parser-resolved: parsed, outcome rows (source parser), done; projects fields', async () => {
    const { e, query } = engine();
    const evs = await collect(
      runAsk({ namespace: 'ns', question: 'open todos', project: 'substrate' }, http, {
        pack,
        engine: e
      })
    );
    expect(evs.map((x) => x.event)).toEqual(['parsed', 'outcome', 'done']);
    const o = outcome(evs);
    expect(o).toMatchObject({ kind: 'rows', source: 'parser', data: [{ id: '1' }] });
    const sent = query.mock.calls[0]?.[0] as Record<string, { fields: Record<string, boolean> }>;
    expect(sent['ns/Todo']?.fields).toMatchObject({ id: true, title: true, status: true });
  });

  it('count answers use count: true (no paging calls)', async () => {
    const { e, query } = engine((f) => ({
      data: { [Object.keys(f)[0] as string]: { count: 4321 } }
    }));
    const o = outcome(
      await collect(
        runAsk({ namespace: 'ns', question: 'how many open todos' }, http, { pack, engine: e })
      )
    );
    expect(o).toMatchObject({ kind: 'rows', answer: 'count', count: 4321, dropped: [], plan: [] });
    expect(query).toHaveBeenCalledTimes(1);
    const sent = query.mock.calls[0]?.[0] as Record<
      string,
      { params: Record<string, unknown>; fields: unknown }
    >;
    expect(sent['ns/Todo']?.params.count).toBe(true);
    expect(sent['ns/Todo']?.fields).toEqual({ id: true });
  });

  it.each(['walks_disabled', 'row_policy_blocks_walk'])(
    'a count refused with %s falls back to paging',
    async (code) => {
      const { e, query } = engine((f) => {
        const key = Object.keys(f)[0] as string;
        const params = (f as Record<string, { params: Record<string, unknown> }>)[key]?.params;
        if (params?.count === true) return { data: {}, errors: [{ code, message: 'no' }] };
        return {
          data: { [key]: [{ id: '1' }, { id: '2' }] },
          _pagination: { [key]: { hasMore: false } }
        };
      });
      const o = outcome(
        await collect(
          runAsk({ namespace: 'ns', question: 'how many open todos' }, http, { pack, engine: e })
        )
      );
      expect(o).toMatchObject({ kind: 'rows', answer: 'count', count: 2 });
      expect(o).not.toHaveProperty('errors');
      expect(query).toHaveBeenCalledTimes(2);
    }
  );

  it('counts every page, not just the first', async () => {
    const { e, query } = engine((f) => {
      const key = Object.keys(f)[0] as string;
      const p = (f as Record<string, { params: { cursor?: string; count?: boolean } }>)[key]
        ?.params;
      if (p?.count === true)
        return { data: {}, errors: [{ code: 'walks_disabled', message: 'off' }] };
      const cursor = p?.cursor;
      const ids = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `${cursor}-${i}` }));
      if (cursor === undefined)
        return {
          data: { [key]: ids(100) },
          _pagination: { [key]: { hasMore: true, nextCursor: 'c1' } }
        };
      if (cursor === 'c1')
        return {
          data: { [key]: ids(100) },
          _pagination: { [key]: { hasMore: true, nextCursor: 'c2' } }
        };
      return { data: { [key]: ids(17) }, _pagination: { [key]: { hasMore: false } } };
    });
    const o = outcome(
      await collect(
        runAsk({ namespace: 'ns', question: 'how many open todos' }, http, { pack, engine: e })
      )
    );
    expect(o).toMatchObject({ kind: 'rows', answer: 'count', count: 217 });
    expect((o as { data: unknown[] }).data).toHaveLength(100);
    const later = query.mock.calls[2]?.[0] as Record<string, { fields: Record<string, boolean> }>;
    expect(later['ns/Todo']?.fields).toEqual({ id: true });
  });

  it('omits the count and says why when a later page fails', async () => {
    const { e } = engine((f) => {
      const key = Object.keys(f)[0] as string;
      const p = (f as Record<string, { params: { cursor?: string; count?: boolean } }>)[key]
        ?.params;
      if (p?.count === true)
        return { data: {}, errors: [{ code: 'walks_disabled', message: 'off' }] };
      const cursor = p?.cursor;
      if (cursor === undefined)
        return {
          data: { [key]: [{ id: '1' }] },
          _pagination: { [key]: { hasMore: true, nextCursor: 'c1' } }
        };
      return { data: {}, errors: [{ code: 'invalid_cursor', message: 'no' }] };
    });
    const o = outcome(
      await collect(
        runAsk({ namespace: 'ns', question: 'how many open todos' }, http, { pack, engine: e })
      )
    );
    expect(o).not.toHaveProperty('count');
    expect(o).toMatchObject({ errors: [{ code: 'count_incomplete' }] });
  });

  it('carries engine errors instead of reporting zero rows', async () => {
    const { e } = engine(() => ({ data: {}, errors: [{ code: 'forbidden', message: 'no' }] }));
    const o = outcome(
      await collect(runAsk({ namespace: 'ns', question: 'open todos' }, http, { pack, engine: e }))
    );
    expect(o).toMatchObject({ kind: 'rows', errors: [{ code: 'forbidden' }] });
    expect((o as { data: unknown }).data).toBeUndefined();
  });

  it('a mutation is refused and nothing executes', async () => {
    const { e, query } = engine();
    const evs = await collect(
      runAsk({ namespace: 'ns', question: 'close todo 12' }, http, { pack, engine: e })
    );
    expect(outcome(evs)).toMatchObject({ kind: 'refuse' });
    expect(query).not.toHaveBeenCalled();
  });

  it('escalation without a judge hands off with the parser reading, labelled', async () => {
    const { e } = engine();
    const evs = await collect(
      runAsk({ namespace: 'ns', question: 'zorblax quux todos' }, http, { pack, engine: e })
    );
    expect(evs.map((x) => x.event)).not.toContain('judging');
    const o = outcome(evs);
    expect(o).toMatchObject({ kind: 'rows', source: 'handoff', handoff: 'judge not configured' });
  });

  it('a judge that hangs hands off after judgeTimeoutMs', async () => {
    vi.useFakeTimers();
    const { e } = engine();
    const hang: Judge = {
      decide: (_p, signal) =>
        new Promise((_r, rej) => signal?.addEventListener('abort', () => rej(new Error('aborted'))))
    };
    const p = collect(
      runAsk({ namespace: 'ns', question: 'zorblax quux todos' }, http, {
        pack,
        engine: e,
        judge: hang,
        judgeTimeoutMs: 50
      })
    );
    await vi.advanceTimersByTimeAsync(60);
    const evs = await p;
    vi.useRealTimers();
    expect(evs.map((x) => x.event)).toContain('judging');
    const o = outcome(evs);
    expect(o.kind === 'rows' ? o.handoff : 'clarify').toMatch(/judge unavailable|clarify/);
  });

  it('a judge that ignores its signal still hands off after judgeTimeoutMs', async () => {
    vi.useFakeTimers();
    const { e } = engine();
    const stuck: Judge = { decide: () => new Promise(() => {}) };
    const p = collect(
      runAsk({ namespace: 'ns', question: 'zorblax quux todos' }, http, {
        pack,
        engine: e,
        judge: stuck,
        judgeTimeoutMs: 50
      })
    );
    await vi.advanceTimersByTimeAsync(60);
    const evs = await p;
    vi.useRealTimers();
    expect(outcome(evs)).toMatchObject({
      kind: 'rows',
      source: 'handoff',
      handoff: 'judge unavailable'
    });
    expect(evs.at(-1)?.event).toBe('done');
  });

  it('an abort while suspended at the judging event ends the run without waiting', async () => {
    vi.useFakeTimers();
    const { e } = engine();
    const stuck: Judge = { decide: () => new Promise(() => {}) };
    const ac = new AbortController();
    const gen = runAsk(
      { namespace: 'ns', question: 'zorblax quux todos' },
      { ...http, signal: ac.signal },
      {
        pack,
        engine: e,
        judge: stuck,
        judgeTimeoutMs: 60_000
      }
    );
    expect((await gen.next()).value).toMatchObject({ event: 'parsed' });
    expect((await gen.next()).value).toMatchObject({ event: 'judging' });
    ac.abort();
    const rest: NlEvent[] = [];
    for (;;) {
      const r = await gen.next();
      if (r.done) break;
      rest.push(r.value);
    }
    vi.useRealTimers();
    expect(rest.at(-1)?.event).toBe('done');
  });

  it('a stranded judge cannot run engine queries after the timeout', async () => {
    vi.useFakeTimers();
    const { e, query } = engine();
    let release: (v: unknown) => void = () => {};
    const late = new Promise((r) => {
      release = r;
    });
    const stuck: Judge = { decide: () => late };
    const p = collect(
      runAsk({ namespace: 'ns', question: 'zorblax quux todos' }, http, {
        pack,
        engine: e,
        judge: stuck,
        judgeTimeoutMs: 50
      })
    );
    await vi.advanceTimersByTimeAsync(60);
    await p;
    const before = query.mock.calls.length;
    release({ action: 'bind', word: 'zorblax', field: 'Todo.title', op: 'contains' });
    await vi.advanceTimersByTimeAsync(10);
    vi.useRealTimers();
    expect(query.mock.calls.length).toBe(before);
  });

  it('a judge that resolves (type, then pick) yields rows with source judge, after judging and judged', async () => {
    const { e, query } = engine();
    const evs = await collect(
      runAsk({ namespace: 'ns', question: 'what happened yesterday' }, http, {
        pack,
        engine: e,
        judge: judge({ action: 'type', type: 'SessionLog' }, { action: 'pick', candidate: 0 })
      })
    );
    expect(evs.map((x) => x.event)).toEqual(['parsed', 'judging', 'judged', 'outcome', 'done']);
    expect(evs.find((x) => x.event === 'judged')).toMatchObject({ status: 'resolved' });
    expect(outcome(evs)).toMatchObject({ kind: 'rows', source: 'judge' });
    expect(Object.keys(query.mock.calls[0]?.[0] as object)).toEqual(['ns/SessionLog']);
  });

  it('recall rejected by the engine reports hits undefined with errors', async () => {
    const { e } = engine(() => ({ data: {}, errors: [{ code: 'forbidden', message: 'no' }] }));
    const evs = await collect(
      runAsk({ namespace: 'ns', question: 'what do we know about zorblax' }, http, {
        pack,
        engine: e,
        judge: judge({ action: 'recall', type: 'SessionLog' })
      })
    );
    const o = outcome(evs);
    expect(o).toMatchObject({ kind: 'recall', errors: [{ code: 'forbidden' }] });
    expect((o as { hits: unknown }).hits).toBeUndefined();
  });

  it('judge recall runs recall/Hit through the engine', async () => {
    const { e, query } = engine((f) => ({
      data: { [Object.keys(f)[0] as string]: [{ id: 'h1', score: 0.9 }] }
    }));
    const evs = await collect(
      runAsk({ namespace: 'ns', question: 'what do we know about zorblax' }, http, {
        pack,
        engine: e,
        judge: judge({ action: 'recall', type: 'SessionLog' })
      })
    );
    const o = outcome(evs);
    expect(o).toMatchObject({ kind: 'recall', hits: [{ id: 'h1' }] });
    const sent = query.mock.calls.at(-1)?.[0] as Record<
      string,
      { params: Record<string, unknown> }
    >;
    // recall/Hit refuses a frame with no `type`, so the judge must name one.
    expect(sent['recall/Hit']?.params).toMatchObject({
      to: 'what do we know about zorblax',
      namespace: 'ns',
      type: 'SessionLog'
    });
  });

  it('a type forced by the caller wins over the one the judge names', async () => {
    const { e, query } = engine((f) => ({ data: { [Object.keys(f)[0] as string]: [] } }));
    await collect(
      runAsk({ namespace: 'ns', question: 'what do we know about zorblax', type: 'Todo' }, http, {
        pack,
        engine: e,
        judge: judge({ action: 'recall', type: 'SessionLog' })
      })
    );
    const sent = query.mock.calls.at(-1)?.[0] as Record<
      string,
      { params: Record<string, unknown> }
    >;
    expect(sent['recall/Hit']?.params?.type).toBe('Todo');
  });

  it('an aborted request stops before executing', async () => {
    const { e, query } = engine();
    const ac = new AbortController();
    ac.abort();
    const evs = await collect(
      runAsk(
        { namespace: 'ns', question: 'open todos' },
        { ...http, signal: ac.signal },
        { pack, engine: e }
      )
    );
    expect(query).not.toHaveBeenCalled();
    expect(evs.at(-1)?.event).toBe('done');
  });

  it('type forces the reading (clarify option resubmission)', async () => {
    const { e, query } = engine();
    await collect(
      runAsk({ namespace: 'ns', question: 'substrate', type: 'Decision' }, http, {
        pack,
        engine: e
      })
    );
    expect(Object.keys(query.mock.calls[0]?.[0] ?? {})[0]).toBe('ns/Decision');
  });
});

// --- walk readings: the confidence rule on the wire ---
const num = { kind: 'scalar' as const, type: 'number' as const, indexed: true };
const bool = { kind: 'scalar' as const, type: 'boolean' as const, indexed: true };
const date = { kind: 'scalar' as const, type: 'date' as const, indexed: true };
const ref = (type: string) => ({
  kind: 'crossRef' as const,
  ns: 'cards',
  type,
  onDelete: 'restrict' as const
});
const cards: ServedPack = {
  ...buildNamespacePack({
    namespace: 'cards',
    schema: {
      schemaVersion: 'v',
      mutations: {},
      types: {
        // A user field named like a walk key must not make a reading strict.
        Cert: {
          fields: {
            grade: num,
            psaOffer: num,
            ask: num,
            pick: {
              kind: 'scalar' as const,
              type: 'string' as const,
              indexed: true,
              enum: ['gold', 'silver']
            }
          }
        },
        Listing: { fields: { cert: ref('Cert'), price: num, placeholderPrice: bool } },
        Observation: { fields: { cert: ref('Cert'), price: num, observedAt: date } },
        Island: { fields: { size: num, surveyedAt: date } }
      }
    },
    operators: OPERATORS,
    profile: { types: {} }
  }),
  rulings: {
    typeAliases: { cards: 'Cert', card: 'Cert' },
    timeField: { Observation: 'observedAt', Island: 'surveyedAt' },
    fieldPhrases: {
      'asking price': { field: 'Listing.price', exclude: { placeholderPrice: { eq: true } } },
      'selling for': { field: 'Observation.price' },
      'island size': { field: 'Island.size' },
      margin: { derive: { diff: ['Cert.psaOffer', 'Cert.ask'] } }
    }
  },
  warnings: []
};
const now = () => new Date('2026-10-30T12:00:00Z');
const ask = (question: string, e: NlEngineAccess, judgeFn?: Judge) =>
  collect(
    runAsk({ namespace: 'cards', question }, http, {
      pack: cards,
      engine: e,
      now,
      ...(judgeFn !== undefined ? { judge: judgeFn } : {})
    })
  );

describe('the confidence rule', () => {
  it('a dropped window under a count is unknown with dropped naming the span', async () => {
    const { e, query } = engine();
    const o = outcome(await ask('how many cards with island size in the past 2 days', e));
    expect(o).toMatchObject({
      kind: 'unknown',
      question: 'how many cards with island size in the past 2 days'
    });
    const u = o as Extract<NlOutcome, { kind: 'unknown' }>;
    expect(u.dropped).toContainEqual(
      expect.objectContaining({ span: 'past 2 days', kind: 'filter' })
    );
    expect(query).not.toHaveBeenCalled();
  });

  it('a seed pick-one ("latest") that lost its filters is unknown, never one confident row', async () => {
    const { e, query } = engine();
    const o = outcome(await ask('latest card with island size in the past 2 days', e));
    expect(o).toMatchObject({ kind: 'unknown' });
    expect(query).not.toHaveBeenCalled();
  });

  it('a field literally named "pick" leaves a rows reading answered, with dropped', async () => {
    const { e } = engine();
    const o = outcome(await ask('gold cards with island size', e));
    expect(o).toMatchObject({ kind: 'rows', dropped: [{ span: 'island size', kind: 'filter' }] });
    expect(JSON.stringify(o.kind === 'rows' ? o.frame : null)).toContain('"pick":{"eq":"gold"}');
  });

  it('a dropped ordering on rows is answered with dropped', async () => {
    const { e } = engine();
    const o = outcome(await ask('latest cards by margin', e));
    expect(o).toMatchObject({
      kind: 'rows',
      answer: 'rows',
      dropped: [{ span: 'latest', kind: 'order' }]
    });
  });

  it('a dropped ordering under a count is still answered', async () => {
    const { e } = engine((f) => ({ data: { [Object.keys(f)[0] as string]: { count: 3 } } }));
    const o = outcome(await ask('how many latest cards by margin', e));
    expect(o).toMatchObject({ kind: 'rows', answer: 'count', count: 3 });
    const sent = (o as { frame: Record<string, { params: Record<string, unknown> }> }).frame;
    expect(sent['cards/Cert']?.params).not.toHaveProperty('orderBy');
  });

  it('no judge + count + leftover content words → unknown, never a handoff number', async () => {
    const { e, query } = engine();
    const o = outcome(
      await collect(
        runAsk({ namespace: 'ns', question: 'how many zorblax todos' }, http, { pack, engine: e })
      )
    );
    expect(o).toMatchObject({
      kind: 'unknown',
      dropped: [{ span: 'zorblax', kind: 'filter' }]
    });
    expect(query).not.toHaveBeenCalled();
  });

  it('an escalating judge leaves a count with leftovers unknown', async () => {
    const { e } = engine();
    const o = outcome(
      await collect(
        runAsk({ namespace: 'ns', question: 'how many zorblax todos' }, http, {
          pack,
          engine: e,
          judge: judge({ action: 'escalate' })
        })
      )
    );
    expect(o).toMatchObject({ kind: 'unknown' });
  });

  it('no judge + rows + leftovers → rows with dropped (handoff)', async () => {
    const { e } = engine();
    const o = outcome(
      await collect(
        runAsk({ namespace: 'ns', question: 'zorblax quux todos' }, http, { pack, engine: e })
      )
    );
    expect(o).toMatchObject({ kind: 'rows', source: 'handoff' });
    expect((o as { dropped: { span: string }[] }).dropped.map((d) => d.span)).toEqual([
      'zorblax',
      'quux'
    ]);
  });

  it('rows and unknown carry plan, including ruling exclusions and served flags', async () => {
    const enginePlan: PlanClause[] = [
      { path: ['where', '_walk'], kind: 'hop', served: true },
      {
        path: ['where', '_walk', 'where', 'NOT', 'placeholderPrice'],
        kind: 'filter',
        served: false,
        recommend: { fields: ['cert', 'placeholderPrice'] }
      }
    ];
    const { e } = engine((f) => {
      const key = Object.keys(f)[0] as string;
      return { data: { [key]: [] }, _diagnostics: { [key]: { plan: enginePlan } } };
    });
    const o = outcome(await ask('cards with an asking price', e));
    expect(o).toMatchObject({ kind: 'rows', dropped: [] });
    const plan = (o as { plan: PlanClause[] }).plan;
    expect(plan).toContainEqual({
      path: ['where', '_walk', 'cards/Listing.cert', 'any'],
      kind: 'hop',
      served: true
    });
    // The exclusion keeps its ruling label and takes the engine's flags.
    expect(plan).toContainEqual({
      path: ['where', '_walk', 'where', 'NOT', 'ruling:asking price'],
      kind: 'filter',
      served: false,
      recommend: { fields: ['cert', 'placeholderPrice'] }
    });

    const u = outcome(await ask('how many cards with an asking price or island size', e));
    expect(u).toMatchObject({ kind: 'unknown' });
    expect((u as { plan: PlanClause[] }).plan.map((p) => p.path.at(-1))).toContain(
      'ruling:asking price'
    );
  });

  it("SSE names the unknown outcome's event 'unknown'", async () => {
    const { e } = engine();
    const stream = toSseStream(
      runAsk({ namespace: 'ns', question: 'how many zorblax todos' }, http, { pack, engine: e })
    );
    const text = await new Response(stream).text();
    expect(text).toContain('event: unknown\n');
  });
});

describe('mergePlan', () => {
  it('takes served flags by path; parser-only and engine-only clauses both stay', () => {
    const parsed: PlanClause[] = [
      {
        path: ['where', '_walk', 'where', 'price', 'gt', 'compare:over 50'],
        kind: 'filter',
        served: false
      },
      { path: ['derive', 'margin', 'ruling:margin'], kind: 'derive', served: false },
      { path: ['orderBy', '0', '$margin', 'desc (default)'], kind: 'order', served: false }
    ];
    const merged = mergePlan(parsed, [
      { path: ['where', '_walk'], kind: 'hop', served: true },
      { path: ['where', '_walk', 'where', 'price'], kind: 'filter', served: true },
      { path: ['orderBy', '0'], kind: 'derive', served: true }
    ]);
    expect(merged).toEqual([
      { ...parsed[0], served: true },
      parsed[1],
      { ...parsed[2], served: true },
      { path: ['where', '_walk'], kind: 'hop', served: true }
    ]);
    expect(mergePlan(parsed, undefined)).toBe(parsed);
  });
});

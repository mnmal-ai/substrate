import type { Query, SubstrateRequest } from '@mnmal-ai/substrate/sdk';
import { describe, expect, it, vi } from 'vitest';
import type { NlEngineAccess, NlEnvelope } from '../access.js';
import type { NlEvent } from '../ask/events.js';
import { runAsk } from '../ask/run.js';
import type { Judge } from '../judge/judge.js';
import type { ServedPack } from '../pack/service.js';
import { pack as basePack, rulings } from './_fixture.js';

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
        judge: judge({ action: 'recall' })
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
        judge: judge({ action: 'recall' })
      })
    );
    const o = outcome(evs);
    expect(o).toMatchObject({ kind: 'recall', hits: [{ id: 'h1' }] });
    const sent = query.mock.calls.at(-1)?.[0] as Record<
      string,
      { params: Record<string, unknown> }
    >;
    expect(sent['recall/Hit']?.params).toMatchObject({
      to: 'what do we know about zorblax',
      namespace: 'ns'
    });
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

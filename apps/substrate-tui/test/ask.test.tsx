import type { NlApi } from '@mnmal-ai/substrate/client';
import type { NlServedPack, NlWireEvent } from '@mnmal-ai/substrate/sdk';
import { applySuggestion, assertComposes, createApp } from '@mnmal-ai/surface-core';
import { marathon } from '@mnmal-ai/surface-theme';
import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';
import { askModule } from '../src/ask/module.js';
import { KIND, renderers } from '../src/ask/render.js';
import type { TuiDeps } from '../src/deps.js';
import { noAdmin, noDash } from './_fakes.js';

const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));
// Positive frame assertions poll rather than sleep: a fixed sleep flakes under full-workspace load.
const until = (assert: () => void) => vi.waitFor(assert, { timeout: 2000, interval: 20 });
const ENTER = '\r';
const ESC = '\u001B';
const TAB = '\t';

const PACK: NlServedPack = {
  namespace: 'journal',
  schemaVersion: 'v',
  values: {},
  rulings: {},
  warnings: [],
  types: {
    Todo: {
      name: 'Todo',
      phrases: ['todo', 'todos'],
      fields: {
        status: {
          name: 'status',
          kind: 'scalar',
          valueType: 'string',
          indexed: true,
          operators: ['eq', 'neq'],
          phrases: ['status'],
          enum: ['open', 'closed']
        }
      }
    }
  }
};
const rowsEv = (n: number, source = 'parser'): NlWireEvent => ({
  event: 'rows',
  data: {
    kind: 'rows',
    frame: { 'journal/Todo': { params: {}, fields: {} } },
    answer: 'rows',
    source: source as 'parser',
    dropped: [],
    plan: [],
    data: Array.from({ length: n }, (_, i) => ({ id: `t${i}`, title: `todo ${i}` }))
  }
});

function fake(
  script: (req: { question: string; type?: string }) => (NlWireEvent | 'HOLD')[] | 'hang' | Error,
  packs: Record<string, NlServedPack> = {}
) {
  let release: () => void = () => {};
  const held = new Promise<void>((r) => {
    release = r;
  });
  const calls: { question: string; namespace: string; type?: string; signal?: AbortSignal }[] = [];
  const nl: NlApi = {
    async *ask(req, opts) {
      calls.push({ ...req, ...(opts?.signal !== undefined ? { signal: opts.signal } : {}) });
      const out = script(req);
      if (out instanceof Error) throw out;
      if (out === 'hang') {
        await new Promise((_r, rej) =>
          opts?.signal?.addEventListener('abort', () => rej(new Error('aborted')))
        );
        return;
      }
      for (const ev of out) {
        if (ev === 'HOLD') await held;
        else yield ev;
      }
    },
    askJson: async () => ({ outcome: null, trail: [] }),
    pack: async (ns) => packs[ns] ?? PACK
  };
  const deps: TuiDeps = {
    endpoint: 'http://h',
    project: 'substrate',
    namespace: 'journal',
    nl,
    federatedSchema: async () => ({}),
    ...noDash,
    ...noAdmin(),
    getJson: async () => ({})
  };
  return { deps, calls, release };
}
function start(deps: TuiDeps) {
  const { App } = createApp({
    theme: marathon,
    modules: [askModule(deps)],
    defaultTurn: 'substrate.ask:ask'
  });
  const r = render(<App columns={120} />);
  return { ...r, frame: () => r.lastFrame() ?? '' };
}

describe('substrate.ask', () => {
  it('composes', () => {
    expect(() => assertComposes([askModule(fake(() => []).deps)])).not.toThrow();
  });
  it('a question streams to a rows answer with chips, sending namespace and project', async () => {
    const { deps, calls } = fake(() => [
      { event: 'parsed', data: { status: 'resolved', evidence: [], residual: [] } },
      rowsEv(2),
      { event: 'done', data: {} }
    ]);
    const app = start(deps);
    app.stdin.write('open todos');
    app.stdin.write(ENTER);
    await until(() => expect(app.frame()).toContain('todo 1'));
    expect(app.frame()).toContain('▸ journal/Todo · parser · 2 rows');
    expect(calls[0]).toMatchObject({
      question: 'open todos',
      namespace: 'journal',
      project: 'substrate'
    });
  });
  it('Esc on an empty draft aborts the in-flight request', async () => {
    const { deps, calls } = fake(() => 'hang');
    const app = start(deps);
    app.stdin.write('slow');
    app.stdin.write(ENTER);
    await tick();
    app.stdin.write(ESC);
    await tick();
    expect(calls[0]?.signal?.aborted).toBe(true);
  });
  it('clarify opens a panel; 2 resubmits with that option type', async () => {
    const { deps, calls } = fake((req) =>
      req.type === undefined
        ? [
            {
              event: 'clarify',
              data: {
                kind: 'clarify',
                question: 'substrate',
                reason: 'which?',
                options: [
                  { label: 'todos (Todo)', question: 'substrate', type: 'Todo' },
                  { label: 'decisions (Decision)', question: 'substrate', type: 'Decision' }
                ]
              }
            },
            { event: 'done', data: {} }
          ]
        : [rowsEv(1), { event: 'done', data: {} }]
    );
    const app = start(deps);
    app.stdin.write('substrate');
    app.stdin.write(ENTER);
    await until(() => expect(app.frame()).toContain('1. todos (Todo)'));
    app.stdin.write('2');
    await tick(80);
    expect(calls[1]).toMatchObject({ question: 'substrate', type: 'Decision' });
  });
  it('/frame shows the last frame, evidence and trail', async () => {
    const { deps } = fake(() => [
      {
        event: 'parsed',
        data: {
          status: 'resolved',
          frame: { 'journal/Todo': { params: { where: { status: { eq: 'open' } } }, fields: {} } },
          evidence: [{ span: 'open', role: 'value', detail: 'status' }],
          residual: []
        }
      },
      rowsEv(0),
      { event: 'done', data: {} }
    ]);
    const app = start(deps);
    app.stdin.write('open todos');
    app.stdin.write(ENTER);
    await tick(80);
    app.stdin.write('/frame');
    app.stdin.write(ENTER);
    await until(() => expect(app.frame()).toContain('"status"'));
    expect(app.frame()).toContain('open → value');
  });
  it('/ns switches the namespace for the next question', async () => {
    const { deps, calls } = fake(() => [rowsEv(0), { event: 'done', data: {} }]);
    const app = start(deps);
    app.stdin.write('/ns plane');
    app.stdin.write(ENTER);
    await tick();
    app.stdin.write('things');
    app.stdin.write(ENTER);
    await tick(80);
    expect(calls[0]?.namespace).toBe('plane');
  });
  it('Tab on a field:value draft completes the value and keeps field:', async () => {
    const { deps } = fake(() => []);
    const app = start(deps);
    await tick(80); // pack loads in init
    app.stdin.write('todos status:op');
    app.stdin.write(TAB);
    await until(() => expect(app.frame()).toContain('todos status:open'));
  });
  it('NL absent on the server is a clear reply, not a stack', async () => {
    const { deps } = fake(() =>
      Object.assign(new Error('404 from /substrate/v1/nl'), { name: 'NetworkError', status: 404 })
    );
    const app = start(deps);
    app.stdin.write('anything');
    app.stdin.write(ENTER);
    await until(() => expect(app.frame()).toContain('substrate-nl is not installed on http://h'));
    expect(app.frame()).not.toMatch(/at .*\.ts:\d+/);
  });
  it('strips terminal escapes from server-supplied text but keeps the readable part', async () => {
    const evil = '\x1b]0;pwned\x07Ship\x1b[31mit';
    const { deps } = fake((req) =>
      req.question === 'rows'
        ? [
            {
              event: 'rows',
              data: {
                kind: 'rows',
                frame: { 'journal/Todo': { params: {}, fields: {} } },
                answer: 'rows',
                source: 'parser',
                dropped: [],
                plan: [],
                data: [{ id: 't', title: evil }]
              }
            },
            { event: 'done', data: {} }
          ]
        : req.question === 'clar'
          ? [
              {
                event: 'clarify',
                data: {
                  kind: 'clarify',
                  question: 'q',
                  reason: 'why\x1b[2J',
                  options: [{ label: 'lab\x1b[2Jel', question: 'q', type: 'Todo' }]
                }
              },
              { event: 'done', data: {} }
            ]
          : new Error('bad\x1b[2Jmsg')
    );
    const app = start(deps);
    app.stdin.write('rows');
    app.stdin.write(ENTER);
    await until(() => expect(app.frame()).toContain('Ship'));
    expect(app.frame()).not.toContain(']0;pwned');
    app.stdin.write('boom');
    app.stdin.write(ENTER);
    await until(() => expect(app.frame()).toContain('badmsg'));
    app.stdin.write('clar');
    app.stdin.write(ENTER);
    await until(() => expect(app.frame()).toContain('label'));
    expect(app.frame()).not.toContain('[2J');
  });
  it('renderers hand Ink no escape bytes from server-supplied text', () => {
    const evil = '\x1b]0;pwned\x07Ship\x1b[31mit';
    const out = (kind: string, data: unknown) =>
      JSON.stringify(renderers[kind]?.({ data, theme: marathon, size: { columns: 100 } }));
    const frame = { 'journal/Todo': { params: {}, fields: {} } };
    const cases = [
      out(KIND.rows, {
        kind: 'rows',
        frame,
        answer: '',
        source: 'parser',
        data: [{ id: 'a', title: evil, status: evil, project: evil }]
      }),
      out(KIND.rows, {
        kind: 'rows',
        frame,
        answer: '',
        source: 'parser',
        errors: [{ code: evil, message: evil }]
      }),
      out(KIND.unknown, {
        kind: 'unknown',
        question: evil,
        dropped: [{ span: evil, reason: evil, kind: 'filter' }],
        plan: []
      }),
      out(KIND.recall, { kind: 'recall', query: 'q', hits: [{ type: evil, id: evil, score: 1 }] }),
      out(KIND.recall, { kind: 'recall', query: 'q', errors: [{ message: evil }] }),
      out(KIND.clarify, {
        kind: 'clarify',
        question: 'q',
        reason: evil,
        options: [{ label: evil, question: 'q', type: 'T' }]
      }),
      out(KIND.refuse, { kind: 'refuse', reason: evil }),
      out(KIND.error, evil),
      out(KIND.line, evil)
    ];
    for (const c of cases) {
      expect(c).not.toContain('\\u001b');
      expect(c).not.toContain('\\u0007');
      expect(c).toContain('Ship');
      expect(c).toContain('it');
    }
  });
  it('a non-clarify outcome closes a stale clarify panel', async () => {
    const { deps } = fake((req) =>
      req.question === 'clar'
        ? [
            {
              event: 'clarify',
              data: {
                kind: 'clarify',
                question: 'clar',
                reason: 'which?',
                options: [{ label: 'todos (Todo)', question: 'clar', type: 'Todo' }]
              }
            },
            { event: 'done', data: {} }
          ]
        : [rowsEv(1), { event: 'done', data: {} }]
    );
    let submit: ((t: string) => void) | undefined;
    const mod = askModule(deps);
    const { App } = createApp({
      theme: marathon,
      modules: [
        {
          ...mod,
          init: (ctx) => {
            submit = ctx.submit;
            return mod.init?.(ctx);
          }
        }
      ],
      defaultTurn: 'substrate.ask:ask'
    });
    const app = render(<App columns={120} />);
    app.stdin.write('clar');
    app.stdin.write(ENTER);
    await tick(80);
    expect(app.lastFrame()).toContain('press 1–1');
    expect(app.lastFrame()).toContain('1. todos (Todo)');
    submit?.('other');
    await tick(80);
    expect(app.lastFrame()).toContain('todo 0');
    expect(app.lastFrame()).not.toContain('1–9 choose');
  });
  it('completion with the cursor mid-token matches the prefix and replaces to the token end', async () => {
    const { deps } = fake(() => []);
    const mod = askModule(deps);
    const { App } = createApp({
      theme: marathon,
      modules: [mod],
      defaultTurn: 'substrate.ask:ask'
    });
    render(<App columns={120} />);
    await tick(80);
    const nl = mod.completers?.find((c) => c.id === 'nl');
    // 'todos status:op|xx': the full token 'opxx' matches nothing, the prefix 'op' completes.
    const draft = 'todos status:opxx';
    const cursor = 'todos status:op'.length;
    const open = (await nl?.complete(draft, cursor))?.find((x) => x.insert === 'open');
    expect(open?.replace).toEqual([13, 17]);
    expect(open && applySuggestion(draft, cursor, open).text).toBe('todos status:open');
  });
  it('shows the parsing partial with the frame key, then the judging partial, then the final', async () => {
    const { deps, release } = fake(() => [
      {
        event: 'parsed',
        data: {
          status: 'resolved',
          frame: { 'journal/Todo': { params: {}, fields: {} } },
          evidence: [],
          residual: []
        }
      },
      'HOLD',
      { event: 'judging', data: { reason: 'unsure' } },
      'HOLD',
      rowsEv(1),
      { event: 'done', data: {} }
    ]);
    const app = start(deps);
    app.stdin.write('q');
    app.stdin.write(ENTER);
    await until(() => expect(app.frame()).toContain('▸ journal/Todo · parsing…'));
    release();
    await tick(80);
    // second HOLD shares the already-released promise, so the stream runs through
    expect(app.frame()).toContain('todo 0');
  });
  it('shows the judging partial while the stream is held', async () => {
    const { deps, release } = fake(() => [
      { event: 'judging', data: { reason: 'unsure' } },
      'HOLD',
      rowsEv(1),
      { event: 'done', data: {} }
    ]);
    const app = start(deps);
    app.stdin.write('q');
    app.stdin.write(ENTER);
    await until(() => expect(app.frame()).toContain('judging…'));
    release();
    await until(() => expect(app.frame()).toContain('todo 0'));
  });
  it('lands a recall answer and a refuse answer', async () => {
    const { deps } = fake((req) =>
      req.question === 'rec'
        ? [
            {
              event: 'recall',
              data: {
                kind: 'recall',
                query: 'rec',
                hits: [{ type: 'Memory', id: 'abc', score: 0.5 }]
              }
            },
            { event: 'done', data: {} }
          ]
        : [
            { event: 'refuse', data: { kind: 'refuse', reason: 'not a question' } },
            { event: 'done', data: {} }
          ]
    );
    const app = start(deps);
    app.stdin.write('rec');
    app.stdin.write(ENTER);
    await until(() => expect(app.frame()).toContain('recall · 1 hits'));
    expect(app.frame()).toContain('Memory');
    app.stdin.write('no');
    app.stdin.write(ENTER);
    await until(() => expect(app.frame()).toContain('not a question'));
  });
  it('a 401 gives the key hint', async () => {
    const { deps } = fake(() =>
      Object.assign(new Error('unauthorized'), { name: 'NetworkError', status: 401 })
    );
    const app = start(deps);
    app.stdin.write('x');
    app.stdin.write(ENTER);
    await tick(80);
    expect(app.frame()).toContain(
      'not authorised (401) — check SUBSTRATE_AGENT_KEY_ID / SUBSTRATE_AGENT_KEY_PATH'
    );
  });
  it('/ns plane makes completion use the plane pack', async () => {
    const PLANE: NlServedPack = {
      namespace: 'plane',
      schemaVersion: 'v',
      values: {},
      rulings: {},
      warnings: [],
      types: { Widget: { name: 'Widget', phrases: ['widget', 'widgets'], fields: {} } }
    };
    const { deps } = fake(() => [], { plane: PLANE });
    const app = start(deps);
    await tick(80);
    app.stdin.write('/ns plane');
    app.stdin.write(ENTER);
    await tick(120);
    app.stdin.write('widg');
    app.stdin.write(TAB);
    await until(() => expect(app.frame()).toContain('widget'));
  });
});

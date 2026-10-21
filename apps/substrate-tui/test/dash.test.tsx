import { EventEmitter } from 'node:events';
import type { ResolverStat, RuntimeMetrics } from '@mnmal-ai/substrate/sdk';
import { assertComposes, createApp, type ModuleCtx } from '@mnmal-ai/surface-core';
import { cellWidth } from '@mnmal-ai/surface-kit';
import { marathon } from '@mnmal-ai/surface-theme';
import { Box, render as inkRender } from 'ink';
import { render } from 'ink-testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type DashState, initialDash, type Sample, step } from '../src/dash/derive.js';
import { DashView, dashModule, trafficLines } from '../src/dash/module.js';
import type { TuiDeps } from '../src/deps.js';
import { noAdmin } from './_fakes.js';

const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));
// Positive assertions poll rather than sleep: a fixed sleep flakes under full-workspace load.
const until = (assert: () => void) => vi.waitFor(assert, { timeout: 2000, interval: 20 });
/** How long a negative assertion waits for anything that would have happened to happen. */
const SETTLE_MS = 300;
const ENTER = '\r';
const ESC = '\u001B';
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping Ink's own colour codes
const SGR = /\u001b\[[0-9;]*m/g;
const SPARK = /[▁▂▃▄▅▆▇█]/;

const stat = (p99Ms: number, calls: number, errors = 0): ResolverStat => ({
  kind: 'query',
  calls,
  errors,
  p50Ms: 1,
  p99Ms,
  maxMs: p99Ms,
  lastAt: '2026-10-05T00:00:00Z'
});
function metricsAt(n: number, resolvers: Record<string, ResolverStat>): RuntimeMetrics {
  const op = (total: number) => ({
    total,
    ok: total,
    error: 0,
    durationMsSum: total * 3,
    durationMsMax: 40
  });
  return {
    since: 'x',
    requests: { query: op(n * 10), mutate: op(n) },
    subscriptions: { active: 2, maxQueueDepth: 1 },
    events: { engine_policy_denied: n, swept: 1 },
    resolvers,
    process: {
      rssMB: 120,
      heapUsedMB: 80,
      cpuUserMs: 0,
      cpuSystemMs: 0,
      eventLoopLagP99Ms: 4,
      inFlight: 0
    },
    slowest: []
  };
}
const httpErr = (status: number) => Object.assign(new Error(`${status}`), { status });

type Script = {
  errors?: () => Promise<unknown>;
  embed?: () => Promise<unknown>;
  health?: () => Promise<unknown>;
};
function fakeDeps(script: Script = {}) {
  const calls: string[] = [];
  let n = 0;
  const resolvers = { 'a/X': stat(80, 5), 'b/Y': stat(10, 50) };
  const deps: TuiDeps = {
    endpoint: 'http://h',
    project: 'substrate',
    namespace: 'journal',
    nl: {} as TuiDeps['nl'],
    ...noAdmin(),
    federatedSchema: async () => ({}),
    async getJson(path) {
      calls.push(path);
      if (path === '/health')
        return script.health ? script.health() : { version: '7.4.0', uptimeSeconds: 65 };
      if (path === '/substrate/v1/embed-stats')
        return script.embed ? script.embed() : { enabled: true, writes: 3, failures: 0 };
      throw httpErr(404);
    },
    async metrics() {
      calls.push('/substrate/v1/metrics');
      n++;
      return metricsAt(n, resolvers);
    },
    async errors() {
      calls.push('/substrate/v1/errors');
      if (script.errors) return script.errors() as never;
      return { since: 'x', errors: [] };
    }
  };
  return { deps, calls };
}

/** ink-testing-library's stdout is fixed at 100 columns; this one is as wide as asked. */
function renderAt(tree: React.ReactElement, columns: number): { frame: string; unmount(): void } {
  class Out extends EventEmitter {
    columns = columns;
    last = '';
    write = (f: string) => {
      this.last = f;
    };
  }
  const stdout = new Out();
  const instance = inkRender(tree, {
    stdout: stdout as never,
    stderr: new Out() as never,
    stdin: Object.assign(new EventEmitter(), {
      isTTY: false,
      setEncoding() {},
      setRawMode() {},
      resume() {},
      pause() {},
      ref() {},
      unref() {},
      read: () => null
    }) as never,
    debug: true,
    exitOnCtrlC: false,
    patchConsole: false
  });
  return { frame: stdout.last, unmount: () => instance.unmount() };
}

function fiveSecondClock() {
  let t = 0;
  return () => {
    t += 5000;
    return t;
  };
}

function start(deps: TuiDeps, opts: { intervalMs?: number; timeoutMs?: number } = {}) {
  const { App } = createApp({
    theme: marathon,
    // Each metrics sample reads as 5 s after the last, so short test intervals still make points.
    modules: [
      dashModule(deps, { intervalMs: 100, timeoutMs: 50, clock: fiveSecondClock(), ...opts })
    ]
  });
  const r = render(<App columns={100} rows={60} />);
  const frame = () => (r.lastFrame() ?? '').replace(SGR, '');
  /** Types /dash, waits for the draft to land, runs it, and waits for the panel. */
  const open = async () => {
    r.stdin.write('/dash');
    await until(() => expect(frame()).toContain('/dash'));
    r.stdin.write(ENTER);
    await until(() => expect(frame()).toContain('◈ SERVICE'));
  };
  /** Until the first poll has rendered: the version only arrives with data. */
  const loaded = () => until(() => expect(frame()).toContain('v7.4.0'));
  return { ...r, frame, open, loaded };
}

describe('substrate.dash', () => {
  it('composes', () => {
    expect(() => assertComposes([dashModule(fakeDeps().deps)])).not.toThrow();
  });
  it('/dash opens the panel with the three section titles', async () => {
    const app = start(fakeDeps().deps);
    await app.open();
    await app.loaded();
    const f = app.frame();
    for (const t of ['◈ SERVICE', '◈ ENGINE', '◈ LIVE TRAFFIC']) expect(f).toContain(t);
    expect(f).toContain('live');
    app.unmount();
  });
  it('after two ticks the traffic sparkline is non-empty', async () => {
    const app = start(fakeDeps().deps);
    await app.open();
    const queryLine = () =>
      app
        .frame()
        .split('\n')
        .find((l) => l.includes('▸ query')) ?? '';
    await until(() => expect(queryLine()).toMatch(SPARK));
    app.unmount();
  });
  it('s cycles the per-key sort: p99 puts a/X first, calls puts b/Y first', async () => {
    const app = start(fakeDeps().deps, { intervalMs: 10_000 });
    await app.open();
    const order = () => {
      const f = app.frame();
      return f.indexOf('a/X') < f.indexOf('b/Y') ? 'a' : 'b';
    };
    await until(() => {
      expect(app.frame()).toContain('KEYS · by p99');
      expect(app.frame()).toContain('b/Y');
    });
    expect(order()).toBe('a');
    app.stdin.write('s');
    await until(() => expect(app.frame()).toContain('KEYS · by calls'));
    expect(order()).toBe('b');
    app.unmount();
  });
  it('a 403 on /substrate/v1/errors shows n/a (admin) and the rest renders', async () => {
    const { deps } = fakeDeps({ errors: async () => Promise.reject(httpErr(403)) });
    const app = start(deps);
    await app.open();
    await until(() => {
      const f = app.frame();
      expect(f).toContain('n/a (admin)');
      expect(f).toContain('▸ query');
      expect(f).toContain('v7.4.0');
    });
    app.unmount();
  });
  it('a hung embed-stats times out on its own; the other sections still update', async () => {
    let version = 1;
    const { deps } = fakeDeps({
      embed: () => new Promise(() => {}), // ignores its signal: only the deadline ends it
      health: async () => ({ version: `${version}.0.0` })
    });
    const app = start(deps);
    await app.open();
    await until(() => {
      expect(app.frame()).toContain('v1.0.0');
      expect(app.frame()).toContain('embed n/a (down)');
    });
    version = 2;
    await until(() => expect(app.frame()).toContain('v2.0.0'));
    app.unmount();
  });
  it('a pre-7.5 server (no resolvers) shows n/a (server), not none yet', async () => {
    const { deps } = fakeDeps();
    const old: TuiDeps = {
      ...deps,
      metrics: async (sg) => {
        const { resolvers: _r, ...m } = await deps.metrics(sg);
        return m;
      }
    };
    const app = start(old, { intervalMs: 10_000 });
    await app.open();
    await until(() => expect(app.frame()).toContain('n/a (server)'));
    expect(app.frame()).not.toContain('none yet');
    app.unmount();
  });
  it('r refreshes now', async () => {
    const { deps, calls } = fakeDeps();
    const app = start(deps, { intervalMs: 10_000 });
    const metricsCalls = () => calls.filter((c) => c === '/substrate/v1/metrics').length;
    await app.open();
    await app.loaded();
    await until(() => expect(calls).toContain('/substrate/v1/errors'));
    await tick(SETTLE_MS); // the first tick has finished
    const before = metricsCalls();
    app.stdin.write('r');
    await until(() => expect(metricsCalls()).toBe(before + 1));
    await tick(SETTLE_MS);
    expect(metricsCalls()).toBe(before + 1);
    app.unmount();
  });
  it('after Esc closes the panel, time passing makes no more fetches', async () => {
    const { deps, calls } = fakeDeps();
    const app = start(deps);
    await app.open();
    await app.loaded();
    app.stdin.write(ESC);
    await until(() => expect(app.frame()).not.toContain('SERVICE'));
    // Let a tick that was already in flight at Esc finish its fetches, then count.
    await tick(SETTLE_MS);
    const n = calls.length;
    await tick(2 * SETTLE_MS);
    expect(calls.length).toBe(n);
    app.unmount();
  });
  it('app unmount stops the poller', async () => {
    const { deps, calls } = fakeDeps();
    const app = start(deps);
    await app.open();
    await app.loaded();
    app.unmount();
    await tick(SETTLE_MS);
    const n = calls.length;
    await tick(2 * SETTLE_MS);
    expect(calls.length).toBe(n);
  });
});

describe('substrate.dash short terminals', () => {
  const ok = <T,>(value: T) => ({ ok: true as const, value });
  function state(): DashState {
    const resolvers = Object.fromEntries(
      Array.from({ length: 12 }, (_, i) => [`ns/T${i}`, stat(10 + i, i + 1)])
    );
    const sample = (n: number): Sample => ({
      health: ok({ version: '7.4.0', uptimeSeconds: 99 }),
      metrics: ok({
        ...metricsAt(n, resolvers),
        events: Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`ev_${i}`, n])),
        slowest: [{ key: 'ns/T1', kind: 'query', durationMs: 120, at: 'x' }]
      }),
      embed: ok({ enabled: true, writes: 1, failures: 0 }),
      errors: { ok: false, why: 'admin' }
    });
    return step(step(initialDash(), sample(1), 0), sample(2), 5000);
  }
  for (const [columns, rows] of [
    [80, 24],
    [80, 16],
    [80, 15],
    [80, 10],
    [80, 3],
    [120, 14],
    [120, 5],
    [100, 6]
  ] as const) {
    it(`${columns}×${rows}: the frame is never taller than size.rows nor wider than columns`, () => {
      const r = renderAt(
        <DashView state={state()} theme={marathon} size={{ rows, columns }} />,
        columns
      );
      const lines = r.frame.replace(SGR, '').split('\n');
      expect(lines.length).toBeLessThanOrEqual(rows);
      for (const l of lines) expect(cellWidth(l)).toBeLessThanOrEqual(columns);
      if (rows >= 10)
        for (const t of ['SERVICE', 'ENGINE', 'LIVE TRAFFIC']) expect(r.frame).toContain(t);
      if (rows >= 15) {
        expect(r.frame).toContain('RECENT ERRORS');
        expect(r.frame).toContain('n/a (admin)');
      }
      r.unmount();
    });
  }
  it('80×26 with the band: the whole app fits, with key rows, and RECENT ERRORS shows n/a (admin)', async () => {
    const { deps } = fakeDeps({ errors: async () => Promise.reject(httpErr(403)) });
    const { App } = createApp({
      theme: marathon,
      modules: [dashModule(deps, { intervalMs: 10_000, timeoutMs: 50 })],
      band: true
    });
    const r = render(<App columns={80} rows={26} />);
    const frame = () => (r.lastFrame() ?? '').replace(SGR, '');
    r.stdin.write('/dash');
    await until(() => expect(frame()).toContain('/dash'));
    r.stdin.write(ENTER);
    await until(() => {
      expect(frame()).toContain('RECENT ERRORS');
      expect(frame()).toContain('n/a (admin)');
      expect(frame()).toMatch(/a\/X\s/);
      expect(frame()).toMatch(/b\/Y\s/);
    });
    expect(frame().split('\n').length).toBeLessThanOrEqual(26);
    r.unmount();
  });
});

describe('substrate.dash lifecycle (fake timers)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });
  function fakeCtx() {
    let open = false;
    let state: DashState | undefined;
    const ac = new AbortController();
    const ctx = {
      theme: marathon,
      signal: ac.signal,
      open: (_p: string, s: DashState) => {
        open = true;
        state = s;
      },
      update: (_p: string, fn: (s: DashState) => DashState) => {
        if (open && state !== undefined) state = fn(state);
      },
      close: () => {
        open = false;
      },
      print: () => {}
    };
    return {
      ctx: ctx as unknown as ModuleCtx<{ dash: DashState }>,
      close: ctx.close,
      ac,
      state: () => state
    };
  }
  it('stops its interval on the first tick after close, and on dispose', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
    const { deps, calls } = fakeDeps();
    const mod = dashModule(deps, { intervalMs: 1000 });
    const f = fakeCtx();
    const dispose = mod.init?.(f.ctx) as () => void;
    await mod.commands?.[0]?.run([], f.ctx);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.state()?.metrics?.ok).toBe(true);
    expect(vi.getTimerCount()).toBe(1);
    f.close();
    const n = calls.length;
    await vi.advanceTimersByTimeAsync(5000);
    expect(calls.length).toBe(n);
    expect(vi.getTimerCount()).toBe(0);

    await mod.commands?.[0]?.run([], f.ctx);
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(1);
    dispose();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('r during an in-flight tick queues exactly one follow-up tick', async () => {
    const { deps } = fakeDeps();
    let pending: (() => void)[] = [];
    let metricsCalls = 0;
    const slow: TuiDeps = {
      ...deps,
      metrics: (sg) => {
        metricsCalls++;
        return new Promise((res) => {
          pending.push(() => res(deps.metrics(sg)));
        });
      }
    };
    const mod = dashModule(slow, { intervalMs: 60_000, timeoutMs: 60_000 });
    const f = fakeCtx();
    const dispose = mod.init?.(f.ctx) as () => void;
    await mod.commands?.[0]?.run([], f.ctx);
    await until(() => expect(pending).toHaveLength(1));
    const refresh = mod.panels?.dash.on?.refresh;
    for (let i = 0; i < 3; i++) refresh?.(f.state() as DashState, f.ctx);
    await tick(SETTLE_MS);
    expect(metricsCalls).toBe(1); // not concurrent
    const flush = () => {
      const p = pending;
      pending = [];
      for (const fn of p) fn();
    };
    flush();
    await until(() => expect(pending).toHaveLength(1));
    expect(metricsCalls).toBe(2); // exactly one follow-up
    flush();
    await until(() => expect(f.state()?.metrics?.ok).toBe(true));
    await tick(SETTLE_MS);
    expect(metricsCalls).toBe(2);
    dispose();
  });
  it('an r 100 ms after a tick adds no rate point; the next full interval does', async () => {
    let t = 0;
    const mod = dashModule(fakeDeps().deps, { intervalMs: 60_000, clock: () => t });
    const f = fakeCtx();
    const dispose = mod.init?.(f.ctx) as () => void;
    // A tick's update and its busy flag clear in one synchronous step, so once a poll's total is
    // in the state the next refresh starts a fresh tick rather than queueing.
    const polled = (n: number) =>
      until(() => {
        const m = f.state()?.metrics;
        expect(m?.ok === true && m.value.requests.query.total).toBe(n * 10);
      });
    await mod.commands?.[0]?.run([], f.ctx);
    await polled(1);
    t = 5000;
    mod.panels?.dash.on?.refresh?.(f.state() as DashState, f.ctx);
    await polled(2);
    expect(f.state()?.hist.queryRate).toHaveLength(1);
    t = 5100;
    mod.panels?.dash.on?.refresh?.(f.state() as DashState, f.ctx);
    await polled(3);
    expect(f.state()?.hist.queryRate).toHaveLength(1);
    t = 10_000;
    mod.panels?.dash.on?.refresh?.(f.state() as DashState, f.ctx);
    await polled(4);
    // Two metrics calls since the 5000 baseline (10 queries each), over 5 s: 4/s, not a spike.
    expect(f.state()?.hist.queryRate).toEqual([2, 4]);
    dispose();
  });
  it('a reopen restarts with one interval, not two', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
    const mod = dashModule(fakeDeps().deps, { intervalMs: 1000 });
    const f = fakeCtx();
    const dispose = mod.init?.(f.ctx) as () => void;
    await mod.commands?.[0]?.run([], f.ctx);
    await mod.commands?.[0]?.run([], f.ctx);
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(1);
    dispose();
  });
});

describe('substrate.dash view', () => {
  const ok = <T,>(value: T) => ({ ok: true as const, value });
  function populated(resolvers: Record<string, ResolverStat>): DashState {
    const sample = (n: number): Sample => ({
      health: ok({ version: '7.4.0', uptimeSeconds: 4000 }),
      metrics: ok(metricsAt(n, resolvers)),
      embed: ok({ enabled: true, writes: 1, failures: 2 }),
      errors: ok({
        since: 'x',
        errors: [
          {
            at: '2026-10-05T01:02:03Z',
            op: 'query',
            key: 'a/X',
            code: 'boom',
            message: 'bad thing'
          }
        ]
      })
    });
    return step(step(step(initialDash(), sample(1), 0), sample(2), 5000), sample(4), 10_000);
  }
  for (const columns of [40, 96, 160]) {
    it(`at ${columns} columns it stacks SERVICE, ENGINE, LIVE TRAFFIC, full width`, () => {
      const state = populated({
        'journal/Todo': stat(30, 9),
        'journal/AVeryLongTypeNameIndeed': stat(150, 2, 1)
      });
      const r = renderAt(
        <DashView state={state} theme={marathon} size={{ rows: 60, columns }} />,
        columns
      );
      const lines = r.frame.replace(SGR, '').split('\n');
      for (const l of lines) expect(cellWidth(l)).toBeLessThanOrEqual(columns);
      const row = (t: string) => lines.findIndex((l) => l.includes(t));
      expect(row('◈ SERVICE')).toBeGreaterThanOrEqual(0);
      expect(row('◈ ENGINE')).toBeGreaterThan(row('◈ SERVICE'));
      expect(row('◈ LIVE TRAFFIC')).toBeGreaterThan(row('◈ ENGINE'));
      // One panel per row: no title row carries a second title.
      expect(lines[row('◈ SERVICE')]).not.toContain('◈ ENGINE');
      r.unmount();
    });
  }
  it('RECENT ERRORS names the caller, and an older server without one renders as before', () => {
    const base = populated({ 'journal/Todo': stat(30, 9) });
    const state: DashState = {
      ...base,
      errors: ok({
        since: 'x',
        errors: [
          {
            at: '2026-10-06T13:24:40Z',
            op: 'query',
            key: '_system/EnumCheckVerdict',
            code: 'policy_denied',
            message: 'requireCapability(admin)',
            caller: 'labs-claude@laptop'
          },
          { at: '2026-10-06T13:24:41Z', op: 'query', key: 'a/Old', code: 'c', message: 'm' }
        ]
      })
    };
    const r = renderAt(
      <DashView state={state} theme={marathon} size={{ rows: 60, columns: 160 }} />,
      160
    );
    const lines = r.frame.replace(SGR, '').split('\n');
    const row = lines.find((l) => l.includes('_system/EnumCheckVerdict'));
    expect(row).toContain('labs-claude@laptop');
    const old = lines.find((l) => l.includes('a/Old'));
    expect(old).toBeDefined();
    expect(old).not.toContain('undefined');
    r.unmount();
  });
  it('LIVE TRAFFIC takes the rows SERVICE and ENGINE leave', () => {
    const keys = Object.fromEntries(
      Array.from({ length: 30 }, (_, i) => [`ns/K${String(i).padStart(2, '0')}`, stat(10 + i, 5)])
    );
    const r = renderAt(
      <DashView state={populated(keys)} theme={marathon} size={{ rows: 50, columns: 120 }} />,
      120
    );
    const lines = r.frame.replace(SGR, '').split('\n');
    expect(lines.length).toBeLessThanOrEqual(50);
    const shown = lines.filter((l) => /ns\/K\d\d/.test(l)).length;
    expect(shown).toBeGreaterThanOrEqual(20);
    r.unmount();
  });
  it('a 200-character key carrying ESC renders truncated, with no ESC', () => {
    const evil = `ns/${'\x1b]0;pwned\x07'}${'x'.repeat(200)}`;
    const base = populated({ [evil]: stat(30, 9) });
    const state: DashState = {
      ...base,
      errors: ok({
        since: 'x',
        errors: [
          // A hostile timestamp: the ESC sequence sits inside the slice the view shows.
          { at: '2026-10-05T\x1b]0;at\x07\x1b[2J', op: 'query', key: 'k', code: 'c', message: 'm' }
        ]
      })
    };
    const view = dashModule(fakeDeps().deps).panels?.dash.view;
    if (view === undefined) throw new Error('no view');
    const r = render(
      <Box>{view({ state, theme: marathon, size: { rows: 40, columns: 96 } })}</Box>
    );
    const f = (r.lastFrame() ?? '').replace(SGR, '');
    expect(f.includes('\x1b')).toBe(false);
    expect(f.includes('\x07')).toBe(false);
    expect(f).not.toContain('pwned');
    expect(f).toContain('ns/xxx');
    expect(f).toContain('…');
    for (const l of f.split('\n')) expect(cellWidth(l)).toBeLessThanOrEqual(96);
    r.unmount();
  });
  for (const columns of [100, 160]) {
    it(`at ${columns} columns a per-key row keeps ✗ and the sparkline, within its panel`, () => {
      const state = populated({
        'journal/Todo': stat(30, 9, 1),
        'journal/AVeryLongTypeNameThatGoesOnAndOnForever': stat(150, 2, 1)
      });
      const r = renderAt(
        <DashView state={state} theme={marathon} size={{ rows: 40, columns }} />,
        columns
      );
      const lines = r.frame.replace(SGR, '').split('\n');
      // Stacked full-width panels: every body row carries exactly two borders.
      const body = lines.filter((l) => l.startsWith('│'));
      for (const l of body) expect(l.split('│')).toHaveLength(3);
      for (const l of lines) expect(cellWidth(l)).toBeLessThanOrEqual(columns);
      for (const key of ['journal/Todo', 'journal/AVery']) {
        const row = lines.find((l) => l.includes(key)) ?? '';
        const traffic = row.split('│').find((cell) => cell.includes(key)) ?? '';
        expect(traffic).toMatch(/✗\d+ [▁▂▃▄▅▆▇█]+/);
      }
      r.unmount();
    });
  }
  it("per-key ✗ is red only when that key's errors rose since the last poll", () => {
    const state = populated({ 'a/Rise': stat(10, 9, 1) });
    expect(state.keyErrRose.has('a/Rise')).toBe(false); // a constant cumulative count
    const toneOfX = (st: DashState) =>
      trafficLines(st, marathon, 60)
        .flat()
        .find((sg) => sg.t.includes('✗1'))?.tone;
    expect(toneOfX(state)).toBe('dim');
    expect(toneOfX({ ...state, keyErrRose: new Set(['a/Rise']) })).toBe('error');
  });
  it('latency and failures carry their threshold tones', () => {
    const state = populated({ 'journal/Todo': stat(150, 9) });
    const r = render(<DashView state={state} theme={marathon} size={{ rows: 40, columns: 96 }} />);
    const f = r.lastFrame() ?? '';
    expect(f).toContain('150ms');
    expect(f).toContain('✗2');
    r.unmount();
  });
});

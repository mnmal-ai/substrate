/**
 * The command-centre loop, driven through a fake ModuleCtx and fake timers, as
 * status.test does: the status cell and the transcript are the observable output.
 */

import type {
  DiagnoseOpts,
  DiagnoseResult,
  DoctorCheck,
  SubstrateClient
} from '@mnmal-ai/substrate/client';
import type { ModuleCtx } from '@mnmal-ai/surface-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAdminSession } from '../src/admin/session.js';
import { buildModules } from '../src/app.js';
import type { TuiDeps } from '../src/deps.js';
import { doctorModule } from '../src/doctor/module.js';
import { noAdmin, noDash } from './_fakes.js';

const ok = (name: string): DoctorCheck => ({ name, status: 'ok', detail: `${name} fine` });
const no = (name: string, detail = `${name} broken`): DoctorCheck => ({
  name,
  status: 'no',
  detail,
  fix: `fix ${name}`
});
const skip = (name: string): DoctorCheck => ({ name, status: 'skip', detail: 'not asked' });
const result = (checks: DoctorCheck[], facts: DiagnoseResult['facts'] = {}): DiagnoseResult => ({
  checks,
  exitCode: checks.some((c) => c.status === 'no') ? 1 : 0,
  identity: 'a@h',
  facts
});
// What an agent identity sees: the admin checks are NOT ASKED.
const AGENT_GREEN = result([
  ok('reachable'),
  ok('auth-enabled'),
  ok('credential'),
  ok('identity'),
  skip('admin-capability'),
  skip('admin-floor'),
  ok('namespaces'),
  skip('key-directory')
]);
const AGENT_AUTH_OFF = result([
  ok('reachable'),
  no('auth-enabled', 'auth is\nDISABLED'),
  ok('credential'),
  ok('identity'),
  skip('admin-capability'),
  skip('admin-floor'),
  ok('namespaces'),
  skip('key-directory')
]);
const UNREACHABLE = result([no('reachable')]);
const ADMIN_GREEN = result(
  [
    'reachable',
    'auth-enabled',
    'credential',
    'identity',
    'admin-capability',
    'admin-floor',
    'namespaces',
    'key-directory'
  ].map(ok),
  {
    adminKids: ['a1', 'a2'],
    liveKeyCount: 3,
    retiredWithLiveKey: [],
    liveKeyWithoutRow: [],
    agentKids: ['x']
  }
);

type Step = DiagnoseResult | 'hang';

function loop(results: Step[], over: Partial<TuiDeps> = {}, opts: { deadlineMs?: number } = {}) {
  const calls: DiagnoseOpts[] = [];
  let i = 0;
  const deps: TuiDeps = {
    endpoint: 'http://h',
    project: 'substrate',
    namespace: 'journal',
    nl: {} as TuiDeps['nl'],
    federatedSchema: async () => ({}),
    getJson: async () => ({}),
    ...noDash,
    ...noAdmin(),
    ...over
  };
  const status = new Map<string, { text: string | null; tone?: string }>();
  const printed: Array<{ text: string; tone?: string }> = [];
  const ac = new AbortController();
  const ctx = {
    signal: ac.signal,
    size: () => ({ rows: 30, columns: 120 }),
    status: (id: string, text: string | null, tone?: string) =>
      status.set(id, { text, ...(tone !== undefined ? { tone } : {}) }),
    print: (text: string, tone?: string) =>
      printed.push({ text, ...(tone !== undefined ? { tone } : {}) }),
    open: () => {},
    update: () => {},
    close: () => {},
    on: () => () => {}
  };
  const mod = doctorModule(deps, {
    intervalMs: 1_000,
    deadlineMs: opts.deadlineMs ?? 500,
    diagnose: async (o) => {
      calls.push(o);
      const r = results[Math.min(i++, results.length - 1)] as Step;
      return r === 'hang' ? new Promise<DiagnoseResult>(() => {}) : r;
    }
  });
  const dispose = mod.init?.(ctx as unknown as ModuleCtx<never>) as (() => void) | undefined;
  return {
    calls,
    status,
    printed,
    cell: () => status.get('doctor'),
    /** Runs `/doctor` against the loop's own ctx, as a keypress racing teardown would. */
    command: () => mod.commands?.[0]?.run([], ctx as never),
    stop: () => {
      ac.abort();
      dispose?.();
    }
  };
}

function unlockedAdmin() {
  const admin = createAdminSession({
    endpoint: 'http://h',
    idleMs: 60_000,
    makeClient: () => ({ close: async () => {} }) as unknown as SubstrateClient
  });
  admin.unlock('ops-admin@Box', () => 'jwt');
  return admin;
}

const adv = (ms: number) => vi.advanceTimersByTimeAsync(ms);
beforeEach(() => {
  vi.useFakeTimers({
    toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date']
  });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('command-centre loop', () => {
  it('runs at once; the first verdict sets the cell and prints nothing', async () => {
    const l = loop([AGENT_GREEN]);
    await adv(0);
    expect(l.calls).toHaveLength(1);
    expect(l.cell()).toEqual({ text: 'doctor ✓ 5/5', tone: 'dim' });
    expect(l.printed).toEqual([]);
    l.stop();
  });

  it('a step going NO prints once; staying NO prints nothing more', async () => {
    const l = loop([AGENT_GREEN, AGENT_AUTH_OFF, AGENT_AUTH_OFF]);
    await adv(0);
    await adv(1_000);
    await adv(1_000);
    expect(l.calls).toHaveLength(3);
    expect(l.printed).toEqual([
      { text: '⚠ doctor: auth-enabled went NO — auth is DISABLED · /doctor', tone: 'warn' }
    ]);
    expect(l.cell()).toEqual({ text: 'doctor ⚠ auth-enabled', tone: 'warn' });
    l.stop();
  });

  it('recovery prints one line', async () => {
    const l = loop([AGENT_AUTH_OFF, AGENT_GREEN]);
    await adv(0);
    await adv(1_000);
    expect(l.printed).toEqual([{ text: '✓ doctor: auth-enabled recovered', tone: 'dim' }]);
    l.stop();
  });

  it('an outage speaks once through reachable, and once on return', async () => {
    const l = loop([AGENT_GREEN, UNREACHABLE, UNREACHABLE, AGENT_GREEN]);
    await adv(0);
    await adv(1_000);
    expect(l.cell()).toEqual({ text: 'doctor ✗ unreachable', tone: 'error' });
    await adv(1_000);
    await adv(1_000);
    expect(l.printed.map((p) => p.text)).toEqual([
      '⚠ doctor: reachable went NO — reachable broken · /doctor',
      '✓ doctor: reachable recovered'
    ]);
    l.stop();
  });

  it('a step done before an outage and NO after it warns, though it was blocked between', async () => {
    const l = loop([AGENT_GREEN, UNREACHABLE, AGENT_AUTH_OFF]);
    await adv(0);
    await adv(1_000);
    await adv(1_000);
    expect(l.printed.map((p) => p.text)).toEqual([
      '⚠ doctor: reachable went NO — reachable broken · /doctor',
      '✓ doctor: reachable recovered',
      '⚠ doctor: auth-enabled went NO — auth is DISABLED · /doctor'
    ]);
    l.stop();
  });

  it('a step NO before an outage and done after it recovers', async () => {
    const l = loop([AGENT_AUTH_OFF, UNREACHABLE, AGENT_GREEN]);
    await adv(0);
    await adv(1_000);
    await adv(1_000);
    expect(l.printed.map((p) => p.text)).toEqual([
      '⚠ doctor: reachable went NO — reachable broken · /doctor',
      '✓ doctor: reachable recovered',
      '✓ doctor: auth-enabled recovered'
    ]);
    l.stop();
  });

  it('a hung run is dropped at its deadline as unreachable; ticks meanwhile add no call', async () => {
    const l = loop(['hang', AGENT_GREEN], {}, { deadlineMs: 2_500 });
    await adv(0);
    await adv(2_000); // two ticks while the first run hangs
    expect(l.calls).toHaveLength(1);
    await adv(500); // deadline
    expect(l.cell()).toEqual({ text: 'doctor ✗ unreachable', tone: 'error' });
    l.stop();
  });

  it('teardown stops the timer and silences a run still in flight', async () => {
    const l = loop(['hang'], {}, { deadlineMs: 10_000 });
    await adv(0);
    l.stop();
    const before = l.status.size;
    await adv(20_000);
    expect(l.calls).toHaveLength(1);
    expect(l.status.size).toBe(before);
    expect(l.printed).toEqual([]);
  });

  it('nothing starts after teardown, even on an explicit request', async () => {
    const l = loop([AGENT_GREEN]);
    await adv(0);
    l.stop();
    l.command();
    await adv(0);
    expect(l.calls).toHaveLength(1);
  });

  it('admin runs pass touch:false, so a background run never holds admin open', async () => {
    const admin = unlockedAdmin();
    const touches: Array<{ touch?: boolean } | undefined> = [];
    const spy = {
      ...admin,
      run: <T>(op: Parameters<typeof admin.run<T>>[0], o?: { touch?: boolean }) => {
        touches.push(o);
        return admin.run(op, o);
      }
    } as typeof admin;
    const l = loop([ADMIN_GREEN], { admin: spy });
    await adv(0);
    expect(touches).toEqual([{ touch: false }]);
    expect(l.cell()).toEqual({ text: 'doctor ✓ 10/10', tone: 'dim' });
    l.stop();
  });

  it('locking re-baselines: the agent view after an admin view prints nothing', async () => {
    const admin = unlockedAdmin();
    // auth-enabled is done for admin and NO for the agent: only a re-baseline keeps it silent.
    const l = loop([ADMIN_GREEN, AGENT_AUTH_OFF], { admin });
    await adv(0);
    admin.lock('test');
    await adv(0);
    expect(l.calls).toHaveLength(2);
    expect(l.calls[1]?.expectAdmin).toBe(false);
    expect(l.printed).toEqual([]);
    l.stop();
  });

  it('an admin run that finishes after a lock is discarded', async () => {
    const admin = unlockedAdmin();
    let release: (r: DiagnoseResult) => void = () => {};
    const gated = new Promise<DiagnoseResult>((r) => {
      release = r;
    });
    const calls: DiagnoseOpts[] = [];
    const status = new Map<string, unknown>();
    const printed: string[] = [];
    const ac = new AbortController();
    const mod = doctorModule(
      {
        endpoint: 'http://h',
        project: 'substrate',
        namespace: 'journal',
        nl: {} as TuiDeps['nl'],
        federatedSchema: async () => ({}),
        getJson: async () => ({}),
        ...noDash,
        ...noAdmin(),
        admin
      } as TuiDeps,
      {
        intervalMs: 1_000,
        deadlineMs: 5_000,
        diagnose: (o) => {
          calls.push(o);
          return calls.length === 1 ? gated : Promise.resolve(AGENT_AUTH_OFF);
        }
      }
    );
    mod.init?.({
      signal: ac.signal,
      status: (id: string, t: string | null) => status.set(id, t),
      print: (t: string) => printed.push(t),
      open: () => {},
      update: () => {},
      close: () => {},
      on: () => () => {}
    } as unknown as ModuleCtx<never>);
    await adv(0);
    admin.lock('test');
    release(ADMIN_GREEN);
    await adv(0);
    // The stale admin result never became the cell; the agent run did.
    expect(status.get('doctor')).toBe('doctor ⚠ auth-enabled');
    expect(printed).toEqual([]);
    ac.abort();
  });

  it('notices are sanitised: no escape sequence reaches the transcript', async () => {
    const evil = result([
      ok('reachable'),
      no('auth-enabled', 'bad\u001b[31mred\u0007'),
      ok('credential'),
      ok('identity'),
      skip('admin-capability'),
      skip('admin-floor'),
      ok('namespaces'),
      skip('key-directory')
    ]);
    const l = loop([AGENT_GREEN, evil]);
    await adv(0);
    await adv(1_000);
    const text = l.printed[0]?.text ?? '';
    expect(text).toContain('auth-enabled went NO');
    expect(text.includes('\u001b')).toBe(false);
    expect(text.includes('\u0007')).toBe(false);
    l.stop();
  });
});

describe('app wiring', () => {
  it('buildModules accepts doctorIntervalMs and registers the doctor module', () => {
    const deps = {
      endpoint: 'http://h',
      project: 'substrate',
      namespace: 'journal',
      nl: {} as TuiDeps['nl'],
      federatedSchema: async () => ({}),
      getJson: async () => ({}),
      ...noDash,
      ...noAdmin()
    } as TuiDeps;
    const mods = buildModules(deps, { doctorIntervalMs: 1_234 }) ?? [];
    expect(mods.some((m) => m.id === 'substrate.doctor')).toBe(true);
  });
});

describe('review fixes', () => {
  it('a foreground admin action (touch) does not trigger a diagnose; only a lock/unlock flip does', async () => {
    const admin = unlockedAdmin();
    const l = loop([ADMIN_GREEN], { admin });
    await adv(0);
    expect(l.calls).toHaveLength(1);
    await admin.run(async () => 1); // touches: onChange('unlocked') again
    await admin.run(async () => 2);
    await adv(0);
    expect(l.calls).toHaveLength(1);
    admin.lock('test');
    await adv(0);
    expect(l.calls).toHaveLength(2);
    l.stop();
  });

  it('each run releases its abort signal, so nothing accumulates over a long session', async () => {
    const signals: AbortSignal[] = [];
    vi.stubGlobal('fetch', async (_u: unknown, init?: RequestInit) => {
      if (init?.signal) signals.push(init.signal);
      return new Response('{}');
    });
    try {
      const l = loop([AGENT_GREEN]);
      // The fake diagnose does not fetch; reach the run's fetch through the opts it was given.
      await adv(0);
      await l.calls[0]?.fetch?.('http://h/health');
      await adv(0);
      expect(signals).toHaveLength(1);
      expect(signals[0]?.aborted).toBe(true);
      l.stop();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('a diagnose that throws turns the cell to ✗ could not run, never leaves a stale ✓', async () => {
    let n = 0;
    const l = loop([AGENT_GREEN]);
    l.stop();
    const status = new Map<string, { text: string | null; tone?: string }>();
    const ac = new AbortController();
    const mod = doctorModule(
      {
        endpoint: 'http://h',
        project: 'substrate',
        namespace: 'journal',
        nl: {} as TuiDeps['nl'],
        federatedSchema: async () => ({}),
        getJson: async () => ({}),
        ...noDash,
        ...noAdmin()
      } as TuiDeps,
      {
        intervalMs: 1_000,
        deadlineMs: 500,
        diagnose: async () => {
          n += 1;
          if (n === 1) return AGENT_GREEN;
          throw new Error('boom');
        }
      }
    );
    mod.init?.({
      signal: ac.signal,
      status: (id: string, text: string | null, tone?: string) =>
        status.set(id, { text, ...(tone !== undefined ? { tone } : {}) }),
      print: () => {},
      open: () => {},
      update: () => {},
      close: () => {},
      on: () => () => {}
    } as unknown as ModuleCtx<never>);
    await adv(0);
    expect(status.get('doctor')?.text).toBe('doctor ✓ 5/5');
    await adv(1_000);
    expect(status.get('doctor')).toEqual({ text: 'doctor ✗ could not run', tone: 'error' });
    ac.abort();
  });
});

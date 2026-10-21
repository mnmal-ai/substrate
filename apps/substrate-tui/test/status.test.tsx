import type { ModuleCtx, TuiModule } from '@mnmal-ai/surface-core';
import { createApp } from '@mnmal-ai/surface-core';
import { marathon } from '@mnmal-ai/surface-theme';
import { render } from 'ink-testing-library';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { askModule } from '../src/ask/module.js';
import type { TuiDeps } from '../src/deps.js';
import { statusModule } from '../src/status/module.js';
import { noAdmin, noDash } from './_fakes.js';

function viewOf(mod: TuiModule): string {
  const view = mod.presence?.view;
  if (view === undefined) throw new Error('no presence view');
  return String(view({ theme: marathon } as never));
}
type Reply = unknown | Error | ((signal?: AbortSignal) => Promise<unknown>);
function harness(health: Reply[], whoami: Reply) {
  const calls: string[] = [];
  let h = 0;
  const deps: TuiDeps = {
    endpoint: 'http://h',
    project: 'substrate',
    namespace: 'journal',
    nl: {} as TuiDeps['nl'],
    federatedSchema: async () => ({}),
    ...noDash,
    ...noAdmin(),
    async getJson(path, signal) {
      calls.push(path);
      const r = path === '/health' ? health[Math.min(h++, health.length - 1)] : whoami;
      if (r instanceof Error) throw r;
      if (typeof r === 'function') return r(signal);
      return r;
    }
  };
  const status = new Map<string, { text: string | null; tone?: string }>();
  const listeners: ((p: { namespace: string }) => void)[] = [];
  const ctx = {
    signal: new AbortController().signal,
    size: () => ({ rows: 30, columns: 120 }),
    status: (id: string, text: string | null, tone?: string) =>
      status.set(id, { text, ...(tone !== undefined ? { tone } : {}) }),
    on: (_e: string, fn: (p: { namespace: string }) => void) => {
      listeners.push(fn);
      return () => listeners.splice(listeners.indexOf(fn), 1);
    }
  };
  const mod = statusModule(deps, { intervalMs: 1000 });
  const dispose = mod.init?.(ctx as unknown as ModuleCtx<never>) as (() => void) | undefined;
  const presence = () => viewOf(mod);
  return { calls, status, listeners, dispose, presence };
}
const ok = { status: 'ok', version: '7.3.1' };
const adv = (ms: number) => vi.advanceTimersByTimeAsync(ms);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('substrate.status', () => {
  it('shows LIVE and the version when health succeeds', async () => {
    const t = harness([ok], { authEnabled: true, identity: null });
    await adv(0);
    expect(t.presence()).toBe('● live · journal');
    expect(t.status.get('version')?.text).toBe('v7.3.1');
    t.dispose?.();
  });
  it('shows OFFLINE when health fails first', async () => {
    const t = harness([new Error('down')], {});
    await adv(0);
    expect(t.presence()).toBe('○ offline · journal');
    t.dispose?.();
  });
  it('goes RECONNECTING after a failure following success, then LIVE again', async () => {
    const t = harness([ok, new Error('x'), ok], {});
    await adv(0);
    expect(t.presence()).toBe('● live · journal');
    await adv(1000);
    expect(t.presence()).toBe('◌ reconnecting · journal');
    await adv(1000);
    expect(t.presence()).toBe('● live · journal');
    t.dispose?.();
  });
  it('shows the kid, anon, or anon? from whoami', async () => {
    const a = harness([ok], { authEnabled: true, identity: { id: 'substrate-claude@devbox' } });
    const b = harness([ok], { authEnabled: true, identity: null });
    const c = harness([ok], new Error('401'));
    await adv(0);
    expect(a.status.get('who')?.text).toBe('substrate-claude@devbox');
    expect(b.status.get('who')?.text).toBe('anon');
    expect(c.status.get('who')?.text).toBe('anon?');
    for (const t of [a, b, c]) t.dispose?.();
  });
  it('strips escape and bell bytes from server-supplied identity and version', async () => {
    const t = harness([{ version: '1\x1b[31m.0\x07' }], { identity: { id: 'x\x1b]0;x\x07y' } });
    await adv(0);
    for (const id of ['who', 'version']) {
      const text = t.status.get(id)?.text ?? '';
      expect(text.includes('\x1b') || text.includes('\x07')).toBe(false);
      expect(text.length).toBeGreaterThan(0);
    }
    t.dispose?.();
  });
  it('collapses line breaks in a server-supplied identity and version', async () => {
    const t = harness([{ version: '7\n.4\r\n.0' }], { identity: { id: 'a\nb@h' } });
    await adv(0);
    expect(t.status.get('who')?.text).toBe('a b@h');
    expect(t.status.get('version')?.text).toBe('v7 .4 .0');
    t.dispose?.();
  });
  it('follows substrate/ns', async () => {
    const t = harness([ok], {});
    expect(t.presence()).toContain('journal');
    t.listeners[0]?.({ namespace: 'plane' });
    expect(t.presence()).toBe('◌ … · plane');
    expect(t.status.get('presence-tick')?.text ?? null).toBeNull();
    t.dispose?.();
  });
  it('unmount clears the interval', async () => {
    const t = harness([ok], {});
    await adv(2500);
    t.dispose?.();
    const n = t.calls.length;
    await adv(5000);
    expect(t.calls.length).toBe(n);
    expect(t.listeners.length).toBe(0);
  });
});

describe('substrate.status presence', () => {
  it('adds N in flight from /substrate/v1/metrics and drops it when metrics fail or idle', async () => {
    let metrics: unknown = { process: { inFlight: 2 } };
    const deps: TuiDeps = {
      endpoint: 'http://h',
      project: 'substrate',
      namespace: 'journal',
      nl: {} as TuiDeps['nl'],
      federatedSchema: async () => ({}),
      ...noDash,
      ...noAdmin(),
      getJson: async (p) => {
        if (p === '/substrate/v1/metrics') {
          if (metrics instanceof Error) throw metrics;
          return metrics;
        }
        return p === '/health' ? ok : {};
      }
    };
    const ticks: (string | null)[] = [];
    const ctx = {
      signal: new AbortController().signal,
      size: () => ({ rows: 30, columns: 120 }),
      status: (id: string, text: string | null) => id === 'presence-tick' && ticks.push(text),
      on: () => () => {}
    };
    const mod = statusModule(deps, { intervalMs: 1000 });
    const dispose = mod.init?.(ctx as unknown as ModuleCtx<never>) as () => void;
    const view = () => viewOf(mod);
    await adv(0);
    expect(view()).toBe('● live · journal · 2 in flight');
    expect(ticks.length).toBeGreaterThan(0);
    metrics = { process: { inFlight: 0 } };
    await adv(1000);
    expect(view()).toBe('● live · journal');
    metrics = new Error('503');
    await adv(1000);
    expect(view()).toBe('● live · journal');
    dispose();
  });
  it('strips escape bytes from the namespace', async () => {
    const t = harness([ok], {});
    t.listeners[0]?.({ namespace: 'a\x1b[31mb\x07' });
    const text = t.presence();
    expect(text.includes('\x1b') || text.includes('\x07')).toBe(false);
    t.dispose?.();
  });
});

describe('substrate.status resilience', () => {
  it('times out a hung poll, goes RECONNECTING, and keeps one request in flight', async () => {
    let healthCalls = 0;
    let aborted = 0;
    const hang = (signal?: AbortSignal) =>
      new Promise<never>((_res, rej) => {
        healthCalls++;
        signal?.addEventListener('abort', () => {
          aborted++;
          rej(new Error('aborted'));
        });
      });
    const t = harness([ok, hang], {});
    await adv(0);
    expect(t.presence()).toBe('● live · journal');
    await adv(1000);
    expect(healthCalls).toBe(1);
    await adv(3000);
    expect(healthCalls).toBe(1);
    expect(t.presence()).toBe('● live · journal');
    await adv(2000);
    expect(aborted).toBe(1);
    expect(t.presence()).toBe('◌ reconnecting · journal');
    t.dispose?.();
  });
  it('clears the version while offline and refetches whoami after recovery', async () => {
    const t = harness([ok, new Error('x'), ok], { identity: { id: 'k@h' } });
    await adv(0);
    expect(t.status.get('version')?.text).toBe('v7.3.1');
    await adv(1000);
    expect(t.status.get('version')?.text).toBe('…');
    const before = t.calls.filter((c) => c === '/substrate/v1/whoami').length;
    await adv(1000);
    expect(t.status.get('version')?.text).toBe('v7.3.1');
    expect(t.calls.filter((c) => c === '/substrate/v1/whoami').length).toBe(before + 1);
    t.dispose?.();
  });
  it('recovers who from anon? when started offline', async () => {
    let n = 0;
    const t = harness([new Error('down'), ok], async () => {
      if (n++ === 0) throw new Error('down');
      return { identity: { id: 'k@h' } };
    });
    await adv(0);
    expect(t.status.get('who')?.text).toBe('anon?');
    await adv(1000);
    expect(t.status.get('who')?.text).toBe('k@h');
    t.dispose?.();
  });
  it('seeds items in a fixed order before any request answers', () => {
    const t = harness([() => new Promise(() => {})], () => new Promise(() => {}));
    expect([...t.status.keys()]).toEqual(['version', 'who']);
    t.dispose?.();
  });
});

describe('substrate.status composed (real timers)', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });
  it('renders LIVE, version, kid and follows /ns', async () => {
    const deps: TuiDeps = {
      endpoint: 'http://h',
      project: 'substrate',
      namespace: 'journal',
      nl: {
        async *ask() {},
        askJson: async () => ({ outcome: null, trail: [] }),
        pack: async () => {
          throw new Error('x');
        }
      } as unknown as TuiDeps['nl'],
      federatedSchema: async () => ({}),
      ...noDash,
      ...noAdmin(),
      getJson: async (p) =>
        p === '/health' ? ok : { authEnabled: true, identity: { id: 'substrate-claude@devbox' } }
    };
    const { App } = createApp({
      theme: marathon,
      modules: [statusModule(deps), askModule(deps)],
      defaultTurn: 'substrate.ask:ask',
      band: true
    });
    const r = render(<App columns={120} />);
    // Poll rather than sleep: a fixed sleep flakes under full-workspace load.
    const until = (assert: () => void) => vi.waitFor(assert, { timeout: 2000, interval: 20 });
    const f = () => r.lastFrame() ?? '';
    const row = () =>
      f()
        .split('\n')
        .find((l) => l.includes('s u b s t r a t e')) ?? '';
    await until(() => {
      expect(row()).toContain('● live · journal');
      expect(f()).toContain('v7.3.1');
      expect(f()).toContain('substrate-claude@devbox');
    });
    r.stdin.write('/ns plane');
    await until(() => expect(f()).toContain('/ns plane'));
    r.stdin.write('\r');
    await until(() => {
      expect(row()).toContain('plane');
      expect(row()).not.toContain('journal');
    });
    r.unmount();
  });
});

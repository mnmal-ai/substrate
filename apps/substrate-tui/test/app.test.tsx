import type { NlApi } from '@mnmal-ai/substrate/client';
import { assertComposes } from '@mnmal-ai/surface-core';
import { marathon } from '@mnmal-ai/surface-theme';
import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';
import { buildModules, createTui, substrateAppOptions } from '../src/app.js';
import type { TuiDeps } from '../src/deps.js';
import { noAdmin, noDash } from './_fakes.js';

// Positive frame assertions poll rather than sleep: a fixed sleep flakes under full-workspace load.
const until = (assert: () => void) => vi.waitFor(assert, { timeout: 2000, interval: 20 });

function fake() {
  const asked: string[] = [];
  const nl: NlApi = {
    // biome-ignore lint/correctness/useYield: an empty stream is the point
    async *ask(req) {
      asked.push(req.question);
    },
    askJson: async () => ({ outcome: null, trail: [] }),
    pack: async () => {
      throw new Error('no');
    }
  };
  const deps: TuiDeps = {
    endpoint: 'http://h',
    project: 'substrate',
    namespace: 'journal',
    nl,
    federatedSchema: async () => ({}),
    ...noDash,
    ...noAdmin(),
    getJson: async (p) =>
      p === '/substrate/v1/metrics' ? { process: { inFlight: 2 } } : { version: '7.3.1' }
  };
  return { deps, asked };
}

describe('app', () => {
  it('leaves the terminal to the bin, which prepares it with SUBSTRATE_TUI_BACKGROUND / SUBSTRATE_TUI_CLEAR', () => {
    expect(substrateAppOptions(fake().deps).terminal).toBe(false);
  });
  it('paints no overlay fill, so panels sit on the ground', () => {
    const { theme } = substrateAppOptions(fake().deps);
    expect(theme?.color.raised).toBe('');
    expect(theme?.color.accent).toBe(marathon.color.accent);
  });
  it('composes', () => {
    expect(() => assertComposes(buildModules(fake().deps))).not.toThrow();
  });
  it('registers ns, frame and schema commands', () => {
    const { registry } = createTui(fake().deps);
    const names = [...registry.commands.keys()];
    for (const n of ['ns', 'frame', 'schema']) expect(names).toContain(n);
  });
  it('defaults free text to substrate.ask', async () => {
    const { deps, asked } = fake();
    const { App } = createTui(deps);
    const r = render(<App columns={120} />);
    r.stdin.write('hello');
    await until(() => expect(r.lastFrame()).toContain('hello'));
    r.stdin.write('\r');
    await until(() => expect(asked).toEqual(['hello']));
    r.unmount();
  });
  it('renders the presence row in the band, follows /ns, and shows the ctrl-c hint', async () => {
    const { App } = createTui(fake().deps);
    const r = render(<App columns={120} />);
    const row = () =>
      (r.lastFrame() ?? '').split('\n').find((l) => l.includes('s u b s t r a t e')) ?? '';
    await until(() => {
      expect(row()).toContain('● live · journal');
      expect(row()).toContain('2 in flight');
    });
    r.stdin.write('/ns plane');
    await until(() => expect(r.lastFrame()).toContain('/ns plane'));
    r.stdin.write('\r');
    await until(() => {
      expect(row()).toContain('plane');
      expect(row()).not.toContain('journal');
    });
    r.stdin.write('\x03');
    await until(() => expect(row()).toContain('press ctrl+c again to exit'));
    r.unmount();
  });
  it('shows offline when health fails', async () => {
    const { deps } = fake();
    const down = {
      ...deps,
      getJson: async () => {
        throw new Error('down');
      }
    };
    const { App } = createTui(down);
    const r = render(<App columns={120} />);
    const row = () =>
      (r.lastFrame() ?? '').split('\n').find((l) => l.includes('s u b s t r a t e')) ?? '';
    await until(() => expect(row()).toContain('○ offline'));
    r.unmount();
  });
  it('band follows live (2 in flight) -> idle -> reconnecting -> recovery in rendered frames', async () => {
    let healthy = true;
    let inflight = 2;
    const { deps } = fake();
    const live: TuiDeps = {
      ...deps,
      getJson: async (p) => {
        if (p === '/health') {
          if (!healthy) throw new Error('down');
          return { version: '7.3.1' };
        }
        if (p === '/substrate/v1/metrics') return { process: { inFlight: inflight } };
        return {};
      }
    };
    const { App } = createTui(live, { intervalMs: 100 });
    const r = render(<App columns={120} />);
    const row = () =>
      (r.lastFrame() ?? '').split('\n').find((l) => l.includes('s u b s t r a t e')) ?? '';
    await until(() => expect(row()).toContain('● live · journal · 2 in flight'));
    inflight = 0;
    await until(() => {
      expect(row()).toContain('● live · journal');
      expect(row()).not.toContain('in flight');
    });
    inflight = 3;
    healthy = false;
    await until(() => {
      expect(row()).toContain('◌ reconnecting · journal');
      expect(row()).not.toContain('in flight');
    });
    healthy = true;
    await until(() => expect(row()).toContain('● live · journal · 3 in flight'));
    r.unmount();
  });
});

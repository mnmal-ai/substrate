import { type AdminKeyRow, AuthError, type SubstrateClient } from '@mnmal-ai/substrate/client';
import { createApp } from '@mnmal-ai/surface-core';
import { defaultTheme, marathon, type Theme } from '@mnmal-ai/surface-theme';
import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';
import { createAdminSession } from '../src/admin/session.js';
import type { TuiDeps } from '../src/deps.js';
import { compactGrant } from '../src/keys/grant.js';
import {
  headParts,
  hintParts,
  type KeysState,
  keysModule,
  legendParts
} from '../src/keys/module.js';
import { noAdmin, noDash } from './_fakes.js';

const until = (assert: () => void) => vi.waitFor(assert, { timeout: 2000, interval: 20 });
const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));
const ENTER = '\r';
const DOWN = '\u001B[B';
const row = (kid: string, namespaces: string): AdminKeyRow => ({
  id: kid,
  kid,
  name: `${kid.split('@')[0]} key`,
  algorithm: 'EdDSA',
  namespaces,
  capabilities: 'read,mutate',
  createdAt: ''
});
const ROWS = [row('a-agent@Box', 'journal,plane:read'), row('b-admin@Box', '_system:read+admin')];

function start(over: Partial<TuiDeps>, theme: Theme = marathon, columns = 120) {
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
  const { App } = createApp({ theme, modules: [keysModule(deps)], band: true });
  const r = render(<App columns={columns} rows={40} />);
  return { ...r, deps, frame: () => r.lastFrame() ?? '' };
}
async function open(app: { stdin: { write(s: string): void } }) {
  app.stdin.write('/keys');
  await tick();
  app.stdin.write(ENTER);
  await tick(80);
}

describe('/keys', () => {
  it('1. locked, with an agent grant that cannot read keys: says admin is required', async () => {
    const app = start({
      keys: async () => {
        throw new AuthError('Forbidden', 403);
      }
    });
    await open(app);
    expect(app.frame()).toContain('admin required — /admin unlock');
    app.unmount();
  });

  it('an unlocked read refused by a route shows the refusal, not "admin required"', async () => {
    const admin = createAdminSession({
      endpoint: 'http://h',
      idleMs: 60_000,
      makeClient: () =>
        ({
          admin: {
            keys: async () => {
              throw new AuthError('Forbidden', 403, {
                code: 'policy_denied',
                serverMessage: 'denied'
              });
            }
          },
          close: async () => {}
        }) as unknown as SubstrateClient
    });
    admin.unlock('b-admin@Box', () => 't');
    const app = start({ admin });
    await open(app);
    expect(app.frame()).toContain('could not read keys: policy_denied: denied');
    expect(app.frame()).not.toContain('admin required');
    app.unmount();
  });

  it('2. unlocked: reads through the admin session and lists kid and grant summary', async () => {
    const admin = createAdminSession({
      endpoint: 'http://h',
      idleMs: 60_000,
      makeClient: () =>
        ({ admin: { keys: async () => ROWS }, close: async () => {} }) as unknown as SubstrateClient
    });
    admin.unlock('b-admin@Box', () => 't');
    const app = start({ admin });
    await open(app);
    expect(app.frame()).toContain('keys · 2 active · admin');
    // Grouped under the host, the agent name with one aligned column per namespace; no description.
    expect(app.frame()).toMatch(/^\s+── Box ─+ 2$/m);
    expect(app.frame()).toMatch(/a-agent\s+journal rm\s+plane r/);
    expect(app.frame()).not.toContain('a-agent key');
    expect(app.frame()).toContain('r=read · m=mutate · a=admin');
    app.unmount();
  });

  it('3. Enter on a row shows its full per-namespace grant', async () => {
    const app = start({ keys: async () => ROWS });
    await open(app);
    app.stdin.write(DOWN);
    await tick();
    app.stdin.write(ENTER);
    await tick();
    expect(app.frame()).toContain('b-admin@Box');
    expect(app.frame()).toContain('_system:read+admin');
    app.unmount();
  });

  it('4. locking while an admin-read table is open closes it, with a note', async () => {
    const admin = createAdminSession({
      endpoint: 'http://h',
      idleMs: 60_000,
      makeClient: () =>
        ({ admin: { keys: async () => ROWS }, close: async () => {} }) as unknown as SubstrateClient
    });
    admin.unlock('b-admin@Box', () => 't');
    const app = start({ admin });
    await open(app);
    admin.lock('locked by /admin lock');
    await tick();
    expect(app.frame()).not.toContain('a-agent@Box');
    expect(app.frame()).not.toContain('keys · 2 active');
    expect(app.frame()).toContain('keys closed — admin locked');
    app.unmount();
  });

  it('5. a late admin read cannot land in an agent table opened after the lock', async () => {
    let release = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const admin = createAdminSession({
      endpoint: 'http://h',
      idleMs: 60_000,
      makeClient: () =>
        ({
          admin: {
            keys: async () => {
              await gate;
              return [row('z-secret@Box', '_system:read+admin')];
            }
          },
          close: async () => {}
        }) as unknown as SubstrateClient
    });
    admin.unlock('b-admin@Box', () => 't');
    const app = start({ admin, keys: async () => ROWS });
    await open(app);
    admin.lock('locked by /admin lock');
    await tick();
    await open(app);
    expect(app.frame()).toContain('keys · 2 active · agent');
    release();
    await tick(80);
    expect(app.frame()).toMatch(/a-agent\s+journal/);
    expect(app.frame()).not.toContain('z-secret');
    expect(app.frame()).toContain('keys · 2 active · agent');
    app.unmount();
  });
});

describe('/keys revoked toggle (#1914)', () => {
  const GONE: AdminKeyRow = {
    ...row('c-old@Box', 'journal'),
    revokedAt: '2026-11-01T10:00:00.000Z'
  };
  const LIVE = ROWS.map((r) => ({ ...r, revokedAt: null }));

  it('r re-reads with filter all and lists revoked rows with their revokedAt; r again hides them', async () => {
    const filters: (string | undefined)[] = [];
    const app = start({
      keys: async (_signal, filter) => {
        filters.push(filter);
        return filter === 'all' ? [...LIVE, GONE] : ROWS;
      }
    });
    await open(app);
    expect(app.frame()).toContain('r show revoked');
    expect(app.frame()).not.toContain('c-old@Box');
    app.stdin.write('r');
    // Revoked keys sit in a section of their own, with the date they were revoked.
    await until(() => expect(app.frame()).toMatch(/^\s+── revoked ─+ 1$/m));
    expect(app.frame()).toMatch(/c-old@Box\s+2026-11-01/);
    expect(app.frame()).toContain('keys · 2 active · 1 revoked · agent');
    expect(app.frame()).toContain('r hide revoked');
    app.stdin.write('r');
    await until(() => expect(app.frame()).not.toContain('c-old@Box'));
    expect(filters).toEqual(['active', 'all', 'active']);
    app.unmount();
  });

  it('unlocked, a revoked row is read-only: enter shows its grant, x does nothing', async () => {
    const seen: (string | undefined)[] = [];
    const admin = createAdminSession({
      endpoint: 'http://h',
      idleMs: 60_000,
      makeClient: () =>
        ({
          admin: {
            keys: async (o?: { filter?: string }) => {
              seen.push(o?.filter);
              return o?.filter === 'all' ? [GONE, ...LIVE] : ROWS;
            }
          },
          close: async () => {}
        }) as unknown as SubstrateClient
    });
    admin.unlock('b-admin@Box', () => 't');
    const app = start({ admin });
    await open(app);
    app.stdin.write('r');
    await until(() => expect(app.frame()).toContain('c-old@Box'));
    expect(seen).toEqual(['active', 'all']);
    // The cursor stays on the row it was on (a-agent); revoked rows sort last, two rows down.
    app.stdin.write('j');
    await tick();
    app.stdin.write('j');
    await tick();
    app.stdin.write('x');
    await tick();
    expect(app.frame()).not.toContain('revoke c-old@Box');
    expect(app.frame()).toContain('keys · 2 active · 1 revoked · admin');
    app.stdin.write(ENTER);
    await until(() => expect(app.frame()).toContain('revoked 2026-11-01T10:00:00.000Z'));
    expect(app.frame()).toContain('backspace back');
    app.unmount();
  });
});

describe('/keys styling', () => {
  const state = (rows: AdminKeyRow[] | null, revoked = false) => ({
    source: 'admin' as const,
    rows,
    note: null,
    cursor: 0,
    detail: false,
    revoked
  });

  it('tones the head: glyph accent, keys bold text, the rest dimMid', () => {
    const parts = headParts(state(ROWS), '◆');
    expect(parts[0]).toMatchObject({ text: '◆', tone: 'accent' });
    expect(parts.find((p) => p.text === 'keys')).toMatchObject({ tone: 'text', bold: true });
    expect(parts.map((p) => p.text).join('')).toBe('◆ keys · 2 active · admin');
    expect(parts.at(-1)).toMatchObject({ tone: 'dimMid' });
  });

  it('tones the legend dim with a warn bold a', () => {
    const parts = legendParts();
    expect(parts.map((p) => p.text).join('')).toBe('  r=read · m=mutate · a=admin');
    expect(parts.find((p) => p.text === 'a')).toMatchObject({ tone: 'warn', bold: true });
    expect(parts.filter((p) => p.tone !== 'dim' && p.text !== 'a')).toEqual([]);
  });

  it('tones hints: keys text, actions dimMid, separators dim', () => {
    const parts = hintParts([
      ['enter', 'grant'],
      ['esc', 'close']
    ]);
    expect(parts.map((p) => p.text).join('')).toBe('  enter grant · esc close');
    expect(parts.find((p) => p.text === 'enter')).toMatchObject({ tone: 'text' });
    expect(parts.find((p) => p.text === ' grant')).toMatchObject({ tone: 'dimMid' });
    expect(parts.find((p) => p.text === ' · ')).toMatchObject({ tone: 'dim' });
  });

  it('tones the head the same in the note, reading, detail and list views', () => {
    type Node = { props: { children: Node[] | string; color?: string; bold?: boolean } };
    const { view } = (keysModule({ ...noDash, ...noAdmin() } as TuiDeps).panels ?? {}).keys as {
      view: (p: unknown) => unknown;
    };
    const tones = (s: KeysState) => {
      const node = view({ state: s, theme: marathon, size: { columns: 60, rows: 20 } }) as Node;
      const head = (node.props.children as Node[])[0] as Node;
      return (head.props.children as Node[]).map((p) => [p.props.color, p.props.bold]);
    };
    const list = tones(state(ROWS));
    expect(list[0]).toEqual([marathon.color.accent, undefined]);
    expect(list).toContainEqual([marathon.color.text, true]);
    expect(tones({ ...state(ROWS), note: 'could not read keys: down' })).toEqual(list);
    expect(tones(state(null))).toEqual(list);
    expect(tones({ ...state(ROWS), detail: true })).toEqual(list);
  });

  it('truncates the head to the panel width, so it stays one line', async () => {
    const gone = { ...row('c-old@Box', 'journal'), revokedAt: '2026-11-01T10:00:00.000Z' };
    const app = start(
      { keys: async (_s, f) => (f === 'all' ? [...ROWS, gone] : ROWS) },
      marathon,
      34
    );
    await open(app);
    app.stdin.write('r');
    await until(() => expect(app.frame()).toMatch(/── revoked/));
    const lines = app.frame().split('\n');
    const at = lines.findIndex((l) => l.includes('keys ·'));
    expect(lines[at]?.endsWith('…')).toBe(true);
    expect(lines[at + 1]).toMatch(/── Box/);
    app.unmount();
  });

  it('renders under marathon and the default theme', async () => {
    const boot = { ...row('boot-id', 'journal'), name: 'bootstrap-admin' };
    for (const theme of [marathon, defaultTheme]) {
      const app = start({ keys: async () => [...ROWS, boot] }, theme);
      await open(app);
      expect(app.frame()).toMatch(/── Box ─+ 2/);
      expect(app.frame()).toContain('bootstrap-admin');
      expect(app.frame()).toContain('r=read · m=mutate · a=admin');
      app.unmount();
    }
  });

  it('an empty table shows the head, legend and hints only', async () => {
    const app = start({ keys: async () => [] });
    await open(app);
    const lines = app
      .frame()
      .split('\n')
      .filter((l) => l.trim() !== '');
    expect(lines.some((l) => l.includes('keys · 0 active'))).toBe(true);
    expect(app.frame()).toContain('r=read · m=mutate · a=admin');
    expect(app.frame()).toContain('r show revoked');
    expect(app.frame()).not.toContain('──');
    app.unmount();
  });

  it('with only revoked keys and r on, shows just the revoked band', async () => {
    const gone = { ...row('c-old@Box', 'journal'), revokedAt: '2026-11-01T10:00:00.000Z' };
    const app = start({ keys: async (_s, f) => (f === 'all' ? [gone] : []) });
    await open(app);
    app.stdin.write('r');
    await until(() => expect(app.frame()).toMatch(/── revoked ─+ 1/));
    expect(app.frame()).not.toMatch(/── Box/);
    expect(
      app
        .frame()
        .split('\n')
        .filter((l) => l.includes('──'))
    ).toHaveLength(1);
    app.unmount();
  });
});

describe('/keys layout in the frame', () => {
  it('the selection band stays on its row and bands are separated by a blank line', async () => {
    // ink-testing-library's stdout is 100 columns wide, so render at that width.
    const rows = [row('a@A', 'journal'), row('b@A', 'journal'), row('c@B', 'journal')];
    const app = start({ keys: async () => rows }, marathon, 100);
    await open(app);
    const lines = app.frame().split('\n');
    expect(Math.max(...lines.map((l) => l.length))).toBeLessThanOrEqual(100);
    const at = lines.findIndex((l) => l.includes('▶'));
    expect(lines[at]).toMatch(/a\s+journal/);
    expect(lines[at + 1]).toMatch(/b\s+journal/);
    const b = lines.findIndex((l) => l.includes('── B'));
    expect(lines[b - 1]?.trim()).toBe('');
    expect(lines[b - 2]).toMatch(/b\s+journal/);
    expect(lines[1]).toContain('── A');
    app.unmount();
  });

  it('the selected row reaches the panel content width, and no line exceeds it', async () => {
    // At 100 columns the panel draws 98 cells after its one-cell inset: a line ends by column 99.
    const long = `${'n'.repeat(60)}:read,${'m'.repeat(60)}:read`;
    const app = start({ keys: async () => [row('a@A', long), row('b@A', long)] }, marathon, 100);
    await open(app);
    const lines = app.frame().split('\n');
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(99);
    const at = lines.findIndex((l) => l.includes('▶'));
    expect(lines[at]).toHaveLength(99);
    expect(lines[at]?.endsWith('…')).toBe(true);
    expect(lines[at + 1]).toHaveLength(99);
    app.unmount();
  });
});

describe('compactGrant', () => {
  it('shortens read, mutate and admin, joining namespaces with commas', () => {
    expect(compactGrant('journal,recall', 'read,mutate')).toBe('journal:r+m,recall:r+m');
    expect(compactGrant('*', 'read,mutate,admin')).toBe('*:r+m+a');
  });
  it('orders capabilities canonically and spells out one with no short form', () => {
    expect(compactGrant('ops:mutate+drain+read', '')).toBe('ops:r+m+drain');
  });
  it('says so when the key is granted nothing', () => {
    expect(compactGrant('', '')).toBe('(none)');
  });
  it('an unparseable grant falls back to the full description', () => {
    expect(compactGrant('journal:', '')).toMatch(/^UNPARSEABLE/);
  });
});

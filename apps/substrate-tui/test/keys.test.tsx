import { type AdminKeyRow, AuthError, type SubstrateClient } from '@mnmal-ai/substrate/client';
import { createApp } from '@mnmal-ai/surface-core';
import { marathon } from '@mnmal-ai/surface-theme';
import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import { createAdminSession } from '../src/admin/session.js';
import type { TuiDeps } from '../src/deps.js';
import { compactGrant } from '../src/keys/grant.js';
import { keysModule } from '../src/keys/module.js';
import { noAdmin, noDash } from './_fakes.js';

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

function start(over: Partial<TuiDeps>) {
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
  const { App } = createApp({ theme: marathon, modules: [keysModule(deps)], band: true });
  const r = render(<App columns={120} rows={40} />);
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
    expect(app.frame()).toContain('a-agent@Box');
    expect(app.frame()).toMatch(/a-agent@Box\s+a-agent key\s+journal:r\+m,plane:r/);
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
    expect(app.frame()).toContain('a-agent@Box');
    expect(app.frame()).not.toContain('z-secret@Box');
    expect(app.frame()).toContain('keys · 2 active · agent');
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

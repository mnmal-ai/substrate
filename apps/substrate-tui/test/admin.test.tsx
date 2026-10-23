import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DiagnoseOpts, DiagnoseResult } from '@mnmal-ai/substrate/client';
import { createApp } from '@mnmal-ai/surface-core';
import { marathon } from '@mnmal-ai/surface-theme';
import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import { adminModule } from '../src/admin/module.js';
import { createAdminSession } from '../src/admin/session.js';
import type { TuiDeps } from '../src/deps.js';
import { noAdmin, noDash } from './_fakes.js';

const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));
const ENTER = '\r';

function keyDir(passphrase?: string) {
  const dir = mkdtempSync(join(tmpdir(), 'substrate-tui-admin-'));
  const { privateKey } = generateKeyPairSync('ed25519', {
    privateKeyEncoding:
      passphrase === undefined
        ? { type: 'pkcs8', format: 'pem' }
        : { type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase }
  });
  writeFileSync(join(dir, 'ops.key'), privateKey);
  writeFileSync(join(dir, 'ops.kid'), 'ops-admin@Box');
  return join(dir, 'ops.key');
}

const verdict = (adminOk: boolean, identity: string | null): DiagnoseResult => ({
  checks: [
    {
      name: 'admin-capability',
      status: adminOk ? 'ok' : 'no',
      detail: adminOk ? 'ok' : 'not admin',
      ...(adminOk ? {} : { fix: 'widen it' })
    }
  ],
  exitCode: adminOk ? 0 : 1,
  identity,
  facts: {}
});

function start(adminEnv: TuiDeps['adminEnv'], result: DiagnoseResult, gate?: Promise<void>) {
  const seen: DiagnoseOpts[] = [];
  const deps: TuiDeps = {
    endpoint: 'https://h',
    project: 'substrate',
    namespace: 'journal',
    nl: {} as TuiDeps['nl'],
    federatedSchema: async () => ({}),
    getJson: async () => ({}),
    ...noDash,
    ...noAdmin(),
    admin: createAdminSession({ endpoint: 'https://h', idleMs: 15 * 60_000 }),
    adminEnv
  };
  const mod = adminModule(deps, {
    diagnose: async (o) => {
      seen.push(o);
      if (gate !== undefined) await gate;
      return result;
    }
  });
  const { App } = createApp({ theme: marathon, modules: [mod], band: true });
  const r = render(<App columns={120} />);
  return { ...r, deps, seen, frame: () => r.lastFrame() ?? '' };
}

async function type(app: { stdin: { write(s: string): void } }, line: string) {
  app.stdin.write(line);
  await tick();
  app.stdin.write(ENTER);
  await tick();
}

describe('/admin', () => {
  it('1. unlock with a plain key verifies as admin, then shows the badge and unlocks the session', async () => {
    const app = start({ SUBSTRATE_ADMIN_KEY_PATH: keyDir() }, verdict(true, 'ops-admin@Box'));
    await type(app, '/admin unlock');
    await tick();
    expect(app.deps.admin.unlocked()).toBe(true);
    expect(app.frame()).toMatch(/admin ops-admin@Box · 15m/);
    expect(app.seen[0]?.expectAdmin).not.toBe(false);
    await type(app, '/admin lock');
    expect(app.deps.admin.unlocked()).toBe(false);
    expect(app.frame()).not.toMatch(/admin ops-admin@Box ·/);
    app.unmount();
  });

  it('2. a key that is not admin is refused and nothing is retained', async () => {
    const app = start({ SUBSTRATE_ADMIN_KEY_PATH: keyDir() }, verdict(false, 'ops-admin@Box'));
    await type(app, '/admin unlock');
    await tick();
    expect(app.deps.admin.unlocked()).toBe(false);
    expect(app.frame()).toContain('not admin');
    expect(app.frame()).toContain('widen it');
    app.unmount();
  });

  it('3. an encrypted key asks for the passphrase masked; a wrong one keeps the panel open', async () => {
    const app = start(
      { SUBSTRATE_ADMIN_KEY_PATH: keyDir('right') },
      verdict(true, 'ops-admin@Box')
    );
    await type(app, '/admin unlock');
    expect(app.frame()).toContain('passphrase');
    await type(app, 'wrong');
    expect(app.frame()).toContain('wrong passphrase, or the key is unreadable');
    expect(app.deps.admin.unlocked()).toBe(false);
    await type(app, 'right');
    await tick();
    expect(app.deps.admin.unlocked()).toBe(true);
    expect(app.frame()).not.toContain('right');
    app.unmount();
  });

  it('4. SUBSTRATE_ADMIN_TOKEN: the badge names the kid whoami resolved', async () => {
    const app = start({ SUBSTRATE_ADMIN_TOKEN: 'tok' }, verdict(true, 'genesis@Box'));
    await type(app, '/admin unlock');
    await tick();
    expect(app.frame()).toMatch(/admin genesis@Box · 15m/);
    expect(app.frame()).not.toContain('undefined');
    app.unmount();
  });

  it('5. nothing configured: unlock says what to set', async () => {
    const app = start({ HOME: mkdtempSync(join(tmpdir(), 'empty-home-')) }, verdict(true, 'x'));
    await type(app, '/admin unlock');
    expect(app.frame()).toMatch(/SUBSTRATE_ADMIN_TOKEN, or SUBSTRATE_ADMIN_KEY_ID/);
    expect(app.deps.admin.unlocked()).toBe(false);
    app.unmount();
  });

  it('6. a lock the operator did not ask for is printed', async () => {
    const app = start({ SUBSTRATE_ADMIN_TOKEN: 'tok' }, verdict(true, 'genesis@Box'));
    await type(app, '/admin unlock');
    await tick();
    app.deps.admin.lock('admin locked: 403 — the admin key was rejected');
    await tick();
    expect(app.frame()).toContain('admin locked: 403 — the admin key was rejected');
    app.unmount();
  });

  it('7. escape while checking drops the attempt: a late verification grants nothing', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const app = start(
      { SUBSTRATE_ADMIN_KEY_PATH: keyDir('right') },
      verdict(true, 'ops-admin@Box'),
      gate
    );
    await type(app, '/admin unlock');
    await type(app, 'right');
    app.stdin.write('\u001b');
    await tick();
    release();
    await tick();
    expect(app.deps.admin.unlocked()).toBe(false);
    app.unmount();
  });

  it('8. /admin lock while an unlock is verifying cancels it', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const app = start({ SUBSTRATE_ADMIN_TOKEN: 'tok' }, verdict(true, 'genesis@Box'), gate);
    await type(app, '/admin unlock');
    await type(app, '/admin lock');
    expect(app.frame()).toContain('admin unlock cancelled');
    release();
    await tick();
    expect(app.deps.admin.unlocked()).toBe(false);
    expect(app.frame()).not.toMatch(/admin genesis@Box ·/);
    app.unmount();
  });

  it('9. SUBSTRATE_ADMIN_CAPABILITY: unlock verifies that capability, as the CLI doctor does', async () => {
    const app = start(
      { SUBSTRATE_ADMIN_TOKEN: 'tok', SUBSTRATE_ADMIN_CAPABILITY: 'superuser' },
      verdict(true, 'genesis@Box')
    );
    await type(app, '/admin unlock');
    await tick();
    expect(app.seen[0]?.adminCapability).toBe('superuser');
    expect(app.deps.admin.unlocked()).toBe(true);
    app.unmount();
  });

  it('10. SUBSTRATE_ADMIN_CAPABILITY: a key-signed token CLAIMS that capability', async () => {
    const app = start(
      { SUBSTRATE_ADMIN_KEY_PATH: keyDir(), SUBSTRATE_ADMIN_CAPABILITY: 'superuser' },
      verdict(true, 'ops-admin@Box')
    );
    await type(app, '/admin unlock');
    await tick();
    const cred = app.seen[0]?.credential;
    const bearer = cred !== undefined && 'authorization' in cred ? cred.authorization() : '';
    const payload = bearer.replace(/^Bearer /, '').split('.')[1] ?? '';
    const claim = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')).capabilities;
    expect(claim).toEqual(['read', 'mutate', 'admin', 'superuser']);
    app.unmount();
  });
});

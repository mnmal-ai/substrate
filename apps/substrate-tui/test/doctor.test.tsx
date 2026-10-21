import type { DiagnoseOpts, DiagnoseResult, SubstrateClient } from '@mnmal-ai/substrate/client';
import { createApp } from '@mnmal-ai/surface-core';
import { marathon } from '@mnmal-ai/surface-theme';
import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import { createAdminSession } from '../src/admin/session.js';
import type { TuiDeps } from '../src/deps.js';
import { doctorModule } from '../src/doctor/module.js';
import { noAdmin, noDash } from './_fakes.js';

const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));
const ENTER = '\r';

function start(
  over: Partial<TuiDeps>,
  result: (o: DiagnoseOpts) => DiagnoseResult | Promise<DiagnoseResult>
) {
  const seen: DiagnoseOpts[] = [];
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
  const { App } = createApp({
    theme: marathon,
    modules: [
      doctorModule(deps, {
        diagnose: async (o) => {
          seen.push(o);
          return result(o);
        }
      })
    ],
    band: true
  });
  const r = render(<App columns={120} rows={40} />);
  return { ...r, seen, deps, frame: () => r.lastFrame() ?? '' };
}

describe('/doctor', () => {
  it('1. locked: diagnoses the agent identity, not expecting admin, and says so in the title', async () => {
    const app = start({ agentAuthorization: () => 'Bearer agent' }, () => ({
      checks: [
        { name: 'reachable', status: 'ok', detail: 'up' },
        {
          name: 'admin-capability',
          status: 'skip',
          detail: 'not asked — this identity was not expected to be an admin'
        }
      ],
      exitCode: 0,
      identity: 'substrate-claude@Box',
      facts: {}
    }));
    app.stdin.write('/doctor');
    await tick();
    app.stdin.write(ENTER);
    await tick(80);
    expect(app.seen[0]?.expectAdmin).toBe(false);
    expect(app.frame()).toContain('doctor · agent identity');
    // Plan marks now: done ✓, not asked ⊘ (blocked), and the verdict counts only what was asked.
    expect(app.frame()).toMatch(/✓ reachable/);
    expect(app.frame()).toMatch(/⊘ admin-capability/);
    expect(app.frame()).toContain('doctor ✓ 1/1 · r re-check');
    app.unmount();
  });

  it('2. no agent identity: the credential is a NO carrying the reason, nothing passes after it', async () => {
    const app = start({ agentAuthorization: null }, (o) => ({
      checks: [
        {
          name: 'credential',
          status: 'no',
          detail: 'error' in o.credential ? o.credential.error : '?',
          fix: 'set it'
        }
      ],
      exitCode: 1,
      identity: null,
      facts: {}
    }));
    app.stdin.write('/doctor');
    await tick();
    app.stdin.write(ENTER);
    await tick(80);
    expect(app.frame()).toMatch(/▶ credential\s+no agent identity configured \(anonymous\)/);
    app.unmount();
  });

  it('3. as admin, an identity check that is NO with httpStatus 401 locks the session, whatever its detail says', async () => {
    const admin = createAdminSession({
      endpoint: 'http://h',
      idleMs: 60_000,
      makeClient: () => ({ close: async () => {} }) as unknown as SubstrateClient
    });
    admin.unlock('ops-admin@Box', () => 'jwt');
    // The background run at start passes; the run /doctor requests is the one rejected.
    let n = 0;
    const app = start({ admin }, () =>
      ++n === 1
        ? ADMIN_OK
        : {
            checks: [
              {
                name: 'identity',
                status: 'no',
                detail: 'the server REJECTED the credential',
                fix: 'new key',
                httpStatus: 401
              }
            ],
            exitCode: 1,
            identity: null,
            facts: {}
          }
    );
    await tick(80);
    app.stdin.write('/doctor');
    await tick();
    app.stdin.write(ENTER);
    await tick(80);
    expect(app.frame()).toContain('doctor · admin identity');
    expect(app.deps.admin.unlocked()).toBe(false);
    // The doctor's own lock keeps the result that explains it on screen.
    expect(app.frame()).toMatch(/▶ identity\s+the server REJECTED/);
    expect(app.frame()).not.toContain('doctor closed — admin locked');
    app.unmount();
  });

  it('4. as admin, a failing check that is not a 401 leaves the session unlocked', async () => {
    const admin = createAdminSession({
      endpoint: 'http://h',
      idleMs: 60_000,
      makeClient: () => ({ close: async () => {} }) as unknown as SubstrateClient
    });
    admin.unlock('ops-admin@Box', () => 'jwt');
    const app = start({ admin }, () => ({
      checks: [{ name: 'identity', status: 'no', detail: 'unreachable', fix: 'start it' }],
      exitCode: 1,
      identity: null,
      facts: {}
    }));
    app.stdin.write('/doctor');
    await tick();
    app.stdin.write(ENTER);
    await tick(80);
    expect(app.deps.admin.unlocked()).toBe(true);
    app.unmount();
  });

  it('4b. "401" in the detail text without httpStatus 401 does not lock — the status decides, not the prose', async () => {
    const admin = createAdminSession({
      endpoint: 'http://h',
      idleMs: 60_000,
      makeClient: () => ({ close: async () => {} }) as unknown as SubstrateClient
    });
    admin.unlock('ops-admin@Box', () => 'jwt');
    const app = start({ admin }, () => ({
      checks: [
        {
          name: 'identity',
          status: 'no',
          detail: 'proxy said 401 somewhere upstream',
          fix: 'check the proxy',
          httpStatus: 200
        }
      ],
      exitCode: 1,
      identity: null,
      facts: {}
    }));
    app.stdin.write('/doctor');
    await tick();
    app.stdin.write(ENTER);
    await tick(80);
    expect(app.deps.admin.unlocked()).toBe(true);
    app.unmount();
  });

  it('5.an admin /doctor panel closes with a note when admin locks from elsewhere', async () => {
    const admin = unlockedAdmin();
    const app = start({ admin }, () => ADMIN_OK);
    await run(app);
    expect(app.frame()).toContain('doctor · admin identity');
    admin.lock('locked by /admin lock');
    await tick();
    expect(app.frame()).not.toContain('doctor · admin identity');
    expect(app.frame()).toContain('doctor closed — admin locked');
    app.unmount();
  });

  it('6. a lock landing mid-diagnose drops the late admin result', async () => {
    const admin = unlockedAdmin();
    let release = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const app = start({ admin }, async () => {
      await gate;
      return ADMIN_OK;
    });
    await run(app);
    expect(app.frame()).toContain('checking…');
    admin.lock('locked by /admin lock');
    await tick();
    release();
    await tick(80);
    expect(app.frame()).not.toContain('admin floor holds');
    expect(app.frame()).not.toContain('doctor · admin identity');
    app.unmount();
  });

  it('6b. a result from before a lock cannot land in the panel of a later unlock', async () => {
    const admin = unlockedAdmin();
    let release = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let calls = 0;
    const app = start({ admin }, async () => {
      calls += 1;
      if (calls === 1) {
        await gate;
        return {
          checks: [{ name: 'admin-floor', status: 'ok', detail: 'FROM THE OLD UNLOCK' }],
          exitCode: 0,
          identity: 'ops-admin@Box',
          facts: {}
        };
      }
      return ADMIN_OK;
    });
    await run(app);
    admin.lock('locked by /admin lock');
    await tick();
    admin.unlock('ops-admin@Box', () => 'jwt2');
    await run(app);
    // Runs are single-flight: the new unlock's run waits for the gated one, which is
    // then discarded as stale. What must hold is that the old result never lands.
    expect(app.frame()).not.toContain('FROM THE OLD UNLOCK');
    release();
    await tick(80);
    expect(app.frame()).toContain('admin floor holds');
    expect(app.frame()).not.toContain('FROM THE OLD UNLOCK');
    app.unmount();
  });

  it('7. locked with no agent identity: the fix names the agent identity, not the admin env', async () => {
    const app = start({ agentAuthorization: null }, (o) => ({
      checks: [
        {
          name: 'credential',
          status: 'no',
          detail: 'error' in o.credential ? o.credential.error : '?',
          fix: ('error' in o.credential ? o.credential.fix : undefined) ?? 'admin fix'
        }
      ],
      exitCode: 1,
      identity: null,
      facts: {}
    }));
    await run(app);
    expect(app.seen[0] !== undefined && 'error' in app.seen[0].credential).toBe(true);
    expect(app.frame()).toContain('fix: Set SUBSTRATE_AGENT_KEY_ID and SUBSTRATE_AGENT_KEY_PATH');
    expect(app.frame()).not.toContain('admin fix');
    app.unmount();
  });

  it('8. as admin, SUBSTRATE_ADMIN_CAPABILITY is the capability diagnose checks', async () => {
    const admin = unlockedAdmin();
    const app = start(
      { admin, adminEnv: { SUBSTRATE_ADMIN_CAPABILITY: 'superuser' } },
      () => ADMIN_OK
    );
    await run(app);
    expect(app.seen[0]?.adminCapability).toBe('superuser');
    app.unmount();
  });
});

describe('/doctor live panel', () => {
  const GREEN: DiagnoseResult = {
    checks: [
      { name: 'reachable', status: 'ok', detail: 'up, version 7.13.1' },
      { name: 'auth-enabled', status: 'ok', detail: 'verifies' },
      { name: 'credential', status: 'ok', detail: 'minted' },
      { name: 'identity', status: 'ok', detail: 'resolved' },
      { name: 'namespaces', status: 'ok', detail: 'hosted: journal' }
    ],
    exitCode: 0,
    identity: 'substrate-claude@Box',
    facts: {}
  };

  it('opened before the first result shows checking…, never an empty list', async () => {
    let release: (r: DiagnoseResult) => void = () => {};
    const gate = new Promise<DiagnoseResult>((r) => {
      release = r;
    });
    const app = start({}, () => gate);
    app.stdin.write('/doctor');
    await tick();
    app.stdin.write(ENTER);
    await tick(80);
    // Both the header's run state and the body's placeholder, and no step line at all.
    expect(app.frame()).toMatch(/identity · checking…/);
    expect(app.frame().match(/checking…/g)).toHaveLength(2);
    expect(app.frame()).not.toMatch(/[✓·⊘↷▶] (reachable|auth-enabled|credential)/);
    release(GREEN);
    await tick(80);
    expect(app.frame()).toMatch(/✓ reachable/);
    app.unmount();
  });

  it('renders the plan with marks, the check time, the next time and the verdict', async () => {
    const app = start({}, () => GREEN);
    await tick(80); // the background run lands first
    app.stdin.write('/doctor');
    await tick();
    app.stdin.write(ENTER);
    await tick(80);
    const f = app.frame();
    expect(f).toContain('doctor · agent identity · checked ');
    expect(f).toMatch(/next \d\d:\d\d:\d\d/);
    expect(f).toMatch(/✓ reachable\s+up, version 7\.13\.1/);
    expect(f).toContain('⊘ admin-floor');
    expect(f).toContain('doctor ✓ 5/5 · r re-check · esc close');
    app.unmount();
  });

  it('a todo step shows its fix, and the current step is marked ▶', async () => {
    const app = start({}, () => ({
      ...GREEN,
      checks: GREEN.checks.map((c) =>
        c.name === 'auth-enabled'
          ? { ...c, status: 'no' as const, detail: 'DISABLED', fix: 'set SUBSTRATE_AUTH_MODE' }
          : c
      )
    }));
    await tick(80);
    app.stdin.write('/doctor');
    await tick();
    app.stdin.write(ENTER);
    await tick(80);
    expect(app.frame()).toMatch(/▶ auth-enabled\s+DISABLED/);
    expect(app.frame()).toContain('fix: set SUBSTRATE_AUTH_MODE');
    app.unmount();
  });

  it('a multi-line detail or fix stays on its own line in the panel', async () => {
    const app = start({}, () => ({
      ...GREEN,
      checks: GREEN.checks.map((c) =>
        c.name === 'auth-enabled'
          ? {
              ...c,
              status: 'no' as const,
              detail: 'auth is\nDISABLED',
              fix: 'set\nSUBSTRATE_AUTH_MODE'
            }
          : c
      )
    }));
    await tick(80);
    app.stdin.write('/doctor');
    await tick();
    app.stdin.write(ENTER);
    await tick(80);
    expect(app.frame()).toMatch(/▶ auth-enabled\s+auth is DISABLED/);
    expect(app.frame()).toContain('fix: set SUBSTRATE_AUTH_MODE');
    app.unmount();
  });

  it('opening requests one fresh run; r requests another', async () => {
    const app = start({}, () => GREEN);
    await tick(80);
    expect(app.seen).toHaveLength(1); // the background run
    app.stdin.write('/doctor');
    await tick();
    app.stdin.write(ENTER);
    await tick(80);
    expect(app.seen).toHaveLength(2);
    app.stdin.write('r');
    await tick(80);
    expect(app.seen).toHaveLength(3);
    app.unmount();
  });
});

const ADMIN_OK: DiagnoseResult = {
  checks: [{ name: 'admin-floor', status: 'ok', detail: 'admin floor holds' }],
  exitCode: 0,
  identity: 'ops-admin@Box',
  facts: {}
};

function unlockedAdmin() {
  const admin = createAdminSession({
    endpoint: 'http://h',
    idleMs: 60_000,
    makeClient: () => ({ close: async () => {} }) as unknown as SubstrateClient
  });
  admin.unlock('ops-admin@Box', () => 'jwt');
  return admin;
}

async function run(app: { stdin: { write(s: string): void } }) {
  app.stdin.write('/doctor');
  await tick();
  app.stdin.write(ENTER);
  await tick(80);
}

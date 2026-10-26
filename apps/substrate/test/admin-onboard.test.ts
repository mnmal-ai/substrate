/**
 * `substrate-admin onboard`. The loop is driven through injected IO, diagnose and
 * action runners, so every branch is exercised without a server or a TTY.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DiagnoseResult, DoctorCheck } from '@mnmal-ai/substrate-client';
import { describe, expect, it } from 'vitest';
import { seedCapabilities } from '../src/admin/commands/bootstrap.js';
import {
  formatChecklist,
  type OnboardActions,
  type RunOnboardOpts,
  realOnboardActions,
  redactStore,
  runOnboard
} from '../src/admin/commands/onboard.js';
import { bootstrapBlockers, writeKeypair } from '../src/admin/commands/onboard-keys.js';
import { AdminCliError } from '../src/admin/errors.js';
import { main, onboardCommand } from '../src/admin/index.js';

describe('writeKeypair', () => {
  const dir = () => mkdtempSync(join(tmpdir(), 'onboard-keys-'));

  it('writes a 0600 private key and a .pub beside it', () => {
    const d = dir();
    const r = writeKeypair({}, join(d, 'second.key'));
    expect(r.publicKeyPath).toBe(join(d, 'second.key.pub'));
    expect(readFileSync(r.publicKeyPath, 'utf8')).toContain('BEGIN PUBLIC KEY');
    expect(statSync(r.privateKeyPath).mode & 0o777).toBe(0o600);
  });

  it('refuses to overwrite an existing private key or .pub', () => {
    const d = dir();
    writeFileSync(join(d, 'taken.key'), 'x');
    expect(() => writeKeypair({}, join(d, 'taken.key'))).toThrow(/already exists/);
    writeFileSync(join(d, 'pub.key.pub'), 'x');
    expect(() => writeKeypair({}, join(d, 'pub.key'))).toThrow(/already exists/);
  });
});

const CHECK_NAMES = [
  'reachable',
  'auth-enabled',
  'credential',
  'identity',
  'admin-capability',
  'admin-floor',
  'namespaces',
  'key-directory'
];
const okc = (name: string): DoctorCheck => ({ name, status: 'ok', detail: `${name} fine` });
const noc = (name: string): DoctorCheck => ({
  name,
  status: 'no',
  detail: `${name} broken`,
  fix: `fix ${name}`
});
const healthyFacts = {
  adminKids: ['a1', 'a2'],
  liveKeyCount: 3,
  retiredWithLiveKey: [],
  liveKeyWithoutRow: [],
  agentKids: ['agent']
};
const R = (
  over: Partial<Record<string, DoctorCheck>> = {},
  facts: DiagnoseResult['facts'] = healthyFacts
): DiagnoseResult => {
  const checks = CHECK_NAMES.map((n) => over[n] ?? okc(n));
  return {
    checks,
    exitCode: checks.some((c) => c.status === 'no') ? 1 : 0,
    identity: 'a1',
    facts
  };
};
const GREEN = R();
const NO_CRED = R({ credential: noc('credential') }, {});
const ONE_ADMIN = R({}, { ...healthyFacts, adminKids: ['a1'] });

function harness(
  results: DiagnoseResult[],
  answers: Array<string | null>,
  actions: Partial<OnboardActions> = {}
) {
  const out: string[] = [];
  const calls: string[] = [];
  let i = 0;
  const queue = [...answers];
  const fail = (what: string) => async () => {
    throw new Error(`unexpected ${what}`);
  };
  return {
    out,
    calls,
    run: (interactive = true, canBootstrap = true) =>
      runOnboard({
        diagnose: async () => results[Math.min(i++, results.length - 1)] as DiagnoseResult,
        canBootstrap,
        interactive,
        io: {
          out: (s) => out.push(s),
          ask: async (p) => {
            out.push(p);
            return queue.length > 0 ? (queue.shift() as string | null) : null;
          }
        },
        actions: {
          bootstrap: fail('bootstrap'),
          registerAdmin: fail('registerAdmin'),
          registerAgent: fail('registerAgent'),
          revoke: fail('revoke'),
          generateKeypair: () => {
            throw new Error('unexpected generateKeypair');
          },
          ...actions
        }
      }),
    diagnoseCalls: () => i
  };
}

describe('runOnboard', () => {
  it('a green deployment finishes at once with exit 0', async () => {
    const h = harness([GREEN], []);
    expect(await h.run()).toBe(0);
    expect(h.out.join('')).toContain('onboarding complete');
  });

  it('--check (non-interactive) never prompts; exit 1 while a required step is todo', async () => {
    const h = harness([ONE_ADMIN], []);
    expect(await h.run(false)).toBe(1);
    expect(h.out.join('')).not.toMatch(/\[y\/N\]/);
    expect(h.out.join('')).toContain('second-admin');
  });

  it('--check exits 0 when only the optional first-agent is outstanding', async () => {
    const h = harness([R({}, { ...healthyFacts, agentKids: [] })], []);
    expect(await h.run(false)).toBe(0);
  });

  it('confirming bootstrap runs it, re-diagnoses, and advances once the credential is green', async () => {
    const h = harness([NO_CRED, GREEN], ['y'], {
      bootstrap: async () => {
        h.calls.push('bootstrap');
        return 'bootstrapped kid k1';
      }
    });
    expect(await h.run()).toBe(0);
    expect(h.calls).toEqual(['bootstrap']);
    expect(h.diagnoseCalls()).toBe(2);
    expect(h.out.join('')).toContain('bootstrapped kid k1');
  });

  it('the bootstrap offer names the database it writes to, since --url cannot vouch for it', async () => {
    const out: string[] = [];
    const answers = ['n', 'q'];
    await runOnboard({
      diagnose: async () => NO_CRED,
      canBootstrap: true,
      bootstrapStore: 'postgres://substrate:***@127.0.0.1:5433/substrate_prod',
      interactive: true,
      io: { out: (s) => out.push(s), ask: async () => answers.shift() ?? null },
      actions: {} as OnboardActions
    });
    const text = out.join('');
    expect(text).toContain(
      'SUBSTRATE_DATABASE_URL=postgres://substrate:***@127.0.0.1:5433/substrate_prod'
    );
    expect(text).toMatch(/same database/);
  });

  it('declining the action falls back to the fix and waits; q quits with exit 1', async () => {
    const h = harness([NO_CRED], ['n', 'q']);
    expect(await h.run()).toBe(1);
    expect(h.out.join('')).toContain('fix credential');
  });

  it('end of input (stdin closed) quits with the summary instead of looping', async () => {
    const h = harness([NO_CRED], [null]);
    expect(await h.run()).toBe(1);
    expect(h.diagnoseCalls()).toBe(1);
    expect(h.out.join('')).toMatch(/stopped/);
  });

  it('a failed action prints its error and stays on the step', async () => {
    const h = harness([NO_CRED, NO_CRED], ['y', 'q'], {
      bootstrap: async () => {
        throw new AdminCliError('SUBSTRATE_DATABASE_URL is required', 1);
      }
    });
    expect(await h.run()).toBe(1);
    expect(h.out.join('')).toContain('SUBSTRATE_DATABASE_URL is required');
  });

  it('s skips second-admin; the summary names it as skipped', async () => {
    const h = harness([ONE_ADMIN, ONE_ADMIN], ['n', 's']);
    expect(await h.run()).toBe(0);
    expect(h.out.join('')).toMatch(/skipped: second-admin/);
  });

  it('s on a required, non-skippable step is refused', async () => {
    const h = harness([NO_CRED, NO_CRED], ['n', 's', 'q']);
    expect(await h.run(true, false)).toBe(1);
    expect(h.out.join('')).toContain('cannot be skipped');
  });

  it('register-admin with an existing public key passes kid and path through', async () => {
    const h = harness([ONE_ADMIN, GREEN], ['y', 'admin-2@Box', '/keys/second.pub'], {
      registerAdmin: async (kid, pub) => {
        h.calls.push(`${kid} ${pub}`);
        return 'registered';
      }
    });
    expect(await h.run()).toBe(0);
    expect(h.calls).toEqual(['admin-2@Box /keys/second.pub']);
  });

  it('register-admin with no public key offers generation, then registers the generated .pub', async () => {
    const h = harness([ONE_ADMIN, GREEN], ['y', 'admin-2@Box', '', '/keys/second.key'], {
      generateKeypair: (p) => ({ privateKeyPath: p, publicKeyPath: `${p}.pub` }),
      registerAdmin: async (kid, pub) => {
        h.calls.push(`${kid} ${pub}`);
        return 'registered';
      }
    });
    expect(await h.run()).toBe(0);
    expect(h.calls).toEqual(['admin-2@Box /keys/second.key.pub']);
    expect(h.out.join('')).toMatch(/private key must live with whoever will use it/);
  });

  it('a bad public key path: the register error is shown and the step stays', async () => {
    const h = harness([ONE_ADMIN, ONE_ADMIN], ['y', 'k', '/nope.pub', 'q'], {
      registerAdmin: async () => {
        throw new AdminCliError("could not read public key '/nope.pub'", 1);
      }
    });
    expect(await h.run()).toBe(1);
    expect(h.out.join('')).toContain("could not read public key '/nope.pub'");
  });

  it('register-agent grants the namespaces typed', async () => {
    const h = harness(
      [R({}, { ...healthyFacts, agentKids: [] }), GREEN],
      ['y', 'first@Box', '/k.pub', 'notes,recall'],
      {
        registerAgent: async (kid, pub, ns) => {
          h.calls.push(`${kid} ${pub} ${ns.join(',')}`);
          return 'registered';
        }
      }
    );
    expect(await h.run()).toBe(0);
    expect(h.calls).toEqual(['first@Box /k.pub notes,recall']);
  });

  it('register-agent has no default grant', async () => {
    const h = harness(
      [R({}, { ...healthyFacts, agentKids: [] })],
      ['y', 'first@Box', '/k.pub', ''],
      {
        registerAgent: async (kid) => {
          h.calls.push(kid);
          return 'registered';
        }
      }
    );
    await h.run();
    expect(h.calls).toEqual([]);
  });

  it('revoke runs only when the kid is typed back exactly', async () => {
    const retired = R(
      { 'key-directory': noc('key-directory') },
      { ...healthyFacts, retiredWithLiveKey: ['old@Box'] }
    );
    const h = harness([retired, retired, GREEN], ['y', 'old@box', 'y', 'old@Box'], {
      revoke: async (kid) => {
        h.calls.push(kid);
        return 'revoked';
      }
    });
    expect(await h.run()).toBe(0);
    expect(h.calls).toEqual(['old@Box']);
    expect(h.out.join('')).toContain('did not match');
  });

  it('diagnose throwing exits 2', async () => {
    const out: string[] = [];
    const code = await runOnboard({
      diagnose: async () => {
        throw new Error('boom');
      },
      canBootstrap: false,
      interactive: true,
      io: { out: (s) => out.push(s), ask: async () => null },
      actions: {} as OnboardActions
    });
    expect(code).toBe(2);
    expect(out.join('')).toContain('boom');
  });
});

describe('formatChecklist', () => {
  it('marks the current step and renders skipped and blocked distinctly', () => {
    const text = formatChecklist([
      { name: 'reachable', status: 'done', detail: 'up', optional: false, skippable: false },
      { name: 'credential', status: 'todo', detail: 'none', optional: false, skippable: false },
      {
        name: 'second-admin',
        status: 'skipped',
        detail: 'one key',
        optional: false,
        skippable: true
      },
      {
        name: 'first-agent',
        status: 'blocked',
        detail: 'not measured',
        optional: true,
        skippable: true
      }
    ]);
    expect(text).toMatch(/✓ reachable/);
    expect(text).toMatch(/▶ credential/);
    expect(text).toMatch(/↷ second-admin/);
    expect(text).toMatch(/⊘ first-agent/);
    expect(text).toContain('(optional)');
  });
});

describe('onboard command', () => {
  const io = (outs: string[]) => ({
    out: (s: string) => {
      outs.push(s);
    },
    ask: async () => null
  });

  it('refuses a postgres (non-route) target the same way doctor does', async () => {
    const outs: string[] = [];
    const code = await onboardCommand(['--direct'], {}, io(outs), false);
    expect(code).toBe(1);
    expect(outs.join('')).toContain('bypassing the running server');
  });

  it('--check against an unreachable server exits 1 with reachable as the current step', async () => {
    const outs: string[] = [];
    const down = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    const code = await onboardCommand(
      ['--check', '--url', 'https://h.test'],
      {},
      io(outs),
      true,
      down
    );
    expect(code).toBe(1);
    expect(outs.join('')).toMatch(/▶ reachable/);
  });

  it('main lists onboard in usage and refuses an unknown flag', async () => {
    const out: string[] = [];
    const err: string[] = [];
    expect(
      await main(
        ['help'],
        {},
        (s) => out.push(s),
        (s) => err.push(s)
      )
    ).toBe(0);
    expect(out.join('')).toContain('onboard');
    expect(
      await main(
        ['onboard', '--nope'],
        {},
        (s) => out.push(s),
        (s) => err.push(s)
      )
    ).toBe(1);
  });
});

describe('redactStore', () => {
  it('hides the password and keeps host, port and database', () => {
    expect(redactStore('postgres://substrate:s3cret@127.0.0.1:5433/substrate_prod')).toBe(
      'postgres://substrate:***@127.0.0.1:5433/substrate_prod'
    );
    expect(redactStore('postgresql://h/db')).toBe('postgresql://h/db');
  });

  it('an unparseable URL is not echoed back', () => {
    expect(redactStore('postgres://u:p@[bad')).not.toContain(':p@');
  });
});

describe('review follow-ups', () => {
  const NO_AGENT = R({}, { ...healthyFacts, agentKids: [] });
  function drive(
    results: DiagnoseResult[],
    answers: Array<string | null>,
    actions: Partial<OnboardActions> = {},
    extra: Partial<RunOnboardOpts> = {}
  ) {
    const out: string[] = [];
    const queue = [...answers];
    let i = 0;
    const fail = (what: string) => async () => {
      throw new Error(`unexpected ${what}`);
    };
    const run = runOnboard({
      diagnose: async () => results[Math.min(i++, results.length - 1)] as DiagnoseResult,
      canBootstrap: true,
      interactive: true,
      io: {
        out: (s) => out.push(s),
        ask: async (p) => {
          out.push(p);
          return queue.length > 0 ? (queue.shift() as string | null) : null;
        }
      },
      actions: {
        bootstrap: fail('bootstrap'),
        registerAdmin: fail('registerAdmin'),
        registerAgent: fail('registerAgent'),
        revoke: fail('revoke'),
        generateKeypair: () => {
          throw new Error('unexpected generateKeypair');
        },
        ...actions
      },
      ...extra
    });
    return { run, out: () => out.join('') };
  }
  const count = (text: string, needle: string) => text.split(needle).length - 1;

  it('quitting with only an optional step left exits 0 (spec §5)', async () => {
    expect(await drive([NO_AGENT], ['n', 'q']).run).toBe(0);
    expect(await drive([NO_AGENT], [null]).run).toBe(0);
  });

  it('a declined action is not re-offered on re-check; r offers it again', async () => {
    const d = drive([NO_CRED], ['n', '', 'q']);
    expect(await d.run).toBe(1);
    expect(count(d.out(), 'Run it? [y/N]')).toBe(1);
    let ran = 0;
    const r = drive([NO_CRED, NO_CRED, GREEN], ['n', 'r', 'y'], {
      bootstrap: async () => {
        ran += 1;
        return 'ok';
      }
    });
    expect(await r.run).toBe(0);
    expect(ran).toBe(1);
    expect(count(r.out(), 'Run it? [y/N]')).toBe(2);
  });

  it('the second-admin offer mirrors the bootstrap grant and names the configured capability', async () => {
    const d = drive([ONE_ADMIN], ['n', 'q'], {}, { adminCapability: 'superuser' });
    await d.run;
    expect(d.out()).toContain("--ns '*' --caps read,mutate,superuser --allow-admin");
  });

  it('a malformed agent grant is refused before any request', async () => {
    let called = false;
    const d = drive([NO_AGENT], ['y', 'k@h', '/k.pub', 'cortext:', 'q'], {
      registerAgent: async () => {
        called = true;
        return 'x';
      }
    });
    await d.run;
    expect(called).toBe(false);
    expect(d.out()).toContain("grant 'cortext:' refused");
  });

  it('a trailing comma in the agent grant is dropped, not sent as an empty namespace', async () => {
    let got: readonly string[] = [];
    const d = drive([NO_AGENT, GREEN], ['y', 'k@h', '/k.pub', 'cortext, '], {
      registerAgent: async (_k, _p, ns) => {
        got = ns;
        return 'x';
      }
    });
    await d.run;
    expect(got).toEqual(['cortext']);
  });

  it('revoking several kids reports each one, even when a later one fails', async () => {
    const two = R(
      { 'key-directory': noc('key-directory') },
      { ...healthyFacts, retiredWithLiveKey: ['a@B', 'b@B'] }
    );
    const d = drive([two, two], ['y', 'a@B', 'b@B', 'q'], {
      revoke: async (kid) => {
        if (kid === 'b@B') throw new AdminCliError('route said no', 1);
        return `revoked ${kid}`;
      }
    });
    await d.run;
    expect(d.out()).toContain('revoked a@B');
    expect(d.out()).toMatch(/b@B.*route said no/);
  });

  it('the summary lists steps that were never checked, so "complete" cannot read as all green', async () => {
    const blocked = R(
      { 'key-directory': { name: 'key-directory', status: 'skip', detail: 'not asked' } },
      { adminKids: ['a1', 'a2'], liveKeyCount: 2 }
    );
    const d = drive([blocked], []);
    expect(await d.run).toBe(0);
    expect(d.out()).toContain('not checked: key-directory, first-agent');
  });

  describe('realOnboardActions', () => {
    const pub = () => {
      const d = mkdtempSync(join(tmpdir(), 'onboard-real-'));
      return writeKeypair({}, join(d, 'second.key')).publicKeyPath;
    };
    function capture() {
      const bodies: Record<string, unknown>[] = [];
      const f = (async (_u: string, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return {
          ok: true,
          status: 201,
          text: async () =>
            JSON.stringify({ directory: { created: false, reason: 'not_requested' } })
        } as unknown as Response;
      }) as unknown as typeof fetch;
      return { bodies, f };
    }
    const ENV = { SUBSTRATE_ADMIN_TOKEN: 'Bearer t' };

    it('registerAdmin grants what bootstrap seeds: every namespace, with admin', async () => {
      const { bodies, f } = capture();
      await realOnboardActions(ENV, 'https://h.test', f).registerAdmin('admin-2@Box', pub());
      expect(bodies[0]).toMatchObject({
        namespaces: ['*'],
        capabilities: seedCapabilities('admin'),
        allowAdmin: true,
        directory: { create: false }
      });
    });

    it('registerAdmin output does not warn about the directory row admins are exempt from', async () => {
      const { f } = capture();
      const text = await realOnboardActions(ENV, 'https://h.test', f).registerAdmin('a2@B', pub());
      expect(text).not.toContain('WARNING');
      expect(text).toMatch(/exempt/);
    });
  });
});

describe('writeKeypair follow-ups', () => {
  const home = () => mkdtempSync(join(tmpdir(), 'onboard-home-'));

  it('expands ~ against HOME and creates missing parent directories 0700', () => {
    const h = home();
    const r = writeKeypair({ HOME: h }, '~/keys/new/second.key');
    expect(r.privateKeyPath).toBe(join(h, 'keys/new/second.key'));
    expect(existsSync(r.privateKeyPath)).toBe(true);
    expect(statSync(join(h, 'keys/new')).mode & 0o777).toBe(0o700);
  });

  it('writes the kid beside the key, where the credential resolver looks for it', () => {
    const h = home();
    const r = writeKeypair({}, join(h, 'second.key'), 'admin-2@Box');
    expect(r.kidPath).toBe(join(h, 'second.kid'));
    expect(readFileSync(join(h, 'second.kid'), 'utf8')).toBe('admin-2@Box\n');
  });

  it('refuses when the kid file already exists', () => {
    const h = home();
    writeFileSync(join(h, 'taken.kid'), 'x');
    expect(() => writeKeypair({}, join(h, 'taken.key'), 'k')).toThrow(/already exists/);
    expect(existsSync(join(h, 'taken.key'))).toBe(false);
  });

  it('a failed .pub write leaves no orphaned private key behind', () => {
    const h = home();
    // A dangling symlink passes existsSync but makes the exclusive write fail.
    symlinkSync(join(h, 'nowhere'), join(h, 'x.key.pub'));
    expect(() => writeKeypair({}, join(h, 'x.key'))).toThrow();
    expect(existsSync(join(h, 'x.key'))).toBe(false);
  });
});

describe('bootstrapBlockers', () => {
  const home = () => mkdtempSync(join(tmpdir(), 'onboard-bb-'));

  it('a clean home has none, so bootstrap can be offered', () => {
    expect(bootstrapBlockers({ HOME: home() })).toEqual([]);
  });

  it('an existing default admin key blocks it, as bootstrap itself would refuse', () => {
    const h = home();
    mkdirSync(join(h, '.config/substrate'), { recursive: true });
    writeFileSync(join(h, '.config/substrate/admin.key'), 'x');
    expect(bootstrapBlockers({ HOME: h })).toEqual([join(h, '.config/substrate/admin.key')]);
  });

  it('with SUBSTRATE_ADMIN_KEY_PATH, the kid beside that key blocks it', () => {
    const h = home();
    writeFileSync(join(h, 'mine.kid'), 'x');
    expect(bootstrapBlockers({ HOME: h, SUBSTRATE_ADMIN_KEY_PATH: join(h, 'mine.key') })).toEqual([
      join(h, 'mine.kid')
    ]);
  });
});

describe('keypair and bootstrap wiring', () => {
  it('a generated keypair carries the kid, and the output says where it went', async () => {
    const out: string[] = [];
    const answers = ['y', 'admin-2@Box', '', '/keys/second.key'];
    const seen: Array<string | undefined> = [];
    await runOnboard({
      diagnose: (() => {
        let n = 0;
        return async () => (n++ === 0 ? ONE_ADMIN : GREEN);
      })(),
      canBootstrap: false,
      interactive: true,
      io: { out: (s) => out.push(s), ask: async () => answers.shift() ?? null },
      actions: {
        generateKeypair: (p: string, kid: string) => {
          seen.push(kid);
          return { privateKeyPath: p, publicKeyPath: `${p}.pub`, kidPath: '/keys/second.kid' };
        },
        registerAdmin: async () => 'registered'
      } as unknown as OnboardActions
    });
    expect(seen).toEqual(['admin-2@Box']);
    expect(out.join('')).toContain('/keys/second.kid');
  });

  it('onboardCommand withholds bootstrap when an admin key already exists on this box', async () => {
    const h = mkdtempSync(join(tmpdir(), 'onboard-cmd-'));
    mkdirSync(join(h, '.config/substrate'), { recursive: true });
    writeFileSync(join(h, '.config/substrate/admin.key'), 'not a key');
    const outs: string[] = [];
    const json = (status: number, body: unknown) =>
      ({ status, ok: status < 300, json: async () => body }) as unknown as Response;
    const f = (async (u: string) =>
      String(u).endsWith('/health')
        ? json(200, { version: '7.13.1' })
        : json(200, { authEnabled: true, identity: null })) as unknown as typeof fetch;
    // Interactive, so an offered action would print its 'would run' line before the prompt.
    await onboardCommand(
      ['--url', 'https://h.test'],
      { HOME: h, SUBSTRATE_DATABASE_URL: 'postgres://u:p@h/db' },
      { out: (s) => outs.push(s), ask: async () => 'q' },
      true,
      f
    );
    expect(outs.join('')).toMatch(/▶ credential/);
    expect(outs.join('')).not.toContain('would run: substrate-admin bootstrap');
  });
});

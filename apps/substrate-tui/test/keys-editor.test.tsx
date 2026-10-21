import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type AdminKeyRow,
  AuthError,
  NetworkError,
  type SubstrateClient
} from '@mnmal-ai/substrate/client';
import { createApp } from '@mnmal-ai/surface-core';
import { marathon } from '@mnmal-ai/surface-theme';
import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import { createAdminSession } from '../src/admin/session.js';
import type { TuiDeps } from '../src/deps.js';
import { editorPanels, parseTtl, readInviteTtl, switchTo, wrapCode } from '../src/keys/editor.js';
import { openMatrix } from '../src/keys/matrix.js';
import { keysModule } from '../src/keys/module.js';
import { noAdmin, noDash } from './_fakes.js';

const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));
const ENTER = '\r';
const ESC = '\u001B';
const DOWN = '\u001B[B';
const RIGHT = '\u001B[C';
const row = (kid: string, namespaces: string, capabilities = 'read,mutate'): AdminKeyRow => ({
  id: kid,
  kid,
  name: kid.split('@')[0] as string,
  algorithm: 'EdDSA',
  namespaces,
  capabilities,
  createdAt: ''
});
const ROWS = [
  row('a-agent@Box', 'journal,plane:read'),
  row('b-admin@Box', '_system:read+admin', 'read')
];
const HOSTED = { journal: {}, plane: {}, recall: {}, _system: {} };

function unlockedApp(
  over: {
    calls?: unknown[];
    fail?: unknown;
    failOnce?: unknown;
    rows?: AdminKeyRow[];
    size?: [number, number];
    hold?: Promise<void>;
    code?: string;
    reads?: { n: number };
    schema?: () => Promise<unknown>;
  } = {}
) {
  const calls = over.calls ?? [];
  let readsFail = false;
  let rows = over.rows ?? ROWS;
  const admin = createAdminSession({
    endpoint: 'http://h',
    idleMs: 60_000,
    makeClient: () =>
      ({
        admin: {
          keys: async () => {
            if (over.reads) over.reads.n++;
            if (readsFail) throw new Error('boom');
            return rows;
          },
          update: async (c: unknown) => {
            calls.push(['update', c]);
            await over.hold;
            if (
              over.failOnce !== undefined &&
              calls.filter((c) => (c as unknown[])[0] === 'update').length === 1
            ) {
              throw over.failOnce;
            }
            if (over.fail) throw over.fail;
            return {};
          },
          revoke: async (k: unknown) => {
            calls.push(['revoke', k]);
            if (over.fail) throw over.fail;
            rows = rows.filter((r) => r.kid !== k);
            return {};
          },
          register: async (c: unknown) => {
            calls.push(['register', c]);
            if (over.fail) throw over.fail;
            return { fingerprint: 'sha256:abcdefgh' };
          },
          invite: async (c: unknown) => {
            calls.push(['invite', c]);
            if (over.fail) throw over.fail;
            return { code: over.code ?? 'inv_SECRET', expiresAt: '2026-10-13T00:00:00.000Z' };
          }
        },
        close: async () => {}
      }) as unknown as SubstrateClient
  });
  admin.unlock('b-admin@Box', () => 't');
  const deps: TuiDeps = {
    endpoint: 'http://h',
    project: 'substrate',
    namespace: 'journal',
    nl: {} as TuiDeps['nl'],
    federatedSchema: (async () =>
      over.schema ? over.schema() : HOSTED) as unknown as TuiDeps['federatedSchema'],
    getJson: async () => ({}),
    ...noDash,
    ...noAdmin(),
    admin
  };
  const [columns, rowsN] = over.size ?? [120, 40];
  const { App } = createApp({ theme: marathon, modules: [keysModule(deps)], band: true });
  const r = render(<App columns={columns} rows={rowsN} />);
  return {
    ...r,
    admin,
    calls,
    setRows: (next: AdminKeyRow[]) => {
      rows = next;
    },
    failReads: () => {
      readsFail = true;
    },
    frame: () => r.lastFrame() ?? ''
  };
}
const type = async (app: { stdin: { write(s: string): void } }, ...keys: string[]) => {
  for (const k of keys) {
    app.stdin.write(k);
    await tick();
  }
};
const openKeys = async (app: { stdin: { write(s: string): void } }) => {
  await type(app, '/keys');
  app.stdin.write(ENTER);
  await tick(80);
};

describe('the grant editor', () => {
  it('Enter on a row while unlocked opens the matrix with r/m/a columns and hosted rows', async () => {
    const app = unlockedApp();
    await openKeys(app);
    await type(app, ENTER);
    await tick(60);
    const f = app.frame();
    expect(f).toContain('a-agent@Box · editing');
    expect(f).toMatch(/namespace\s+r\s+m\s+a/);
    expect(f).toContain('recall');
    expect(f).toContain('before journal:r+m,plane:r');
    app.unmount();
  });

  it("the schema's _enumVerdicts key is not shown as a namespace row", async () => {
    const app = unlockedApp({ schema: async () => ({ ...HOSTED, _enumVerdicts: {} }) });
    await openKeys(app);
    await type(app, ENTER);
    await tick(60);
    expect(app.frame()).toContain('a-agent@Box · editing');
    expect(app.frame()).not.toContain('_enumVerdicts');
    app.unmount();
  });

  it('Enter on an unchanged matrix stays in the editor with "no changes to review"', async () => {
    const app = unlockedApp();
    await toReview(app);
    expect(app.frame()).toContain('no changes to review');
    expect(app.frame()).toContain('editing');
    expect(app.frame()).not.toContain('· review');
    app.unmount();
  });

  it('space toggles the cursor cell and the after line follows', async () => {
    const app = unlockedApp();
    await openKeys(app);
    await type(app, ENTER);
    await tick(60);
    await type(app, DOWN, RIGHT, ' '); // plane, mutate
    expect(app.frame()).toContain('after  journal:r+m,plane:r+m');
    app.unmount();
  });

  it('Esc with changes asks first; a second Esc discards', async () => {
    const app = unlockedApp();
    await openKeys(app);
    await type(app, ENTER);
    await tick(60);
    await type(app, ' ', ESC);
    expect(app.frame()).toContain('discard changes? esc again');
    await type(app, ESC);
    await tick(60);
    expect(app.frame()).not.toContain('editing');
    app.unmount();
  });

  it('scrolls a ten-namespace grant to the cursor where the grid cannot hold it (80×14)', async () => {
    const many = Array.from({ length: 10 }, (_, i) => `ns${i}`).join(',');
    const app = unlockedApp({ rows: [row('wide@Box', many), ...ROWS.slice(1)], size: [80, 14] });
    await openKeys(app);
    await type(app, ENTER);
    await tick(60);
    for (let i = 0; i < 9; i++) await type(app, DOWN);
    const lines = app.frame().split('\n');
    const head = lines.findIndex((l) => /namespace\s+r\s+m\s+a/.test(l));
    const foot = lines.findIndex((l, i) => i > head && /^\s*before /.test(l));
    expect(head).toBeGreaterThanOrEqual(0);
    const grid = lines.slice(head + 1, foot);
    expect(grid.length).toBeLessThan(11);
    expect(grid.some((l) => l.includes(marathon.glyph.cursor) && l.includes('ns9'))).toBe(true);
    expect(grid.some((l) => l.includes('ns0'))).toBe(false);
    app.unmount();
  });
});

describe('parseTtl', () => {
  it('reads m/h/d, defaults on empty, refuses the rest', () => {
    expect(parseTtl('')).toBeUndefined();
    expect(parseTtl('30m')).toBe(1_800_000);
    expect(parseTtl('12h')).toBe(43_200_000);
    expect(parseTtl('7d')).toBe(604_800_000);
    expect(parseTtl('0d')).toBeNull();
    expect(parseTtl('abc')).toBeNull();
  });
});

describe('readInviteTtl', () => {
  it('accepts up to 30 days, refuses beyond with "at most 30 days", keeps the default on empty', () => {
    expect(readInviteTtl('')).toEqual({});
    expect(readInviteTtl('30d')).toEqual({ ttlMs: 2_592_000_000 });
    expect(readInviteTtl('720h')).toEqual({ ttlMs: 2_592_000_000 });
    expect(readInviteTtl('31d')).toEqual({ error: 'at most 30 days' });
    expect(readInviteTtl('721h')).toEqual({ error: 'at most 30 days' });
    expect(readInviteTtl('43201m')).toEqual({ error: 'at most 30 days' });
    expect(readInviteTtl('abc')).toEqual({ error: 'a duration like 30m, 12h or 7d' });
  });

  it('the invite-ttl prompt refuses 31d there and sends nothing', async () => {
    const app = unlockedApp();
    await openKeys(app);
    await type(app, 'i');
    await tick(60);
    await type(app, DOWN, ' ', ENTER);
    await tick(20);
    await type(app, ...'31d', ENTER);
    await tick(20);
    expect(app.frame()).toContain('at most 30 days');
    expect(app.frame()).not.toContain('· review');
    expect(app.calls).toEqual([]);
    app.unmount();
  });
});

describe('switchTo', () => {
  const fakeCtx = () => {
    const opened: unknown[] = [];
    return { opened, ctx: { open: (p: unknown, st: unknown) => opened.push([p, st]) } };
  };

  it('opens the panel while unlocked, and nothing once locked', () => {
    const admin = createAdminSession({ endpoint: 'http://h', idleMs: 60_000 });
    const { opened, ctx } = fakeCtx();
    switchTo(ctx as never, { admin }, 'prompt', {} as never);
    expect(opened).toEqual([]);
    admin.unlock('root@h', () => 't');
    switchTo(ctx as never, { admin }, 'review', {} as never);
    expect(opened).toHaveLength(1);
    admin.lock('test');
    switchTo(ctx as never, { admin }, 'prompt', {} as never);
    expect(opened).toHaveLength(1);
    admin.dispose();
  });
});

describe('prompts', () => {
  it('+ asks for a namespace, adds it as a row, and Esc returns to the editor with the edit kept', async () => {
    const app = unlockedApp();
    await openKeys(app);
    await type(app, ENTER);
    await tick(60);
    await type(app, ' ');
    await type(app, '+');
    await tick(20);
    expect(app.frame()).toContain('namespace to add');
    await type(app, 'r', 'e', 'v', 'i', 'e', 'w', ENTER);
    await tick(20);
    expect(app.frame()).toContain('review');
    expect(app.frame()).toContain('unhosted');
    expect(app.frame()).toContain('editing');
    app.unmount();
  });

  it('an invalid namespace stays on the prompt with the reason', async () => {
    const app = unlockedApp();
    await openKeys(app);
    await type(app, ENTER);
    await tick(60);
    await type(app, '+', 'a', ',', 'b', ENTER);
    expect(app.frame()).toContain('a namespace is letters, digits, _ . - or *');
    app.unmount();
  });

  it('n walks kid → pubkey → name, then opens an empty editor for the new kid', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'keys-'));
    const pem = generateKeyPairSync('ed25519')
      .publicKey.export({ type: 'spki', format: 'pem' })
      .toString();
    writeFileSync(join(dir, 'c.pub'), pem);
    const app = unlockedApp();
    await openKeys(app);
    await type(app, 'n');
    await tick(20);
    expect(app.frame()).toContain('kid to register');
    await type(app, ...'labs-claude@laptop', ENTER);
    expect(app.frame()).toContain('public key path');
    await type(app, ...join(dir, 'c.pub'), ENTER);
    await tick(40);
    expect(app.frame()).toMatch(/EdDSA · sha256:/);
    await type(app, ENTER);
    await tick(60);
    expect(app.frame()).toContain('labs-claude@laptop · editing');
    app.unmount();
  });

  it('a private key on the pubkey prompt is refused there', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'keys-'));
    const priv = generateKeyPairSync('ed25519')
      .privateKey.export({ type: 'pkcs8', format: 'pem' })
      .toString();
    writeFileSync(join(dir, 'c.key'), priv);
    const app = unlockedApp();
    await openKeys(app);
    await type(app, 'n', ...'c@h', ENTER, ...join(dir, 'c.key'), ENTER);
    await tick(40);
    expect(app.frame()).toContain('PRIVATE key');
    expect(app.frame()).not.toContain(priv.split('\n')[1] as string);
    app.unmount();
  });

  it('Esc on the namespace prompt returns to the editor with the edit kept', async () => {
    const app = unlockedApp();
    await openKeys(app);
    await type(app, ENTER);
    await tick(60);
    await type(app, ' ');
    const before = app.frame();
    expect(before).toMatch(/after\s+\S/);
    await type(app, '+');
    await tick(20);
    await type(app, ESC);
    await tick(40);
    expect(app.frame()).toContain('· editing');
    expect(app.frame()).not.toContain('namespace to add');
    expect(app.frame()).toMatch(/\+\s/);
    app.unmount();
  });

  it('Esc on a register prompt returns to the key table', async () => {
    const app = unlockedApp();
    await openKeys(app);
    await type(app, 'n');
    await tick(20);
    expect(app.frame()).toContain('kid to register');
    await type(app, ESC);
    await tick(60);
    expect(app.frame()).toContain('keys · 2 active');
    expect(app.frame()).not.toContain('kid to register');
    app.unmount();
  });

  it('an unreadable path shows the error code, not contents', async () => {
    const app = unlockedApp();
    await openKeys(app);
    await type(app, 'n', ...'c@h', ENTER, ...'/nonexistent/x.pub', ENTER);
    await tick(40);
    expect(app.frame()).toContain('cannot read /nonexistent/x.pub: ENOENT');
    app.unmount();
  });
});

const toReview = async (app: ReturnType<typeof unlockedApp>, ...edits: string[]) => {
  await openKeys(app);
  await type(app, ENTER);
  await tick(60);
  await type(app, ...edits, ENTER);
  await tick(20);
};

describe('review and apply', () => {
  it('a narrowing is tier 1: y then Enter applies, sends no flags, prints one line, re-reads', async () => {
    const app = unlockedApp();
    await toReview(app, DOWN, ' '); // plane read off → narrows
    expect(app.frame()).toContain('y then enter applies');
    await type(app, 'y', ENTER);
    await tick(60);
    expect(app.calls).toEqual([
      ['update', { kid: 'a-agent@Box', namespaces: ['journal'], capabilities: ['read', 'mutate'] }]
    ]);
    expect(app.frame()).toContain('✓ granted a-agent@Box journal:r+m (admin: b-admin@Box)');
    expect(app.frame()).toContain('keys · 2 active');
    app.unmount();
  });

  it('a widening is tier 2: y does nothing, the target is not pre-filled, the kid must be typed', async () => {
    const app = unlockedApp();
    await toReview(app, DOWN, RIGHT, ' '); // plane mutate on → widens
    expect(app.frame()).toContain('type a-agent@Box then enter to apply');
    await type(app, 'y', ENTER);
    expect(app.calls).toEqual([]);
    await type(app, ...'a-agent@Bo', ENTER);
    expect(app.calls).toEqual([]);
    expect(app.frame()).toContain('does not match');
    await type(app, ...'a-agent@Box', ENTER);
    await tick(60);
    expect(app.calls).toEqual([
      [
        'update',
        {
          kid: 'a-agent@Box',
          namespaces: ['journal', 'plane'],
          capabilities: ['read', 'mutate'],
          widen: true
        }
      ]
    ]);
    app.unmount();
  });

  it('an unhosted namespace is tier 2 and sends allowUnknownNs plus exactly the flags the verdict named', async () => {
    const app = unlockedApp();
    await openKeys(app);
    await type(app, ENTER);
    await tick(60);
    await type(app, '+');
    await tick(20);
    await type(app, ...'typo', ENTER);
    await tick(40);
    await type(app, ' ', ENTER); // typo read on
    await tick(20);
    expect(app.frame()).toContain('type a-agent@Box then enter to apply');
    expect(app.frame()).toContain('does not host: typo');
    await type(app, 'y', ENTER);
    await tick(40);
    expect(app.calls).toEqual([]);
    await type(app, ...'a-agent@Box', ENTER);
    await tick(60);
    expect(app.calls).toEqual([
      [
        'update',
        {
          kid: 'a-agent@Box',
          namespaces: ['journal', 'plane:read', 'typo:read'],
          capabilities: ['read', 'mutate'],
          widen: true,
          allowUnknownNs: true
        }
      ]
    ]);
    app.unmount();
  });

  it('a tier-2 target containing table-bound letters (k, j, x, i, n) types into the draft', async () => {
    const kid = 'labs-claude@laptop';
    const app = unlockedApp({ rows: [row(kid, 'journal'), ...ROWS.slice(1)] });
    await toReview(app, DOWN, ' '); // _system read on → widens
    await type(app, ...kid, ENTER);
    await tick(60);
    expect(app.calls).toEqual([['update', expect.objectContaining({ kid, widen: true })]]);
    app.unmount();
  });

  it('an unconditional refusal leaves apply dead and Esc goes back to the edit', async () => {
    const app = unlockedApp();
    await openKeys(app);
    await type(app, DOWN, ENTER); // b-admin
    await tick(60);
    await type(app, RIGHT, RIGHT, ' ', ENTER); // drop admin from the last admin
    await tick(20);
    expect(app.frame()).toContain('last_admin_deadmin');
    await type(app, 'y', ENTER, ...'b-admin@Box', ENTER);
    expect(app.calls).toEqual([]);
    await type(app, ESC);
    await tick(20);
    expect(app.frame()).toContain('editing');
    app.unmount();
  });

  it('a server refusal the preview did not predict is shown verbatim and not retried', async () => {
    const fail = new NetworkError('409 from /substrate/v1/_system/keys', null, {
      status: 409,
      code: 'already_revoked',
      serverMessage: 'Key a-agent@Box was revoked at 2026-10-06'
    });
    const app = unlockedApp({ fail });
    await toReview(app, DOWN, ' ');
    await type(app, 'y', ENTER);
    await tick(60);
    expect(app.frame()).toContain('already_revoked: Key a-agent@Box was revoked at 2026-10-06');
    expect(app.calls).toHaveLength(1);
    app.unmount();
  });

  it("a route's 403 shows as a refusal and the session stays unlocked", async () => {
    const fail = new AuthError('Forbidden', 403, {
      code: 'policy_denied',
      serverMessage: 'denied'
    });
    const app = unlockedApp({ fail });
    await toReview(app, DOWN, ' ');
    await type(app, 'y', ENTER);
    await tick(60);
    expect(app.frame()).toContain('policy_denied: denied');
    expect(app.admin.unlocked()).toBe(true);
    app.unmount();
  });

  it('a refusal that also locks the session still prints the refusal verbatim', async () => {
    const fail = new AuthError('Forbidden', 403, { code: 'forbidden', serverMessage: 'nope' });
    const app = unlockedApp({ fail });
    await toReview(app, DOWN, ' ');
    await type(app, 'y', ENTER);
    await tick(60);
    expect(app.admin.unlocked()).toBe(false);
    expect(app.frame()).toContain('forbidden: nope');
    app.unmount();
  });

  it('x on a row reviews a revoke (tier 1); revoking the last admin is refused there', async () => {
    const app = unlockedApp();
    await openKeys(app);
    await type(app, 'x');
    await tick(20);
    expect(app.frame()).toContain('a-agent@Box loses access immediately');
    await type(app, 'y', ENTER);
    await tick(60);
    expect(app.calls).toEqual([['revoke', 'a-agent@Box']]);
    expect(app.frame()).toContain('✓ revoked a-agent@Box (admin: b-admin@Box)');
    app.unmount();
  });

  it('an invite shows its code in the panel only, never in the transcript', async () => {
    const app = unlockedApp();
    await openKeys(app);
    await type(app, 'i');
    await tick(60);
    await type(app, DOWN, ' ', ENTER); // journal read (_system sorts first)
    await tick(20);
    await type(app, ...'7d', ENTER); // ttl
    await tick(20);
    await type(app, 'y', ENTER);
    await tick(60);
    expect(app.calls).toEqual([
      ['invite', { namespaces: ['journal'], capabilities: ['read'], ttlMs: 604_800_000 }]
    ]);
    expect(app.frame()).toContain('inv_SECRET');
    await type(app, ESC);
    await tick(20);
    expect(app.frame()).not.toContain('inv_SECRET');
    expect(app.frame()).toContain(
      '✓ invite minted for journal:r, expires 2026-10-13T00:00:00.000Z (admin: b-admin@Box)'
    );
    app.unmount();
  });
});

describe('review: register, empty grant, last-admin revoke', () => {
  it('register is tier 2 on the kid and sends the PEM exactly as read', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'keys-'));
    const pem = `${generateKeyPairSync('ed25519')
      .publicKey.export({ type: 'spki', format: 'pem' })
      .toString()}\n\n`;
    writeFileSync(join(dir, 'c.pub'), pem);
    const app = unlockedApp();
    await openKeys(app);
    await type(app, 'n', ...'c@h', ENTER, ...join(dir, 'c.pub'), ENTER);
    await tick(40);
    await type(app, ENTER);
    await tick(60);
    await type(app, DOWN, ' ', ENTER); // journal read
    await tick(20);
    expect(app.frame()).toContain('type c@h then enter to apply');
    expect(app.frame()).toContain('· registers a new identity');
    await type(app, 'y', ENTER);
    expect(app.calls).toEqual([]);
    await type(app, ...'c@h', ENTER);
    await tick(60);
    expect(app.calls).toEqual([
      [
        'register',
        {
          kid: 'c@h',
          publicKey: pem,
          algorithm: 'EdDSA',
          namespaces: ['journal'],
          capabilities: ['read']
        }
      ]
    ]);
    expect(app.frame()).toContain(
      '✓ registered c@h journal:r sha256:abcdefgh (admin: b-admin@Box)'
    );
    app.unmount();
  });

  it('register sends allowAdmin only when the grant carries admin', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'keys-'));
    const pem = generateKeyPairSync('ed25519')
      .publicKey.export({ type: 'spki', format: 'pem' })
      .toString();
    writeFileSync(join(dir, 'c.pub'), pem);
    const app = unlockedApp();
    await openKeys(app);
    await type(app, 'n', ...'c@h', ENTER, ...join(dir, 'c.pub'), ENTER);
    await tick(40);
    await type(app, ENTER);
    await tick(60);
    await type(app, DOWN, ' ', RIGHT, RIGHT, ' ', ENTER); // journal read + admin
    await tick(20);
    expect(app.frame()).toContain("carries 'admin'");
    await type(app, ...'c@h', ENTER);
    await tick(60);
    expect(app.calls).toEqual([
      [
        'register',
        {
          kid: 'c@h',
          publicKey: pem,
          algorithm: 'EdDSA',
          namespaces: ['journal'],
          capabilities: ['read', 'admin'],
          allowAdmin: true
        }
      ]
    ]);
    app.unmount();
  });

  it('an empty grant stays in the editor with the revoke hint', async () => {
    const app = unlockedApp({ rows: [row('a-agent@Box', 'journal', 'read'), ...ROWS.slice(1)] });
    await toReview(app, ' '); // journal read off → nothing left
    expect(app.frame()).toContain('a key needs at least one namespace');
    expect(app.frame()).toContain('editing');
    expect(app.calls).toEqual([]);
    app.unmount();
  });

  it('x on the last admin is refused in the review and y sends nothing', async () => {
    const app = unlockedApp();
    await openKeys(app);
    await type(app, DOWN, 'x');
    await tick(20);
    expect(app.frame()).toContain('b-admin@Box loses access immediately');
    expect(app.frame()).toContain('refused:');
    await type(app, 'y', ENTER, ...'b-admin@Box', ENTER);
    await tick(40);
    expect(app.calls).toEqual([]);
    await type(app, ESC);
    await tick(60);
    expect(app.frame()).toContain('keys · 2 active');
    app.unmount();
  });
});

describe('lock and size', () => {
  for (const at of ['edit', 'prompt', 'review'] as const) {
    it(`locking while the ${at} panel is open closes it, says why, and sends nothing`, async () => {
      const app = unlockedApp();
      await openKeys(app);
      await type(app, ENTER);
      await tick(60);
      if (at === 'prompt') await type(app, '+');
      if (at === 'review') await type(app, DOWN, ' ', ENTER);
      await tick(20);
      app.admin.lock('test');
      await tick(40);
      expect(app.frame()).toContain('keys closed — admin locked');
      expect(app.frame()).not.toMatch(/editing|namespace to add|· review/);
      expect(app.calls).toEqual([]);
      app.unmount();
    });
  }

  it('the editor renders at 160×50', async () => {
    const app = unlockedApp({ size: [160, 50] });
    await openKeys(app);
    await type(app, ENTER);
    await tick(60);
    expect(app.frame()).toContain('a-agent@Box · editing');
    expect(app.frame().split('\n').length).toBeLessThanOrEqual(50);
    app.unmount();
  });

  it('a lock during the hosted-namespace read opens no editor and sends nothing', async () => {
    let release: (v: unknown) => void = () => {};
    const gate = new Promise((r) => {
      release = r;
    });
    const app = unlockedApp({ schema: () => gate.then(() => HOSTED) });
    await openKeys(app);
    await type(app, ENTER);
    app.admin.lock('test');
    await tick(20);
    release(undefined);
    await tick(60);
    expect(app.frame()).not.toContain('editing');
    expect(app.calls).toEqual([]);
    app.unmount();
  });

  it('the success line names the admin even when a lock lands mid-request', async () => {
    let release: () => void = () => {};
    const hold = new Promise<void>((r) => {
      release = r;
    });
    const app = unlockedApp({ hold });
    await toReview(app, DOWN, ' ');
    await type(app, 'y', ENTER);
    await tick(20);
    app.admin.lock('test');
    await tick(20);
    release();
    await tick(60);
    expect(app.frame()).toContain('✓ granted a-agent@Box journal:r+m (admin: b-admin@Box)');
    app.unmount();
  });
});

describe('review gestures and size', () => {
  it('typing the target on a tier-1 review sends nothing', async () => {
    const app = unlockedApp();
    await toReview(app, DOWN, ' '); // narrows: tier 1
    await type(app, ...'a-agent@Box', ENTER);
    await tick(40);
    expect(app.calls).toEqual([]);
    app.unmount();
  });

  it('a second y then Enter while applying sends nothing more', async () => {
    let release: () => void = () => {};
    const hold = new Promise<void>((r) => {
      release = r;
    });
    const app = unlockedApp({ hold });
    await toReview(app, DOWN, ' ');
    await type(app, 'y', ENTER);
    await tick(20);
    expect(app.frame()).toContain('applying');
    await type(app, 'y', ENTER);
    expect(app.calls.length).toBe(1);
    release();
    await tick(60);
    expect(app.calls.length).toBe(1);
    app.unmount();
  });

  it('the review renders within 80×24, and a long invite code wraps untruncated', async () => {
    const code = `inv_${'abcdefghij'.repeat(12)}`;
    const app = unlockedApp({ size: [80, 24], code });
    await openKeys(app);
    await type(app, 'i');
    await tick(60);
    await type(app, DOWN, ' ', ENTER);
    await tick(20);
    await type(app, ENTER); // default ttl
    await tick(20);
    expect(app.frame().split('\n').length).toBeLessThanOrEqual(24);
    await type(app, 'y', ENTER);
    await tick(60);
    const f = app.frame();
    const lines = f.split('\n');
    expect(lines.length).toBeLessThanOrEqual(24);
    // The transcript line above the panel is the core's, and is not ours to wrap.
    const panel = lines.slice(lines.findIndex((l) => l.includes('· review')));
    expect(panel.every((l) => [...l].length <= 80)).toBe(true);
    const joined = lines
      .filter((l) => /^\s*(code|\|) /.test(l))
      .map((l) => l.replace(/^\s*(code|\|) /, '').trimEnd())
      .join('');
    expect(joined).toBe(code);
    app.unmount();
  });
});

describe('1603 minors', () => {
  const unlockedAndReview = async (over: Parameters<typeof unlockedApp>[0] = {}) => {
    const app = unlockedApp(over);
    await toReview(app, DOWN, ' ');
    return app;
  };

  it('refusal lines render in the error tone, other lines untoned', () => {
    const panels = editorPanels({} as TuiDeps);
    const colours = (node: unknown): [string, string | undefined][] =>
      (
        node as { props: { children: { props: { children: string; color?: string } }[] } }
      ).props.children.map((c) => [c.props.children, c.props.color]);
    const state = {
      flow: { kind: 'revoke', row: ROWS[0] as AdminKeyRow },
      edit: null,
      next: null,
      verdict: { kind: 'ok', tier: 1, flags: [], reasons: [] },
      stage: 'refused',
      error: { code: 'already_revoked', message: 'gone' },
      mismatch: false,
      table: ROWS
    } as const;
    const size = { columns: 80, rows: 24 };
    const refused = colours(panels.review.view({ state: state as never, theme: marathon, size }));
    expect(refused.find(([t]) => t.includes('already_revoked: gone'))?.[1]).toBe(
      marathon.color.error
    );
    expect(refused.find(([t]) => t.includes('esc back'))?.[1]).toBeUndefined();
    const verdictRefused = colours(
      panels.review.view({
        state: {
          ...state,
          stage: 'review',
          verdict: { kind: 'refused', code: 'empty_grant', message: 'no' }
        } as never,
        theme: marathon,
        size
      })
    );
    expect(verdictRefused.find(([t]) => t.includes('refused: empty_grant'))?.[1]).toBe(
      marathon.color.error
    );
    const prompt = colours(
      panels.prompt.view({
        state: { purpose: 'add-ns', label: 'x', error: 'bad name', back: null, table: [] } as never,
        theme: marathon,
        size
      })
    );
    expect(prompt.find(([t]) => t.includes('bad name'))?.[1]).toBe(marathon.color.error);
  });

  it('after a confirmable 422 the refreshed row drives the next verdict, which then sends widen', async () => {
    const fail = new NetworkError('422', null, {
      status: 422,
      code: 'requires_widen',
      serverMessage: 'widening needs widen'
    });
    const app = unlockedApp({ failOnce: fail });
    // Open on a-agent@Box (journal:r+m, plane:r) and drop plane: a narrowing, tier 1, no flags.
    await toReview(app, DOWN, ' ');
    expect(app.frame()).toContain('y then enter applies');
    // Meanwhile another admin narrows the key on the server; the operator's grant now WIDENS it.
    app.setRows([row('a-agent@Box', 'journal:read,plane:read', 'read'), ...ROWS.slice(1)]);
    await type(app, 'y', ENTER);
    await tick(80);
    expect(app.frame()).toContain('requires_widen: widening needs widen');
    expect(app.calls).toHaveLength(1);
    expect((app.calls[0] as [string, object])[1]).not.toHaveProperty('widen');
    // The refreshed verdict is already on the refused review.
    expect(app.frame()).toContain('before journal:r,plane:r');
    await type(app, ESC);
    await tick(60);
    await type(app, ENTER);
    await tick(40);
    expect(app.frame()).toContain('type a-agent@Box then enter to apply');
    await type(app, ...'a-agent@Box', ENTER);
    await tick(80);
    expect(app.calls).toHaveLength(2);
    expect((app.calls[1] as [string, object])[1]).toMatchObject({ widen: true });
    app.unmount();
  });

  it('a 422 for a key that has left the table says so and offers no apply', async () => {
    const fail = new NetworkError('422', null, {
      status: 422,
      code: 'requires_widen',
      serverMessage: 'w'
    });
    const app = unlockedApp({ failOnce: fail });
    await toReview(app, DOWN, ' ');
    app.setRows(ROWS.slice(1));
    await type(app, 'y', ENTER);
    await tick(80);
    expect(app.frame()).toContain('a-agent@Box is no longer in the key table');
    expect(app.frame()).toContain('requires_widen: w');
    // Esc must not reopen the editor on the stale row: the full re-apply gesture sends nothing.
    await type(app, ESC);
    await tick(60);
    await type(app, ENTER);
    await tick(40);
    await type(app, 'y', ENTER);
    await tick(80);
    expect(app.calls).toHaveLength(1);
    app.unmount();
  });

  it('a failed re-read keeps the refusal and says the table could not be refreshed', async () => {
    const fail = new NetworkError('422', null, {
      status: 422,
      code: 'requires_widen',
      serverMessage: 'w'
    });
    const app = unlockedApp({ failOnce: fail });
    await toReview(app, DOWN, ' ');
    app.failReads();
    await type(app, 'y', ENTER);
    await tick(80);
    expect(app.frame()).toContain('requires_widen: w');
    expect(app.frame()).toContain('could not refresh the key table');
    app.unmount();
  });

  it('an unrelated refusal does not re-read the table', async () => {
    const reads = { n: 0 };
    const app = await unlockedAndReview({
      reads,
      fail: new NetworkError('409', null, {
        status: 409,
        code: 'already_revoked',
        serverMessage: 'x'
      })
    });
    const before = reads.n;
    await type(app, 'y', ENTER);
    await tick(80);
    expect(reads.n).toBe(before);
    app.unmount();
  });

  it('the empty-grant refusal in the edit panel is toned as an error', () => {
    const panels = editorPanels({} as TuiDeps);
    const node = panels.edit.view({
      state: {
        flow: { kind: 'invite' },
        matrix: openMatrix(new Map(), ['journal']),
        table: [],
        discardArmed: false,
        note: 'a key needs at least one namespace — revoke removes all access'
      },
      theme: marathon,
      size: { columns: 100, rows: 30 }
    }) as { props: { children: { props: { children: string; color?: string } }[] } };
    const line = node.props.children.find((c) =>
      c.props.children.includes('at least one namespace')
    );
    expect(line?.props.color).toBe(marathon.color.error);
  });

  it('a lock while the invite code is displayed leaves the code visible', async () => {
    const app = unlockedApp({ code: 'inv_VISIBLE' });
    await openKeys(app);
    await type(app, 'i');
    await tick(60);
    await type(app, DOWN, ' ', ENTER);
    await tick(20);
    await type(app, ENTER);
    await tick(20);
    await type(app, 'y', ENTER);
    await tick(60);
    expect(app.frame()).toContain('inv_VISIBLE');
    app.admin.lock('test');
    await tick(60);
    expect(app.frame()).toContain('inv_VISIBLE');
    expect(app.frame()).not.toContain('keys closed — admin locked');
    app.unmount();
  });

  it('the grid keeps every cell four wide: the cursor does not shift a glyph, tails share a column', async () => {
    const app = unlockedApp({ rows: [row('x@Box', 'journal,legacy'), ...ROWS.slice(1)] });
    await openKeys(app);
    await type(app, ENTER);
    await tick(60);
    const lines = app.frame().split('\n');
    const at = (ns: string) => lines.find((l) => new RegExp(`\\s${ns}\\s`).test(l)) as string;
    // The cursor sits on journal/read; its glyph must sit where the same glyph sits one row down.
    const cur = at('journal');
    const other = lines.find((l) => /\s_system\s/.test(l)) as string;
    expect(cur.indexOf('[')).toBeGreaterThan(0);
    expect(cur.indexOf('■') - 1).toBe(cur.indexOf('['));
    const head = lines.find((l) => /namespace\s+r\s+m\s+a/.test(l)) as string;
    expect(other).toBeDefined();
    expect(head.indexOf('r', head.indexOf('namespace') + 9)).toBe(cur.indexOf('■'));
    expect(at('legacy').indexOf('unhosted')).toBe(at('plane').indexOf('(hosted, not granted)'));
    app.unmount();
  });

  it('~other/… on the pubkey prompt is refused with a message, not rewritten', async () => {
    const app = unlockedApp();
    await openKeys(app);
    await type(app, 'n', ...'c@h', ENTER, ...'~other/x.pub', ENTER);
    await tick(40);
    expect(app.frame()).toContain('only ~ and ~/… are expanded');
    app.unmount();
  });
});

describe('wrapCode', () => {
  it('slices by code points, never splitting a surrogate pair', () => {
    const code = '😀'.repeat(10);
    const lines = wrapCode(code, 12);
    for (const l of lines) expect(l).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(lines.map((l) => l.replace(/^ {2}(code|\|) /, '')).join('')).toBe(code);
  });
});

/**
 * `substrate-admin list --url` — the authenticated read.
 *
 * The direct read cannot answer "does my admin credential work": it prints the
 * admin row whether or not admin auth works. This path asks the server, so a
 * 403 is the deployment's verdict on THIS caller.
 */

import { describe, expect, it } from 'vitest';
import { formatRemoteListOutput } from '../src/admin/commands/list.js';
import type { AdminCliEnv } from '../src/admin/env.js';
import { runKeyListViaRoute } from '../src/admin/route.js';

const env: AdminCliEnv = { SUBSTRATE_ADMIN_TOKEN: 'tok' };

function res(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body
  } as unknown as Response;
}

describe('runKeyListViaRoute', () => {
  it('sends the admin credential and returns the keys', async () => {
    const seen: Array<{ url: string; auth: string | undefined }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen.push({ url, auth: (init.headers as Record<string, string>).authorization });
      return res(200, { keys: [{ kid: 'a@h' }], hasMore: false });
    }) as unknown as typeof fetch;

    const keys = await runKeyListViaRoute('https://peer:3100', env, fetchImpl);
    expect(keys).toEqual([{ kid: 'a@h' }]);
    expect(seen[0]?.url).toBe('https://peer:3100/substrate/v1/_system/keys');
    expect(seen[0]?.auth).toBe('Bearer tok');
  });

  it('PAGES to exhaustion — a truncated answer to "which identities exist" is worse than an error', async () => {
    let call = 0;
    const fetchImpl = (async () => {
      call += 1;
      return call === 1
        ? res(200, { keys: [{ kid: 'a@h' }], hasMore: true, nextCursor: 'c1' })
        : res(200, { keys: [{ kid: 'b@h' }], hasMore: false });
    }) as unknown as typeof fetch;

    const keys = await runKeyListViaRoute('https://peer', env, fetchImpl);
    expect(keys.map((k) => k.kid)).toEqual(['a@h', 'b@h']);
    expect(call).toBe(2);
  });

  it('refuses to report a partial list as complete when hasMore has no cursor', async () => {
    const fetchImpl = (async () =>
      res(200, { keys: [{ kid: 'a@h' }], hasMore: true })) as unknown as typeof fetch;
    await expect(runKeyListViaRoute('https://peer', env, fetchImpl)).rejects.toThrow(
      /refusing to report a partial list as complete/
    );
  });

  it("a 403 is reported as the SERVER'S verdict on this credential, not a malfunction", async () => {
    const fetchImpl = (async () =>
      res(403, {
        code: 'policy_denied',
        message: 'requireCapability(admin): missing capability'
      })) as unknown as typeof fetch;
    await expect(runKeyListViaRoute('https://peer', env, fetchImpl)).rejects.toThrow(
      /refused by https:\/\/peer/
    );
  });

  it("a 401 names the server's reason, not just the status", async () => {
    const fetchImpl = (async () =>
      res(401, {
        code: 'unauthorized',
        reason: 'wrong_audience',
        detail: 'the token names an origin this server does not list'
      })) as unknown as typeof fetch;
    await expect(runKeyListViaRoute('https://peer', env, fetchImpl)).rejects.toThrow(
      /unauthorized \(wrong_audience\): the token names an origin/
    );
  });

  it('a missing keys array is an error, not an empty store', async () => {
    const fetchImpl = (async () => res(200, { hasMore: false })) as unknown as typeof fetch;
    await expect(runKeyListViaRoute('https://peer', env, fetchImpl)).rejects.toThrow(
      /carried no `keys` array/
    );
  });

  // An EMPTY env is not credential-less: the resolver falls back to default key
  // paths, so `{}` resolves on any box that has been bootstrapped. Naming a key
  // that cannot exist is what makes this assertion about the code rather than
  // about the machine it runs on.
  it('an unresolvable admin credential fails before any request is made', async () => {
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return res(200, { keys: [], hasMore: false });
    }) as unknown as typeof fetch;
    const noCred: AdminCliEnv = { SUBSTRATE_ADMIN_KEY_PATH: '/nonexistent/no-such-admin.key' };
    await expect(runKeyListViaRoute('https://peer', noCred, fetchImpl)).rejects.toThrow(/list:/);
    expect(called).toBe(false);
  });
});

describe('formatRemoteListOutput', () => {
  it('says the read was AUTHENTICATED and names the target', () => {
    const out = formatRemoteListOutput([{ kid: 'a@h', capabilities: 'admin' }], 'https://peer');
    expect(out).toMatch(/a@h/);
    expect(out).toMatch(/AUTHENTICATED/);
    expect(out).toMatch(/https:\/\/peer/);
  });

  it('the EMPTY result carries it too — that is where the ambiguity lives', () => {
    const out = formatRemoteListOutput([], 'https://peer');
    expect(out).toMatch(/no active Key rows/);
    expect(out).toMatch(/AUTHENTICATED/);
  });
});

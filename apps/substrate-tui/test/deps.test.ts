import { describe, expect, it } from 'vitest';
import { makeDeps } from '../src/deps.js';

describe('makeDeps errors()', () => {
  it('signs as admin while unlocked without extending the idle clock; as the agent otherwise', async () => {
    const auth: (string | null)[] = [];
    const fetchImpl = (async (_u: unknown, init?: RequestInit) => {
      const h = new Headers(init?.headers);
      auth.push(h.get('authorization'));
      return new Response(JSON.stringify({ errors: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }) as typeof fetch;
    const deps = makeDeps(
      { endpoint: 'https://h', project: 'p', namespace: 'n', token: () => 'agent-tok' } as never,
      fetchImpl,
      {}
    );
    await deps.errors().catch(() => {});
    deps.admin.unlock('ops@Box', () => 'admin-tok');
    const before = deps.admin.state();
    await new Promise((r) => setTimeout(r, 15));
    await deps.errors().catch(() => {});
    const after = deps.admin.state();
    expect(auth[0]).toBe('Bearer agent-tok');
    expect(auth[1]).toBe('Bearer admin-tok');
    expect(after.kind === 'unlocked' && before.kind === 'unlocked' && after.idleUntil).toBe(
      before.kind === 'unlocked' ? before.idleUntil : -1
    );
    deps.admin.dispose();
  });
});

describe('makeDeps adminEnv', () => {
  it('carries SUBSTRATE_ADMIN_CAPABILITY through', () => {
    const deps = makeDeps(
      { endpoint: 'https://h', project: 'p', namespace: 'n', token: null } as never,
      (async () => new Response('{}')) as typeof fetch,
      { SUBSTRATE_ADMIN_CAPABILITY: 'superuser' }
    );
    expect(deps.adminEnv.SUBSTRATE_ADMIN_CAPABILITY).toBe('superuser');
    deps.admin.dispose();
  });
});

describe('makeDeps credential target', () => {
  const ok = (async () => new Response('{}')) as typeof fetch;

  it('refuses plain http to a non-loopback host once a credential is configured', () => {
    const cfg = { endpoint: 'http://h', project: 'p', namespace: 'n' };
    expect(() => makeDeps({ ...cfg, token: () => 't' } as never, ok, {})).toThrow(/use https/);
    expect(() =>
      makeDeps({ ...cfg, token: null } as never, ok, { SUBSTRATE_ADMIN_TOKEN: 'a' })
    ).toThrow(/use https/);
    makeDeps({ ...cfg, token: null } as never, ok, {}).admin.dispose();
  });

  it('refuses redirects on every request that can carry a bearer', async () => {
    const redirects: RequestInit['redirect'][] = [];
    const fetchImpl = (async (_u: unknown, init?: RequestInit) => {
      redirects.push(init?.redirect);
      return new Response('{"errors":[]}', { headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    const deps = makeDeps(
      { endpoint: 'https://h', project: 'p', namespace: 'n', token: () => 't' } as never,
      fetchImpl,
      {}
    );
    await deps.getJson('/x');
    await deps.errors().catch(() => {});
    deps.admin.unlock('ops@Box', () => 'admin-tok');
    await deps.errors().catch(() => {});
    deps.admin.dispose();
    expect(redirects).toEqual(['error', 'error', 'error']);
  });
});

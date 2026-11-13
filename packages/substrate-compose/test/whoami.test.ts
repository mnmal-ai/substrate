/**
 * `GET /substrate/v1/whoami`.
 *
 * Each distinction is exercised as a THREE-WAY comparison rather than a
 * single case:
 *
 *   auth off          -> { authEnabled: false, identity: null }
 *   auth on, no token -> { authEnabled: true,  identity: null }
 *   auth on, bad token-> 401
 *
 * The first two rows tell "auth off" from "anonymous", which look identical
 * from the client side; the third keeps a BROKEN credential from being
 * reported as an absent one.
 */

import { capabilitiesFor, flattenGrant, parseGrantEntries } from '@mnmal-ai/substrate-policy';
import type { SubstrateRequest } from '@mnmal-ai/substrate-types';
import { describe, expect, it } from 'vitest';
import { type AuthConfig, signHs256 } from '../src/auth.js';
import { describeIdentity, whoamiRoute } from '../src/routes/whoami.js';

const SECRET = 'whoami-test-secret';
const KID = 'whoami-test';

const AUTH: AuthConfig = {
  mode: 'attribute',
  keys: [{ kid: KID, alg: 'HS256', publicKey: SECRET }]
};

function token(capabilities: string[] = ['read'], namespaces: string[] = ['journal']): string {
  return signHs256(
    { sub: 'caller@host', capabilities, ns: namespaces, exp: Math.floor(Date.now() / 1000) + 300 },
    SECRET,
    { kid: KID }
  );
}

function request(headers: Record<string, string> = {}): SubstrateRequest {
  return {
    method: 'GET',
    path: '/substrate/v1/whoami',
    headers,
    query: {},
    params: {},
    body: null
  } as unknown as SubstrateRequest;
}

async function call(
  auth: AuthConfig | undefined,
  headers: Record<string, string> = {}
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await whoamiRoute(auth)(request(headers));
  return { status: res.status, body: JSON.parse(String(res.body)) };
}

describe('GET /substrate/v1/whoami', () => {
  it('reports auth being OFF as distinct from being anonymous', async () => {
    // Different facts with different fixes: one is a deployment posture the
    // caller cannot change, the other is the caller's own broken wiring.
    const off = await call(undefined);
    const anon = await call(AUTH);

    expect(off.body).toEqual({ authEnabled: false, identity: null });
    expect(anon.body).toEqual({ authEnabled: true, identity: null });
    expect(off.body).not.toEqual(anon.body);
  });

  it('answers an anonymous caller with 200, not 401', async () => {
    // The caller with no credential has the most urgent question, and this is
    // why the route is NOT mounted behind `gate(…, 'read')`.
    const res = await call(AUTH);
    expect(res.status).toBe(200);
  });

  it('401s a present-but-INVALID token rather than calling it anonymous', async () => {
    // The asymmetry that carries most of the value: "you sent nothing" and
    // "what you sent is broken" need different fixes, and a single response for
    // both would leave a caller debugging the wrong half.
    const res = await call(AUTH, { authorization: 'Bearer not-a-real-token' });

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('unauthorized');
    expect(String(res.body.detail)).toContain('not the same as sending no token');
  });

  it('returns the principal for a valid token', async () => {
    const res = await call(AUTH, { authorization: `Bearer ${token()}` });

    expect(res.status).toBe(200);
    // `{ id, grants }` and nothing else. The flat claim is expanded to the
    // cross product at verification, so this reports the same authority the
    // gates enforce.
    expect(res.body).toEqual({
      authEnabled: true,
      identity: {
        id: 'caller@host',
        grants: { journal: ['read'] }
      }
    });
  });

  it('carries NO flat fields and NO deprecation notice — both retired with 6.0.0', async () => {
    // No flat field and no notice about one: the grant is the only
    // description of authority on the wire.
    const res = await call(AUTH, { authorization: `Bearer ${token()}` });
    expect(res.body).not.toHaveProperty('deprecations');
    const identity = res.body.identity as Record<string, unknown>;
    expect(identity).not.toHaveProperty('capabilities');
    expect(identity).not.toHaveProperty('namespaces');
  });

  it('returns the grant AS RECORDED — a wildcard stays a wildcard', async () => {
    // Expanding `*` into the list of live namespaces would turn a
    // self-description into a directory. The caller is told what they hold,
    // never what exists.
    const res = await call(AUTH, {
      authorization: `Bearer ${token(['read', 'mutate'], ['*'])}`
    });

    expect((res.body.identity as { grants: Record<string, string[]> }).grants).toEqual({
      '*': ['mutate', 'read']
    });
  });

  it('never echoes the token', async () => {
    const jwt = token();
    const res = await call(AUTH, { authorization: `Bearer ${jwt}` });

    expect(JSON.stringify(res.body)).not.toContain(jwt);
  });
});

describe('one value on both surfaces', () => {
  // The wire carries the grant VERBATIM — no recompute, no union, no null —
  // and no flat field that could disagree with substrate-types' declaration.
  const ENTRIES = [
    'journal:read+mutate',
    'recall:read+mutate',
    'tasks:read+mutate+admin',
    'board:read'
  ];
  const asRecord = (g: ReadonlyMap<string, ReadonlySet<string>>): Record<string, string[]> =>
    Object.fromEntries([...g].map(([ns, caps]) => [ns, [...caps]]));

  it('the wire carries the grant verbatim for a non-uniform grant', () => {
    const grants = asRecord(parseGrantEntries(ENTRIES, ['read', 'mutate']));

    const wire = describeIdentity({ id: 'tasks-claude@devbox', grants });

    expect(wire).toEqual({ id: 'tasks-claude@devbox', grants });
  });

  it('the union still exists — but only inside the grant module, never on Identity', () => {
    // `flattenGrant` is a grant-module utility for the route gate's
    // widest-reading question. It must not resurface as an Identity field.
    const grant = parseGrantEntries(ENTRIES, ['read', 'mutate']);
    expect(new Set(flattenGrant(grant).capabilities)).toEqual(new Set(['read', 'mutate', 'admin']));
    expect(capabilitiesFor(grant, 'board').has('admin')).toBe(false);
  });
});

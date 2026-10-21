/**
 * `GET /substrate/v1/whoami` and the WS `whoami` op.
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
 *
 * A socket's auth is a different code path from HTTP's, so the WS op is tested
 * through a real registered route rather than trusted to agree with the HTTP
 * handler.
 */

import { Engine, MemoryEdgesStore, Registry } from '@mnmal-ai/substrate-core';
import { MemoryDataset, MemoryDatasetRegistry } from '@mnmal-ai/substrate-dataset-memory';
import { capabilitiesFor, flattenGrant, parseGrantEntries } from '@mnmal-ai/substrate-policy';
import type {
  SubstrateRequest,
  SubstrateServer,
  WsConnection,
  WsHandler
} from '@mnmal-ai/substrate-types';
import { describe, expect, it } from 'vitest';
import { type AuthConfig, signHs256 } from '../src/auth.js';
import { describeIdentity, whoamiRoute } from '../src/routes/whoami.js';
import { registerWsRoute } from '../src/routes/ws.js';

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

/** Drive the real WS route and collect what it sends back. */
async function wsExchange(
  auth: AuthConfig | undefined,
  headers: Record<string, string>,
  frames: unknown[]
): Promise<Array<Record<string, unknown>>> {
  let handler: WsHandler | undefined;
  const server = {
    route: () => {},
    websocket: (_p: string, h: WsHandler) => {
      handler = h;
    }
  } as unknown as SubstrateServer;

  const registry = new Registry();
  registry.register('Memo', { resolver: async () => [] });
  const datasets = new MemoryDatasetRegistry();
  datasets.set('default', new MemoryDataset({ namespace: 'default' }));
  const engine = new Engine({
    namespaces: new Map([['default', { registry }]]),
    datasets,
    edges: new MemoryEdgesStore({ now: () => new Date('2026-08-25T00:00:00Z') })
  });

  registerWsRoute(server, engine, new Set<string>(), () => {}, auth);

  const sent: Array<Record<string, unknown>> = [];
  let onMsg: ((b: Buffer) => void) | undefined;
  const conn = {
    id: 'c1',
    send: (d: string | Buffer) => {
      sent.push(JSON.parse(String(d)) as Record<string, unknown>);
    },
    onMessage: (cb: (b: Buffer) => void) => {
      onMsg = cb;
    },
    onClose: () => {},
    close: () => {}
  } as unknown as WsConnection;

  await handler?.({ ...request(headers), path: '/substrate/v1/ws' } as SubstrateRequest, conn);
  for (const f of frames) onMsg?.(Buffer.from(JSON.stringify(f), 'utf8'));
  return sent;
}

describe('WS whoami op', () => {
  it('answers on the socket, without opening a session', async () => {
    // Asked and answered on the connection whose auth is in question — a
    // client that has to leave the socket to find out is answering a
    // different question.
    const frames = await wsExchange(AUTH, { authorization: `Bearer ${token()}` }, [
      { id: '1', op: 'whoami' }
    ]);

    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({
      id: '1',
      kind: 'whoami',
      data: {
        authEnabled: true,
        identity: { id: 'caller@host', grants: { journal: ['read'] } }
      }
    });
  });

  it('reports an anonymous socket as anonymous rather than refusing', async () => {
    // Reachable because `attribute` mode admits a tokenless upgrade.
    const frames = await wsExchange(AUTH, {}, [{ id: '1', op: 'whoami' }]);

    expect(frames[0]).toMatchObject({
      kind: 'whoami',
      data: { authEnabled: true, identity: null }
    });
  });

  it('reports auth-off distinctly on the socket too', async () => {
    const frames = await wsExchange(undefined, {}, [{ id: '1', op: 'whoami' }]);

    expect(frames[0]).toMatchObject({
      kind: 'whoami',
      data: { authEnabled: false, identity: null }
    });
  });

  it('leaves the other ops working — whoami is additive', async () => {
    // The op allowlist is deliberately tiny: an unknown op is still
    // `invalid_frame`.
    const frames = await wsExchange(AUTH, { authorization: `Bearer ${token()}` }, [
      { id: '1', op: 'nonsense' }
    ]);

    expect(frames[0]).toMatchObject({ kind: 'error' });
    expect((frames[0]!.errors as Array<{ code: string }>)[0]?.code).toBe('invalid_frame');
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

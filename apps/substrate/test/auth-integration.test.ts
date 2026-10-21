/**
 * §5.12 Phase 1 auth integration — route→capability map, per-frame namespace
 * gate, WS per-frame gating, and the `requireNamespace` policy primitive's
 * composition with `requireCapability`.
 *
 * Uses `MemorySubstrateServer.inject()` for HTTP and `connectWebsocket` for WS so
 * the full compose path is exercised (no direct-engine shortcuts).
 */

import { generateKeyPairSync } from 'node:crypto';
import {
  type AuthConfig,
  type ComposeResult,
  compose,
  signEdDSA,
  signHs256
} from '@mnmal-ai/substrate-compose';
import { MemoryDataset } from '@mnmal-ai/substrate-dataset-memory';
import { and, requireCapability, requireNamespace } from '@mnmal-ai/substrate-policy';
import { installAutoCrud } from '@mnmal-ai/substrate-sdk';
import { FastifySubstrateServer } from '@mnmal-ai/substrate-server-fastify';
import { MemorySubstrateServer } from '@mnmal-ai/substrate-server-memory';
import type {
  CoordinatorPlugin,
  Identity,
  PackEnvelope,
  RequestContext,
  ResolverArgs,
  SubstrateResponse,
  SubstrateServer,
  WsResponseFrame
} from '@mnmal-ai/substrate-types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fixturePlugin } from './_fixtures/fixture-plugin.js';

function bodyToString(res: SubstrateResponse): string {
  const b = res.body;
  if (b === undefined || b === null) return '';
  if (typeof b === 'string') return b;
  if (Buffer.isBuffer(b)) return b.toString('utf8');
  if (b instanceof Uint8Array) return Buffer.from(b).toString('utf8');
  return '';
}

function jsonBody<T>(res: SubstrateResponse): T {
  return JSON.parse(bodyToString(res)) as T;
}

const SECRET = 'phase1-integration-secret';
const KID = 'phase1';
const authCfg: AuthConfig = { keys: [{ kid: KID, alg: 'HS256', publicKey: SECRET }] };

function mkToken(claims: Record<string, unknown>): string {
  const now = Math.floor(Date.now() / 1000);
  return signHs256({ sub: 'tester', exp: now + 60, ...claims }, SECRET, { kid: KID });
}

interface AuthServerCtx {
  server: MemorySubstrateServer;
  composed: ComposeResult;
}

async function mkAuthServer(
  opts: { coordinators?: Array<CoordinatorPlugin> } = {}
): Promise<AuthServerCtx> {
  const server = new MemorySubstrateServer();
  const dataset = new MemoryDataset({ namespace: 'default' });
  const composeOpts: Parameters<typeof compose>[0] = {
    server,
    dataset,
    auth: authCfg,
    streamTicketSecret: 'test-stream-ticket-secret'
  };
  if (opts.coordinators !== undefined) composeOpts.coordinators = opts.coordinators;
  const composed = await compose(composeOpts);
  await server.start();
  return { server, composed };
}

describe('apps/substrate § auth route-capability map', () => {
  let ctx: AuthServerCtx | null = null;

  afterEach(async () => {
    if (ctx !== null) {
      await ctx.composed.stop();
      ctx = null;
    }
  });

  it.each(['/substrate/v1/schema', '/substrate/v1/federated-schema', '/substrate/v1/onboard'])(
    'GET %s refuses a tokenless caller when auth is configured',
    async (path) => {
      ctx = await mkAuthServer();
      const res = await ctx.server.inject({ method: 'GET', path });
      expect(res.status).toBe(401);
    }
  );

  it.each(['/substrate/v1/schema', '/substrate/v1/federated-schema', '/substrate/v1/onboard'])(
    'GET %s answers a caller holding read',
    async (path) => {
      ctx = await mkAuthServer();
      const token = mkToken({ capabilities: ['read'], ns: ['*'] });
      const res = await ctx.server.inject({
        method: 'GET',
        path,
        headers: { authorization: `Bearer ${token}` }
      });
      expect(res.status).toBe(200);
    }
  );

  it('POST /substrate/v1/query requires read capability — read token succeeds', async () => {
    ctx = await mkAuthServer();
    const token = mkToken({ capabilities: ['read'], ns: ['*'] });
    const res = await ctx.server.inject({
      method: 'POST',
      path: '/substrate/v1/query',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json'
      },
      body: Buffer.from(
        JSON.stringify({
          'default/Todo': { params: { limit: 1 }, fields: { id: true } }
        })
      )
    });
    expect(res.status).toBe(200);
  });

  it('POST /substrate/v1/query rejects tokens that only have mutate with 403', async () => {
    ctx = await mkAuthServer();
    const token = mkToken({ capabilities: ['mutate'], ns: ['*'] });
    const res = await ctx.server.inject({
      method: 'POST',
      path: '/substrate/v1/query',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json'
      },
      body: Buffer.from(
        JSON.stringify({
          'default/Todo': { params: { limit: 1 }, fields: { id: true } }
        })
      )
    });
    expect(res.status).toBe(403);
    const body = jsonBody<{ code: string; required: string; have: Array<string> }>(res);
    expect(body.code).toBe('forbidden');
    expect(body.required).toBe('read');
    expect(body.have).toEqual(['mutate']);
  });

  it('POST /substrate/v1/mutate rejects tokens that only have read with 403', async () => {
    ctx = await mkAuthServer();
    const token = mkToken({ capabilities: ['read'], ns: ['*'] });
    const res = await ctx.server.inject({
      method: 'POST',
      path: '/substrate/v1/mutate',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json'
      },
      body: Buffer.from(
        JSON.stringify({
          'default/createTodo': { params: { id: '1', title: 't' }, fields: { id: true } }
        })
      )
    });
    expect(res.status).toBe(403);
    const body = jsonBody<{ code: string; required: string }>(res);
    expect(body.required).toBe('mutate');
  });

  it('POST /substrate/v1/mutate allows a mutate-capable token', async () => {
    ctx = await mkAuthServer();
    const token = mkToken({ capabilities: ['mutate'], ns: ['*'] });
    const res = await ctx.server.inject({
      method: 'POST',
      path: '/substrate/v1/mutate',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json'
      },
      body: Buffer.from(
        JSON.stringify({
          'default/createTodo': { params: { id: '1', title: 't' }, fields: { id: true } }
        })
      )
    });
    expect(res.status).toBe(200);
  });

  it('POST /substrate/v1/query without a bearer returns 401 (not 403)', async () => {
    ctx = await mkAuthServer();
    const res = await ctx.server.inject({
      method: 'POST',
      path: '/substrate/v1/query',
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(
        JSON.stringify({
          'default/Todo': { params: {}, fields: { id: true } }
        })
      )
    });
    expect(res.status).toBe(401);
  });

  it('plugin GET routes default to read capability', async () => {
    const plugin: CoordinatorPlugin = {
      name: 'p',
      contractVersion: '*',
      namespaces: [{ namespace: 'default', install: (): void => undefined }],
      routes: (router): void => {
        router.get('/ping', () => ({ status: 200, body: 'ok' }));
        router.post('/bump', () => ({ status: 200, body: 'bumped' }));
      }
    };
    ctx = await mkAuthServer({ coordinators: [plugin] });
    const readToken = mkToken({ capabilities: ['read'], ns: ['*'] });
    const mutateToken = mkToken({ capabilities: ['mutate'], ns: ['*'] });

    // GET /ping allows read
    const okGet = await ctx.server.inject({
      method: 'GET',
      path: '/substrate/v1/plugins/p/ping',
      headers: { authorization: `Bearer ${readToken}` }
    });
    expect(okGet.status).toBe(200);

    // GET /ping with mutate-only is 403
    const forbiddenGet = await ctx.server.inject({
      method: 'GET',
      path: '/substrate/v1/plugins/p/ping',
      headers: { authorization: `Bearer ${mutateToken}` }
    });
    expect(forbiddenGet.status).toBe(403);
  });

  it('plugin POST routes default to mutate capability', async () => {
    const plugin: CoordinatorPlugin = {
      name: 'p',
      contractVersion: '*',
      namespaces: [{ namespace: 'default', install: (): void => undefined }],
      routes: (router): void => {
        router.post('/bump', () => ({ status: 200, body: 'bumped' }));
      }
    };
    ctx = await mkAuthServer({ coordinators: [plugin] });

    const readToken = mkToken({ capabilities: ['read'], ns: ['*'] });
    const forbidden = await ctx.server.inject({
      method: 'POST',
      path: '/substrate/v1/plugins/p/bump',
      headers: { authorization: `Bearer ${readToken}`, 'content-type': 'application/json' },
      body: Buffer.from('{}')
    });
    expect(forbidden.status).toBe(403);

    const mutateToken = mkToken({ capabilities: ['mutate'], ns: ['*'] });
    const ok = await ctx.server.inject({
      method: 'POST',
      path: '/substrate/v1/plugins/p/bump',
      headers: { authorization: `Bearer ${mutateToken}`, 'content-type': 'application/json' },
      body: Buffer.from('{}')
    });
    expect(ok.status).toBe(200);
  });
});

describe('apps/substrate § per-frame namespace gate', () => {
  let ctx: AuthServerCtx | null = null;

  afterEach(async () => {
    if (ctx !== null) {
      await ctx.composed.stop();
      ctx = null;
    }
  });

  function makeClaudePlugin(): CoordinatorPlugin {
    return {
      name: 'claude',
      contractVersion: '*',
      namespaces: [
        {
          namespace: 'claude',
          install: (installCtx): void => {
            installAutoCrud(installCtx.registry, 'Todo', installCtx.dataset, installCtx.edges, {
              fields: {
                id: { kind: 'scalar', type: 'string', indexed: true },
                title: { kind: 'scalar', type: 'string', indexed: true }
              }
            });
          }
        }
      ]
    };
  }

  function makeSentinelPlugin(): CoordinatorPlugin {
    return {
      name: 'sentinel',
      contractVersion: '*',
      namespaces: [
        {
          namespace: 'sentinel',
          install: (installCtx): void => {
            installAutoCrud(
              installCtx.registry,
              'Coordinator',
              installCtx.dataset,
              installCtx.edges,
              {
                fields: {
                  id: { kind: 'scalar', type: 'string', indexed: true },
                  label: { kind: 'scalar', type: 'string', indexed: true }
                }
              }
            );
          }
        }
      ]
    };
  }

  function makeDefaultPlugin(): CoordinatorPlugin {
    return {
      name: 'default-todos',
      contractVersion: '*',
      namespaces: [
        {
          namespace: 'default',
          install: (installCtx): void => {
            installAutoCrud(installCtx.registry, 'Todo', installCtx.dataset, installCtx.edges, {
              fields: {
                id: { kind: 'scalar', type: 'string', indexed: true },
                title: { kind: 'scalar', type: 'string', indexed: true }
              }
            });
          }
        }
      ]
    };
  }

  async function mkMultiNsServer(): Promise<AuthServerCtx> {
    const server = new MemorySubstrateServer();
    const dataset = new MemoryDataset({ namespace: 'default' });
    const claudeDs = new MemoryDataset({ namespace: 'claude' });
    const sentinelDs = new MemoryDataset({ namespace: 'sentinel' });
    const composed = await compose({
      systemActor: 'test',
      server,
      dataset,
      datasets: { claude: claudeDs, sentinel: sentinelDs },
      coordinators: [makeDefaultPlugin(), makeClaudePlugin(), makeSentinelPlugin()],
      auth: authCfg,
      streamTicketSecret: 'test-stream-ticket-secret'
    });
    await server.start();
    return { server, composed };
  }

  it('claude-scoped token resolves claude/Todo but errors on sentinel/Coordinator', async () => {
    ctx = await mkMultiNsServer();
    const token = mkToken({ capabilities: ['read'], ns: ['claude'] });
    const res = await ctx.server.inject({
      method: 'POST',
      path: '/substrate/v1/query',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json'
      },
      body: Buffer.from(
        JSON.stringify({
          'claude/Todo': { params: { limit: 5 }, fields: { id: true, title: true } },
          'sentinel/Coordinator': { params: { limit: 5 }, fields: { id: true, label: true } }
        })
      )
    });
    expect(res.status).toBe(200);
    const env = jsonBody<PackEnvelope>(res);
    // claude key resolves to an empty list (no rows inserted)
    expect(env.data['claude/Todo']).toEqual([]);
    // sentinel key is missing from data (errored) — error surfaces in envelope.errors
    expect(env.data['sentinel/Coordinator']).toBeUndefined();
    const sentinelErr = (env.errors ?? []).find(
      (e) => Array.isArray(e.path) && e.path[0] === 'sentinel/Coordinator'
    );
    expect(sentinelErr?.code).toBe('unauthorized_namespace');
  });

  it('wildcard token (ns=[*]) passes any namespace', async () => {
    ctx = await mkMultiNsServer();
    const token = mkToken({ capabilities: ['read'], ns: ['*'] });
    const res = await ctx.server.inject({
      method: 'POST',
      path: '/substrate/v1/query',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json'
      },
      body: Buffer.from(
        JSON.stringify({
          'claude/Todo': { params: { limit: 5 }, fields: { id: true, title: true } },
          'sentinel/Coordinator': { params: { limit: 5 }, fields: { id: true, label: true } }
        })
      )
    });
    const env = jsonBody<PackEnvelope>(res);
    expect(env.data['claude/Todo']).toEqual([]);
    expect(env.data['sentinel/Coordinator']).toEqual([]);
    expect(env.errors).toBeUndefined();
  });

  it('default-only token resolves default/* but is rejected for claude/*', async () => {
    ctx = await mkMultiNsServer();
    const token = mkToken({ capabilities: ['read'], ns: ['default'] });
    const res = await ctx.server.inject({
      method: 'POST',
      path: '/substrate/v1/query',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json'
      },
      body: Buffer.from(
        JSON.stringify({
          'default/Todo': { params: { limit: 5 }, fields: { id: true } },
          'claude/Todo': { params: { limit: 5 }, fields: { id: true } }
        })
      )
    });
    const env = jsonBody<PackEnvelope>(res);
    expect(env.data['default/Todo']).toBeDefined();
    const claudeErr = (env.errors ?? []).find(
      (e) => Array.isArray(e.path) && e.path[0] === 'claude/Todo'
    );
    expect(claudeErr?.code).toBe('unauthorized_namespace');
  });
});

describe('apps/substrate § WS per-frame namespace gate', () => {
  let ctx: AuthServerCtx | null = null;

  afterEach(async () => {
    if (ctx !== null) {
      await ctx.composed.stop();
      ctx = null;
    }
  });

  it('rejects a subscribe frame targeting a namespace the token is not scoped to; connection stays open', async () => {
    const claude: CoordinatorPlugin = {
      name: 'claude',
      contractVersion: '*',
      namespaces: [
        {
          namespace: 'claude',
          install: (installCtx): void => {
            installAutoCrud(installCtx.registry, 'Todo', installCtx.dataset, installCtx.edges, {
              fields: {
                id: { kind: 'scalar', type: 'string', indexed: true },
                title: { kind: 'scalar', type: 'string', indexed: true }
              }
            });
          }
        }
      ]
    };
    const sentinel: CoordinatorPlugin = {
      name: 'sentinel',
      contractVersion: '*',
      namespaces: [
        {
          namespace: 'sentinel',
          install: (installCtx): void => {
            installAutoCrud(
              installCtx.registry,
              'Coordinator',
              installCtx.dataset,
              installCtx.edges,
              {
                fields: {
                  id: { kind: 'scalar', type: 'string', indexed: true }
                }
              }
            );
          }
        }
      ]
    };
    const server = new MemorySubstrateServer();
    const dataset = new MemoryDataset({ namespace: 'default' });
    const claudeDs = new MemoryDataset({ namespace: 'claude' });
    const sentinelDs = new MemoryDataset({ namespace: 'sentinel' });
    const composed = await compose({
      systemActor: 'test',
      server,
      dataset,
      datasets: { claude: claudeDs, sentinel: sentinelDs },
      coordinators: [claude, sentinel],
      auth: authCfg,
      streamTicketSecret: 'test-stream-ticket-secret'
    });
    await server.start();
    ctx = { server, composed };

    const token = mkToken({ capabilities: ['read'], ns: ['claude'] });
    const client = server.connectWebsocket('/substrate/v1/ws', {
      authorization: `Bearer ${token}`
    });
    const frames: Array<WsResponseFrame> = [];
    client.onMessage((buf) => {
      frames.push(JSON.parse(buf.toString('utf8')) as WsResponseFrame);
    });
    await new Promise((r) => setImmediate(r));

    // Frame 1: target sentinel — should get an unauthorized_namespace error.
    client.send(
      Buffer.from(
        JSON.stringify({
          id: 'sub-1',
          op: 'subscribe',
          frame: {
            'sentinel/Coordinator': { params: {}, fields: { id: true } }
          }
        })
      )
    );
    await new Promise((r) => setTimeout(r, 20));
    const errFrame = frames.find((f) => f.id === 'sub-1' && f.kind === 'error');
    expect(errFrame).toBeDefined();
    expect(errFrame?.errors?.[0]?.code).toBe('unauthorized_namespace');

    // Frame 2: target claude — should succeed (snapshot with empty data).
    frames.length = 0;
    client.send(
      Buffer.from(
        JSON.stringify({
          id: 'sub-2',
          op: 'subscribe',
          frame: {
            'claude/Todo': { params: {}, fields: { id: true } }
          }
        })
      )
    );
    await new Promise((r) => setTimeout(r, 20));
    const snapshot = frames.find((f) => f.id === 'sub-2' && f.kind === 'snapshot');
    expect(snapshot).toBeDefined();
    const snapshotData = snapshot?.data as Record<string, unknown> | undefined;
    expect(snapshotData?.['claude/Todo']).toEqual([]);

    client.close(1000);
  });
});

describe('sdk/policy § requireNamespace', () => {
  function makeCtx(identity: Identity | null): RequestContext {
    return {
      identity,
      namespace: 'default',
      operation: 'query',
      now: new Date(),
      headers: {},
      meta: {}
    };
  }
  const emptyArgs: ResolverArgs = {};

  it('allows when the identity grant covers the requested namespace', () => {
    const policy = requireNamespace('claude');
    const decision = policy(
      makeCtx({ id: 'a', grants: { claude: ['read'], sentinel: ['read'] } }),
      emptyArgs
    );
    expect(decision).toEqual({ allow: true });
  });

  it('allows when the grant contains the wildcard', () => {
    const policy = requireNamespace('anything-goes');
    const decision = policy(makeCtx({ id: 'a', grants: { '*': ['read'] } }), emptyArgs);
    expect(decision).toEqual({ allow: true });
  });

  it('denies when the grant does not cover the requested namespace', () => {
    const policy = requireNamespace('claude');
    const decision = policy(makeCtx({ id: 'a', grants: { default: ['read'] } }), emptyArgs);
    expect(decision.allow).toBe(false);
    if (!decision.allow) {
      expect(decision.reason).toMatch(/not in allowed namespaces/);
    }
  });

  it('denies when identity is null', () => {
    const policy = requireNamespace('claude');
    const decision = policy(makeCtx(null), emptyArgs);
    expect(decision.allow).toBe(false);
    if (!decision.allow) expect(decision.reason).toMatch(/no identity/);
  });

  it('composes with requireCapability via and — both must hold', () => {
    const policy = and(requireCapability('mutate'), requireNamespace('claude'));
    // Has capability + namespace → allow. (The grant must cover the CTX
    // namespace for the capability half AND 'claude' for the namespace half —
    // requireCapability is namespace-aware.)
    expect(
      policy(makeCtx({ id: 'a', grants: { default: ['mutate'], claude: ['read'] } }), emptyArgs)
    ).toEqual({ allow: true });
    // Missing capability → deny.
    const denyCap = policy(makeCtx({ id: 'a', grants: { default: ['read'] } }), emptyArgs);
    expect(denyCap.allow).toBe(false);
    // Wrong namespace → deny.
    const denyNs = policy(makeCtx({ id: 'a', grants: { sentinel: ['mutate'] } }), emptyArgs);
    expect(denyNs.allow).toBe(false);
  });
});

// ── withAuth attribute-mode branch ────────────────────────────────────

describe('apps/substrate § withAuth attribute mode', () => {
  let ctx: { server: MemorySubstrateServer; composed: ComposeResult } | null = null;

  afterEach(async () => {
    if (ctx !== null) {
      await ctx.composed.stop();
      ctx = null;
    }
  });

  async function mkAttributeServer(): Promise<{
    server: MemorySubstrateServer;
    composed: ComposeResult;
    agentJwt: string;
    attrCfg: AuthConfig;
  }> {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const pubPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const kid = 'test-agent';
    const attrCfg: AuthConfig = {
      keys: [{ kid, alg: 'EdDSA', publicKey: pubPem, kind: 'agent' }],
      mode: 'attribute'
    };
    const server = new MemorySubstrateServer();
    const dataset = new MemoryDataset({ namespace: 'default' });
    const composed = await compose({
      systemActor: 'test',
      server,
      dataset,
      coordinators: [fixturePlugin],
      auth: attrCfg,
      streamTicketSecret: 'test-stream-ticket-secret'
    });
    await server.start();
    const now = Math.floor(Date.now() / 1000);
    const agentJwt = signEdDSA(
      { sub: kid, iat: now, exp: now + 300, ns: ['*'], capabilities: ['read', 'mutate'] },
      privateKey,
      { kid }
    );
    return { server, composed, agentJwt, attrCfg };
  }

  it('attribute mode: anonymous MUTATE is refused — attribute means anonymous reads, never anonymous writes', async () => {
    const { server, composed } = await mkAttributeServer();
    ctx = { server, composed };
    const res = await server.inject({
      method: 'POST',
      path: '/substrate/v1/mutate',
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(
        JSON.stringify({
          'default/createTodo': {
            params: { title: 'anon-task', priority: 0 },
            fields: { id: true }
          }
        })
      )
    });
    expect(res.status).toBe(401);
  });

  it('attribute mode: anonymous READ is still allowed — the reads-open posture is preserved', async () => {
    const { server, composed } = await mkAttributeServer();
    ctx = { server, composed };
    const res = await server.inject({
      method: 'POST',
      path: '/substrate/v1/query',
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(JSON.stringify({ 'default/Todo': { params: {}, fields: { id: true } } }))
    });
    expect(res.status).toBe(200);
  });

  it('attribute mode: anonymous admin route is still 401', async () => {
    const { server, composed } = await mkAttributeServer();
    ctx = { server, composed };
    const res = await server.inject({
      method: 'POST',
      path: '/substrate/v1/_system/invites',
      headers: { 'content-type': 'application/json' },
      body: Buffer.from('{}')
    });
    expect(res.status).toBe(401);
  });

  it('attribute mode: invalid token is 401 (present-but-bad)', async () => {
    const { server, composed } = await mkAttributeServer();
    ctx = { server, composed };
    const res = await server.inject({
      method: 'POST',
      path: '/substrate/v1/query',
      headers: { 'content-type': 'application/json', authorization: 'Bearer not.a.jwt' },
      body: Buffer.from(JSON.stringify({ 'default/Todo': { params: {}, fields: { id: true } } }))
    });
    expect(res.status).toBe(401);
  });

  it('attribute mode: valid agent token is accepted and attributes as agent', async () => {
    const { server, composed, agentJwt } = await mkAttributeServer();
    ctx = { server, composed };
    const mutateRes = await server.inject({
      method: 'POST',
      path: '/substrate/v1/mutate',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${agentJwt}` },
      body: Buffer.from(
        JSON.stringify({
          'default/createTodo': {
            params: { title: 'agent-task', priority: 0 },
            fields: { id: true }
          }
        })
      )
    });
    expect(mutateRes.status).toBe(200);

    const mutateEnv = jsonBody<PackEnvelope>(mutateRes);
    const created = mutateEnv.data['default/createTodo'] as { id: string };
    const todoId = created.id;

    const queryRes = await server.inject({
      method: 'POST',
      path: '/substrate/v1/query',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${agentJwt}` },
      body: Buffer.from(
        JSON.stringify({
          'default/Todo': {
            params: { where: { id: { eq: todoId } } },
            fields: { id: true, _metadata: true }
          }
        })
      )
    });
    expect(queryRes.status).toBe(200);

    const queryEnv = jsonBody<PackEnvelope>(queryRes);
    const rows = queryEnv.data['default/Todo'] as Array<{
      id: string;
      _metadata: { createdBy: { kind: string; id: string } };
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!._metadata.createdBy).toEqual({ kind: 'agent', id: 'test-agent' });
  });
});

// ── attribute-mode parity across MemorySubstrateServer + FastifySubstrateServer ──
//
// Proves that attribute-mode behaves identically on both transports.
// Each server is composed independently with the same auth config so the
// assertion is transport-only (no shared state leaks between the two).

interface AttributeHarness {
  server: SubstrateServer & { inject: NonNullable<SubstrateServer['inject']> };
  composed: ComposeResult;
  teardown: () => Promise<void>;
}

async function mkAttributeHarness(
  makeServer: () => SubstrateServer & { inject: NonNullable<SubstrateServer['inject']> },
  startOpts?: { host: string; port: number }
): Promise<AttributeHarness> {
  const { publicKey } = generateKeyPairSync('ed25519');
  const pubPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const attrCfg: AuthConfig = {
    keys: [{ kid: 'parity-agent', alg: 'EdDSA', publicKey: pubPem, kind: 'agent' }],
    mode: 'attribute'
  };
  const server = makeServer();
  const dataset = new MemoryDataset({ namespace: 'default' });
  const composed = await compose({
    systemActor: 'test',
    server,
    dataset,
    coordinators: [fixturePlugin],
    auth: attrCfg,
    streamTicketSecret: 'test-stream-ticket-secret'
  });
  if (startOpts !== undefined) {
    await (server as FastifySubstrateServer).start(startOpts);
  } else {
    await (server as MemorySubstrateServer).start();
  }
  return {
    server,
    composed,
    teardown: () => composed.stop()
  };
}

async function scenarioAttributeModeAnonymous(harness: AttributeHarness): Promise<void> {
  // No bearer token. `attribute` admits anonymous READS and refuses anonymous
  // WRITES, and both transports must agree — a mode that means one thing over
  // fastify and another in-process is worse than either behaviour on its own.
  const write = await harness.server.inject({
    method: 'POST',
    path: '/substrate/v1/mutate',
    headers: { 'content-type': 'application/json' },
    body: Buffer.from(
      JSON.stringify({
        'default/createTodo': {
          params: { title: 'anon-parity', priority: 0 },
          fields: { id: true }
        }
      })
    )
  });
  expect(write.status).toBe(401);

  // The other half of the contract, asserted in the same scenario so a fix that
  // closed writes by closing everything could not pass this suite.
  const read = await harness.server.inject({
    method: 'POST',
    path: '/substrate/v1/query',
    headers: { 'content-type': 'application/json' },
    body: Buffer.from(JSON.stringify({ 'default/Todo': { params: {}, fields: { id: true } } }))
  });
  expect(read.status).toBe(200);
}

interface TransportEntry {
  readonly name: string;
  readonly build: () => AttributeHarness | Promise<AttributeHarness>;
}

const ATTRIBUTE_SERVERS: Array<TransportEntry> = [
  {
    name: 'memory',
    build: () =>
      mkAttributeHarness(
        () =>
          new MemorySubstrateServer() as MemorySubstrateServer & {
            inject: NonNullable<SubstrateServer['inject']>;
          }
      )
  },
  {
    name: 'fastify',
    build: () =>
      mkAttributeHarness(
        () =>
          new FastifySubstrateServer() as FastifySubstrateServer & {
            inject: NonNullable<SubstrateServer['inject']>;
          },
        { host: '127.0.0.1', port: 0 }
      )
  }
];

for (const { name, build } of ATTRIBUTE_SERVERS) {
  describe(`§attribute-mode parity: ${name}`, () => {
    let harness: AttributeHarness;

    beforeEach(async () => {
      harness = await build();
    });

    afterEach(async () => {
      await harness.teardown();
    });

    it('attribute-mode: anonymous write refused, anonymous read allowed (no token)', async () => {
      await scenarioAttributeModeAnonymous(harness);
    });
  });
}

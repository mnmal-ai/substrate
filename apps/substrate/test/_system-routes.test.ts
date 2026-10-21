/**
 * `_system` admin + register route tests (spec §5.12).
 *
 * Coverage:
 *   - POST /substrate/v1/_system/invites — admin gate, body validation, ttl band.
 *   - POST /substrate/v1/_system/register — happy path, race safety, bad algorithm,
 *     PEM parse failures, expired / missing / consumed invites, rate limiter.
 *   - End-to-end: mint invite → register → sign JWT with the returned kid →
 *     the binary honours the new identity.
 */

import { generateKeyPairSync } from 'node:crypto';
import {
  type AuthConfig,
  type ComposeResult,
  compose,
  createRateLimiter,
  INVITE_TYPE,
  KEY_TYPE,
  type RateLimiter,
  SYSTEM_NAMESPACE,
  signEdDSA,
  signHs256
} from '@mnmal-ai/substrate-compose';
import { MemoryDataset } from '@mnmal-ai/substrate-dataset-memory';
import { MemorySubstrateServer } from '@mnmal-ai/substrate-server-memory';
import type { PackEnvelope, SubstrateResponse } from '@mnmal-ai/substrate-types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fixturePlugin } from './_fixtures/fixture-plugin.js';

const ADMIN_CAP = 'admin';
const SECRET = 'dispatch-b-secret';
const FILE_KID = 'file-k1';

const authCfg: AuthConfig = {
  keys: [{ kid: FILE_KID, alg: 'HS256', publicKey: SECRET }],
  adminCapability: ADMIN_CAP
};

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

function mkFileToken(claims: Record<string, unknown>): string {
  const now = Math.floor(Date.now() / 1000);
  return signHs256({ sub: 'tester', exp: now + 60, ...claims }, SECRET, { kid: FILE_KID });
}

function adminToken(): string {
  return mkFileToken({ capabilities: [ADMIN_CAP, 'read', 'mutate'], ns: ['*'] });
}

function nonAdminToken(): string {
  return mkFileToken({ capabilities: ['read', 'mutate'], ns: ['*'] });
}

interface Ctx {
  server: MemorySubstrateServer;
  composed: ComposeResult;
  substrateDataset: MemoryDataset;
  rateLimiter: RateLimiter;
}

async function mkServer(overrides: { rateLimiter?: RateLimiter } = {}): Promise<Ctx> {
  const server = new MemorySubstrateServer();
  const dataset = new MemoryDataset({ namespace: 'default' });
  const substrateDataset = new MemoryDataset({ namespace: SYSTEM_NAMESPACE });
  const rateLimiter =
    overrides.rateLimiter ?? createRateLimiter({ maxRequests: 100, windowMs: 60_000 });
  const composed = await compose({
    systemActor: 'test',
    server,
    dataset,
    datasets: { [SYSTEM_NAMESPACE]: substrateDataset },
    auth: authCfg,
    streamTicketSecret: 'test-stream-ticket-secret',
    registerRateLimiter: rateLimiter,
    coordinators: [fixturePlugin]
  });
  await server.start();
  return { server, composed, substrateDataset, rateLimiter };
}

async function post(
  ctx: Ctx,
  path: string,
  body: unknown,
  extraHeaders: Record<string, string> = {}
): Promise<SubstrateResponse> {
  return ctx.server.inject({
    method: 'POST',
    path,
    headers: { 'content-type': 'application/json', ...extraHeaders },
    body: Buffer.from(JSON.stringify(body))
  });
}

async function postAdmin(
  ctx: Ctx,
  path: string,
  body: unknown,
  extraHeaders: Record<string, string> = {}
): Promise<SubstrateResponse> {
  return post(ctx, path, body, { authorization: `Bearer ${adminToken()}`, ...extraHeaders });
}

function edPem(): { publicKeyPem: string; privateKeyPem: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
  };
}

function rsaPem(): string {
  const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return publicKey.export({ type: 'spki', format: 'pem' }).toString();
}

// ---------------------------------------------------------------------------
// POST /substrate/v1/_system/invites
// ---------------------------------------------------------------------------

describe('POST /substrate/v1/_system/invites', () => {
  let ctx: Ctx | null = null;
  afterEach(async () => {
    if (ctx !== null) {
      await ctx.composed.stop();
      ctx = null;
    }
  });

  it('admin + valid body → 201 with code, expiresAt, namespaces, capabilities', async () => {
    ctx = await mkServer();
    const res = await postAdmin(ctx, '/substrate/v1/_system/invites', {
      namespaces: ['default', 'other'],
      capabilities: ['read'],
      ttlMs: 3600_000,
      allowUnknownNs: true
    });
    expect(res.status).toBe(201);
    const body = jsonBody<{
      code: string;
      expiresAt: string;
      namespaces: Array<string>;
      capabilities: Array<string>;
    }>(res);
    expect(body.code.length).toBeGreaterThan(20);
    expect(body.namespaces).toEqual(['default', 'other']);
    expect(body.capabilities).toEqual(['read']);
    // expiresAt must parse to a future timestamp.
    expect(new Date(body.expiresAt).getTime()).toBeGreaterThan(Date.now());

    // Invite row persisted under the returned code.
    const inviteRead = await ctx.substrateDataset.read(INVITE_TYPE, { id: body.code });
    expect(inviteRead.rows).toHaveLength(1);
  });

  it('non-admin → 403', async () => {
    ctx = await mkServer();
    const res = await post(
      ctx,
      '/substrate/v1/_system/invites',
      { namespaces: ['default'], capabilities: ['read'] },
      { authorization: `Bearer ${nonAdminToken()}` }
    );
    expect(res.status).toBe(403);
  });

  it('missing body → 400', async () => {
    ctx = await mkServer();
    const res = await ctx.server.inject({
      method: 'POST',
      path: '/substrate/v1/_system/invites',
      headers: {
        authorization: `Bearer ${adminToken()}`,
        'content-type': 'application/json'
      },
      body: Buffer.alloc(0)
    });
    expect(res.status).toBe(400);
    const body = jsonBody<{ code: string }>(res);
    expect(body.code).toBe('invalid_body');
  });

  it('empty namespaces → 400', async () => {
    ctx = await mkServer();
    const res = await postAdmin(ctx, '/substrate/v1/_system/invites', {
      namespaces: [],
      capabilities: ['read']
    });
    expect(res.status).toBe(400);
    expect(jsonBody<{ code: string }>(res).code).toBe('invalid_namespaces');
  });

  it('ttlMs greater than 30 days → 400', async () => {
    ctx = await mkServer();
    const thirtyOneDays = 31 * 86_400_000;
    const res = await postAdmin(ctx, '/substrate/v1/_system/invites', {
      namespaces: ['default'],
      capabilities: ['read'],
      ttlMs: thirtyOneDays
    });
    expect(res.status).toBe(400);
    expect(jsonBody<{ code: string }>(res).code).toBe('invalid_ttl');
  });

  it('runs the POST /keys grant checks: admin opt-in, entry syntax, hosted namespaces', async () => {
    ctx = await mkServer();
    const mint = (body: Record<string, unknown>) =>
      postAdmin(ctx as Ctx, '/substrate/v1/_system/invites', body);
    const admin = await mint({ namespaces: ['default'], capabilities: ['admin'] });
    expect([admin.status, jsonBody<{ code: string }>(admin).code]).toEqual([
      400,
      'admin_requires_opt_in'
    ]);
    expect(
      (await mint({ namespaces: ['default'], capabilities: ['admin'], allowAdmin: true })).status
    ).toBe(201);
    const entry = await mint({ namespaces: ['default:'], capabilities: ['read'] });
    expect(jsonBody<{ code: string }>(entry).code).toBe('invalid_grant_entry');
    const unhosted = await mint({ namespaces: ['nosuchns'], capabilities: ['read'] });
    expect([unhosted.status, jsonBody<{ code: string }>(unhosted).code]).toEqual([
      422,
      'unknown_namespaces'
    ]);
  });

  it('ttlMs omitted → 24h default', async () => {
    ctx = await mkServer();
    const res = await postAdmin(ctx, '/substrate/v1/_system/invites', {
      namespaces: ['default'],
      capabilities: ['read']
    });
    expect(res.status).toBe(201);
    const body = jsonBody<{ expiresAt: string }>(res);
    const delta = new Date(body.expiresAt).getTime() - Date.now();
    // Default is 24h; allow generous slack for test wall-clock jitter.
    expect(delta).toBeGreaterThan(23 * 3600_000);
    expect(delta).toBeLessThanOrEqual(25 * 3600_000);
  });
});

// ---------------------------------------------------------------------------
// POST /substrate/v1/_system/register
// ---------------------------------------------------------------------------

async function mintInvite(
  ctx: Ctx,
  body: {
    namespaces: Array<string>;
    capabilities: Array<string>;
    ttlMs?: number;
    allowUnknownNs?: boolean;
  } = {
    namespaces: ['default'],
    capabilities: ['read']
  }
): Promise<string> {
  const res = await postAdmin(ctx, '/substrate/v1/_system/invites', body);
  expect(res.status).toBe(201);
  return jsonBody<{ code: string }>(res).code;
}

describe('POST /substrate/v1/_system/register — happy path + validation', () => {
  let ctx: Ctx | null = null;
  afterEach(async () => {
    if (ctx !== null) {
      await ctx.composed.stop();
      ctx = null;
    }
  });

  it('mint invite, register with matching Ed25519 key → 201 + kid, Key row, invite consumed', async () => {
    ctx = await mkServer();
    const code = await mintInvite(ctx);
    const { publicKeyPem } = edPem();
    const res = await post(ctx, '/substrate/v1/_system/register', {
      code,
      publicKey: publicKeyPem,
      keyName: 'my-laptop',
      algorithm: 'EdDSA'
    });
    expect(res.status).toBe(201);
    const body = jsonBody<{ kid: string; namespaces: Array<string>; capabilities: Array<string> }>(
      res
    );
    expect(body.kid).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(body.namespaces).toEqual(['default']);
    expect(body.capabilities).toEqual(['read']);

    // Row id must be a UUID (constraint-safe); kid is stored in the kid field.
    const keyRows = await ctx.substrateDataset.read(KEY_TYPE, {
      where: { kid: { eq: body.kid } }
    });
    expect(keyRows.rows).toHaveLength(1);
    const keyRow = keyRows.rows[0] as Record<string, unknown>;
    expect(keyRow?.algorithm).toBe('EdDSA');
    // Row id is a UUID, not the kid.
    expect(typeof keyRow?.id).toBe('string');
    expect(keyRow?.id as string).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    );
    expect(keyRow?.id).not.toBe(body.kid);
    // kid field holds the principal identifier returned in the response.
    expect(keyRow?.kid).toBe(body.kid);

    const inviteRows = await ctx.substrateDataset.read(INVITE_TYPE, { id: code });
    const invite = inviteRows.rows[0];
    expect(invite?.consumedBy).toBe(body.kid);
    expect(invite?.consumedAt).toBeDefined();
  });

  it('invalid code → 400 invite_not_found', async () => {
    ctx = await mkServer();
    const { publicKeyPem } = edPem();
    const res = await post(ctx, '/substrate/v1/_system/register', {
      code: 'not-a-real-code',
      publicKey: publicKeyPem,
      keyName: 'x',
      algorithm: 'EdDSA'
    });
    expect(res.status).toBe(400);
    expect(jsonBody<{ code: string }>(res).code).toBe('invite_not_found');
  });

  it('already-consumed invite → 409 invite_already_consumed', async () => {
    ctx = await mkServer();
    const code = await mintInvite(ctx);
    const { publicKeyPem } = edPem();
    await post(ctx, '/substrate/v1/_system/register', {
      code,
      publicKey: publicKeyPem,
      keyName: 'first',
      algorithm: 'EdDSA'
    });
    const res = await post(ctx, '/substrate/v1/_system/register', {
      code,
      publicKey: publicKeyPem,
      keyName: 'second',
      algorithm: 'EdDSA'
    });
    expect(res.status).toBe(409);
    expect(jsonBody<{ code: string }>(res).code).toBe('invite_already_consumed');
  });

  it('expired invite → 410 invite_expired', async () => {
    ctx = await mkServer();
    // Seed an expired invite directly so we don't need to sleep.
    await ctx.substrateDataset.write(INVITE_TYPE, [
      {
        id: 'expired-code',
        namespaces: 'default',
        capabilities: 'read',
        expiresAt: new Date(Date.now() - 60_000),
        consumedAt: null,
        consumedBy: null
      }
    ]);
    const { publicKeyPem } = edPem();
    const res = await post(ctx, '/substrate/v1/_system/register', {
      code: 'expired-code',
      publicKey: publicKeyPem,
      keyName: 'late',
      algorithm: 'EdDSA'
    });
    expect(res.status).toBe(410);
    expect(jsonBody<{ code: string }>(res).code).toBe('invite_expired');
  });

  it('algorithm mismatches PEM type → 400 key_algorithm_mismatch', async () => {
    ctx = await mkServer();
    const code = await mintInvite(ctx);
    const rsaPublicKeyPem = rsaPem();
    const res = await post(ctx, '/substrate/v1/_system/register', {
      code,
      publicKey: rsaPublicKeyPem,
      keyName: 'mismatch',
      algorithm: 'EdDSA'
    });
    expect(res.status).toBe(400);
    expect(jsonBody<{ code: string }>(res).code).toBe('key_algorithm_mismatch');
  });

  it('HS256 → 400 hmac_not_allowed', async () => {
    ctx = await mkServer();
    const code = await mintInvite(ctx);
    const res = await post(ctx, '/substrate/v1/_system/register', {
      code,
      publicKey: 'fake',
      keyName: 'sym',
      algorithm: 'HS256'
    });
    expect(res.status).toBe(400);
    expect(jsonBody<{ code: string }>(res).code).toBe('hmac_not_allowed');
  });

  it('malformed PEM → 400 invalid_public_key', async () => {
    ctx = await mkServer();
    const code = await mintInvite(ctx);
    const res = await post(ctx, '/substrate/v1/_system/register', {
      code,
      publicKey: '-----BEGIN PUBLIC KEY-----\nnot-a-real-key\n-----END PUBLIC KEY-----\n',
      keyName: 'bad-pem',
      algorithm: 'EdDSA'
    });
    expect(res.status).toBe(400);
    expect(jsonBody<{ code: string }>(res).code).toBe('invalid_public_key');
  });

  it('concurrent registrations on the same code → exactly one succeeds, the other 409s', async () => {
    ctx = await mkServer();
    const code = await mintInvite(ctx);
    const a = edPem();
    const b = edPem();
    const [resA, resB] = await Promise.all([
      post(ctx, '/substrate/v1/_system/register', {
        code,
        publicKey: a.publicKeyPem,
        keyName: 'a',
        algorithm: 'EdDSA'
      }),
      post(ctx, '/substrate/v1/_system/register', {
        code,
        publicKey: b.publicKeyPem,
        keyName: 'b',
        algorithm: 'EdDSA'
      })
    ]);
    const successes = [resA, resB].filter((r) => r.status === 201);
    const conflicts = [resA, resB].filter((r) => r.status === 409);
    expect(successes).toHaveLength(1);
    expect(conflicts).toHaveLength(1);
    const conflictRes = conflicts[0];
    if (conflictRes === undefined) throw new Error('expected exactly one 409');
    expect(jsonBody<{ code: string }>(conflictRes).code).toBe('invite_already_consumed');

    // Exactly one Key landed for this invite.
    const invite = (await ctx.substrateDataset.read(INVITE_TYPE, { id: code })).rows[0];
    expect(invite?.consumedBy).toBeDefined();
    const allKeys = await ctx.substrateDataset.read(KEY_TYPE, {});
    expect(allKeys.rows).toHaveLength(1);
  });
});

describe('POST /substrate/v1/_system/register — end-to-end + intersection', () => {
  let ctx: Ctx | null = null;
  afterEach(async () => {
    if (ctx !== null) {
      await ctx.composed.stop();
      ctx = null;
    }
  });

  it('end-to-end: mint → register → sign a JWT with the returned kid → /substrate/v1/query succeeds', async () => {
    ctx = await mkServer();
    const code = await mintInvite(ctx);
    const { publicKeyPem, privateKeyPem } = edPem();
    const regRes = await post(ctx, '/substrate/v1/_system/register', {
      code,
      publicKey: publicKeyPem,
      keyName: 'e2e',
      algorithm: 'EdDSA'
    });
    expect(regRes.status).toBe(201);
    const { kid } = jsonBody<{ kid: string }>(regRes);

    const token = signEdDSA(
      {
        sub: 'e2e',
        exp: Math.floor(Date.now() / 1000) + 60,
        capabilities: ['read'],
        ns: ['default']
      },
      privateKeyPem,
      { kid }
    );
    const queryRes = await ctx.server.inject({
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
    expect(queryRes.status).toBe(200);
  });

  it('claim vs row intersection: JWT claims more namespaces than the invite granted → stripped', async () => {
    ctx = await mkServer();
    // Mint an invite scoped to ONLY 'default'.
    const code = await mintInvite(ctx, {
      namespaces: ['default'],
      capabilities: ['read']
    });
    const { publicKeyPem, privateKeyPem } = edPem();
    const regRes = await post(ctx, '/substrate/v1/_system/register', {
      code,
      publicKey: publicKeyPem,
      keyName: 'intersected',
      algorithm: 'EdDSA'
    });
    expect(regRes.status).toBe(201);
    const { kid } = jsonBody<{ kid: string }>(regRes);

    // Token over-claims: asks for 'default' + 'other'. Intersection should
    // leave only 'default' — asking for something in the `other` namespace is
    // rejected at the per-frame gate.
    const token = signEdDSA(
      {
        sub: 'greedy',
        exp: Math.floor(Date.now() / 1000) + 60,
        capabilities: ['read'],
        ns: ['default', 'other']
      },
      privateKeyPem,
      { kid }
    );
    const res = await ctx.server.inject({
      method: 'POST',
      path: '/substrate/v1/query',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json'
      },
      body: Buffer.from(
        JSON.stringify({
          'default/Todo': { params: { limit: 1 }, fields: { id: true } },
          'other/Thing': { params: { limit: 1 }, fields: { id: true } }
        })
      )
    });
    expect(res.status).toBe(200);
    const env = jsonBody<PackEnvelope>(res);
    // `default/Todo` succeeds (no errors for that key).
    const defaultErr = (env.errors ?? []).find((e) => e.path?.[0] === 'default/Todo');
    expect(defaultErr).toBeUndefined();
    // `other/Thing` is stripped from the authorised ns list → unauthorized.
    const otherErr = (env.errors ?? []).find((e) => e.path?.[0] === 'other/Thing');
    expect(otherErr?.code).toBe('unauthorized_namespace');
  });
});

// ---------------------------------------------------------------------------
// Rate limiter integration
// ---------------------------------------------------------------------------

describe('POST /substrate/v1/_system/register — rate limiter', () => {
  let ctx: Ctx | null = null;
  let limiter: RateLimiter;

  beforeEach(() => {
    limiter = createRateLimiter({ maxRequests: 2, windowMs: 60_000 });
  });

  afterEach(async () => {
    limiter.dispose();
    if (ctx !== null) {
      await ctx.composed.stop();
      ctx = null;
    }
  });

  it('over-quota request from the same IP → 429 with Retry-After header', async () => {
    ctx = await mkServer({ rateLimiter: limiter });
    const headers = { 'x-forwarded-for': '203.0.113.7' };
    // Fire two successful (bad-body, but counted) requests — the rate limiter
    // runs before body validation, so even malformed bodies count.
    for (let i = 0; i < 2; i++) {
      await post(ctx, '/substrate/v1/_system/register', { code: 'x' }, headers);
    }
    const res = await post(ctx, '/substrate/v1/_system/register', { code: 'x' }, headers);
    expect(res.status).toBe(429);
    const body = jsonBody<{ code: string; retryAfterMs: number }>(res);
    expect(body.code).toBe('rate_limited');
    expect(body.retryAfterMs).toBeGreaterThan(0);
    expect(res.headers?.['retry-after']).toBeDefined();
    expect(Number.parseInt(res.headers?.['retry-after'] ?? '0', 10)).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// GET /substrate/v1/whoami
// ---------------------------------------------------------------------------

describe('GET /substrate/v1/whoami', () => {
  let ctx: Ctx | null = null;
  afterEach(async () => {
    if (ctx !== null) {
      await ctx.composed.stop();
      ctx = null;
    }
  });

  it('reports the resolved identity for an authenticated caller, intersected against the invite row', async () => {
    ctx = await mkServer();
    // Mint an invite scoped to ONLY 'demo' + 'read'.
    const code = await mintInvite(ctx, {
      namespaces: ['demo'],
      capabilities: ['read'],
      allowUnknownNs: true
    });
    const { publicKeyPem, privateKeyPem } = edPem();
    const regRes = await post(ctx, '/substrate/v1/_system/register', {
      code,
      publicKey: publicKeyPem,
      keyName: 'bridge from a',
      algorithm: 'EdDSA'
    });
    expect(regRes.status).toBe(201);
    const { kid } = jsonBody<{ kid: string }>(regRes);

    // Claim MORE than the invite granted: wildcard namespaces + every
    // capability. The verifier intersects claims against the Key row, so
    // whoami must echo back the row's NARROWER grant, not the token's claim.
    // The intersection is unit-tested at `verifyBearerToken` (_system.test.ts);
    // this pins the full HTTP round-trip.
    const token = signEdDSA(
      {
        sub: kid,
        exp: Math.floor(Date.now() / 1000) + 60,
        ns: ['*'],
        capabilities: ['read', 'mutate', 'admin']
      },
      privateKeyPem,
      { kid }
    );
    const res = await ctx.server.inject({
      method: 'GET',
      path: '/substrate/v1/whoami',
      headers: { authorization: `Bearer ${token}` }
    });

    expect(res.status).toBe(200);
    const body = jsonBody<{
      authEnabled: boolean;
      identity: { id: string; grants: Record<string, string[]> } | null;
    }>(res);
    expect(body.authEnabled).toBe(true);
    expect(body.identity?.id).toBe(kid);
    expect(body.identity?.grants).toEqual({ demo: ['read'] });
  });

  it('ANSWERS an unauthenticated caller rather than refusing, when auth is enabled', async () => {
    // The route is deliberately ungated: a caller with no credential is the one
    // most needing an answer. `authEnabled: true` with `identity: null` says
    // "auth is on here and you are nobody".
    ctx = await mkServer();
    const res = await ctx.server.inject({ method: 'GET', path: '/substrate/v1/whoami' });
    expect(res.status).toBe(200);
    expect(jsonBody<{ authEnabled: boolean; identity: unknown }>(res)).toEqual({
      authEnabled: true,
      identity: null
    });
  });

  it('401s a present-but-INVALID token, distinctly from sending none', async () => {
    // Absent and broken credentials are different facts with different fixes.
    ctx = await mkServer();
    const res = await ctx.server.inject({
      method: 'GET',
      path: '/substrate/v1/whoami',
      headers: { authorization: 'Bearer not-a-real-token' }
    });
    expect(res.status).toBe(401);
  });
});

describe('GET /substrate/v1/whoami — auth disabled', () => {
  it('reports authEnabled:false when the instance has auth disabled', async () => {
    // No `auth` config at all. Must be distinguishable from an anonymous caller
    // on an auth-enabled instance (the attribute-mode block below): this one
    // means "this peer verifies nothing", that one "your credential never
    // arrived".
    const server = new MemorySubstrateServer();
    const dataset = new MemoryDataset({ namespace: 'default' });
    const composed = await compose({
      // Auth is off, so the deployment must declare who it writes as.
      systemActor: 'test',
      server,
      dataset,
      coordinators: [fixturePlugin]
    });
    await server.start();
    try {
      const res = await server.inject({ method: 'GET', path: '/substrate/v1/whoami' });
      expect(res.status).toBe(200);
      expect(jsonBody<{ authEnabled: boolean; identity: unknown }>(res)).toEqual({
        authEnabled: false,
        identity: null
      });
    } finally {
      await composed.stop();
    }
  });
});

describe('GET /substrate/v1/whoami — attribute mode', () => {
  // Attribute mode is a supported rollout posture. `authEnabled` separates
  // "auth is on and you are nobody" from "this deployment verifies nothing".
  //
  // A present-but-invalid token still 401s in this mode, which keeps the
  // endpoint meaningful to a caller that always sends a bearer token, like
  // `substrate federate check`.
  const attributeAuthCfg: AuthConfig = {
    keys: [{ kid: FILE_KID, alg: 'HS256', publicKey: SECRET }],
    adminCapability: ADMIN_CAP,
    mode: 'attribute'
  };

  async function mkAttributeServer(): Promise<{
    server: MemorySubstrateServer;
    composed: ComposeResult;
  }> {
    const server = new MemorySubstrateServer();
    const dataset = new MemoryDataset({ namespace: 'default' });
    const composed = await compose({
      systemActor: 'test',
      server,
      dataset,
      auth: attributeAuthCfg,
      streamTicketSecret: 'test-stream-ticket-secret',
      coordinators: [fixturePlugin]
    });
    await server.start();
    return { server, composed };
  }

  it('anonymous caller (no Authorization header) → 200 { authEnabled: true, identity: null }', async () => {
    const { server, composed } = await mkAttributeServer();
    try {
      const res = await server.inject({ method: 'GET', path: '/substrate/v1/whoami' });
      expect(res.status).toBe(200);
      // `authEnabled: TRUE` — the distinction from the auth-disabled block
      // above, and the reason the field exists.
      expect(jsonBody<{ authEnabled: boolean; identity: unknown }>(res)).toEqual({
        authEnabled: true,
        identity: null
      });
    } finally {
      await composed.stop();
    }
  });

  it('present-but-invalid token → 401 even in attribute mode', async () => {
    const { server, composed } = await mkAttributeServer();
    try {
      const res = await server.inject({
        method: 'GET',
        path: '/substrate/v1/whoami',
        headers: { authorization: 'Bearer not-a-real-token' }
      });
      expect(res.status).toBe(401);
    } finally {
      await composed.stop();
    }
  });
});

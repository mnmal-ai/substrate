/**
 * §5.12 — `_system` namespace + dataset-backed key registry.
 *
 * Coverage:
 *   - Type registration in `_system` shows up in the federated schema.
 *   - Admin-gated autoCRUD on `Key` and `Invite` — non-admin tokens
 *     surface per-frame `policy_denied` errors; admin tokens succeed.
 *   - `KeyRegistry` cache: prime, refresh, evict, revocation.
 *   - End-to-end: a dataset-seeded Ed25519 key verifies a live HTTP query.
 *   - Intersection rule: dataset-verified tokens cannot claim more scope than
 *     the Key row authorises.
 *   - Revocation: updating a Key's `revokedAt` invalidates existing tokens.
 *   - HS256 rejection at create/update time.
 *
 * Every test uses `MemorySubstrateServer` / `MemoryDataset`; no port binding.
 */

import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import {
  type AuthConfig,
  type ComposeResult,
  compose,
  createKeyRegistry,
  encodeList,
  INVITE_TYPE,
  KEY_TYPE,
  type KeyAlgorithm,
  SYSTEM_NAMESPACE,
  signEdDSA,
  signHs256
} from '@mnmal-ai/substrate-compose';
import { MemoryDataset } from '@mnmal-ai/substrate-dataset-memory';
import { MemorySubstrateServer } from '@mnmal-ai/substrate-server-memory';
import type {
  Dataset,
  PackEnvelope,
  Row,
  Schema,
  SubstrateResponse
} from '@mnmal-ai/substrate-types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fixturePlugin } from './_fixtures/fixture-plugin.js';

const ADMIN_CAP = 'admin';
const SECRET = 'dispatch-a-secret';
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

interface ServerCtx {
  server: MemorySubstrateServer;
  composed: ComposeResult;
  substrateDataset: MemoryDataset;
}

async function mkServer(overrides: { adminCapability?: string } = {}): Promise<ServerCtx> {
  const server = new MemorySubstrateServer();
  const dataset = new MemoryDataset({ namespace: 'default' });
  const substrateDataset = new MemoryDataset({ namespace: SYSTEM_NAMESPACE });
  const cfg: AuthConfig = { ...authCfg };
  if (overrides.adminCapability !== undefined) cfg.adminCapability = overrides.adminCapability;
  const composed = await compose({
    systemActor: 'test',
    server,
    dataset,
    datasets: { [SYSTEM_NAMESPACE]: substrateDataset },
    auth: cfg,
    streamTicketSecret: 'test-stream-ticket-secret'
  });
  await server.start();
  return { server, composed, substrateDataset };
}

async function runMutate(
  ctx: ServerCtx,
  token: string,
  body: Record<string, unknown>
): Promise<SubstrateResponse> {
  return ctx.server.inject({
    method: 'POST',
    path: '/substrate/v1/mutate',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json'
    },
    body: Buffer.from(JSON.stringify(body))
  });
}

async function runQuery(
  ctx: ServerCtx,
  token: string,
  body: Record<string, unknown>
): Promise<SubstrateResponse> {
  return ctx.server.inject({
    method: 'POST',
    path: '/substrate/v1/query',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json'
    },
    body: Buffer.from(JSON.stringify(body))
  });
}

/** Fresh admin token with `_system` namespace scope. */
function adminToken(): string {
  return mkFileToken({ capabilities: [ADMIN_CAP, 'read', 'mutate'], ns: ['*'] });
}

/** Token that can hit mutate/query routes but lacks admin — used to test policy denial. */
function nonAdminMutateToken(): string {
  return mkFileToken({ capabilities: ['read', 'mutate'], ns: ['*'] });
}

describe('apps/substrate § _system namespace — registration & schema', () => {
  let ctx: ServerCtx | null = null;
  afterEach(async () => {
    if (ctx !== null) {
      await ctx.composed.stop();
      ctx = null;
    }
  });

  it('_system namespace exposes Key and Invite in the federated schema', async () => {
    ctx = await mkServer();
    const res = await ctx.server.inject({
      method: 'GET',
      path: '/substrate/v1/federated-schema',
      headers: { authorization: `Bearer ${mkFileToken({ capabilities: ['read'], ns: ['*'] })}` }
    });
    expect(res.status).toBe(200);
    const federated = jsonBody<Record<string, Schema>>(res);
    expect(federated[SYSTEM_NAMESPACE]).toBeDefined();
    expect(federated[SYSTEM_NAMESPACE]?.types[KEY_TYPE]).toBeDefined();
    expect(federated[SYSTEM_NAMESPACE]?.types[INVITE_TYPE]).toBeDefined();
    expect(federated[SYSTEM_NAMESPACE]?.mutations.createKey).toBeDefined();
    expect(federated[SYSTEM_NAMESPACE]?.mutations.updateKey).toBeDefined();
    expect(federated[SYSTEM_NAMESPACE]?.mutations.deleteKey).toBeDefined();
    expect(federated[SYSTEM_NAMESPACE]?.mutations.purgeKey).toBeDefined();
    expect(federated[SYSTEM_NAMESPACE]?.mutations.createInvite).toBeDefined();
  });
});

describe('apps/substrate § _system namespace — admin-gated writes', () => {
  let ctx: ServerCtx | null = null;
  afterEach(async () => {
    if (ctx !== null) {
      await ctx.composed.stop();
      ctx = null;
    }
  });

  it('createKey with an admin token succeeds', async () => {
    ctx = await mkServer();
    const { publicKey } = generateKeyPairSync('ed25519');
    const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const res = await runMutate(ctx, adminToken(), {
      [`${SYSTEM_NAMESPACE}/createKey`]: {
        params: {
          id: 'key-1',
          kid: 'key-1',
          name: 'deployment-a',
          algorithm: 'EdDSA',
          publicKey: pem,
          namespaces: encodeList(['default']),
          capabilities: encodeList(['read'])
        },
        fields: { id: true, name: true }
      }
    });
    expect(res.status).toBe(200);
    const env = jsonBody<PackEnvelope>(res);
    expect(env.errors).toBeUndefined();
    const data = env.data[`${SYSTEM_NAMESPACE}/createKey`];
    expect(data).toBeDefined();
  });

  it('createKey with a non-admin token is denied at policy time', async () => {
    ctx = await mkServer();
    const { publicKey } = generateKeyPairSync('ed25519');
    const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const res = await runMutate(ctx, nonAdminMutateToken(), {
      [`${SYSTEM_NAMESPACE}/createKey`]: {
        params: {
          id: 'key-x',
          kid: 'key-x',
          name: 'attacker',
          algorithm: 'EdDSA',
          publicKey: pem,
          namespaces: encodeList(['default']),
          capabilities: encodeList(['read'])
        },
        fields: { id: true }
      }
    });
    expect(res.status).toBe(200);
    const env = jsonBody<PackEnvelope>(res);
    const err = (env.errors ?? []).find((e) => e.path?.[0] === `${SYSTEM_NAMESPACE}/createKey`);
    expect(err?.code).toBe('policy_denied');
    // Row must not have been written.
    const readRes = await ctx.substrateDataset.read(KEY_TYPE, { id: 'key-x' });
    expect(readRes.rows).toHaveLength(0);
  });

  it('updateKey with a non-admin token is denied', async () => {
    ctx = await mkServer();
    // Seed via admin first.
    await ctx.substrateDataset.write(KEY_TYPE, [
      {
        id: 'k-existing',
        name: 'seeded',
        algorithm: 'EdDSA',
        publicKey: 'PEM',
        namespaces: 'default',
        capabilities: 'read'
      }
    ]);
    const res = await runMutate(ctx, nonAdminMutateToken(), {
      [`${SYSTEM_NAMESPACE}/updateKey`]: {
        params: { id: 'k-existing', name: 'hijacked' },
        fields: { id: true }
      }
    });
    const env = jsonBody<PackEnvelope>(res);
    const err = (env.errors ?? []).find((e) => e.path?.[0] === `${SYSTEM_NAMESPACE}/updateKey`);
    expect(err?.code).toBe('policy_denied');
  });

  it('createInvite with an admin token succeeds; non-admin is denied', async () => {
    ctx = await mkServer();
    const okRes = await runMutate(ctx, adminToken(), {
      [`${SYSTEM_NAMESPACE}/createInvite`]: {
        params: {
          id: 'invite-1',
          namespaces: encodeList(['default']),
          capabilities: encodeList(['read']),
          expiresAt: new Date(Date.now() + 3_600_000).toISOString()
        },
        fields: { id: true }
      }
    });
    expect(okRes.status).toBe(200);
    const okEnv = jsonBody<PackEnvelope>(okRes);
    expect(okEnv.errors).toBeUndefined();

    const denyRes = await runMutate(ctx, nonAdminMutateToken(), {
      [`${SYSTEM_NAMESPACE}/createInvite`]: {
        params: {
          id: 'invite-evil',
          namespaces: encodeList(['default']),
          capabilities: encodeList(['read']),
          expiresAt: new Date(Date.now() + 3_600_000).toISOString()
        },
        fields: { id: true }
      }
    });
    const denyEnv = jsonBody<PackEnvelope>(denyRes);
    const err = (denyEnv.errors ?? []).find(
      (e) => e.path?.[0] === `${SYSTEM_NAMESPACE}/createInvite`
    );
    expect(err?.code).toBe('policy_denied');
  });

  it('namespace-scoped non-admin token gets unauthorized_namespace on _system reads', async () => {
    ctx = await mkServer();
    // Token scoped only to 'default' — the per-frame engine gate should reject
    // the frame before the admin policy even fires.
    const token = mkFileToken({ capabilities: ['read'], ns: ['default'] });
    const res = await runQuery(ctx, token, {
      [`${SYSTEM_NAMESPACE}/${KEY_TYPE}`]: {
        params: { limit: 5 },
        fields: { id: true }
      }
    });
    const env = jsonBody<PackEnvelope>(res);
    const err = (env.errors ?? []).find((e) => e.path?.[0] === `${SYSTEM_NAMESPACE}/${KEY_TYPE}`);
    expect(err?.code).toBe('unauthorized_namespace');
  });

  it('rejects HS256 in createKey (DC-6: structured envelope error)', async () => {
    ctx = await mkServer();
    const res = await runMutate(ctx, adminToken(), {
      [`${SYSTEM_NAMESPACE}/createKey`]: {
        params: {
          id: 'hs-key',
          kid: 'hs-key',
          name: 'symmetric',
          algorithm: 'HS256',
          publicKey: 'not-a-pem',
          namespaces: encodeList(['default']),
          capabilities: encodeList(['read'])
        },
        fields: { id: true }
      }
    });
    // HS256 writes surface as a structured envelope error with
    // code: 'hmac_not_allowed' (HTTP 200 + envelope.errors), not HTTP 500.
    expect(res.status).toBe(200);
    const env = jsonBody<PackEnvelope>(res);
    const err = (env.errors ?? []).find((e) => e.path?.[0] === `${SYSTEM_NAMESPACE}/createKey`);
    expect(err).toBeDefined();
    expect(err?.code).toBe('hmac_not_allowed');
    expect(err?.message ?? '').toMatch(/HS256|symmetric|not supported/i);
    // Structured details payload — clients can branch on the
    // rejected field name + supplied value without parsing the prose.
    expect(err?.details).toMatchObject({
      field: 'algorithm',
      supplied: 'HS256'
    });
    expect(Array.isArray((err?.details as Record<string, unknown> | undefined)?.allowed)).toBe(
      true
    );
    // And nothing persisted.
    const readRes = await ctx.substrateDataset.read(KEY_TYPE, { id: 'hs-key' });
    expect(readRes.rows).toHaveLength(0);
  });
});

describe('apps/substrate § KeyRegistry — cache behaviour', () => {
  let dataset: Dataset;
  let registry: ReturnType<typeof createKeyRegistry>;
  let clock: () => Date;

  const baseRow = (id: string, overrides: Record<string, unknown> = {}): Row => ({
    id,
    kid: id,
    name: `key-${id}`,
    algorithm: 'EdDSA' as KeyAlgorithm,
    publicKey: '-----BEGIN PUBLIC KEY-----\nstub\n-----END PUBLIC KEY-----',
    namespaces: 'default',
    capabilities: 'read',
    revokedAt: null,
    ...overrides
  });

  beforeEach(() => {
    dataset = new MemoryDataset({ namespace: SYSTEM_NAMESPACE });
    clock = () => new Date('2026-06-01T00:00:00Z');
    registry = createKeyRegistry({ dataset, now: clock });
  });

  it('primeFromDataset loads every row into the cache', async () => {
    await dataset.write(KEY_TYPE, [baseRow('a'), baseRow('b'), baseRow('c')]);
    await registry.primeFromDataset();
    expect(registry.lookup('a')).not.toBeNull();
    expect(registry.lookup('b')).not.toBeNull();
    expect(registry.lookup('c')).not.toBeNull();
  });

  it('lookup returns null for an unknown kid', async () => {
    await registry.primeFromDataset();
    expect(registry.lookup('missing')).toBeNull();
  });

  it('refresh sees a newly inserted row', async () => {
    await registry.primeFromDataset();
    expect(registry.lookup('fresh')).toBeNull();
    await dataset.write(KEY_TYPE, [baseRow('fresh')]);
    await registry.refresh('fresh');
    expect(registry.lookup('fresh')).not.toBeNull();
  });

  it('revokedAt in the past returns null from lookup', async () => {
    await dataset.write(KEY_TYPE, [
      baseRow('rev', { revokedAt: new Date('2026-03-01T00:00:00Z') })
    ]);
    await registry.primeFromDataset();
    expect(registry.lookup('rev')).toBeNull();
  });

  it('revokedAt in the future is treated as live (pre-effective)', async () => {
    await dataset.write(KEY_TYPE, [
      baseRow('future', { revokedAt: new Date('2099-01-01T00:00:00Z') })
    ]);
    await registry.primeFromDataset();
    expect(registry.lookup('future')).not.toBeNull();
  });

  it('evict removes the entry; lookup returns null', async () => {
    await dataset.write(KEY_TYPE, [baseRow('gone')]);
    await registry.primeFromDataset();
    registry.evict('gone');
    expect(registry.lookup('gone')).toBeNull();
  });

  it('drops rows with an unrecognised algorithm from the cache and warns', async () => {
    const warnings: Array<[string, unknown]> = [];
    const local = createKeyRegistry({
      dataset,
      now: clock,
      onWarn: (m, d) => warnings.push([m, d])
    });
    await dataset.write(KEY_TYPE, [
      baseRow('ok'),
      // HS256 stored somehow (simulating malformed legacy data) — must skip, not throw.
      baseRow('bad', { algorithm: 'HS256' })
    ]);
    await local.primeFromDataset();
    expect(local.lookup('ok')).not.toBeNull();
    expect(local.lookup('bad')).toBeNull();
    expect(warnings.length).toBe(1);
    expect(warnings[0]?.[0]).toBe('substrate_key_registry_malformed_row');
  });
});

describe('apps/substrate § KeyRegistry — invalidation via autoCRUD', () => {
  let ctx: ServerCtx | null = null;
  afterEach(async () => {
    if (ctx !== null) {
      await ctx.composed.stop();
      ctx = null;
    }
  });

  async function createKey(
    c: ServerCtx,
    id: string,
    pem: string,
    overrides: Record<string, unknown> = {}
  ): Promise<void> {
    const res = await runMutate(c, adminToken(), {
      [`${SYSTEM_NAMESPACE}/createKey`]: {
        params: {
          id,
          kid: id,
          name: `key-${id}`,
          algorithm: 'EdDSA',
          publicKey: pem,
          namespaces: encodeList(['default']),
          capabilities: encodeList(['read']),
          ...overrides
        },
        fields: { id: true }
      }
    });
    const env = jsonBody<PackEnvelope>(res);
    if (env.errors !== undefined) {
      throw new Error(`createKey failed: ${JSON.stringify(env.errors)}`);
    }
  }

  it('createKey invalidates — new kid is visible via the engine route', async () => {
    ctx = await mkServer();
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    await createKey(ctx, 'ds-key-1', pem);

    // Sign a token against the just-seeded key.
    const token = signEdDSA(
      {
        sub: 'dataset-client',
        exp: Math.floor(Date.now() / 1000) + 60,
        capabilities: ['read'],
        ns: ['default']
      },
      privateKey,
      { kid: 'ds-key-1' }
    );

    const res = await runQuery(ctx, token, {
      'default/Todo': { params: { limit: 1 }, fields: { id: true } }
    });
    expect(res.status).toBe(200);
  });

  it('deleteKey evicts; subsequent token verifies fail', async () => {
    ctx = await mkServer();
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    await createKey(ctx, 'ds-key-2', pem);

    const token = signEdDSA(
      {
        sub: 'x',
        exp: Math.floor(Date.now() / 1000) + 60,
        capabilities: ['read'],
        ns: ['default']
      },
      privateKey,
      { kid: 'ds-key-2' }
    );
    // Works before delete.
    const okRes = await runQuery(ctx, token, {
      'default/Todo': { params: { limit: 1 }, fields: { id: true } }
    });
    expect(okRes.status).toBe(200);

    // Delete the key.
    const delRes = await runMutate(ctx, adminToken(), {
      [`${SYSTEM_NAMESPACE}/deleteKey`]: {
        params: { id: 'ds-key-2' },
        fields: { id: true }
      }
    });
    expect(delRes.status).toBe(200);

    // Same token now fails.
    const failRes = await runQuery(ctx, token, {
      'default/Todo': { params: { limit: 1 }, fields: { id: true } }
    });
    expect(failRes.status).toBe(401);
  });

  it('createKey with kid distinct from id: registry resolves on kid, evicts on delete', async () => {
    // kid and id are decoupled. The interceptor must
    // refresh/evict by the kid FIELD, not the row id. This test seeds a key
    // where kid !== id to prove the cache-key alignment is correct.
    ctx = await mkServer();
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString();

    // Create with distinct kid and id (UUID-style id, human-readable kid).
    const rowId = 'uuid-row-id-distinct';
    const principalKid = 'agent-x@host';

    const createRes = await runMutate(ctx, adminToken(), {
      [`${SYSTEM_NAMESPACE}/createKey`]: {
        params: {
          id: rowId,
          kid: principalKid,
          name: 'distinct-kid-key',
          algorithm: 'EdDSA',
          publicKey: pem,
          namespaces: encodeList(['default']),
          capabilities: encodeList(['read'])
        },
        fields: { id: true, kid: true }
      }
    });
    expect(createRes.status).toBe(200);
    const createEnv = jsonBody<PackEnvelope>(createRes);
    expect(createEnv.errors).toBeUndefined();
    // Confirm the returned row has both fields set distinctly.
    const createdRow = createEnv.data[`${SYSTEM_NAMESPACE}/createKey`] as Record<string, unknown>;
    expect(createdRow?.id).toBe(rowId);
    expect(createdRow?.kid).toBe(principalKid);

    // Sign a token with the kid field (principal identity), NOT the row id.
    const token = signEdDSA(
      {
        sub: 'agent-x',
        exp: Math.floor(Date.now() / 1000) + 60,
        capabilities: ['read'],
        ns: ['default']
      },
      privateKey,
      { kid: principalKid }
    );

    // Registry must have been refreshed on kid='agent-x@host', not id='uuid-row-id-distinct'.
    const okRes = await runQuery(ctx, token, {
      'default/Todo': { params: { limit: 1 }, fields: { id: true } }
    });
    expect(okRes.status).toBe(200);

    // Delete by row id — the interceptor must evict by kid field so the cache
    // entry (keyed by 'agent-x@host') is actually removed.
    const delRes = await runMutate(ctx, adminToken(), {
      [`${SYSTEM_NAMESPACE}/deleteKey`]: {
        params: { id: rowId },
        fields: { id: true, kid: true }
      }
    });
    expect(delRes.status).toBe(200);
    const delEnv = jsonBody<PackEnvelope>(delRes);
    expect(delEnv.errors).toBeUndefined();

    // Token signed with the kid must now fail — the cache entry was evicted.
    const failRes = await runQuery(ctx, token, {
      'default/Todo': { params: { limit: 1 }, fields: { id: true } }
    });
    expect(failRes.status).toBe(401);
  });
});

describe('apps/substrate § Ed25519 end-to-end via dataset key', () => {
  let ctx: ServerCtx | null = null;
  afterEach(async () => {
    if (ctx !== null) {
      await ctx.composed.stop();
      ctx = null;
    }
  });

  async function seedKey(
    c: ServerCtx,
    id: string,
    overrides: Record<string, unknown> = {}
  ): Promise<{ privateKey: KeyObject }> {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    await c.substrateDataset.write(KEY_TYPE, [
      {
        id,
        kid: id,
        name: `k-${id}`,
        algorithm: 'EdDSA',
        publicKey: pem,
        namespaces: 'default',
        capabilities: 'read',
        revokedAt: null,
        ...overrides
      }
    ]);
    return { privateKey };
  }

  it('dataset-seeded Ed25519 key verifies a live HTTP query', async () => {
    // First seed into the dataset, then build the server — compose() primes
    // the registry before any route handler registers.
    const server = new MemorySubstrateServer();
    const dataset = new MemoryDataset({ namespace: 'default' });
    const substrateDataset = new MemoryDataset({ namespace: SYSTEM_NAMESPACE });
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    await substrateDataset.write(KEY_TYPE, [
      {
        id: 'ds-seed-1',
        kid: 'ds-seed-1',
        name: 'seed',
        algorithm: 'EdDSA',
        publicKey: pem,
        namespaces: 'default',
        capabilities: 'read',
        revokedAt: null
      }
    ]);
    const composed = await compose({
      systemActor: 'test',
      server,
      dataset,
      datasets: { [SYSTEM_NAMESPACE]: substrateDataset },
      auth: authCfg,
      streamTicketSecret: 'test-stream-ticket-secret'
    });
    await server.start();
    ctx = { server, composed, substrateDataset };

    const token = signEdDSA(
      {
        sub: 'edtester',
        exp: Math.floor(Date.now() / 1000) + 60,
        capabilities: ['read'],
        ns: ['default']
      },
      privateKey,
      { kid: 'ds-seed-1' }
    );

    const res = await runQuery(ctx, token, {
      'default/Todo': { params: { limit: 1 }, fields: { id: true } }
    });
    expect(res.status).toBe(200);
  });

  it('un-seeded kid with otherwise-valid EdDSA signature is rejected', async () => {
    ctx = await mkServer();
    const { privateKey } = generateKeyPairSync('ed25519');
    const token = signEdDSA(
      {
        sub: 'nobody',
        exp: Math.floor(Date.now() / 1000) + 60,
        capabilities: ['read'],
        ns: ['default']
      },
      privateKey,
      { kid: 'never-seeded' }
    );
    const res = await runQuery(ctx, token, {
      'default/Todo': { params: { limit: 1 }, fields: { id: true } }
    });
    expect(res.status).toBe(401);
    // Side note on seedKey helper — referenced to avoid "unused" lint.
    void seedKey;
  });
});

describe('apps/substrate § claim-vs-row intersection for dataset-verified tokens', () => {
  let ctx: ServerCtx | null = null;
  afterEach(async () => {
    if (ctx !== null) {
      await ctx.composed.stop();
      ctx = null;
    }
  });

  it('intersection strips claimed namespaces that the row does not authorise', async () => {
    // Seed a narrowly-scoped Key, then see what verifyBearerToken
    // returns directly — we exercise the auth.ts seam without going through
    // the full HTTP path so the identity object is observable.
    const substrateDataset = new MemoryDataset({ namespace: SYSTEM_NAMESPACE });
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    await substrateDataset.write(KEY_TYPE, [
      {
        id: 'intersect-1',
        kid: 'intersect-1',
        name: 'narrow',
        algorithm: 'EdDSA',
        publicKey: pem,
        namespaces: 'default',
        capabilities: 'read',
        revokedAt: null
      }
    ]);
    const registry = createKeyRegistry({ dataset: substrateDataset });
    await registry.primeFromDataset();

    const { verifyBearerToken } = await import('@mnmal-ai/substrate-compose');
    const cfg: AuthConfig = { keys: [], keyRegistry: registry };
    const token = signEdDSA(
      {
        sub: 'over-claim',
        exp: Math.floor(Date.now() / 1000) + 60,
        capabilities: ['read', 'admin'],
        ns: ['default', 'other']
      },
      privateKey,
      { kid: 'intersect-1' }
    );
    const identity = await verifyBearerToken(token, cfg);
    expect(identity).not.toBeNull();
    expect(identity?.grants).toEqual({ default: ['read'] });
  });

  it('wildcard in the claim expands to the row-authorised list', async () => {
    const substrateDataset = new MemoryDataset({ namespace: SYSTEM_NAMESPACE });
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    await substrateDataset.write(KEY_TYPE, [
      {
        id: 'wild-1',
        kid: 'wild-1',
        name: 'multi',
        algorithm: 'EdDSA',
        publicKey: pem,
        namespaces: 'default,claude',
        capabilities: 'read',
        revokedAt: null
      }
    ]);
    const registry = createKeyRegistry({ dataset: substrateDataset });
    await registry.primeFromDataset();
    const { verifyBearerToken } = await import('@mnmal-ai/substrate-compose');
    const cfg: AuthConfig = { keys: [], keyRegistry: registry };
    const token = signEdDSA(
      {
        sub: 'wild',
        exp: Math.floor(Date.now() / 1000) + 60,
        capabilities: ['read'],
        ns: ['*']
      },
      privateKey,
      { kid: 'wild-1' }
    );
    const identity = await verifyBearerToken(token, cfg);
    expect(identity?.grants).toEqual({ default: ['read'], claude: ['read'] });
  });

  it('file-registry tokens bypass the intersection (Phase 1 back-compat)', async () => {
    // File entries don't carry row-authorised lists; the identity should
    // reflect the claim verbatim.
    const { verifyBearerToken } = await import('@mnmal-ai/substrate-compose');
    const token = signHs256(
      {
        sub: 'file',
        exp: Math.floor(Date.now() / 1000) + 60,
        capabilities: ['read', 'mutate', 'admin'],
        ns: ['anything', 'goes']
      },
      SECRET,
      { kid: FILE_KID }
    );
    const identity = await verifyBearerToken(token, authCfg);
    expect(identity?.grants).toEqual({
      anything: ['admin', 'mutate', 'read'],
      goes: ['admin', 'mutate', 'read']
    });
  });
});

describe('apps/substrate § revocation round-trip', () => {
  let ctx: ServerCtx | null = null;
  afterEach(async () => {
    if (ctx !== null) {
      await ctx.composed.stop();
      ctx = null;
    }
  });

  it('revoking a Key (updateKey + revokedAt) invalidates existing tokens', async () => {
    ctx = await mkServer();
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const createRes = await runMutate(ctx, adminToken(), {
      [`${SYSTEM_NAMESPACE}/createKey`]: {
        params: {
          id: 'rev-1',
          kid: 'rev-1',
          name: 'to-revoke',
          algorithm: 'EdDSA',
          publicKey: pem,
          namespaces: encodeList(['default']),
          capabilities: encodeList(['read'])
        },
        fields: { id: true }
      }
    });
    expect(createRes.status).toBe(200);

    const token = signEdDSA(
      {
        sub: 'r',
        exp: Math.floor(Date.now() / 1000) + 60,
        capabilities: ['read'],
        ns: ['default']
      },
      privateKey,
      { kid: 'rev-1' }
    );
    // Token works before revocation.
    const okRes = await runQuery(ctx, token, {
      'default/Todo': { params: { limit: 1 }, fields: { id: true } }
    });
    expect(okRes.status).toBe(200);

    // Revoke.
    const pastIso = new Date(Date.now() - 60_000).toISOString();
    const updRes = await runMutate(ctx, adminToken(), {
      [`${SYSTEM_NAMESPACE}/updateKey`]: {
        params: { id: 'rev-1', revokedAt: pastIso },
        fields: { id: true }
      }
    });
    expect(updRes.status).toBe(200);
    const updEnv = jsonBody<PackEnvelope>(updRes);
    expect(updEnv.errors).toBeUndefined();

    // Same token now 401s.
    const denyRes = await runQuery(ctx, token, {
      'default/Todo': { params: { limit: 1 }, fields: { id: true } }
    });
    expect(denyRes.status).toBe(401);
  });
});

describe('apps/substrate § encoding helpers', () => {
  it('encodeList round-trips through decodeList', async () => {
    const { decodeList } = await import('@mnmal-ai/substrate-compose');
    expect(decodeList(encodeList([]))).toEqual([]);
    expect(decodeList(encodeList(['a']))).toEqual(['a']);
    expect(decodeList(encodeList(['a', 'b', 'c']))).toEqual(['a', 'b', 'c']);
    // Whitespace is trimmed.
    expect(decodeList(encodeList([' a ', 'b ']))).toEqual(['a', 'b']);
    // Empty strings drop silently.
    expect(decodeList(encodeList(['a', '', 'b']))).toEqual(['a', 'b']);
  });

  it('encodeList rejects items containing a comma', () => {
    expect(() => encodeList(['a', 'b,c'])).toThrow(/comma/);
  });

  it('decodeList tolerates non-string inputs without throwing', async () => {
    const { decodeList } = await import('@mnmal-ai/substrate-compose');
    expect(decodeList(undefined)).toEqual([]);
    expect(decodeList(null)).toEqual([]);
    expect(decodeList(42)).toEqual([]);
  });
});

describe('apps/substrate § intersection edge cases', () => {
  async function seedRow(
    id: string,
    namespaces: string,
    capabilities: string
  ): Promise<{ dataset: MemoryDataset; privateKey: KeyObject }> {
    const dataset = new MemoryDataset({ namespace: SYSTEM_NAMESPACE });
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    await dataset.write(KEY_TYPE, [
      {
        id,
        kid: id,
        name: `k-${id}`,
        algorithm: 'EdDSA',
        publicKey: pem,
        namespaces,
        capabilities,
        revokedAt: null
      }
    ]);
    return { dataset, privateKey };
  }

  it('row with empty capabilities strips every claimed capability', async () => {
    const { dataset, privateKey } = await seedRow('empty-caps', 'default', '');
    const registry = createKeyRegistry({ dataset });
    await registry.primeFromDataset();
    const { verifyBearerToken } = await import('@mnmal-ai/substrate-compose');
    const cfg: AuthConfig = { keys: [], keyRegistry: registry };
    const token = signEdDSA(
      {
        sub: 'x',
        exp: Math.floor(Date.now() / 1000) + 60,
        capabilities: ['read', 'mutate'],
        ns: ['default']
      },
      privateKey,
      { kid: 'empty-caps' }
    );
    const identity = await verifyBearerToken(token, cfg);
    // The intersection PRUNES namespaces left with no capability — unlike the
    // file-registry construction path, which keeps the empty entry.
    expect(identity?.grants).toEqual({});
  });

  it('row with wildcard namespaces matches any claim', async () => {
    const { dataset, privateKey } = await seedRow('ns-wild', '*', 'read');
    const registry = createKeyRegistry({ dataset });
    await registry.primeFromDataset();
    const { verifyBearerToken } = await import('@mnmal-ai/substrate-compose');
    const cfg: AuthConfig = { keys: [], keyRegistry: registry };
    const token = signEdDSA(
      {
        sub: 'x',
        exp: Math.floor(Date.now() / 1000) + 60,
        capabilities: ['read'],
        ns: ['whatever', 'anything']
      },
      privateKey,
      { kid: 'ns-wild' }
    );
    const identity = await verifyBearerToken(token, cfg);
    expect(identity?.grants).toEqual({ whatever: ['read'], anything: ['read'] });
  });

  it('dataset registry is not consulted for HS256 tokens (DC-8 invariant)', async () => {
    // Build a registry with a kid that COULD match a file token's kid; verify
    // the file path wins and the dataset path is skipped for HS256.
    const dataset = new MemoryDataset({ namespace: SYSTEM_NAMESPACE });
    const registry = createKeyRegistry({ dataset });
    await registry.primeFromDataset();
    const { verifyBearerToken } = await import('@mnmal-ai/substrate-compose');
    const cfg: AuthConfig = { keys: authCfg.keys, keyRegistry: registry };
    const token = signHs256(
      {
        sub: 'x',
        exp: Math.floor(Date.now() / 1000) + 60,
        capabilities: ['read'],
        ns: ['default']
      },
      SECRET,
      { kid: FILE_KID }
    );
    const identity = await verifyBearerToken(token, cfg);
    // Verified against the file entry (HS256), no intersection applied.
    expect(identity?.grants).toEqual({ default: ['read'] });
  });

  it('dataset registry is not consulted when the token has no kid', async () => {
    const { dataset } = await seedRow('no-kid', 'default', 'read');
    const registry = createKeyRegistry({ dataset });
    await registry.primeFromDataset();
    const { verifyBearerToken } = await import('@mnmal-ai/substrate-compose');
    const cfg: AuthConfig = { keys: [], keyRegistry: registry };
    // Sign with no kid — the dataset lookup requires a kid.
    const { privateKey } = generateKeyPairSync('ed25519');
    const token = signEdDSA(
      {
        sub: 'x',
        exp: Math.floor(Date.now() / 1000) + 60,
        capabilities: ['read'],
        ns: ['default']
      },
      privateKey
    );
    // No file entries, no kid → no candidates → verify returns null.
    const identity = await verifyBearerToken(token, cfg);
    expect(identity).toBeNull();
  });
});

describe('apps/substrate § custom admin capability', () => {
  let ctx: ServerCtx | null = null;
  afterEach(async () => {
    if (ctx !== null) {
      await ctx.composed.stop();
      ctx = null;
    }
  });

  it('SUBSTRATE_ADMIN_CAPABILITY override is honoured by the _system admin gate', async () => {
    ctx = await mkServer({ adminCapability: 'role=admin' });
    // Token carrying the default 'admin' claim should now be rejected —
    // deployment demanded 'role=admin'.
    const defaultAdminToken = mkFileToken({ capabilities: ['admin', 'mutate'], ns: ['*'] });
    const { publicKey } = generateKeyPairSync('ed25519');
    const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const res = await runMutate(ctx, defaultAdminToken, {
      [`${SYSTEM_NAMESPACE}/createKey`]: {
        params: {
          id: 'cap-1',
          kid: 'cap-1',
          name: 'wrong-cap',
          algorithm: 'EdDSA',
          publicKey: pem,
          namespaces: encodeList(['default']),
          capabilities: encodeList(['read'])
        },
        fields: { id: true }
      }
    });
    const env = jsonBody<PackEnvelope>(res);
    const err = (env.errors ?? []).find((e) => e.path?.[0] === `${SYSTEM_NAMESPACE}/createKey`);
    expect(err?.code).toBe('policy_denied');

    // Token carrying the overridden capability name succeeds.
    const correctToken = mkFileToken({
      capabilities: ['role=admin', 'mutate'],
      ns: ['*']
    });
    const okRes = await runMutate(ctx, correctToken, {
      [`${SYSTEM_NAMESPACE}/createKey`]: {
        params: {
          id: 'cap-2',
          kid: 'cap-2',
          name: 'right-cap',
          algorithm: 'EdDSA',
          publicKey: pem,
          namespaces: encodeList(['default']),
          capabilities: encodeList(['read'])
        },
        fields: { id: true }
      }
    });
    const okEnv = jsonBody<PackEnvelope>(okRes);
    expect(okEnv.errors).toBeUndefined();
  });
});

describe('apps/substrate § compose auth wiring', () => {
  it('compose does not create a KeyRegistry when auth is omitted', async () => {
    // No auth → no priming. Smoke-test: compose completes without error and
    // the default route still works without a bearer.
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
      const res = await server.inject({
        method: 'POST',
        path: '/substrate/v1/query',
        headers: { 'content-type': 'application/json' },
        body: Buffer.from(
          JSON.stringify({
            'default/Todo': { params: { limit: 1 }, fields: { id: true } }
          })
        )
      });
      expect(res.status).toBe(200);
    } finally {
      await composed.stop();
    }
  });

  it('compose does not mutate the caller-provided AuthConfig', async () => {
    const server = new MemorySubstrateServer();
    const dataset = new MemoryDataset({ namespace: 'default' });
    const substrateDataset = new MemoryDataset({ namespace: SYSTEM_NAMESPACE });
    const callerCfg: AuthConfig = {
      keys: [{ kid: FILE_KID, alg: 'HS256', publicKey: SECRET }],
      adminCapability: ADMIN_CAP
    };
    const composed = await compose({
      systemActor: 'test',
      server,
      dataset,
      datasets: { [SYSTEM_NAMESPACE]: substrateDataset },
      auth: callerCfg,
      streamTicketSecret: 'test-stream-ticket-secret'
    });
    try {
      // The original AuthConfig must remain untouched — compose threads the
      // registry via a derived copy.
      expect((callerCfg as { keyRegistry?: unknown }).keyRegistry).toBeUndefined();
    } finally {
      await composed.stop();
    }
  });
});

describe('apps/substrate § Invite admin surface', () => {
  let ctx: ServerCtx | null = null;
  afterEach(async () => {
    if (ctx !== null) {
      await ctx.composed.stop();
      ctx = null;
    }
  });

  it('admin can update a Invite record (consumedAt / consumedBy)', async () => {
    ctx = await mkServer();
    const exp = new Date(Date.now() + 3_600_000).toISOString();
    const created = await runMutate(ctx, adminToken(), {
      [`${SYSTEM_NAMESPACE}/createInvite`]: {
        params: {
          id: 'inv-u1',
          namespaces: encodeList(['default']),
          capabilities: encodeList(['read']),
          expiresAt: exp
        },
        fields: { id: true }
      }
    });
    expect(created.status).toBe(200);

    const updated = await runMutate(ctx, adminToken(), {
      [`${SYSTEM_NAMESPACE}/updateInvite`]: {
        params: {
          id: 'inv-u1',
          consumedAt: new Date().toISOString(),
          consumedBy: 'kid-consumed'
        },
        fields: { id: true, consumedBy: true }
      }
    });
    expect(updated.status).toBe(200);
    const env = jsonBody<PackEnvelope>(updated);
    expect(env.errors).toBeUndefined();
  });

  it('admin can delete a Invite record', async () => {
    ctx = await mkServer();
    await runMutate(ctx, adminToken(), {
      [`${SYSTEM_NAMESPACE}/createInvite`]: {
        params: {
          id: 'inv-d1',
          namespaces: encodeList(['default']),
          capabilities: encodeList(['read']),
          expiresAt: new Date(Date.now() + 60_000).toISOString()
        },
        fields: { id: true }
      }
    });
    const delRes = await runMutate(ctx, adminToken(), {
      [`${SYSTEM_NAMESPACE}/deleteInvite`]: {
        params: { id: 'inv-d1' },
        fields: { id: true }
      }
    });
    expect(delRes.status).toBe(200);
    const env = jsonBody<PackEnvelope>(delRes);
    expect(env.errors).toBeUndefined();
  });

  it('purgeInvite requires admin capability (via the purge adminCapability)', async () => {
    ctx = await mkServer();
    await runMutate(ctx, adminToken(), {
      [`${SYSTEM_NAMESPACE}/createInvite`]: {
        params: {
          id: 'inv-p1',
          namespaces: encodeList(['default']),
          capabilities: encodeList(['read']),
          expiresAt: new Date(Date.now() + 60_000).toISOString()
        },
        fields: { id: true }
      }
    });
    const purgeRes = await runMutate(ctx, adminToken(), {
      [`${SYSTEM_NAMESPACE}/purgeInvite`]: {
        params: { id: 'inv-p1' },
        fields: { id: true, purged: true }
      }
    });
    expect(purgeRes.status).toBe(200);
    const env = jsonBody<PackEnvelope>(purgeRes);
    expect(env.errors).toBeUndefined();
  });
});

describe('apps/substrate § purgeKey invalidation', () => {
  let ctx: ServerCtx | null = null;
  afterEach(async () => {
    if (ctx !== null) {
      await ctx.composed.stop();
      ctx = null;
    }
  });

  it('purgeKey evicts the registry cache so subsequent tokens fail', async () => {
    ctx = await mkServer();
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    await runMutate(ctx, adminToken(), {
      [`${SYSTEM_NAMESPACE}/createKey`]: {
        params: {
          id: 'purge-kid',
          kid: 'purge-kid',
          name: 'to-purge',
          algorithm: 'EdDSA',
          publicKey: pem,
          namespaces: encodeList(['default']),
          capabilities: encodeList(['read'])
        },
        fields: { id: true }
      }
    });

    const token = signEdDSA(
      {
        sub: 'x',
        exp: Math.floor(Date.now() / 1000) + 60,
        capabilities: ['read'],
        ns: ['default']
      },
      privateKey,
      { kid: 'purge-kid' }
    );
    // Works before purge.
    const okRes = await runQuery(ctx, token, {
      'default/Todo': { params: { limit: 1 }, fields: { id: true } }
    });
    expect(okRes.status).toBe(200);

    const purgeRes = await runMutate(ctx, adminToken(), {
      [`${SYSTEM_NAMESPACE}/purgeKey`]: {
        params: { id: 'purge-kid' },
        fields: { id: true, purged: true }
      }
    });
    expect(purgeRes.status).toBe(200);
    const purgeEnv = jsonBody<PackEnvelope>(purgeRes);
    expect(purgeEnv.errors).toBeUndefined();

    const failRes = await runQuery(ctx, token, {
      'default/Todo': { params: { limit: 1 }, fields: { id: true } }
    });
    expect(failRes.status).toBe(401);
  });
});

describe('apps/substrate § isKeyAlgorithm', () => {
  it('accepts the three supported asymmetric algs', async () => {
    const { isKeyAlgorithm } = await import('@mnmal-ai/substrate-compose');
    expect(isKeyAlgorithm('EdDSA')).toBe(true);
    expect(isKeyAlgorithm('RS256')).toBe(true);
    expect(isKeyAlgorithm('ES256')).toBe(true);
  });

  it('rejects HS256 and anything else', async () => {
    const { isKeyAlgorithm } = await import('@mnmal-ai/substrate-compose');
    expect(isKeyAlgorithm('HS256')).toBe(false);
    expect(isKeyAlgorithm('none')).toBe(false);
    expect(isKeyAlgorithm('')).toBe(false);
    expect(isKeyAlgorithm(42)).toBe(false);
    expect(isKeyAlgorithm(null)).toBe(false);
    expect(isKeyAlgorithm(undefined)).toBe(false);
  });
});

describe('apps/substrate § KeyRegistry priming edge cases', () => {
  it('primeFromDataset on an empty dataset leaves the cache empty', async () => {
    const dataset = new MemoryDataset({ namespace: SYSTEM_NAMESPACE });
    const registry = createKeyRegistry({ dataset });
    await registry.primeFromDataset();
    expect(registry.lookup('anything')).toBeNull();
  });

  it('primeFromDataset called twice reloads the cache (clears stale entries)', async () => {
    const dataset = new MemoryDataset({ namespace: SYSTEM_NAMESPACE });
    const registry = createKeyRegistry({ dataset });
    await dataset.write(KEY_TYPE, [
      {
        id: 'first',
        kid: 'first',
        name: 'a',
        algorithm: 'EdDSA',
        publicKey: '-----BEGIN PUBLIC KEY-----\n\n-----END PUBLIC KEY-----',
        namespaces: 'default',
        capabilities: 'read',
        revokedAt: null
      }
    ]);
    await registry.primeFromDataset();
    expect(registry.lookup('first')).not.toBeNull();
    // Hard-delete the row by wiping the dataset entirely and re-priming.
    await dataset.purge(KEY_TYPE, ['first']);
    await registry.primeFromDataset();
    expect(registry.lookup('first')).toBeNull();
  });

  it('refresh on a missing kid evicts any stale cache entry', async () => {
    const dataset = new MemoryDataset({ namespace: SYSTEM_NAMESPACE });
    const registry = createKeyRegistry({ dataset });
    await dataset.write(KEY_TYPE, [
      {
        id: 'stale',
        kid: 'stale',
        name: 'a',
        algorithm: 'EdDSA',
        publicKey: '-----BEGIN PUBLIC KEY-----\n\n-----END PUBLIC KEY-----',
        namespaces: 'default',
        capabilities: 'read',
        revokedAt: null
      }
    ]);
    await registry.primeFromDataset();
    expect(registry.lookup('stale')).not.toBeNull();
    await dataset.purge(KEY_TYPE, ['stale']);
    await registry.refresh('stale');
    expect(registry.lookup('stale')).toBeNull();
  });

  it('refresh updates an existing cache entry with new field values', async () => {
    const dataset = new MemoryDataset({ namespace: SYSTEM_NAMESPACE });
    const registry = createKeyRegistry({ dataset });
    await dataset.write(KEY_TYPE, [
      {
        id: 'upd',
        kid: 'upd',
        name: 'original',
        algorithm: 'EdDSA',
        publicKey: '-----BEGIN PUBLIC KEY-----\nA\n-----END PUBLIC KEY-----',
        namespaces: 'default',
        capabilities: 'read',
        revokedAt: null
      }
    ]);
    await registry.primeFromDataset();
    const first = registry.lookup('upd');
    expect(first?.capabilities).toEqual(['read']);

    await dataset.updateField({ type: KEY_TYPE, id: 'upd' }, 'capabilities', 'read,mutate');
    await registry.refresh('upd');
    const second = registry.lookup('upd');
    expect(second?.capabilities).toEqual(['read', 'mutate']);
  });
});

/**
 * `AuditEvent` emission tests (§5.12 audit trail).
 *
 * Coverage:
 *   1. createKey → emits `key_created` inside the same tx
 *   2. updateKey with revokedAt → emits `key_revoked`; plain rename does NOT emit
 *   3. createInvite → emits `invite_created`
 *   4. /register flow → emits `invite_consumed` with clientIp captured per XFF trust rules
 *   5. bootstrap audit: seeded Key + no audit rows → exactly one bootstrap event after compose
 *   6. bootstrap idempotency: pre-existing bootstrap row → compose does NOT re-emit
 *   7. audit-emit failure propagates: mock a faulty AuditEvent write → parent mutation rolls back
 *   8. _system purge under SUBSTRATE_HARD_DELETE=refuse → emits `destructive_op_refused`
 *
 * Every test uses `MemorySubstrateServer` / `MemoryDataset`; no port binding.
 */

import { generateKeyPairSync } from 'node:crypto';
import {
  AUDIT_EVENT_TYPE,
  type AuthConfig,
  type ComposeResult,
  compose,
  createRateLimiter,
  encodeList,
  INVITE_TYPE,
  KEY_TYPE,
  type RateLimiter,
  SYSTEM_NAMESPACE,
  signHs256
} from '@mnmal-ai/substrate-compose';
import { MemoryDataset } from '@mnmal-ai/substrate-dataset-memory';
import { MemorySubstrateServer } from '@mnmal-ai/substrate-server-memory';
import type {
  Dataset,
  PackEnvelope,
  ReadParams,
  ReadResult,
  Row,
  SubstrateResponse,
  WriteOptions,
  WriteResult
} from '@mnmal-ai/substrate-types';
import { afterEach, describe, expect, it } from 'vitest';

const ADMIN_CAP = 'admin';
const SECRET = 'audit-test-secret';
const FILE_KID = 'audit-file-k1';

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
  return signHs256({ sub: 'auditor', exp: now + 60, ...claims }, SECRET, { kid: FILE_KID });
}

function adminToken(): string {
  return mkFileToken({ capabilities: [ADMIN_CAP, 'read', 'mutate'], ns: ['*'] });
}

interface ServerCtx {
  server: MemorySubstrateServer;
  composed: ComposeResult;
  substrateDataset: MemoryDataset;
  rateLimiter: RateLimiter;
}

interface MkServerOptions {
  substrateDataset?: Dataset;
  trustedProxies?: Set<string>;
}

async function mkServer(opts: MkServerOptions = {}): Promise<ServerCtx> {
  const server = new MemorySubstrateServer();
  const dataset = new MemoryDataset({ namespace: 'default' });
  const substrateDataset =
    (opts.substrateDataset as MemoryDataset | undefined) ??
    new MemoryDataset({ namespace: SYSTEM_NAMESPACE });
  const rateLimiter = createRateLimiter({ maxRequests: 100, windowMs: 60_000 });
  const composeOpts: Parameters<typeof compose>[0] = {
    systemActor: 'test',
    server,
    dataset,
    datasets: { [SYSTEM_NAMESPACE]: substrateDataset },
    auth: { ...authCfg },
    streamTicketSecret: 'test-stream-ticket-secret',
    registerRateLimiter: rateLimiter
  };
  if (opts.trustedProxies !== undefined) composeOpts.trustedProxies = opts.trustedProxies;
  const composed = await compose(composeOpts);
  await server.start();
  return { server, composed, substrateDataset: substrateDataset as MemoryDataset, rateLimiter };
}

interface RunMutateOptions {
  peerIp?: string;
  xff?: string;
}

async function runMutate(
  ctx: ServerCtx,
  token: string,
  body: Record<string, unknown>,
  opts: RunMutateOptions = {}
): Promise<SubstrateResponse> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${token}`,
    'content-type': 'application/json'
  };
  if (opts.xff !== undefined) headers['x-forwarded-for'] = opts.xff;
  return ctx.server.inject({
    method: 'POST',
    path: '/substrate/v1/mutate',
    headers,
    body: Buffer.from(JSON.stringify(body)),
    ...(opts.peerIp !== undefined ? { peerIp: opts.peerIp } : {})
  });
}

async function readAuditRows(dataset: Dataset, kind?: string): Promise<Array<Row>> {
  const res = await dataset.read(AUDIT_EVENT_TYPE, { limit: 1000 });
  if (kind === undefined) return res.rows;
  return res.rows.filter((r) => r.kind === kind);
}

import { useEnvSnapshot } from './_env-override.js';

// ---------------------------------------------------------------------------
// 1. createKey → emits key_created
// ---------------------------------------------------------------------------

describe('AuditEvent § createKey emits key_created', () => {
  let ctx: ServerCtx | null = null;
  afterEach(async () => {
    if (ctx !== null) {
      await ctx.composed.stop();
      ctx = null;
    }
  });

  it('createKey success writes exactly one key_created audit event with clientIp from trusted XFF', async () => {
    // The interceptor reads `ctx.clientIp`, which the HTTP route's
    // `buildContext` populates from the post-trust IP. A request from a
    // trusted proxy (10.0.0.1) with an XFF header should surface the leftmost
    // XFF entry on the audit row.
    ctx = await mkServer({ trustedProxies: new Set(['10.0.0.1']) });
    // Baseline — at this point the dataset has no keys → no bootstrap event.
    const before = await readAuditRows(ctx.substrateDataset);
    expect(before).toHaveLength(0);

    const { publicKey } = generateKeyPairSync('ed25519');
    const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const res = await runMutate(
      ctx,
      adminToken(),
      {
        [`${SYSTEM_NAMESPACE}/createKey`]: {
          params: {
            id: 'audit-key-1',
            kid: 'audit-key-1',
            name: 'audit-test',
            algorithm: 'EdDSA',
            publicKey: pem,
            namespaces: encodeList(['default']),
            capabilities: encodeList(['read'])
          },
          fields: { id: true }
        }
      },
      { peerIp: '10.0.0.1', xff: '1.2.3.4' }
    );
    expect(res.status).toBe(200);
    const env = jsonBody<PackEnvelope>(res);
    expect(env.errors).toBeUndefined();

    const events = await readAuditRows(ctx.substrateDataset, 'key_created');
    expect(events).toHaveLength(1);
    const ev = events[0];
    expect(ev).toBeDefined();
    expect(ev?.actorKid).toBe(FILE_KID);
    expect(ev?.targetKid).toBe('audit-key-1');
    // §5.12 trust gating: trusted peer → XFF honoured on the audit row.
    expect(ev?.clientIp).toBe('1.2.3.4');
    const details = ev?.details as Record<string, unknown>;
    expect(details.name).toBe('audit-test');
    expect(details.capabilities).toBe(encodeList(['read']));
    expect(details.namespaces).toBe(encodeList(['default']));
  });

  it('audit row carries _metadata.createdBy from the request identity', async () => {
    // `emitAuditInTx` threads `{ identity: resolveIdentity(ctx), now }` into
    // `dataset.write`, so the substrate stamps `_metadata.createdBy`.
    //
    // The token is a file-registry verification (`mkServer` provisions
    // FILE_KID), so auth attaches `tokenId: sub` and resolveIdentity returns
    // `{ kind: 'user', id: 'auditor' }` — the JWT `sub`.
    ctx = await mkServer({ trustedProxies: new Set(['10.0.0.1']) });
    const { publicKey } = generateKeyPairSync('ed25519');
    const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const res = await runMutate(
      ctx,
      adminToken(),
      {
        [`${SYSTEM_NAMESPACE}/createKey`]: {
          params: {
            id: 'audit-meta-key',
            kid: 'audit-meta-key',
            name: 'audit-meta',
            algorithm: 'EdDSA',
            publicKey: pem,
            namespaces: encodeList(['default']),
            capabilities: encodeList(['read'])
          },
          fields: { id: true }
        }
      },
      { peerIp: '10.0.0.1', xff: '1.2.3.4' }
    );
    expect(res.status).toBe(200);

    const events = await readAuditRows(ctx.substrateDataset, 'key_created');
    expect(events).toHaveLength(1);
    const meta = events[0]?._metadata as
      | { createdBy?: { kind: string; id: string } | null }
      | undefined;
    expect(meta).toBeDefined();
    expect(meta?.createdBy).toEqual({ kind: 'user', id: 'auditor' });
  });
});

// ---------------------------------------------------------------------------
// 2. updateKey revocation + non-revocation
// ---------------------------------------------------------------------------

describe('AuditEvent § updateKey', () => {
  let ctx: ServerCtx | null = null;
  afterEach(async () => {
    if (ctx !== null) {
      await ctx.composed.stop();
      ctx = null;
    }
  });

  it('updateKey with revokedAt emits key_revoked with clientIp from trusted XFF', async () => {
    // Revocation path also threads ctx.clientIp through.
    ctx = await mkServer({ trustedProxies: new Set(['10.0.0.1']) });
    const { publicKey } = generateKeyPairSync('ed25519');
    const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    await runMutate(
      ctx,
      adminToken(),
      {
        [`${SYSTEM_NAMESPACE}/createKey`]: {
          params: {
            id: 'to-revoke',
            kid: 'to-revoke',
            name: 'target',
            algorithm: 'EdDSA',
            publicKey: pem,
            namespaces: encodeList(['default']),
            capabilities: encodeList(['read'])
          },
          fields: { id: true }
        }
      },
      { peerIp: '10.0.0.1', xff: '1.2.3.4' }
    );

    const pastIso = new Date(Date.now() - 60_000).toISOString();
    const res = await runMutate(
      ctx,
      adminToken(),
      {
        [`${SYSTEM_NAMESPACE}/updateKey`]: {
          params: { id: 'to-revoke', revokedAt: pastIso },
          fields: { id: true }
        }
      },
      { peerIp: '10.0.0.1', xff: '5.6.7.8' }
    );
    expect(res.status).toBe(200);
    const env = jsonBody<PackEnvelope>(res);
    expect(env.errors).toBeUndefined();

    const revokedEvents = await readAuditRows(ctx.substrateDataset, 'key_revoked');
    expect(revokedEvents).toHaveLength(1);
    const ev = revokedEvents[0];
    expect(ev?.actorKid).toBe(FILE_KID);
    expect(ev?.targetKid).toBe('to-revoke');
    // Distinct IP per request — revocation audit carries the revocation's
    // clientIp, not the create's.
    expect(ev?.clientIp).toBe('5.6.7.8');
    const details = ev?.details as Record<string, unknown>;
    expect(details.revokedAt).toBe(pastIso);
  });

  it('updateKey without revokedAt (rename) does NOT emit key_revoked', async () => {
    ctx = await mkServer();
    const { publicKey } = generateKeyPairSync('ed25519');
    const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    await runMutate(ctx, adminToken(), {
      [`${SYSTEM_NAMESPACE}/createKey`]: {
        params: {
          id: 'rename-kid',
          kid: 'rename-kid',
          name: 'original-name',
          algorithm: 'EdDSA',
          publicKey: pem,
          namespaces: encodeList(['default']),
          capabilities: encodeList(['read'])
        },
        fields: { id: true }
      }
    });

    const res = await runMutate(ctx, adminToken(), {
      [`${SYSTEM_NAMESPACE}/updateKey`]: {
        params: { id: 'rename-kid', name: 'renamed' },
        fields: { id: true, name: true }
      }
    });
    expect(res.status).toBe(200);
    const env = jsonBody<PackEnvelope>(res);
    expect(env.errors).toBeUndefined();

    const revokedEvents = await readAuditRows(ctx.substrateDataset, 'key_revoked');
    expect(revokedEvents).toHaveLength(0);
    // The create event is still there.
    const created = await readAuditRows(ctx.substrateDataset, 'key_created');
    expect(created).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 3. createInvite → emits invite_created
// ---------------------------------------------------------------------------

describe('AuditEvent § createInvite emits invite_created', () => {
  let ctx: ServerCtx | null = null;
  afterEach(async () => {
    if (ctx !== null) {
      await ctx.composed.stop();
      ctx = null;
    }
  });

  it('createInvite via engine.mutate emits exactly one invite_created event with clientIp from trusted XFF', async () => {
    // Invite path also threads ctx.clientIp.
    ctx = await mkServer({ trustedProxies: new Set(['10.0.0.1']) });
    const exp = new Date(Date.now() + 3_600_000).toISOString();
    const res = await runMutate(
      ctx,
      adminToken(),
      {
        [`${SYSTEM_NAMESPACE}/createInvite`]: {
          params: {
            id: 'invite-audit-1',
            namespaces: encodeList(['default']),
            capabilities: encodeList(['read']),
            expiresAt: exp
          },
          fields: { id: true }
        }
      },
      { peerIp: '10.0.0.1', xff: '1.2.3.4' }
    );
    expect(res.status).toBe(200);
    const env = jsonBody<PackEnvelope>(res);
    expect(env.errors).toBeUndefined();

    const events = await readAuditRows(ctx.substrateDataset, 'invite_created');
    expect(events).toHaveLength(1);
    const ev = events[0];
    expect(ev?.actorKid).toBe(FILE_KID);
    expect(ev?.targetKid).toBe('invite-audit-1');
    expect(ev?.clientIp).toBe('1.2.3.4');
    const details = ev?.details as Record<string, unknown>;
    expect(details.capabilities).toBe(encodeList(['read']));
    expect(details.namespaces).toBe(encodeList(['default']));
    expect(details.expiresAt).toBe(exp);
  });

  it('interceptor audit on untrusted peer records peerIp, not XFF', async () => {
    // The interceptor never re-applies trust — it reads whatever
    // buildContext stashed. Untrusted peer + XFF → buildContext records the
    // peer IP (not the spoofable XFF) and the audit row gets that same IP.
    ctx = await mkServer({ trustedProxies: new Set(['10.0.0.1']) });
    const exp = new Date(Date.now() + 3_600_000).toISOString();
    const res = await runMutate(
      ctx,
      adminToken(),
      {
        [`${SYSTEM_NAMESPACE}/createInvite`]: {
          params: {
            id: 'invite-untrusted',
            namespaces: encodeList(['default']),
            capabilities: encodeList(['read']),
            expiresAt: exp
          },
          fields: { id: true }
        }
      },
      { peerIp: '99.99.99.99', xff: '1.2.3.4' }
    );
    expect(res.status).toBe(200);
    const env = jsonBody<PackEnvelope>(res);
    expect(env.errors).toBeUndefined();

    const events = await readAuditRows(ctx.substrateDataset, 'invite_created');
    expect(events).toHaveLength(1);
    const ev = events[0];
    // Trust gate: XFF ignored since peer is not in the trusted set.
    expect(ev?.clientIp).toBe('99.99.99.99');
  });

  it('interceptor audit with no peerIp records clientIp as null', async () => {
    // The route didn't see a peer, so `extractClientIp` returns
    // undefined; `buildContext` omits the optional `clientIp`; the audit
    // builder's `?? null` fallback lands as a null column in the row.
    ctx = await mkServer();
    const exp = new Date(Date.now() + 3_600_000).toISOString();
    const res = await runMutate(ctx, adminToken(), {
      [`${SYSTEM_NAMESPACE}/createInvite`]: {
        params: {
          id: 'invite-no-peer',
          namespaces: encodeList(['default']),
          capabilities: encodeList(['read']),
          expiresAt: exp
        },
        fields: { id: true }
      }
    });
    expect(res.status).toBe(200);
    const env = jsonBody<PackEnvelope>(res);
    expect(env.errors).toBeUndefined();

    const events = await readAuditRows(ctx.substrateDataset, 'invite_created');
    expect(events).toHaveLength(1);
    const ev = events[0];
    // Audit row's clientIp is null (`buildAuditRow`'s `?? null` default fires
    // when `ctx.clientIp` is undefined).
    expect(ev?.clientIp).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 4. /register → emits invite_consumed with clientIp per XFF trust rules
// ---------------------------------------------------------------------------

describe('AuditEvent § /register emits invite_consumed with clientIp', () => {
  let ctx: ServerCtx | null = null;
  afterEach(async () => {
    if (ctx !== null) {
      await ctx.composed.stop();
      ctx = null;
    }
  });

  it('/register success through a trusted proxy records clientIp from XFF', async () => {
    ctx = await mkServer({ trustedProxies: new Set(['10.0.0.1']) });

    // Mint an invite via the admin route.
    const mintRes = await ctx.server.inject({
      method: 'POST',
      path: '/substrate/v1/_system/invites',
      headers: {
        authorization: `Bearer ${adminToken()}`,
        'content-type': 'application/json'
      },
      body: Buffer.from(
        JSON.stringify({
          namespaces: ['default'],
          capabilities: ['read']
        })
      )
    });
    expect(mintRes.status).toBe(201);
    const { code } = jsonBody<{ code: string }>(mintRes);

    const { publicKey } = generateKeyPairSync('ed25519');
    const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    // peerIp=10.0.0.1 is in trustedProxies, so XFF's leftmost entry '1.2.3.4'
    // is honoured.
    const regRes = await ctx.server.inject({
      method: 'POST',
      path: '/substrate/v1/_system/register',
      headers: {
        'content-type': 'application/json',
        'x-forwarded-for': '1.2.3.4'
      },
      peerIp: '10.0.0.1',
      body: Buffer.from(
        JSON.stringify({
          code,
          publicKey: pem,
          keyName: 'audit-e2e',
          algorithm: 'EdDSA'
        })
      )
    });
    expect(regRes.status).toBe(201);
    const { kid } = jsonBody<{ kid: string }>(regRes);

    const events = await readAuditRows(ctx.substrateDataset, 'invite_consumed');
    expect(events).toHaveLength(1);
    const ev = events[0];
    // The actor IS the new kid — it performs its own registration.
    expect(ev?.actorKid).toBe(kid);
    expect(ev?.targetKid).toBe(code);
    expect(ev?.clientIp).toBe('1.2.3.4');
    const details = ev?.details as Record<string, unknown>;
    expect(details.consumedBy).toBe(kid);
  });

  it('invite_consumed audit row carries _metadata.createdBy = agent/<new kid>', async () => {
    // The new kid performs its own registration, so the audit write carries
    // `{ kind: 'agent', id: kid }` as `_metadata.createdBy` — the same
    // identity used on the Key insert.
    ctx = await mkServer({ trustedProxies: new Set(['10.0.0.1']) });

    const mintRes = await ctx.server.inject({
      method: 'POST',
      path: '/substrate/v1/_system/invites',
      headers: {
        authorization: `Bearer ${adminToken()}`,
        'content-type': 'application/json'
      },
      body: Buffer.from(
        JSON.stringify({
          namespaces: ['default'],
          capabilities: ['read']
        })
      )
    });
    expect(mintRes.status).toBe(201);
    const { code } = jsonBody<{ code: string }>(mintRes);

    const { publicKey } = generateKeyPairSync('ed25519');
    const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const regRes = await ctx.server.inject({
      method: 'POST',
      path: '/substrate/v1/_system/register',
      headers: {
        'content-type': 'application/json',
        'x-forwarded-for': '1.2.3.4'
      },
      peerIp: '10.0.0.1',
      body: Buffer.from(
        JSON.stringify({
          code,
          publicKey: pem,
          keyName: 'audit-e2e-meta',
          algorithm: 'EdDSA'
        })
      )
    });
    expect(regRes.status).toBe(201);
    const { kid } = jsonBody<{ kid: string }>(regRes);

    const events = await readAuditRows(ctx.substrateDataset, 'invite_consumed');
    expect(events).toHaveLength(1);
    const meta = events[0]?._metadata as
      | { createdBy?: { kind: string; id: string } | null }
      | undefined;
    expect(meta?.createdBy).toEqual({ kind: 'agent', id: kid });
  });
});

// ---------------------------------------------------------------------------
// 5 + 6. Bootstrap event emission / idempotency
// ---------------------------------------------------------------------------

describe('AuditEvent § bootstrap event', () => {
  it('seeded dataset with a Key and no audit rows gets exactly one bootstrap event', async () => {
    const dataset = new MemoryDataset({ namespace: SYSTEM_NAMESPACE });
    await dataset.write(KEY_TYPE, [
      {
        id: 'seed-kid-1',
        kid: 'seed-kid-1',
        name: 'seeded',
        algorithm: 'EdDSA',
        publicKey: '-----BEGIN PUBLIC KEY-----\nstub\n-----END PUBLIC KEY-----',
        namespaces: 'default',
        capabilities: 'read',
        revokedAt: null
      }
    ]);
    // Verify the dataset has no audit rows yet.
    expect(await readAuditRows(dataset)).toHaveLength(0);

    const ctx = await mkServer({ substrateDataset: dataset });
    try {
      const events = await readAuditRows(dataset, 'bootstrap');
      expect(events).toHaveLength(1);
      const ev = events[0];
      expect(ev?.actorKid).toBe('bootstrap');
      const details = ev?.details as Record<string, unknown>;
      expect(details.bootKeyKid).toBe('seed-kid-1');
      expect(details.bootKeyName).toBe('seeded');
    } finally {
      await ctx.composed.stop();
    }
  });

  it('compose on a dataset that already has a bootstrap event does NOT emit a second', async () => {
    const dataset = new MemoryDataset({ namespace: SYSTEM_NAMESPACE });
    await dataset.write(KEY_TYPE, [
      {
        id: 'seed-kid-2',
        kid: 'seed-kid-2',
        name: 'seeded',
        algorithm: 'EdDSA',
        publicKey: '-----BEGIN PUBLIC KEY-----\nstub\n-----END PUBLIC KEY-----',
        namespaces: 'default',
        capabilities: 'read',
        revokedAt: null
      }
    ]);

    // First compose — should emit one bootstrap event.
    const first = await mkServer({ substrateDataset: dataset });
    try {
      const afterFirst = await readAuditRows(dataset, 'bootstrap');
      expect(afterFirst).toHaveLength(1);
    } finally {
      await first.composed.stop();
    }

    // Second compose against the same dataset — no new bootstrap event.
    const second = await mkServer({ substrateDataset: dataset });
    try {
      const afterSecond = await readAuditRows(dataset, 'bootstrap');
      expect(afterSecond).toHaveLength(1);
    } finally {
      await second.composed.stop();
    }
  });

  it('empty dataset produces no bootstrap event (lazy — waits for the first key)', async () => {
    const dataset = new MemoryDataset({ namespace: SYSTEM_NAMESPACE });
    const ctx = await mkServer({ substrateDataset: dataset });
    try {
      const events = await readAuditRows(dataset, 'bootstrap');
      expect(events).toHaveLength(0);
    } finally {
      await ctx.composed.stop();
    }
  });

  it('bootstrap audit row carries _metadata.createdBy = system/bootstrap', async () => {
    // `backfillBootstrapAuditIfNeeded` runs at compose time with no
    // `RequestContext`, so `_metadata.createdBy` mirrors the body's
    // `actorKid: 'bootstrap'` as `{ kind: 'system', id: 'bootstrap' }`.
    const dataset = new MemoryDataset({ namespace: SYSTEM_NAMESPACE });
    await dataset.write(KEY_TYPE, [
      {
        id: 'seed-kid-meta',
        kid: 'seed-kid-meta',
        name: 'seeded',
        algorithm: 'EdDSA',
        publicKey: '-----BEGIN PUBLIC KEY-----\nstub\n-----END PUBLIC KEY-----',
        namespaces: 'default',
        capabilities: 'read',
        revokedAt: null
      }
    ]);

    const ctx = await mkServer({ substrateDataset: dataset });
    try {
      const events = await readAuditRows(dataset, 'bootstrap');
      expect(events).toHaveLength(1);
      const meta = events[0]?._metadata as
        | { createdBy?: { kind: string; id: string } | null }
        | undefined;
      expect(meta?.createdBy).toEqual({ kind: 'system', id: 'bootstrap' });
    } finally {
      await ctx.composed.stop();
    }
  });
});

// ---------------------------------------------------------------------------
// 7. Kill-switch refusal: _system purge interceptors emit destructive_op_refused
// ---------------------------------------------------------------------------

/**
 * When `SUBSTRATE_HARD_DELETE=refuse` is set on the process, every
 * `_system` purge interceptor (`purgeKey`, `purgeInvite`,
 * `purgeAuditEvent`) catches the resolver-layer `ResolverFrameError`,
 * writes a `destructive_op_refused` audit row via the install closure's
 * `_system` dataset, then re-throws so the engine surfaces a `code:
 * 'destructive_ops_disabled'` envelope error to the client. Re-throw is
 * load-bearing — without it the client sees a successful no-op.
 */
describe('AuditEvent § _system purge interceptors under SUBSTRATE_HARD_DELETE=refuse', () => {
  useEnvSnapshot('SUBSTRATE_HARD_DELETE');
  let ctx: ServerCtx | null = null;

  afterEach(async () => {
    if (ctx !== null) {
      await ctx.composed.stop();
      ctx = null;
    }
  });

  it('purgeKey under refuse: target persists, envelope error surfaces, audit row written', async () => {
    // Provision a server WITHOUT the kill switch so we can seed a key, then
    // flip it to `refuse` before issuing the purge; the gate fires only at
    // apply time.
    ctx = await mkServer();
    const { publicKey } = generateKeyPairSync('ed25519');
    const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const seedRes = await runMutate(ctx, adminToken(), {
      [`${SYSTEM_NAMESPACE}/createKey`]: {
        params: {
          id: 'killswitch-key-1',
          kid: 'killswitch-key-1',
          name: 'killswitch-target',
          algorithm: 'EdDSA',
          publicKey: pem,
          namespaces: encodeList(['default']),
          capabilities: encodeList(['read'])
        },
        fields: { id: true }
      }
    });
    expect(seedRes.status).toBe(200);

    // Flip the switch and attempt purge. (`useEnvSnapshot` already saved the
    // pre-test value — we just set the override here.)
    process.env.SUBSTRATE_HARD_DELETE = 'refuse';

    const res = await runMutate(ctx, adminToken(), {
      [`${SYSTEM_NAMESPACE}/purgeKey`]: {
        params: { id: 'killswitch-key-1' },
        fields: { id: true }
      }
    });
    expect(res.status).toBe(200);
    const env = jsonBody<PackEnvelope>(res);
    expect(env.errors).toBeDefined();
    expect(env.errors?.[0]?.code).toBe('destructive_ops_disabled');

    // Target row STILL present — the gate fired before any state mutation.
    const stillThere = await ctx.substrateDataset.read(KEY_TYPE, {
      where: { id: { eq: 'killswitch-key-1' } },
      limit: 1
    });
    expect(stillThere.rows).toHaveLength(1);

    // Refusal audit row written with the correct surface + targetKid.
    const refused = await readAuditRows(ctx.substrateDataset, 'destructive_op_refused');
    expect(refused).toHaveLength(1);
    const ev = refused[0];
    expect(ev?.actorKid).toBe(FILE_KID);
    expect(ev?.targetKid).toBe('killswitch-key-1');
    const details = ev?.details as Record<string, unknown>;
    expect(details.surface).toBe('purge_substrate_key');
  });

  it('purgeInvite under refuse: target persists, envelope error surfaces, audit row written', async () => {
    ctx = await mkServer();
    const exp = new Date(Date.now() + 3_600_000).toISOString();
    const seedRes = await runMutate(ctx, adminToken(), {
      [`${SYSTEM_NAMESPACE}/createInvite`]: {
        params: {
          id: 'killswitch-invite-1',
          namespaces: encodeList(['default']),
          capabilities: encodeList(['read']),
          expiresAt: exp
        },
        fields: { id: true }
      }
    });
    expect(seedRes.status).toBe(200);

    process.env.SUBSTRATE_HARD_DELETE = 'refuse';

    const res = await runMutate(ctx, adminToken(), {
      [`${SYSTEM_NAMESPACE}/purgeInvite`]: {
        params: { id: 'killswitch-invite-1' },
        fields: { id: true }
      }
    });
    expect(res.status).toBe(200);
    const env = jsonBody<PackEnvelope>(res);
    expect(env.errors).toBeDefined();
    expect(env.errors?.[0]?.code).toBe('destructive_ops_disabled');

    const stillThere = await ctx.substrateDataset.read(INVITE_TYPE, {
      where: { id: { eq: 'killswitch-invite-1' } },
      limit: 1
    });
    expect(stillThere.rows).toHaveLength(1);

    const refused = await readAuditRows(ctx.substrateDataset, 'destructive_op_refused');
    expect(refused).toHaveLength(1);
    const ev = refused[0];
    expect(ev?.actorKid).toBe(FILE_KID);
    expect(ev?.targetKid).toBe('killswitch-invite-1');
    const details = ev?.details as Record<string, unknown>;
    expect(details.surface).toBe('purge_substrate_invite');
  });

  it('purgeAuditEvent under refuse: target persists, envelope error surfaces, audit row written', async () => {
    // Seed an audit row directly via the dataset (bypassing engine policy /
    // tx) so we have a known purge target. Any kind works — `bootstrap` is
    // arbitrary; we just need a row by id.
    ctx = await mkServer();
    const targetId = 'audit-row-to-purge';
    await ctx.substrateDataset.write(AUDIT_EVENT_TYPE, [
      {
        id: targetId,
        ts: new Date().toISOString(),
        actorKid: 'seed',
        kind: 'bootstrap',
        targetKid: null,
        clientIp: null,
        details: { seeded: true }
      }
    ]);

    process.env.SUBSTRATE_HARD_DELETE = 'refuse';

    const res = await runMutate(ctx, adminToken(), {
      [`${SYSTEM_NAMESPACE}/purgeAuditEvent`]: {
        params: { id: targetId },
        fields: { id: true }
      }
    });
    expect(res.status).toBe(200);
    const env = jsonBody<PackEnvelope>(res);
    expect(env.errors).toBeDefined();
    expect(env.errors?.[0]?.code).toBe('destructive_ops_disabled');

    // Target audit row STILL present.
    const stillThere = await ctx.substrateDataset.read(AUDIT_EVENT_TYPE, {
      where: { id: { eq: targetId } },
      limit: 1
    });
    expect(stillThere.rows).toHaveLength(1);

    // Refusal audit row written separately, with the correct surface.
    const refused = await readAuditRows(ctx.substrateDataset, 'destructive_op_refused');
    expect(refused).toHaveLength(1);
    const ev = refused[0];
    expect(ev?.actorKid).toBe(FILE_KID);
    expect(ev?.targetKid).toBe(targetId);
    const details = ev?.details as Record<string, unknown>;
    expect(details.surface).toBe('purge_substrate_audit_event');
  });
});

// ---------------------------------------------------------------------------
// 8. Audit-emit failure propagates (atomicity)
// ---------------------------------------------------------------------------

/**
 * Wraps a dataset so writes to AuditEvent reject. Since interceptor emits
 * run inside the engine's tx via `args.dataset` (the tx handle from
 * `withTransaction`), a throw on the audit write rolls back the enclosing tx
 * — the Key write from the base resolver never commits.
 */
class AuditFailingDataset implements Dataset {
  readonly #inner: Dataset;
  readonly namespace: string;
  readonly txScopeId: string;

  constructor(inner: Dataset) {
    this.#inner = inner;
    this.namespace = inner.namespace;
    this.txScopeId = inner.txScopeId;
  }

  get capabilities(): Dataset['capabilities'] {
    return this.#inner.capabilities;
  }

  read(type: string, params: ReadParams): Promise<ReadResult> {
    return this.#inner.read(type, params);
  }

  write(type: string, rows: Array<Row>, options?: WriteOptions): Promise<WriteResult> {
    if (type === AUDIT_EVENT_TYPE) {
      return Promise.reject(new Error('synthetic audit write failure'));
    }
    return this.#inner.write(type, rows, options);
  }

  updateField: Dataset['updateField'] = (target, field, value) =>
    this.#inner.updateField(target, field, value);

  conditionalUpdate: Dataset['conditionalUpdate'] = (type, id, predicate, updates, actor, now) =>
    this.#inner.conditionalUpdate(type, id, predicate, updates, actor, now);

  tombstone: Dataset['tombstone'] = (type, ids) => this.#inner.tombstone(type, ids);

  purge: Dataset['purge'] = (type, ids) => this.#inner.purge(type, ids);

  dropType: Dataset['dropType'] = (type) => this.#inner.dropType(type);

  dropNamespace: Dataset['dropNamespace'] = () => this.#inner.dropNamespace();

  async withTransaction<T>(fn: (tx: Dataset) => Promise<T>): Promise<T> {
    return this.#inner.withTransaction(async (innerTx) => {
      const wrapped = new AuditFailingDataset(innerTx);
      return fn(wrapped);
    });
  }

  allocateShortId: Dataset['allocateShortId'] = (type) => this.#inner.allocateShortId(type);

  bindShortId: Dataset['bindShortId'] = (type, shortId, rowId) =>
    this.#inner.bindShortId(type, shortId, rowId);

  resolveShortId: Dataset['resolveShortId'] = (type, shortId) =>
    this.#inner.resolveShortId(type, shortId);

  getShortIdForRow: Dataset['getShortIdForRow'] = (type, rowId) =>
    this.#inner.getShortIdForRow(type, rowId);

  forNamespace: Dataset['forNamespace'] = (ns) => this.#inner.forNamespace(ns);
}

describe('AuditEvent § emit-failure rolls back the parent mutation', () => {
  it('createKey with a faulty audit write throws and NO Key is persisted', async () => {
    const inner = new MemoryDataset({ namespace: SYSTEM_NAMESPACE });
    const faulty = new AuditFailingDataset(inner);
    const ctx = await mkServer({ substrateDataset: faulty as unknown as MemoryDataset });
    try {
      const { publicKey } = generateKeyPairSync('ed25519');
      const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
      // The audit emit throws a plain Error; the engine propagates it as a
      // top-level envelope error rather than a per-frame error, and the tx
      // rolls back. Either way, no Key row lands.
      let threw = false;
      let envelope: PackEnvelope | null = null;
      try {
        const res = await runMutate(ctx, adminToken(), {
          [`${SYSTEM_NAMESPACE}/createKey`]: {
            params: {
              id: 'rollback-kid',
              name: 'will-rollback',
              algorithm: 'EdDSA',
              publicKey: pem,
              namespaces: encodeList(['default']),
              capabilities: encodeList(['read'])
            },
            fields: { id: true }
          }
        });
        // If the engine surfaces the throw as a 500 / envelope error, res is
        // still defined. The invariant is that the key row was NOT committed.
        if (res.status >= 500) {
          threw = true;
        } else {
          envelope = jsonBody<PackEnvelope>(res);
        }
      } catch {
        threw = true;
      }

      // Either the call threw outright, or it returned a response that flagged
      // the failure. In either case the key write MUST NOT have landed.
      if (!threw && envelope !== null) {
        // An errors array on the envelope is also an acceptable "failed"
        // signal; the atomicity invariant is the key row is absent.
        // (Don't assert specific shape — the engine's surface for
        // plain-Error resolver failures is the atomicity contract, not the
        // envelope shape.)
      }

      const keyRead = await inner.read(KEY_TYPE, { id: 'rollback-kid' });
      expect(keyRead.rows).toHaveLength(0);
      // And no audit row landed either (the audit write itself threw).
      const auditRows = await readAuditRows(inner, 'key_created');
      expect(auditRows).toHaveLength(0);
    } finally {
      await ctx.composed.stop();
    }
  });
});

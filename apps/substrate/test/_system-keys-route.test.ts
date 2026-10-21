/**
 * `POST /substrate/v1/_system/keys` — admin-gated key registration.
 *
 * The property under test: **when the directory row cannot be written, the
 * credential must not be written either.** Two independent mechanisms have to
 * hold for that:
 *
 *   1. the PRE-FLIGHT (`engine.evaluateWritePolicy`) refuses before any write,
 *      because `policy_denied` does NOT throw inside the engine's transaction —
 *      it records into the envelope and returns, which would let the sibling
 *      credential COMMIT.
 *   2. the cross-substrate refusal, which is what a memory-backed stack gets:
 *      `MemoryDataset.forNamespace` mints a fresh `txScopeId` and the
 *      class implements no `withScopedTransaction`, so a two-namespace frame
 *      is refused wholesale rather than half-applied.
 *
 * Cross-NAMESPACE atomicity is a pg property (one `sql` handle → one
 * `txScopeId` → `coalesced_tx_scope`) and is verified against pg, not here.
 * The happy path below therefore points the directory at a type inside
 * `_system` itself — deliberately contrived, and the only shape that exercises
 * assembly + atomic write + response reporting on a memory substrate.
 */

import { generateKeyPairSync } from 'node:crypto';
import {
  type AuthConfig,
  type ComposeResult,
  compose,
  INVITE_TYPE,
  KEY_TYPE,
  SYSTEM_NAMESPACE,
  signHs256
} from '@mnmal-ai/substrate-compose';
import { MemoryDataset } from '@mnmal-ai/substrate-dataset-memory';
import { MemorySubstrateServer } from '@mnmal-ai/substrate-server-memory';
import type { SubstrateResponse } from '@mnmal-ai/substrate-types';
import { afterEach, describe, expect, it } from 'vitest';
import { fixturePlugin } from './_fixtures/fixture-plugin.js';

const ADMIN_CAP = 'admin';
const SECRET = 'keys-route-secret';
const FILE_KID = 'file-k1';

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

function mkToken(claims: Record<string, unknown>): string {
  const now = Math.floor(Date.now() / 1000);
  return signHs256({ sub: 'tester', exp: now + 60, ...claims }, SECRET, { kid: FILE_KID });
}

const adminToken = (): string =>
  mkToken({ capabilities: [ADMIN_CAP, 'read', 'mutate'], ns: ['*'] });
const nonAdminToken = (): string => mkToken({ capabilities: ['read', 'mutate'], ns: ['*'] });
/** Admin, but scoped to `_system` only — cannot write a directory elsewhere. */
const substrateOnlyAdminToken = (): string =>
  mkToken({ capabilities: [ADMIN_CAP, 'read', 'mutate'], ns: [SYSTEM_NAMESPACE] });

function mkPubkey(): string {
  const { publicKey } = generateKeyPairSync('ed25519');
  return publicKey.export({ type: 'spki', format: 'pem' }).toString();
}

interface Ctx {
  server: MemorySubstrateServer;
  composed: ComposeResult;
  substrateDataset: MemoryDataset;
}

const open: Array<Ctx> = [];

async function mkServer(
  identityDirectory?: AuthConfig['identityDirectory'],
  adminCapability: string = ADMIN_CAP
): Promise<Ctx> {
  const server = new MemorySubstrateServer();
  const dataset = new MemoryDataset({ namespace: 'default' });
  const substrateDataset = new MemoryDataset({ namespace: SYSTEM_NAMESPACE });
  const auth: AuthConfig = {
    keys: [{ kid: FILE_KID, alg: 'HS256', publicKey: SECRET }],
    adminCapability,
    ...(identityDirectory !== undefined ? { identityDirectory } : {})
  };
  const composed = await compose({
    systemActor: 'test',
    server,
    dataset,
    datasets: { [SYSTEM_NAMESPACE]: substrateDataset },
    auth,
    streamTicketSecret: 'test-stream-ticket-secret',
    coordinators: [fixturePlugin]
  });
  await server.start();
  const ctx = { server, composed, substrateDataset };
  open.push(ctx);
  return ctx;
}

afterEach(async () => {
  while (open.length > 0) {
    const ctx = open.pop();
    await ctx?.composed.stop?.();
    await ctx?.server.stop();
  }
});

async function postKeys(
  ctx: Ctx,
  body: unknown,
  token: string | null = adminToken()
): Promise<SubstrateResponse> {
  return ctx.server.inject({
    method: 'POST',
    path: '/substrate/v1/_system/keys',
    headers: {
      'content-type': 'application/json',
      ...(token !== null ? { authorization: `Bearer ${token}` } : {})
    },
    body: Buffer.from(JSON.stringify(body))
  });
}

function validBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kid: 'agent-one@TestHost',
    publicKey: mkPubkey(),
    name: 'agent one',
    namespaces: ['default'],
    capabilities: ['read'],
    ...overrides
  };
}

/** Count Key rows for a kid — the "did a credential land?" question. */
async function keyRows(ctx: Ctx, kid: string): Promise<Array<Record<string, unknown>>> {
  const { rows } = await ctx.substrateDataset.read(KEY_TYPE, { where: { kid: { eq: kid } } });
  return rows as Array<Record<string, unknown>>;
}

async function patchKeys(
  ctx: Ctx,
  body: unknown,
  token: string | null = adminToken()
): Promise<SubstrateResponse> {
  return ctx.server.inject({
    method: 'PATCH',
    path: '/substrate/v1/_system/keys',
    headers: {
      'content-type': 'application/json',
      ...(token !== null ? { authorization: `Bearer ${token}` } : {})
    },
    body: Buffer.from(JSON.stringify(body))
  });
}

describe('PATCH /substrate/v1/_system/keys — unhosted namespaces', () => {
  const KID = 'agent-one@TestHost';

  async function withRegisteredKey(): Promise<Ctx> {
    const ctx = await mkServer();
    const created = await postKeys(ctx, validBody({ namespaces: ['default'] }));
    expect(created.status).toBe(201);
    return ctx;
  }

  // `--ns cortex` (a typo for `cortext`) must not succeed silently and leave
  // every frame refused.
  it('refuses an update whose new grant names a namespace nobody hosts', async () => {
    const ctx = await withRegisteredKey();
    const res = await patchKeys(ctx, { kid: KID, namespaces: ['cortex'] });
    expect(res.status).toBe(422);
    const body = jsonBody<{ code: string; unknownNamespaces: string[] }>(res);
    expect(body.code).toBe('unknown_namespaces');
    expect(body.unknownNamespaces).toEqual(['cortex']);

    // And the grant is UNCHANGED — a refused update must not half-apply.
    const rows = await keyRows(ctx, KID);
    expect(rows[0]?.namespaces).toBe('default');
  });

  it('admits it when the caller confirms', async () => {
    const ctx = await withRegisteredKey();
    const res = await patchKeys(ctx, {
      kid: KID,
      namespaces: ['default', 'not-yet-installed'],
      allowUnknownNs: true,
      widen: true
    });
    expect(res.status).toBe(200);
  });

  // The guard must not fire on updates that leave namespaces alone, or every
  // rename would start failing once a plugin is unloaded.
  it('does not fire on an update that supplies no namespace list', async () => {
    const ctx = await withRegisteredKey();
    const res = await patchKeys(ctx, { kid: KID, name: 'renamed' });
    expect(res.status).toBe(200);
  });
});

describe('POST /substrate/v1/_system/keys — gate + validation', () => {
  it('401s an anonymous caller and 403s a non-admin one', async () => {
    const ctx = await mkServer();
    expect((await postKeys(ctx, validBody(), null)).status).toBe(401);
    expect((await postKeys(ctx, validBody(), nonAdminToken())).status).toBe(403);
    expect(await keyRows(ctx, 'agent-one@TestHost')).toHaveLength(0);
  });

  it('refuses a missing namespaces list rather than defaulting it', async () => {
    // A defaulted grant would be a wildcard nobody chose.
    const ctx = await mkServer();
    const body = validBody();
    delete body.namespaces;
    const res = await postKeys(ctx, body);
    expect(res.status).toBe(400);
    expect(jsonBody<{ code: string }>(res).code).toBe('invalid_namespaces');
  });

  // Accepting a grant for an unhosted namespace looks successful on every
  // surface an operator checks, while every frame is refused with
  // `unauthorized_namespace`.
  it('refuses a grant naming a namespace this deployment does not host', async () => {
    const ctx = await mkServer();
    const res = await postKeys(ctx, validBody({ namespaces: ['default', 'cortex'] }));
    expect(res.status).toBe(422);
    const body = jsonBody<{ code: string; unknownNamespaces: string[]; hosted: string[] }>(res);
    expect(body.code).toBe('unknown_namespaces');
    expect(body.unknownNamespaces).toEqual(['cortex']);
    // Name the hosted set, the way GET /substrate/v1/schema already does — an operator
    // who typo'd needs the correct spelling, not just a refusal.
    expect(body.hosted).toContain('default');
    expect(await keyRows(ctx, 'agent-one@TestHost')).toHaveLength(0);
  });

  it('admits an unhosted namespace when the caller says they meant it', async () => {
    // Registering a kid for a plugin about to be installed is legitimate. A
    // hard refusal would make this guard the thing operators route around, so
    // it lands in the confirmable class alongside --widen / --allow-admin.
    const ctx = await mkServer();
    const res = await postKeys(
      ctx,
      validBody({ namespaces: ['default', 'not-yet-installed'], allowUnknownNs: true })
    );
    expect(res.status).toBe(201);
    expect(await keyRows(ctx, 'agent-one@TestHost')).toHaveLength(1);
  });

  it('never treats the wildcard as unhosted', async () => {
    const ctx = await mkServer();
    const res = await postKeys(ctx, validBody({ namespaces: ['*'] }));
    expect(res.status).toBe(201);
  });

  // The unhosted-namespace guard sees ENTRIES, and a per-namespace entry
  // carries a `:cap` suffix — a naive `hosted.has()` reads `plane:read` as an
  // unhosted namespace called "plane:read" and refuses a good grant.
  it('accepts a per-namespace grant entry for a HOSTED namespace', async () => {
    const ctx = await mkServer();
    const res = await postKeys(ctx, validBody({ namespaces: ['default:read'] }));
    expect(res.status).toBe(201);
    const rows = await keyRows(ctx, 'agent-one@TestHost');
    expect(rows[0]?.namespaces).toBe('default:read');
  });

  it('still refuses a per-namespace entry naming a namespace nobody hosts', async () => {
    const ctx = await mkServer();
    const res = await postKeys(ctx, validBody({ namespaces: ['cortex:read'] }));
    expect(res.status).toBe(422);
    const body = jsonBody<{ code: string; unknownNamespaces: string[] }>(res);
    expect(body.code).toBe('unknown_namespaces');
    // Names the NAMESPACE, not the whole entry — that is what the operator
    // has to correct.
    expect(body.unknownNamespaces).toEqual(['cortex']);
  });

  it('refuses HS256 and a private key pasted as the public one', async () => {
    const ctx = await mkServer();
    const hs = await postKeys(ctx, validBody({ algorithm: 'HS256' }));
    expect(hs.status).toBe(400);
    expect(jsonBody<{ code: string }>(hs).code).toBe('hmac_not_allowed');

    const { privateKey } = generateKeyPairSync('ed25519');
    const priv = await postKeys(
      ctx,
      validBody({ publicKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() })
    );
    expect(priv.status).toBe(400);
    expect(jsonBody<{ code: string }>(priv).code).toBe('invalid_public_key');
  });

  it("refuses the 'admin' capability without an explicit opt-in", async () => {
    const ctx = await mkServer();
    const res = await postKeys(ctx, validBody({ capabilities: ['read', 'admin'] }));
    expect(res.status).toBe(400);
    expect(jsonBody<{ code: string }>(res).code).toBe('admin_requires_opt_in');
    expect(await keyRows(ctx, 'agent-one@TestHost')).toHaveLength(0);
  });

  // A stored malformed entry makes `parseGrantEntries` throw inside
  // `candidatesFor` (auth.ts), turning every request bearing that kid into a 500.
  //
  // The entries are ARRAY elements here, not a CLI comma-string — the route
  // never splits on commas. 'default:' is a HOSTED namespace with an empty
  // capability set, which pins that this refusal is about entry SHAPE rather
  // than the unhosted-namespace guard catching an odd spelling.
  it('refuses a grant entry it cannot parse, and writes no row', async () => {
    const ctx = await mkServer();
    for (const bad of [':admin', 'cortext:', 'default:']) {
      const res = await postKeys(ctx, validBody({ namespaces: [bad] }));
      expect(res.status).toBe(400);
      expect(jsonBody<{ code: string }>(res).code).toBe('invalid_grant_entry');
      expect(await keyRows(ctx, 'agent-one@TestHost')).toHaveLength(0);
    }
  });

  // `grantEntriesConfer` fails CLOSED, so without allowAdmin a malformed grant
  // is caught by the ADMIN gate instead. Passing allowAdmin skips that gate and
  // isolates the shape check.
  it('refuses an unparseable grant even when the admin gate is opted past', async () => {
    const ctx = await mkServer();
    const res = await postKeys(
      ctx,
      validBody({ namespaces: ['default:'], capabilities: ['read'], allowAdmin: true })
    );
    expect(res.status).toBe(400);
    expect(jsonBody<{ code: string }>(res).code).toBe('invalid_grant_entry');
    expect(await keyRows(ctx, 'agent-one@TestHost')).toHaveLength(0);
  });

  it('still accepts well-formed per-namespace grant syntax', async () => {
    const ctx = await mkServer();
    const res = await postKeys(
      ctx,
      validBody({ namespaces: ['default:read+mutate', 'default'], capabilities: ['read'] })
    );
    expect(res.status).toBe(201);
  });

  // The opt-in asks the DEPLOYMENT's admin capability, as the key PATCH
  // route does — on a `root` deployment, literal 'admin' is an ordinary cap.
  it('asks the configured adminCapability, not the literal string', async () => {
    const ctx = await mkServer(undefined, 'root');
    const rootToken = mkToken({ capabilities: ['root', 'read', 'mutate'], ns: ['*'] });
    const root = await postKeys(ctx, validBody({ capabilities: ['read', 'root'] }), rootToken);
    expect(root.status).toBe(400);
    const refusal = jsonBody<{ code: string; message: string }>(root);
    expect(refusal.code).toBe('admin_requires_opt_in');
    expect(refusal.message).toContain("'root'");

    const literal = await postKeys(
      ctx,
      validBody({ kid: 'agent-two@TestHost', capabilities: ['read', 'admin'] }),
      rootToken
    );
    expect(literal.status).toBe(201);
  });

  // The ROUTE gate asks the configured capability too. Asking literal 'admin'
  // would make a `root` operator also need 'admin' to reach any admin route,
  // and let a literal-'admin' holder pass the gate on a deployment where
  // 'admin' confers nothing.
  it('the admin route gate asks the configured adminCapability', async () => {
    const ctx = await mkServer(undefined, 'root');
    const literal = mkToken({ capabilities: ['admin', 'read', 'mutate'], ns: ['*'] });
    const refused = await postKeys(ctx, validBody(), literal);
    expect(refused.status).toBe(403);
    expect(jsonBody<{ code: string; required: string }>(refused)).toMatchObject({
      code: 'forbidden',
      required: 'root'
    });
    const root = mkToken({ capabilities: ['root', 'read', 'mutate'], ns: ['*'] });
    expect((await postKeys(ctx, validBody(), root)).status).toBe(201);
  });

  // Regression: the opt-in gate must see admin conferred through namespace
  // syntax, not only the flat `capabilities` list. Pinned at the transport the
  // CLI uses.
  it('refuses admin conferred through NAMESPACE syntax without an opt-in', async () => {
    const ctx = await mkServer();
    const res = await postKeys(
      ctx,
      validBody({ namespaces: ['default:read+admin'], capabilities: ['read'] })
    );
    expect(res.status).toBe(400);
    expect(jsonBody<{ code: string }>(res).code).toBe('admin_requires_opt_in');
    expect(await keyRows(ctx, 'agent-one@TestHost')).toHaveLength(0);
  });

  it('refuses a second live registration of the same kid', async () => {
    const ctx = await mkServer();
    expect((await postKeys(ctx, validBody())).status).toBe(201);
    const again = await postKeys(ctx, validBody());
    expect(again.status).toBe(409);
    expect(jsonBody<{ code: string }>(again).code).toBe('kid_already_live');
    expect(await keyRows(ctx, 'agent-one@TestHost')).toHaveLength(1);
  });
});

describe('POST /substrate/v1/_system/keys — credential-only postures are REPORTED', () => {
  it('says so when no directory is configured', async () => {
    const ctx = await mkServer();
    const res = await postKeys(ctx, validBody());
    expect(res.status).toBe(201);
    const b = jsonBody<{ directory: { created: boolean; reason: string }; kid: string }>(res);
    // An operator must be able to see from the response alone that this
    // identity has no directory row.
    expect(b.directory).toEqual({ created: false, reason: 'not_configured' });
    expect(await keyRows(ctx, 'agent-one@TestHost')).toHaveLength(1);
  });

  it('says so when the caller opts out', async () => {
    const ctx = await mkServer({ frame: `${SYSTEM_NAMESPACE}/${INVITE_TYPE}` });
    const res = await postKeys(ctx, validBody({ directory: { create: false } }));
    expect(res.status).toBe(201);
    expect(jsonBody<{ directory: { created: boolean; reason: string } }>(res).directory).toEqual({
      created: false,
      reason: 'opted_out'
    });
  });
});

describe('POST /substrate/v1/_system/keys — a directory that cannot be written blocks the credential', () => {
  it('refuses BEFORE writing when the caller cannot write the directory namespace', async () => {
    // The pre-flight is the load-bearing guard: `policy_denied` inside the tx
    // does not throw, so without this probe the credential would commit and the
    // directory error would arrive as a quiet envelope entry beside a 201.
    const ctx = await mkServer({ frame: 'default/Todo' });
    const res = await postKeys(ctx, validBody(), substrateOnlyAdminToken());
    expect(res.status).toBe(403);
    const b = jsonBody<{ code: string; message: string }>(res);
    expect(b.code).toBe('directory_denied');
    expect(b.message).toMatch(/half identity/i);
    // The whole point:
    expect(await keyRows(ctx, 'agent-one@TestHost')).toHaveLength(0);
  });

  it('refuses cleanly when the directory namespace is unknown', async () => {
    const ctx = await mkServer({ frame: 'nosuchns/Directory' });
    const res = await postKeys(ctx, validBody());
    expect(res.status).toBe(403);
    expect(jsonBody<{ code: string }>(res).code).toBe('directory_denied');
    expect(await keyRows(ctx, 'agent-one@TestHost')).toHaveLength(0);
  });

  it('leaves NO credential behind when the tx scope cannot span the two namespaces', async () => {
    // A memory stack: `_system` and `default` are separate MemorySubstrateDatasets
    // with distinct txScopeIds and no `withScopedTransaction`, so the
    // engine refuses the frame wholesale. That refusal is the SAFE failure —
    // what must never happen is the credential landing without the directory.
    const ctx = await mkServer({ frame: 'default/Todo' });
    const res = await postKeys(ctx, validBody());
    expect(res.status).toBe(500);
    expect(await keyRows(ctx, 'agent-one@TestHost')).toHaveLength(0);
  });
});

describe('POST /substrate/v1/_system/keys — atomic write + reporting', () => {
  it('writes credential and directory row together and reports the frame', async () => {
    // Directory pointed INSIDE `_system` so both rows share one dataset and the
    // engine takes the `single_dataset` path — the only way to exercise the
    // atomic write on a memory substrate. Cross-namespace coalescing is a pg
    // property and is verified against pg.
    const ctx = await mkServer({
      frame: `${SYSTEM_NAMESPACE}/${INVITE_TYPE}`,
      kidField: 'consumedBy',
      hostField: null,
      displayNameField: null,
      defaults: {
        namespaces: 'default',
        capabilities: 'read',
        expiresAt: new Date(Date.now() + 86_400_000).toISOString()
      }
    });
    const res = await postKeys(ctx, validBody());
    expect(res.status).toBe(201);
    const b = jsonBody<{
      kid: string;
      fingerprint: string;
      directory: { created: boolean; frame: string };
    }>(res);
    expect(b.directory).toEqual({
      created: true,
      frame: `${SYSTEM_NAMESPACE}/create${INVITE_TYPE}`
    });
    expect(b.fingerprint).toMatch(/^sha256:/);

    expect(await keyRows(ctx, 'agent-one@TestHost')).toHaveLength(1);
    const { rows: dirRows } = await ctx.substrateDataset.read(INVITE_TYPE, {
      where: { consumedBy: { eq: 'agent-one@TestHost' } }
    });
    expect(dirRows).toHaveLength(1);
  });

  it('forces the kid onto the directory row even if the caller supplies another', async () => {
    // A directory entry naming a different principal from the credential it was
    // issued alongside points at nobody. The kid is written last, on purpose.
    const ctx = await mkServer({
      frame: `${SYSTEM_NAMESPACE}/${INVITE_TYPE}`,
      kidField: 'consumedBy',
      hostField: null,
      displayNameField: null,
      defaults: {
        namespaces: 'default',
        capabilities: 'read',
        expiresAt: new Date(Date.now() + 86_400_000).toISOString()
      }
    });
    const res = await postKeys(
      ctx,
      validBody({ directory: { params: { consumedBy: 'someone-else@Elsewhere' } } })
    );
    expect(res.status).toBe(201);
    const { rows } = await ctx.substrateDataset.read(INVITE_TYPE, {
      where: { consumedBy: { eq: 'someone-else@Elsewhere' } }
    });
    expect(rows).toHaveLength(0);
  });

  it('makes the new key verify on the NEXT request, with no re-prime timer running', async () => {
    // `keyReprimeIntervalMs` is deliberately
    // UNSET here: a test that leaves re-prime on passes whether or not the
    // write-through fires.
    const ctx = await mkServer();
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const kid = 'fresh-agent@TestHost';
    const res = await postKeys(
      ctx,
      validBody({
        kid,
        publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
        namespaces: ['default'],
        capabilities: ['read']
      })
    );
    expect(res.status).toBe(201);

    const now = Math.floor(Date.now() / 1000);
    const { signEdDSA } = await import('@mnmal-ai/substrate-compose');
    const token = signEdDSA(
      { sub: kid, exp: now + 60, capabilities: ['read'], ns: ['default'] },
      privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      { kid }
    );
    const whoami = await ctx.server.inject({
      method: 'GET',
      path: '/substrate/v1/whoami',
      headers: { authorization: `Bearer ${token}` },
      body: Buffer.alloc(0)
    });
    expect(whoami.status).toBe(200);
    expect(jsonBody<{ identity: { id: string } | null }>(whoami).identity?.id).toBe(kid);
  });
});

// ---------------------------------------------------------------------------
// GET /substrate/v1/_system/keys — the authenticated read.
//
// Unlike `substrate-admin list`, which reads postgres directly, this read is gated,
// so a successful answer is evidence the admin credential works.

async function getKeys(
  ctx: Ctx,
  token: string | null = adminToken(),
  query = ''
): Promise<SubstrateResponse> {
  return ctx.server.inject({
    method: 'GET',
    path: `/substrate/v1/_system/keys${query}`,
    headers: { ...(token !== null ? { authorization: `Bearer ${token}` } : {}) },
    body: null
  });
}

describe('GET /substrate/v1/_system/keys — the gate is the point', () => {
  it('401s anonymous and 403s a non-admin — the answer `list` could never give', async () => {
    const ctx = await mkServer();
    expect((await getKeys(ctx, null)).status).toBe(401);
    expect((await getKeys(ctx, nonAdminToken())).status).toBe(403);
  });

  it('an admin caller gets the active keys', async () => {
    const ctx = await mkServer();
    await postKeys(ctx, validBody());
    const res = await getKeys(ctx);
    expect(res.status).toBe(200);
    const body = jsonBody<{ keys: Array<{ kid: string }>; filter: string }>(res);
    expect(body.keys.map((k) => k.kid)).toContain('agent-one@TestHost');
    // An empty or filtered result is ambiguous unless the filter is named.
    expect(body.filter).toBe('active');
  });

  it('does NOT return publicKey — a PEM nobody displays is 6x the answer', async () => {
    const ctx = await mkServer();
    await postKeys(ctx, validBody());
    const body = jsonBody<{ keys: Array<Record<string, unknown>> }>(await getKeys(ctx));
    expect(body.keys.length).toBeGreaterThan(0);
    for (const k of body.keys) expect(k).not.toHaveProperty('publicKey');
  });

  it('reports completeness rather than truncating in silence', async () => {
    const ctx = await mkServer();
    await postKeys(ctx, validBody());
    const body = jsonBody<{ hasMore: boolean }>(await getKeys(ctx, adminToken(), '?limit=1'));
    // `hasMore` is always present, so a caller can never mistake a page for the set.
    expect(typeof body.hasMore).toBe('boolean');
  });

  it('refuses a nonsense limit rather than silently clamping it', async () => {
    const ctx = await mkServer();
    const res = await getKeys(ctx, adminToken(), '?limit=0');
    expect(res.status).toBe(400);
    expect(jsonBody<{ code: string }>(res).code).toBe('invalid_limit');
  });

  it('a revoked key is absent from the active read', async () => {
    const ctx = await mkServer();
    await postKeys(ctx, validBody());
    await ctx.server.inject({
      method: 'PATCH',
      path: '/substrate/v1/_system/keys',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken()}` },
      body: Buffer.from(JSON.stringify({ kid: 'agent-one@TestHost', revoke: true }))
    });
    const body = jsonBody<{ keys: Array<{ kid: string }> }>(await getKeys(ctx));
    expect(body.keys.map((k) => k.kid)).not.toContain('agent-one@TestHost');
  });
});

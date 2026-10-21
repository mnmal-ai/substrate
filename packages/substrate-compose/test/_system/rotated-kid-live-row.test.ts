import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import { MemoryDataset } from '@mnmal-ai/substrate-dataset-memory';
import { MemorySubstrateServer } from '@mnmal-ai/substrate-server-memory';
import { afterEach, describe, expect, it } from 'vitest';
import { KEY_TYPE, SYSTEM_NAMESPACE } from '../../src/_system/types.js';
import { signEdDSA, signHs256 } from '../../src/auth.js';
import { compose } from '../../src/compose.js';

const SECRET = 'rotated-kid-live-row-secret-0123456789';
const KID = 'victim@host';

function pubPem(): {
  pem: string;
  privateKey: KeyObject;
} {
  const kp = generateKeyPairSync('ed25519');
  return {
    pem: kp.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    privateKey: kp.privateKey
  };
}

let stop: (() => Promise<void>) | undefined;
afterEach(async () => {
  await stop?.();
  stop = undefined;
});

/** A kid rotated once: a revoked row written BEFORE the live one. */
async function rotatedStack() {
  const server = new MemorySubstrateServer();
  const sys = new MemoryDataset({ namespace: SYSTEM_NAMESPACE });
  const live = pubPem();
  const meta = { identity: { kind: 'agent' as const, id: 'seed' }, now: new Date() };
  const base = {
    kid: KID,
    name: 'v',
    algorithm: 'EdDSA',
    namespaces: '*',
    capabilities: 'read,mutate'
  };
  await sys.write(
    KEY_TYPE,
    [
      {
        ...base,
        id: '00000000-0000-4000-8000-000000000001',
        publicKey: pubPem().pem,
        revokedAt: new Date(Date.now() - 60_000).toISOString()
      }
    ],
    meta
  );
  await sys.write(
    KEY_TYPE,
    [{ ...base, id: '00000000-0000-4000-8000-000000000002', publicKey: live.pem, revokedAt: null }],
    meta
  );
  const composed = await compose({
    server,
    dataset: new MemoryDataset({ namespace: 'default' }),
    datasets: { [SYSTEM_NAMESPACE]: sys },
    auth: { keys: [{ kid: 'file', alg: 'HS256', publicKey: SECRET }], adminCapability: 'admin' },
    streamTicketSecret: 'rotated-kid-live-row-stream'
  });
  await server.start();
  stop = () => composed.stop();
  const now = Math.floor(Date.now() / 1000);
  const admin = signHs256(
    { sub: 'op', exp: now + 60, capabilities: ['admin', 'read', 'mutate'], ns: ['*'] },
    SECRET,
    { kid: 'file' }
  );
  const victim = signEdDSA(
    { sub: KID, exp: now + 60, ns: ['*'], capabilities: ['read', 'mutate'] },
    live.privateKey,
    { kid: KID }
  );
  const call = (method: 'GET' | 'POST' | 'PATCH', path: string, token: string, body?: unknown) =>
    server.inject({
      method,
      path,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      ...(body !== undefined ? { body: Buffer.from(JSON.stringify(body)) } : {})
    });
  return { call, admin, victim };
}

describe('a rotated kid acts on its live row', () => {
  it('PATCH revoke revokes the live key', async () => {
    const { call, admin, victim } = await rotatedStack();
    const res = await call('PATCH', '/substrate/v1/_system/keys', admin, {
      kid: KID,
      revoke: true
    });
    expect(res.status).toBe(200);
    expect((await call('GET', '/substrate/v1/whoami', victim)).status).toBe(401);
  });

  it('POST refuses to register a second live row', async () => {
    const { call, admin } = await rotatedStack();
    const res = await call('POST', '/substrate/v1/_system/keys', admin, {
      kid: KID,
      publicKey: pubPem().pem,
      namespaces: ['*'],
      capabilities: ['read']
    });
    expect(res.status).toBe(409);
    expect(JSON.parse(String(res.body)).code).toBe('kid_already_live');
  });
});

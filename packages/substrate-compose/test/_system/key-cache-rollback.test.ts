/**
 * A key written in a mutate that rolls back must not sign in: the key cache
 * follows committed rows only.
 */

import { generateKeyPairSync } from 'node:crypto';
import { MemoryDataset } from '@mnmal-ai/substrate-dataset-memory';
import { MemorySubstrateServer } from '@mnmal-ai/substrate-server-memory';
import { afterEach, describe, expect, it } from 'vitest';
import { SYSTEM_NAMESPACE } from '../../src/_system/types.js';
import { signEdDSA, signHs256 } from '../../src/auth.js';
import { compose } from '../../src/compose.js';

const SECRET = 'key-cache-rollback-secret-0123456789ab';
const KID = 'new@host';

let stop: (() => Promise<void>) | undefined;
afterEach(async () => {
  await stop?.();
  stop = undefined;
});

async function stack() {
  const server = new MemorySubstrateServer();
  const composed = await compose({
    server,
    dataset: new MemoryDataset({ namespace: 'default' }),
    datasets: { [SYSTEM_NAMESPACE]: new MemoryDataset({ namespace: SYSTEM_NAMESPACE }) },
    auth: { keys: [{ kid: 'file', alg: 'HS256', publicKey: SECRET }], adminCapability: 'admin' }
  });
  await server.start();
  stop = () => composed.stop();
  const now = Math.floor(Date.now() / 1000);
  const admin = signHs256(
    { sub: 'op', exp: now + 60, capabilities: ['admin', 'read', 'mutate'], ns: ['*'] },
    SECRET,
    { kid: 'file' }
  );
  const kp = generateKeyPairSync('ed25519');
  const keyParams = {
    kid: KID,
    name: 'new',
    algorithm: 'EdDSA',
    publicKey: kp.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    namespaces: '*',
    capabilities: 'read,mutate',
    revokedAt: null
  };
  const token = signEdDSA(
    { sub: KID, exp: now + 60, ns: ['*'], capabilities: ['read', 'mutate'] },
    kp.privateKey,
    { kid: KID }
  );
  const post = (path: string, bearer: string, body?: unknown) =>
    server.inject({
      method: body === undefined ? 'GET' : 'POST',
      path,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}` },
      ...(body !== undefined ? { body: Buffer.from(JSON.stringify(body)) } : {})
    });
  return { post, admin, keyParams, token };
}

describe('the key cache after a mutate', () => {
  it('a key whose mutate rolled back does not sign in', async () => {
    const { post, admin, keyParams, token } = await stack();
    const res = await post('/substrate/v1/mutate', admin, {
      [`${SYSTEM_NAMESPACE}/createKey`]: { params: keyParams, fields: { id: true } },
      [`${SYSTEM_NAMESPACE}/createInvite`]: { params: { notAField: 1 }, fields: { id: true } }
    });
    const body = JSON.parse(String(res.body)) as { errors?: unknown[] };
    expect(body.errors?.length ?? 0).toBeGreaterThan(0);
    expect((await post('/substrate/v1/whoami', token)).status).toBe(401);
  });

  it('a key whose mutate committed signs in', async () => {
    const { post, admin, keyParams, token } = await stack();
    const res = await post('/substrate/v1/mutate', admin, {
      [`${SYSTEM_NAMESPACE}/createKey`]: { params: keyParams, fields: { id: true } }
    });
    expect(JSON.parse(String(res.body)).errors).toBeUndefined();
    expect((await post('/substrate/v1/whoami', token)).status).toBe(200);
  });
});

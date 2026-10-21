/**
 * `POST /substrate/v1/_system/keys` re-registering a REVOKED kid, on memory
 * and on pg (where `substrate_key_live_kid_uniq` is enforced).
 *
 * The revoked row stays as the audit record; the re-registration is a fresh
 * row, so the old key stops verifying and the new one starts.
 *
 * The pg half is skipped unless `POSTGRES_URL` is set.
 */

import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import {
  compose,
  KEY_TYPE,
  SYSTEM_NAMESPACE,
  signEdDSA,
  signHs256
} from '@mnmal-ai/substrate-compose';
import { MemoryDataset } from '@mnmal-ai/substrate-dataset-memory';
import { PgDataset, runMigrations } from '@mnmal-ai/substrate-dataset-pg';
import { MemorySubstrateServer } from '@mnmal-ai/substrate-server-memory';
import type { Dataset } from '@mnmal-ai/substrate-types';
import postgres, { type Sql } from 'postgres';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

const POSTGRES_URL = process.env.POSTGRES_URL;
const SECRET = 'keys-reregister-secret';
const KID = 'reregister-fixture@TestHost';

function keyPair(): { pem: string; privateKey: KeyObject } {
  const kp = generateKeyPairSync('ed25519');
  return {
    pem: kp.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    privateKey: kp.privateKey
  };
}

const stops: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (stops.length > 0) await stops.pop()?.();
});

async function scenario(sys: Dataset): Promise<void> {
  const server = new MemorySubstrateServer();
  const composed = await compose({
    server,
    dataset: new MemoryDataset({ namespace: 'default' }),
    datasets: { [SYSTEM_NAMESPACE]: sys },
    auth: { keys: [{ kid: 'file', alg: 'HS256', publicKey: SECRET }], adminCapability: 'admin' },
    streamTicketSecret: 'keys-reregister-ticket'
  });
  await server.start();
  stops.push(async () => {
    await composed.stop();
    await server.stop();
  });
  const now = Math.floor(Date.now() / 1000);
  const admin = signHs256(
    { sub: 'op', exp: now + 60, capabilities: ['admin', 'read', 'mutate'], ns: ['*'] },
    SECRET,
    { kid: 'file' }
  );
  const call = (method: 'POST' | 'PATCH', body: unknown) =>
    server.inject({
      method,
      path: '/substrate/v1/_system/keys',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${admin}` },
      body: Buffer.from(JSON.stringify(body))
    });
  const register = (pem: string) =>
    call('POST', {
      kid: KID,
      publicKey: pem,
      name: 'fixture',
      namespaces: ['*'],
      capabilities: ['read'],
      directory: { create: false }
    });
  const whoami = (privateKey: KeyObject) =>
    server.inject({
      method: 'GET',
      path: '/substrate/v1/whoami',
      headers: {
        authorization: `Bearer ${signEdDSA(
          { sub: KID, exp: now + 60, ns: ['*'], capabilities: ['read'] },
          privateKey,
          { kid: KID }
        )}`
      },
      body: null
    });

  const oldKey = keyPair();
  expect((await register(oldKey.pem)).status).toBe(201);
  expect((await whoami(oldKey.privateKey)).status).toBe(200);
  const revoked = await call('PATCH', { kid: KID, revoke: true });
  expect(revoked.status, String(revoked.body)).toBe(200);

  const newKey = keyPair();
  const res = await register(newKey.pem);
  expect(res.status, String(res.body)).toBe(201);
  expect((await whoami(oldKey.privateKey)).status).toBe(401);
  expect((await whoami(newKey.privateKey)).status).toBe(200);

  const { rows } = await sys.read(KEY_TYPE, { where: { kid: { eq: KID } } });
  expect(rows.filter((r) => r.revokedAt == null)).toHaveLength(1);
  expect(rows).toHaveLength(2);
}

describe('re-registering a revoked kid through the route', () => {
  it('memory', async () => {
    await scenario(new MemoryDataset({ namespace: SYSTEM_NAMESPACE }));
  });

  describe.skipIf(!POSTGRES_URL)('pg', () => {
    let sql: Sql;
    const clear = () =>
      sql`DELETE FROM rows WHERE namespace = ${SYSTEM_NAMESPACE} AND type = ${KEY_TYPE} AND body->>'kid' = ${KID}`;
    beforeAll(async () => {
      sql = postgres(POSTGRES_URL as string);
      await runMigrations(sql);
      await clear();
    });
    afterAll(async () => {
      await clear();
      await sql.end();
    });

    it('pg', async () => {
      await scenario(new PgDataset({ namespace: SYSTEM_NAMESPACE, sql }));
    });
  });
});

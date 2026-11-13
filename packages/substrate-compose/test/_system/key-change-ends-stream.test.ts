import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import { MemoryDataset } from '@mnmal-ai/substrate-dataset-memory';
import { decodeStreamFrames, FRAMES_JSON_MIME } from '@mnmal-ai/substrate-pack';
import { defineNamespace, field } from '@mnmal-ai/substrate-sdk';
import { MemorySubstrateServer } from '@mnmal-ai/substrate-server-memory';
import type { CoordinatorPlugin } from '@mnmal-ai/substrate-types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { KEY_TYPE, SYSTEM_NAMESPACE } from '../../src/_system/types.js';
import { CREDENTIAL_RECHECK_MS, signEdDSA, signHs256 } from '../../src/auth.js';
import { compose } from '../../src/compose.js';

const SECRET = 'key-change-ends-stream-secret-0123456789';
const KID = 'agent@host';

const todoPlugin: CoordinatorPlugin = {
  name: 'key-change-fixture',
  contractVersion: '*',
  namespaces: [
    defineNamespace('default', {
      Todo: { fields: { id: field.string(), title: field.string() }, autoCrud: true }
    })
  ]
};

function keyPair(): { pem: string; privateKey: KeyObject } {
  const kp = generateKeyPairSync('ed25519');
  return {
    pem: kp.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    privateKey: kp.privateKey
  };
}

let stop: (() => Promise<void>) | undefined;
afterEach(async () => {
  vi.useRealTimers();
  await stop?.();
  stop = undefined;
});

/** A live Key row, and a subscription stream open under it. */
async function openStream() {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  const server = new MemorySubstrateServer();
  const sys = new MemoryDataset({ namespace: SYSTEM_NAMESPACE });
  const key = keyPair();
  const row = {
    id: '00000000-0000-4000-8000-000000000001',
    kid: KID,
    name: 'a',
    algorithm: 'EdDSA',
    publicKey: key.pem,
    namespaces: '*',
    capabilities: 'read,mutate',
    revokedAt: null
  };
  await sys.write(KEY_TYPE, [row], {
    identity: { kind: 'agent' as const, id: 'seed' },
    now: new Date()
  });
  const composed = await compose({
    server,
    dataset: new MemoryDataset({ namespace: 'default' }),
    datasets: { [SYSTEM_NAMESPACE]: sys },
    coordinators: [todoPlugin],
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
  const agent = signEdDSA(
    { sub: KID, exp: now + 60, ns: ['*'], capabilities: ['read', 'mutate'] },
    key.privateKey,
    { kid: KID }
  );
  const call = async (method: 'POST' | 'PATCH', body: unknown) => {
    const res = await server.inject({
      method,
      path: '/substrate/v1/_system/keys',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${admin}` },
      body: Buffer.from(JSON.stringify(body))
    });
    expect(res.status, String(res.body)).toBeLessThan(300);
  };
  const res = await server.inject({
    method: 'POST',
    path: '/substrate/v1/subscribe',
    headers: { accept: FRAMES_JSON_MIME, authorization: `Bearer ${agent}` },
    body: Buffer.from(JSON.stringify({ 'default/Todo': { fields: { id: true } } }))
  });
  expect(res.status).toBe(200);
  /** Every frame's `kind:reason`, in order, as the body delivers them. */
  const closed: string[] = [];
  const frames = decodeStreamFrames(res.body as ReadableStream<Uint8Array>)[Symbol.asyncIterator]();
  const snapshot = await frames.next();
  expect(JSON.parse(new TextDecoder().decode(snapshot.value)).kind).toBe('snapshot');
  const drained = (async () => {
    for (let r = await frames.next(); r.done !== true; r = await frames.next()) {
      const f = JSON.parse(new TextDecoder().decode(r.value)) as { kind: string; reason?: string };
      closed.push(`${f.kind}:${f.reason}`);
    }
  })();
  const reRegister = () =>
    call('POST', {
      kid: KID,
      publicKey: keyPair().pem,
      name: 'a',
      namespaces: ['*'],
      capabilities: ['read', 'mutate']
    });
  return { call, closed, drained, reRegister };
}

describe('an open stream ends when its Key row changes', () => {
  it('after the kid is revoked and re-registered with a new key', async () => {
    const { call, closed, drained, reRegister } = await openStream();
    await call('PATCH', { kid: KID, revoke: true });
    await reRegister();
    expect(closed).toEqual([]);
    vi.advanceTimersByTime(CREDENTIAL_RECHECK_MS);
    await drained;
    expect(closed).toEqual(['end:credential_changed']);
  });

  it('after its grant is narrowed', async () => {
    const { call, closed, drained } = await openStream();
    await call('PATCH', { kid: KID, capabilities: ['read'] });
    expect(closed).toEqual([]);
    vi.advanceTimersByTime(CREDENTIAL_RECHECK_MS);
    await drained;
    expect(closed).toEqual(['end:credential_changed']);
  });
});

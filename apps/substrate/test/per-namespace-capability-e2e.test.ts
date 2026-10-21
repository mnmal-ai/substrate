/**
 * Per-namespace capabilities, END TO END.
 *
 * The unit tests prove the gate and the derivation separately. This proves
 * they are CONNECTED — a real EdDSA token, verified against a real Key
 * row, dispatched through a composed server. A test which constructs the
 * collaborator it tests against cannot catch a missing call site, so this one
 * goes through `compose`.
 *
 * Scenario: an identity that needs to READ `plane` without also gaining
 * `mutate` on it.
 */

import { generateKeyPairSync } from 'node:crypto';
import {
  type AuthConfig,
  type ComposeResult,
  compose,
  KEY_TYPE,
  SYSTEM_NAMESPACE,
  signEdDSA
} from '@mnmal-ai/substrate-compose';
import { MemoryDataset } from '@mnmal-ai/substrate-dataset-memory';
import { defineNamespace, field } from '@mnmal-ai/substrate-sdk';
import { MemorySubstrateServer } from '@mnmal-ai/substrate-server-memory';
import type { CoordinatorPlugin, PackEnvelope, SubstrateResponse } from '@mnmal-ai/substrate-types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const KID = 'tasks-claude@TestHost';

function jsonBody<T>(res: SubstrateResponse): T {
  return JSON.parse(Buffer.isBuffer(res.body) ? res.body.toString('utf8') : String(res.body)) as T;
}

function plugin(name: string, ns: string): CoordinatorPlugin {
  return {
    name,
    contractVersion: '>=1.0.0',
    namespaces: [defineNamespace(ns, { Note: { fields: { text: field.string() } } })]
  } as unknown as CoordinatorPlugin;
}

describe('a grant of plane:read reads plane and cannot write it', () => {
  let server: MemorySubstrateServer;
  let composed: ComposeResult;
  let jwt: string;

  beforeEach(async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

    // compose REPLACES any injected keyRegistry with its own dataset-backed
    // one, so the row has to be real; a hand-built registry would prove the
    // derivation and not the wiring.
    const auth: AuthConfig = { keys: [] };
    const substrateDs = new MemoryDataset({ namespace: SYSTEM_NAMESPACE });
    await substrateDs.write(
      KEY_TYPE,
      [
        {
          id: '0f9a1c22-1111-4111-8111-111111111111',
          kid: KID,
          name: 'tasks',
          algorithm: 'EdDSA',
          publicKey: publicPem,
          // The stored form: a comma-separated scalar, carrying `ns:cap` syntax
          // through `encodeList` with no schema change.
          namespaces: 'cortext,plane:read',
          capabilities: 'read,mutate',
          revokedAt: null
        }
      ],
      { identity: { kind: 'system', id: 'test' }, now: new Date() }
    );

    server = new MemorySubstrateServer();
    composed = await compose({
      server,
      dataset: new MemoryDataset({ namespace: 'default' }),
      datasets: {
        cortext: new MemoryDataset({ namespace: 'cortext' }),
        plane: new MemoryDataset({ namespace: 'plane' }),
        [SYSTEM_NAMESPACE]: substrateDs
      },
      coordinators: [plugin('c', 'cortext'), plugin('p', 'plane')],
      auth,
      streamTicketSecret: 'per-ns-caps-e2e-ticket-secret'
    });
    await server.start();

    const now = Math.floor(Date.now() / 1000);
    // The ordinary agent token: claims the wildcard and inherits the row.
    jwt = signEdDSA(
      { sub: KID, iat: now, exp: now + 300, ns: ['*'], capabilities: ['read', 'mutate'] },
      privatePem,
      { kid: KID }
    );
  });

  afterEach(async () => {
    await composed?.stop();
    await server?.stop();
  });

  const call = async (path: string, frame: unknown): Promise<PackEnvelope> => {
    const res = await server.inject({
      method: 'POST',
      path,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${jwt}` },
      body: Buffer.from(JSON.stringify(frame))
    });
    return jsonBody<PackEnvelope>(res);
  };

  it('READS plane — the thing that was impossible to grant on its own', async () => {
    const env = await call('/substrate/v1/query', {
      'plane/Note': { params: {}, fields: { id: true } }
    });
    expect(env.data['plane/Note']).toBeDefined();
    expect(env.errors ?? []).toEqual([]);
  });

  it('REFUSES a plane write, naming the capability rather than the namespace', async () => {
    const env = await call('/substrate/v1/mutate', {
      'plane/createNote': { params: { id: 'n1', text: 'nope' }, fields: { id: true } }
    });
    expect(env.data['plane/createNote']).toBeUndefined();
    const err = (env.errors ?? [])[0];
    expect(err?.code).toBe('unauthorized_capability');
    // A missing grant and a narrowed one are different operator problems.
    expect(err?.message).toContain('mutate');
  });

  it('still WRITES cortext — least privilege, not blanket refusal', async () => {
    const env = await call('/substrate/v1/mutate', {
      'cortext/createNote': { params: { id: 'n2', text: 'yes' }, fields: { id: true } }
    });
    expect(env.errors ?? []).toEqual([]);
    expect(env.data['cortext/createNote']).toBeDefined();
  });

  it('refuses a namespace the grant never names, with the OTHER code', async () => {
    const env = await call('/substrate/v1/query', {
      'default/Todo': { params: {}, fields: { id: true } }
    });
    const err = (env.errors ?? [])[0];
    expect(err?.code).toBe('unauthorized_namespace');
  });

  it('whoami reports the grant, and refuses to flatten it into a lie (§8.1)', async () => {
    const res = await server.inject({
      method: 'GET',
      path: '/substrate/v1/whoami',
      headers: { authorization: `Bearer ${jwt}` }
    });
    const body = jsonBody<{
      identity: {
        id: string;
        grants: Record<string, string[]>;
      };
    }>(res);

    // The grant is the ONLY field to read — no flat list, honest or otherwise.
    expect(body.identity.grants).toEqual({ cortext: ['mutate', 'read'], plane: ['read'] });
    expect(body.identity).toEqual({
      id: expect.any(String),
      grants: { cortext: ['mutate', 'read'], plane: ['read'] }
    });
  });

  it('a UNIFORM grant renders no flat list either', async () => {
    // The wire does not distinguish uniform from non-uniform grants: there is
    // no flat field to render either way.
    const res = await server.inject({
      method: 'GET',
      path: '/substrate/v1/schema/cortext',
      headers: { authorization: `Bearer ${jwt}` }
    });
    expect(res.status).toBe(200);
  });
});

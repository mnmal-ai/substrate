import { generateKeyPairSync, sign } from 'node:crypto';
import { MemoryDataset } from '@mnmal-ai/substrate-dataset-memory';
import { MemorySubstrateServer } from '@mnmal-ai/substrate-server-memory';
import { afterEach, describe, expect, it } from 'vitest';
import { KEY_TYPE, SYSTEM_NAMESPACE } from '../src/_system/types.js';
import { authenticateBearer } from '../src/auth.js';
import { compose } from '../src/compose.js';

let stop: (() => Promise<void>) | undefined;
afterEach(async () => {
  await stop?.();
  stop = undefined;
});

describe('registry ES256 key', () => {
  it('rejects a token without exp or ns', async () => {
    const server = new MemorySubstrateServer();
    const sys = new MemoryDataset({ namespace: SYSTEM_NAMESPACE });
    const kp = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    await sys.write(
      KEY_TYPE,
      [
        {
          id: '00000000-0000-4000-8000-000000000003',
          kid: 'es',
          name: 'v',
          algorithm: 'ES256',
          publicKey: kp.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
          namespaces: '*',
          capabilities: 'read,mutate',
          revokedAt: null
        }
      ],
      { identity: { kind: 'agent', id: 'seed' }, now: new Date() }
    );
    const composed = await compose({
      server,
      dataset: new MemoryDataset({ namespace: 'default' }),
      datasets: { [SYSTEM_NAMESPACE]: sys },
      auth: { keys: [], mode: 'required' },
      streamTicketSecret: 'registry-token-claims-stream'
    });
    await server.start();
    stop = () => composed.stop();

    const b = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const token = (payload: Record<string, unknown>): string => {
      const input = `${b({ alg: 'ES256', kid: 'es' })}.${b(payload)}`;
      const sig = sign('sha256', Buffer.from(input), {
        key: kp.privateKey,
        dsaEncoding: 'ieee-p1363'
      }).toString('base64url');
      return `${input}.${sig}`;
    };
    const whoami = async (t: string) =>
      JSON.parse(
        String(
          (
            await server.inject({
              method: 'GET',
              path: '/substrate/v1/whoami',
              headers: { authorization: `Bearer ${t}` }
            })
          ).body
        )
      );
    const exp = Math.floor(Date.now() / 1000) + 60;

    expect((await whoami(token({ sub: 'es', ns: ['*'] }))).identity ?? null).toBeNull();
    expect((await whoami(token({ sub: 'es', exp }))).identity ?? null).toBeNull();
    expect((await whoami(token({ sub: 'es', exp, ns: ['*'] }))).identity).not.toBeNull();
  });
});

describe('file-registry RS256 key', () => {
  it('rejects a token without exp or ns, as a registry key would', () => {
    const kp = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const cfg = {
      keys: [
        {
          kid: 'rs',
          alg: 'RS256' as const,
          publicKey: kp.publicKey.export({ type: 'spki', format: 'pem' }).toString()
        }
      ]
    };
    const b = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const token = (payload: Record<string, unknown>): string => {
      const input = `${b({ alg: 'RS256', kid: 'rs' })}.${b(payload)}`;
      return `${input}.${sign('sha256', Buffer.from(input), kp.privateKey).toString('base64url')}`;
    };
    const exp = Math.floor(Date.now() / 1000) + 60;

    expect(authenticateBearer(token({ sub: 'rs', ns: ['*'] }), cfg)).toEqual({
      ok: false,
      reason: 'malformed_claim:exp'
    });
    expect(authenticateBearer(token({ sub: 'rs', exp }), cfg)).toEqual({
      ok: false,
      reason: 'malformed_claim:ns'
    });
    expect(authenticateBearer(token({ sub: 'rs', exp, ns: ['*'] }), cfg).ok).toBe(true);
  });
});

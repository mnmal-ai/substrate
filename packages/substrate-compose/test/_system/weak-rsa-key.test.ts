import { generateKeyPairSync } from 'node:crypto';
import { MemoryDataset } from '@mnmal-ai/substrate-dataset-memory';
import { MemorySubstrateServer } from '@mnmal-ai/substrate-server-memory';
import { describe, expect, it } from 'vitest';
import { type AuthConfig, signHs256 } from '../../src/auth.js';
import { compose } from '../../src/compose.js';

const SECRET = 'weak-rsa-key-test-secret-0123456789';
const auth: AuthConfig = { keys: [{ kid: 'admin', alg: 'HS256', publicKey: SECRET }] };

function rsaPem(modulusLength: number): string {
  return generateKeyPairSync('rsa', { modulusLength })
    .publicKey.export({ type: 'spki', format: 'pem' })
    .toString();
}

async function register(publicKey: string): Promise<{ status: number; code?: string }> {
  const server = new MemorySubstrateServer();
  const composed = await compose({
    server,
    dataset: new MemoryDataset({ namespace: 'default' }),
    auth,
    streamTicketSecret: 'weak-rsa-key-stream-secret'
  });
  await server.start();
  const now = Math.floor(Date.now() / 1000);
  const token = signHs256(
    { sub: 'op', exp: now + 60, capabilities: ['read', 'mutate', 'admin'] },
    SECRET,
    {
      kid: 'admin'
    }
  );
  const res = await server.inject({
    method: 'POST',
    path: '/substrate/v1/_system/keys',
    headers: { authorization: `Bearer ${token}` },
    body: Buffer.from(
      JSON.stringify({
        kid: 'rsa@host',
        algorithm: 'RS256',
        publicKey,
        namespaces: ['default'],
        capabilities: ['read']
      })
    )
  });
  await composed.stop();
  return { status: res.status, code: JSON.parse(String(res.body)).code };
}

describe('POST /_system/keys RSA strength', () => {
  it('refuses an RSA key under 2048 bits', async () => {
    expect(await register(rsaPem(1024))).toEqual({ status: 400, code: 'weak_public_key' });
  });

  it('accepts a 2048-bit RSA key', async () => {
    expect((await register(rsaPem(2048))).status).toBeLessThan(300);
  });
});

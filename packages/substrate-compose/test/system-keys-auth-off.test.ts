/**
 * With auth off, gate('admin') admits everyone as the system actor. The key
 * routes still dispatch through the engine's `_system` policy, which wants
 * admin, and the system actor deliberately holds only read + mutate. So an
 * unauthenticated deployment cannot mint or list credentials over HTTP.
 */

import { generateKeyPairSync } from 'node:crypto';
import { MemoryDataset } from '@mnmal-ai/substrate-dataset-memory';
import { MemorySubstrateServer } from '@mnmal-ai/substrate-server-memory';
import { describe, expect, it } from 'vitest';
import { compose } from '../src/compose.js';

describe('_system key routes with auth off', () => {
  it('refuses to register or list keys for the system actor', async () => {
    const server = new MemorySubstrateServer();
    const composed = await compose({
      systemActor: 'local-dev',
      server,
      dataset: new MemoryDataset({ namespace: 'default' })
    });
    await server.start();
    const publicKey = generateKeyPairSync('ed25519')
      .publicKey.export({ type: 'spki', format: 'pem' })
      .toString();
    const post = await server.inject({
      method: 'POST',
      path: '/substrate/v1/_system/keys',
      body: Buffer.from(
        JSON.stringify({
          kid: 'new@host',
          algorithm: 'EdDSA',
          publicKey,
          namespaces: ['*'],
          capabilities: ['read', 'mutate', 'admin'],
          allowAdmin: true
        })
      )
    });
    const list = await server.inject({ method: 'GET', path: '/substrate/v1/_system/keys' });
    await composed.stop();
    expect(post.status).toBe(403);
    expect(list.status).toBe(403);
  });
});

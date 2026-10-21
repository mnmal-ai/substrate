/**
 * The `_system` write routes act on the namespace named in the body, so admin
 * must be held in that namespace, not merely somewhere.
 */

import { MemoryDataset } from '@mnmal-ai/substrate-dataset-memory';
import { MemorySubstrateServer } from '@mnmal-ai/substrate-server-memory';
import { describe, expect, it } from 'vitest';
import { type AuthConfig, signHs256 } from '../src/auth.js';
import { compose } from '../src/compose.js';

const SECRET = 'system-admin-scope-secret';
const KID = 'system-admin-scope';
const authCfg: AuthConfig = { keys: [{ kid: KID, alg: 'HS256', publicKey: SECRET }] };

function bearer(ns: string[]): Record<string, string> {
  const now = Math.floor(Date.now() / 1000);
  const t = signHs256({ sub: 't', exp: now + 60, capabilities: ['admin'], ns }, SECRET, {
    kid: KID
  });
  return { authorization: `Bearer ${t}` };
}

async function drop(ns: string[]) {
  const server = new MemorySubstrateServer();
  const composed = await compose({
    systemActor: 'test',
    server,
    dataset: new MemoryDataset({ namespace: 'default' }),
    auth: authCfg,
    streamTicketSecret: 'test-stream-ticket-secret'
  });
  await server.start();
  const res = await server.inject({
    method: 'POST',
    path: '/substrate/v1/_system/drop-namespace',
    headers: bearer(ns),
    body: Buffer.from(JSON.stringify({ namespace: 'default', confirm: 'default', dryRun: true }))
  });
  await composed.stop();
  return res.status;
}

describe('_system write routes', () => {
  it('refuse admin held only in another namespace', async () => {
    expect(await drop(['board'])).toBe(403);
  });

  it('accept admin held in the target namespace', async () => {
    expect(await drop(['default'])).not.toBe(403);
  });
});

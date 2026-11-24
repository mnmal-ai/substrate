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

async function drop(
  ns: string[],
  route = 'drop-namespace',
  target: object = { namespace: 'default' }
) {
  const server = new MemorySubstrateServer();
  const composed = await compose({
    systemActor: 'test',
    server,
    dataset: new MemoryDataset({ namespace: 'default' }),
    auth: authCfg
  });
  await server.start();
  const res = await server.inject({
    method: 'POST',
    path: `/substrate/v1/_system/${route}`,
    headers: bearer(ns),
    body: Buffer.from(JSON.stringify({ confirm: 'default', dryRun: true, ...target }))
  });
  await composed.stop();
  lastBody = String(res.body);
  return res.status;
}
let lastBody = '';

describe('_system write routes', () => {
  it('refuse admin held only in another namespace', async () => {
    expect(await drop(['board'])).toBe(403);
  });

  it('accept admin held in the target namespace', async () => {
    expect(await drop(['default'])).not.toBe(403);
  });

  it('need store-wide admin to act on a `_system_*` control namespace', async () => {
    const control = '_system_proposals';
    const type = { namespace: control, type: 'NamespaceProposal', confirm: 'NamespaceProposal' };
    const whole = { namespace: control, confirm: control };
    const field = { namespace: control, type: 'NamespaceProposal', field: 'archived' };
    for (const [route, target] of [
      ['drop-type', type],
      ['drop-namespace', whole],
      ['backfill-field', { ...field, values: { a: true } }],
      ['normalise-vocab', field]
    ] as const) {
      expect(await drop([control], route, target)).toBe(403);
      expect(JSON.parse(lastBody)).toEqual({ code: 'forbidden', required: '*:admin' });
      expect(await drop(['*'], route, target)).not.toBe(403);
    }
  });
});

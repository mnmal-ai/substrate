/**
 * Schema discovery and onboarding need a key once auth is on.
 *
 * The schema is the full type map of every namespace, and every legitimate
 * client already holds a key. These routes mount behind the same `read` gate
 * as `/substrate/v1/query`, so `mode: 'attribute'` still admits (and logs) a
 * tokenless fetch while `mode: 'required'` refuses it.
 *
 * What stays open, deliberately: `/health` (liveness), `/substrate/v1/whoami` (the
 * caller with no key is the one who most needs to ask why) and
 * `/substrate/v1/_system/register` (enrolment, rate-limited).
 */

import { MemoryDataset } from '@mnmal-ai/substrate-dataset-memory';
import { MemorySubstrateServer } from '@mnmal-ai/substrate-server-memory';
import { afterEach, describe, expect, it } from 'vitest';
import { type AuthConfig, signHs256 } from '../src/auth.js';
import { compose } from '../src/compose.js';
import { buildOnboardBody } from '../src/routes/onboard.js';

const SECRET = 'schema-onboard-secret';
const KID = 'schemaonboard';

function authCfg(mode: 'required' | 'attribute'): AuthConfig {
  return { mode, keys: [{ kid: KID, alg: 'HS256', publicKey: SECRET }] };
}

function readToken(ns: string[] = ['*']): string {
  const now = Math.floor(Date.now() / 1000);
  return signHs256({ sub: 'reader', exp: now + 60, capabilities: ['read'], ns }, SECRET, {
    kid: KID
  });
}

let server: MemorySubstrateServer | null = null;

async function start(mode: 'required' | 'attribute'): Promise<MemorySubstrateServer> {
  server = new MemorySubstrateServer();
  await compose({
    server,
    dataset: new MemoryDataset({ namespace: 'default' }),
    auth: authCfg(mode)
  });
  await server.start();
  return server;
}

afterEach(async () => {
  await server?.stop?.({ grace: 0 });
  server = null;
});

const GATED = [
  '/substrate/v1/onboard',
  '/substrate/v1/schema',
  '/substrate/v1/schema/default',
  '/substrate/v1/schema/default/Todo',
  '/substrate/v1/federated-schema'
];

describe('schema discovery and onboarding require a key under required mode', () => {
  it.each(GATED)('%s refuses a tokenless caller', async (path) => {
    const srv = await start('required');
    const res = await srv.inject({ method: 'GET', path });
    expect(res.status).toBe(401);
  });

  it.each(GATED)('%s answers a caller holding read', async (path) => {
    const srv = await start('required');
    const res = await srv.inject({
      method: 'GET',
      path,
      headers: { authorization: `Bearer ${readToken()}` }
    });
    // /substrate/v1/schema/default/Todo is 404 on an empty namespace — the point is
    // that the gate let it through to the handler.
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });

  it.each(['/health', '/substrate/v1/whoami'])('%s stays open', async (path) => {
    const srv = await start('required');
    const res = await srv.inject({ method: 'GET', path });
    expect(res.status).toBe(200);
  });

  it('attribute mode still admits a tokenless schema fetch (it is logged, not refused)', async () => {
    const srv = await start('attribute');
    const res = await srv.inject({ method: 'GET', path: '/substrate/v1/federated-schema' });
    expect(res.status).toBe(200);
  });
});

describe('schema discovery answers only for namespaces the caller holds something in', () => {
  const get = async (path: string, ns: string[]) => {
    const srv = server ?? (await start('required'));
    const res = await srv.inject({
      method: 'GET',
      path,
      headers: { authorization: `Bearer ${readToken(ns)}` }
    });
    return { status: res.status, body: JSON.parse(String(res.body)) as unknown };
  };

  it('narrows the federated schema and onboarding to the granted namespaces', async () => {
    const all = await get('/substrate/v1/federated-schema', ['*']);
    expect(Object.keys(all.body as object)).toContain('_system');
    const narrow = await get('/substrate/v1/federated-schema', ['default']);
    expect(Object.keys(narrow.body as object)).toEqual(['default']);
  });

  it('onboarding names only the namespaces it is told the caller sees', () => {
    const body = buildOnboardBody(
      {
        version: '0.0.0',
        coordinators: [
          { name: 'p', namespaces: [{ namespace: 'hidden' }, { namespace: 'mine' }] }
        ] as never,
        bridges: { entries: () => [['far', { name: 'b' }]] } as never,
        authEnabled: true,
        filterOperators: [],
        virtualNamespaces: ['hidden-virtual']
      },
      (ns) => ns === 'mine'
    );
    expect(JSON.stringify(body)).not.toMatch(/hidden|far/);
    expect(JSON.stringify(body)).toContain('mine/Todo');
  });

  it('answers for an ungranted namespace exactly as for a missing one', async () => {
    for (const suffix of ['', '/Key']) {
      const hidden = await get(`/substrate/v1/schema/_system${suffix}`, ['default']);
      const missing = await get(`/substrate/v1/schema/nowhere${suffix}`, ['default']);
      expect(hidden.status).toBe(404);
      expect(JSON.stringify(hidden.body).replaceAll('_system', 'nowhere')).toBe(
        JSON.stringify(missing.body)
      );
      expect((await get(`/substrate/v1/schema/_system${suffix}`, ['*'])).status).not.toBe(401);
    }
    expect((await get('/substrate/v1/schema/_system', ['*'])).status).toBe(200);
  });
});

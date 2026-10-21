/**
 * `GET /substrate/v1/errors` — recent failed resolves with their messages.
 * Admin-gated: messages name other callers' rows and values.
 */

import { MemoryDataset } from '@mnmal-ai/substrate-dataset-memory';
import { MemorySubstrateServer } from '@mnmal-ai/substrate-server-memory';
import { describe, expect, it } from 'vitest';
import { type AuthConfig, signHs256 } from '../src/auth.js';
import { compose } from '../src/compose.js';

const SECRET = 'runtime-errors-test-secret';
const KID = 'runtime-errors';
const ADMIN_CAP = 'admin';

const authCfg: AuthConfig = {
  keys: [{ kid: KID, alg: 'HS256', publicKey: SECRET }],
  adminCapability: ADMIN_CAP
};

function token(capabilities: string[], ns: string[] = ['*']): string {
  const now = Math.floor(Date.now() / 1000);
  return signHs256({ sub: 'tester', exp: now + 60, capabilities, ns }, SECRET, { kid: KID });
}

async function mk(opts: { auth?: AuthConfig } = {}) {
  const server = new MemorySubstrateServer();
  const dataset = new MemoryDataset({ namespace: 'default' });
  const composed = await compose({
    systemActor: 'test',
    server,
    dataset,
    ...(opts.auth !== undefined
      ? { auth: opts.auth, streamTicketSecret: 'test-stream-ticket-secret' }
      : {})
  });
  await server.start();
  return { server, composed };
}

async function deny(server: MemorySubstrateServer, headers?: Record<string, string>) {
  await server.inject({
    method: 'POST',
    path: '/substrate/v1/query',
    ...(headers !== undefined ? { headers } : {}),
    body: Buffer.from(JSON.stringify({ 'secretns/Thing': { params: {}, fields: { id: true } } }))
  });
}

describe('GET /substrate/v1/errors', () => {
  it('401s a tokenless caller when auth is on', async () => {
    const { server, composed } = await mk({ auth: authCfg });
    const res = await server.inject({ method: 'GET', path: '/substrate/v1/errors' });
    expect(res.status).toBe(401);
    await composed.stop();
  });

  it('403s a valid NON-admin token', async () => {
    const { server, composed } = await mk({ auth: authCfg });
    const res = await server.inject({
      method: 'GET',
      path: '/substrate/v1/errors',
      headers: { authorization: `Bearer ${token(['read', 'mutate'])}` }
    });
    expect(res.status).toBe(403);
    await composed.stop();
  });

  it('serves an admin token, newest failure first', async () => {
    const { server, composed } = await mk({ auth: authCfg });
    const bearer = { authorization: `Bearer ${token([ADMIN_CAP, 'read'])}` };
    await deny(server, bearer);
    const res = await server.inject({
      method: 'GET',
      path: '/substrate/v1/errors',
      headers: bearer
    });
    expect(res.status).toBe(200);
    const body = JSON.parse(String(res.body)) as {
      since: string;
      errors: Array<{ key: string; code?: string }>;
    };
    expect(typeof body.since).toBe('string');
    expect(body.errors[0]?.key).toBe('(unknown)');
    expect(body.errors[0]?.code).toBe('unknown_namespace');
    await composed.stop();
  });

  it('serves with auth off (system actor)', async () => {
    const { server, composed } = await mk();
    await deny(server);
    const res = await server.inject({ method: 'GET', path: '/substrate/v1/errors' });
    expect(res.status).toBe(200);
    await composed.stop();
  });

  describe('namespace filter', () => {
    const fail = (key: string) => ({
      key,
      kind: 'query' as const,
      durationMs: 1,
      ok: false,
      code: 'x',
      message: 'm'
    });
    async function keysFor(headers?: Record<string, string>, auth: AuthConfig | null = authCfg) {
      const { server, composed } = await mk(auth !== null ? { auth } : {});
      composed.stats.recordResolve(fail('tasks/Todo'));
      composed.stats.recordResolve(fail('notes/Note'));
      composed.stats.recordResolve(fail('(unknown)'));
      const res = await server.inject({
        method: 'GET',
        path: '/substrate/v1/errors',
        ...(headers !== undefined ? { headers } : {})
      });
      expect(res.status).toBe(200);
      const body = JSON.parse(String(res.body)) as { errors: Array<{ key: string }> };
      await composed.stop();
      return body.errors.map((e) => e.key).sort();
    }
    it('a notes:admin token sees notes errors only', async () => {
      const keys = await keysFor({
        authorization: `Bearer ${token([ADMIN_CAP], ['notes'])}`
      });
      expect(keys).toEqual(['notes/Note']);
    });
    it('a *:admin token sees everything, including (unknown)', async () => {
      const keys = await keysFor({ authorization: `Bearer ${token([ADMIN_CAP])}` });
      expect(keys).toEqual(['(unknown)', 'notes/Note', 'tasks/Todo']);
    });
    it('honours a deployment admin capability other than admin', async () => {
      const keys = await keysFor(
        { authorization: `Bearer ${token(['root'])}` },
        { ...authCfg, adminCapability: 'root' }
      );
      expect(keys).toEqual(['(unknown)', 'notes/Note', 'tasks/Todo']);
    });
    it('auth off sees everything', async () => {
      expect(await keysFor(undefined, null)).toEqual(['(unknown)', 'notes/Note', 'tasks/Todo']);
    });
  });
});

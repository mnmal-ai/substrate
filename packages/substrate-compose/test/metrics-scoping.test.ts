/**
 * `/substrate/v1/metrics` per-key fields (`resolvers`, `slowest`) are filtered by the
 * caller's namespace grant; aggregate fields are not.
 */

import { createRuntimeStats } from '@mnmal-ai/substrate-core';
import { MemoryDataset } from '@mnmal-ai/substrate-dataset-memory';
import { MemorySubstrateServer } from '@mnmal-ai/substrate-server-memory';
import { describe, expect, it } from 'vitest';
import { type AuthConfig, signHs256 } from '../src/auth.js';
import { compose } from '../src/compose.js';
import { handleMetricsRequest } from '../src/routes/runtime-stats.js';

const SECRET = 'metrics-scoping-secret';
const KID = 'metrics-scoping';
const authCfg: AuthConfig = {
  keys: [{ kid: KID, alg: 'HS256', publicKey: SECRET }],
  adminCapability: 'admin'
};

function token(capabilities: string[], ns: string[]): string {
  const now = Math.floor(Date.now() / 1000);
  return signHs256({ sub: 'tester', exp: now + 60, capabilities, ns }, SECRET, { kid: KID });
}

const KEYS = ['journal/Todo', 'board/Note', 'nope/X', 'unqualified'];

async function mk(withAuth: boolean) {
  const server = new MemorySubstrateServer();
  const composed = await compose({
    systemActor: 'test',
    server,
    dataset: new MemoryDataset({ namespace: 'default' }),
    ...(withAuth ? { auth: authCfg, streamTicketSecret: 'test-stream-ticket-secret' } : {})
  });
  await server.start();
  const admin = { authorization: `Bearer ${token(['admin', 'read', 'mutate'], ['*'])}` };
  // These namespaces are not live, so a real request would be recorded as
  // '(unknown)'; seed the keys directly and keep one request for aggregates.
  for (const key of KEYS) {
    composed.stats.recordResolve({ key, kind: 'query', durationMs: 1, ok: true });
  }
  await server.inject({
    method: 'POST',
    path: '/substrate/v1/query',
    ...(withAuth ? { headers: admin } : {}),
    body: Buffer.from(JSON.stringify({ 'journal/Todo': { params: {}, fields: { id: true } } }))
  });
  return { server, composed };
}

async function metrics(server: MemorySubstrateServer, headers?: Record<string, string>) {
  const res = await server.inject({
    method: 'GET',
    path: '/substrate/v1/metrics',
    ...(headers !== undefined ? { headers } : {})
  });
  expect(res.status).toBe(200);
  return JSON.parse(String(res.body)) as {
    requests: { query: { total: number } };
    process: { rssMB: number };
    resolvers: Record<string, unknown>;
    slowest: Array<{ key: string }>;
  };
}

const seen = (b: Awaited<ReturnType<typeof metrics>>): { r: string[]; s: string[] } => ({
  r: Object.keys(b.resolvers).sort(),
  s: [...new Set(b.slowest.map((x) => x.key))].sort()
});

describe('GET /substrate/v1/metrics namespace scoping', () => {
  it('a board:read token sees no journal keys but keeps aggregates', async () => {
    const { server, composed } = await mk(true);
    const b = await metrics(server, {
      authorization: `Bearer ${token(['read'], ['board'])}`
    });
    expect(seen(b).r).toEqual(['board/Note']);
    expect(seen(b).s).toEqual(['board/Note']);
    expect(b.requests.query.total).toBeGreaterThanOrEqual(1);
    expect(typeof b.process.rssMB).toBe('number');
    await composed.stop();
  });

  it('a journal:read token sees journal keys only', async () => {
    const { server, composed } = await mk(true);
    const b = await metrics(server, {
      authorization: `Bearer ${token(['read'], ['journal'])}`
    });
    expect(seen(b).r).toEqual(['journal/Todo']);
    expect(seen(b).s).toEqual(['journal/Todo']);
    await composed.stop();
  });

  it('a * read token sees every key, invented ones included', async () => {
    const { server, composed } = await mk(true);
    const b = await metrics(server, { authorization: `Bearer ${token(['read'], ['*'])}` });
    expect(seen(b).r).toEqual([...KEYS, '(unknown)'].sort());
    await composed.stop();
  });

  it('with auth off every key is visible', async () => {
    const { server, composed } = await mk(false);
    expect(seen(await metrics(server)).r).toEqual([...KEYS, '(unknown)'].sort());
    await composed.stop();
  });

  it('an anonymous reader (attribute mode) gets aggregates but no per-key entries', async () => {
    const server = new MemorySubstrateServer();
    const composed = await compose({
      systemActor: 'test',
      server,
      dataset: new MemoryDataset({ namespace: 'default' }),
      auth: { ...authCfg, mode: 'attribute' },
      streamTicketSecret: 'test-stream-ticket-secret'
    });
    await server.start();
    await server.inject({
      method: 'POST',
      path: '/substrate/v1/query',
      headers: { authorization: `Bearer ${token(['read'], ['*'])}` },
      body: Buffer.from(JSON.stringify({ 'journal/Todo': { params: {}, fields: { id: true } } }))
    });
    const b = await metrics(server);
    expect(b.resolvers).toEqual({});
    expect(b.slowest).toEqual([]);
    expect(b.requests.query.total).toBeGreaterThanOrEqual(1);
    expect(typeof b.process.rssMB).toBe('number');
    await composed.stop();
  });
});

describe('handleMetricsRequest grant rules', () => {
  function loaded() {
    const stats = createRuntimeStats({ activeSubscriptions: () => 0 });
    for (const key of KEYS) {
      stats.recordResolve({ key, kind: 'query', durationMs: 1, ok: true });
    }
    return stats;
  }
  const keysFor = (grants: Record<string, string[]> | null | undefined): string[] =>
    Object.keys(
      handleMetricsRequest(
        loaded(),
        grants === undefined ? undefined : grants === null ? null : { id: 'x', grants }
      ).resolvers ?? {}
    ).sort();

  it('admin in one namespace does not unlock the others', () => {
    expect(keysFor({ board: ['admin'] })).toEqual([]);
    expect(keysFor({ board: ['admin', 'read'] })).toEqual(['board/Note']);
  });
  it('a * grant without read sees nothing', () => {
    expect(keysFor({ '*': ['mutate'] })).toEqual([]);
  });
  it('a * grant with read sees everything, invented keys included', () => {
    expect(keysFor({ '*': ['read'] })).toEqual([...KEYS].sort());
  });
  it('null identity sees no keys; omitted sees all', () => {
    expect(keysFor(null)).toEqual([]);
    expect(keysFor(undefined)).toEqual([...KEYS].sort());
  });
});

describe('subscriptions.entries scoping', () => {
  const stats = createRuntimeStats({
    activeSubscriptions: () => 2,
    subscriptionStats: () => ({
      count: 2,
      maxQueueDepth: 3,
      entries: [
        { id: 's1', ns: 'journal', type: 'Todo', queueLength: 3 },
        { id: 's2', ns: 'board', type: 'Note', queueLength: 0 }
      ]
    })
  });
  it('a board:read caller sees only board entries, aggregates intact', () => {
    const snap = handleMetricsRequest(stats, { grants: { board: ['read'] } } as never);
    expect(snap.subscriptions.entries?.map((e) => e.id)).toEqual(['s2']);
    expect(snap.subscriptions.active).toBe(2);
    expect(snap.subscriptions.maxQueueDepth).toBe(3);
  });
  it('an anonymous caller sees no entries', () => {
    expect(handleMetricsRequest(stats, null).subscriptions.entries).toEqual([]);
  });
});

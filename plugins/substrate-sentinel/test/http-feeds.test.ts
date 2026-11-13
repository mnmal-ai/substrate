/**
 * The frame-stream feeds: POST /register and GET /watch.
 */

import { decodeStreamFrames, FRAMES_JSON_MIME } from '@mnmal-ai/substrate/pack';
import type { PackEnvelope, SubstrateResponse } from '@mnmal-ai/substrate/sdk';
import {
  type AuthConfig,
  type ComposeResult,
  compose,
  MemoryDataset,
  MemorySubstrateServer,
  signHs256
} from '@mnmal-ai/substrate/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { handleRegister } from '../src/coordinators.js';
import { createLivenessRegistry, framePeer, runLivenessTick } from '../src/index.js';
import { buildSentinelForTest } from './_helpers.js';

const NS = 'sentinel';
const BASE = '/substrate/v1/plugins/substrate-sentinel';

const HS_SECRET = 'sentinel-feeds-test-secret';
const HS_KID = 'sentinel-feeds';
const authConfig: AuthConfig = {
  keys: [{ kid: HS_KID, alg: 'HS256', publicKey: HS_SECRET }],
  mode: 'attribute'
};

function bearer(capabilities: string[] = ['read', 'mutate'], sub = 'sentinel-peer'): string {
  return signHs256({ sub, capabilities, exp: Math.floor(Date.now() / 1000) + 300 }, HS_SECRET, {
    kid: HS_KID
  });
}

function authHeaders(): Record<string, string> {
  return { authorization: `Bearer ${bearer()}` };
}

function bodyToString(res: SubstrateResponse): string {
  const b = res.body;
  if (b === undefined || b === null) return '';
  if (typeof b === 'string') return b;
  if (Buffer.isBuffer(b)) return b.toString('utf8');
  if (b instanceof Uint8Array) return Buffer.from(b).toString('utf8');
  return '';
}

function jsonBody<T>(res: SubstrateResponse): T {
  return JSON.parse(bodyToString(res)) as T;
}

interface Harness {
  server: MemorySubstrateServer;
  stop: () => Promise<void>;
  sentinelDataset?: MemoryDataset;
}

/** `withAuth: false` composes no auth at all, so the plugin routes run as the system actor. */
async function setup({ withAuth = true } = {}): Promise<Harness> {
  const server = new MemorySubstrateServer();
  const defaultDataset = new MemoryDataset({ namespace: 'default' });
  const sentinelDataset = new MemoryDataset({ namespace: NS });
  const plugin = buildSentinelForTest({ namespace: NS });
  const composed: ComposeResult = await compose({
    // Required when auth is off: the deployment must declare who it writes as.
    systemActor: 'test',
    server,
    dataset: defaultDataset,
    datasets: { [NS]: sentinelDataset },
    coordinators: [plugin],
    ...(withAuth ? { auth: authConfig } : {})
  });
  await server.start();
  return {
    server,
    sentinelDataset,
    stop: async (): Promise<void> => {
      await composed.stop();
    }
  };
}

/** Wait for the next tick of microtasks. */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setImmediate(r));
  }
}

async function listCoordinators(
  server: MemorySubstrateServer
): Promise<Array<{ name: string; status: string }>> {
  const res = await server.inject({
    method: 'POST',
    path: '/substrate/v1/query',
    headers: { 'content-type': 'application/json' },
    body: Buffer.from(
      JSON.stringify({
        [`${NS}/Coordinator`]: {
          params: {},
          fields: { id: true, name: true, status: true }
        }
      })
    )
  });
  const env = jsonBody<PackEnvelope>(res);
  return (env.data[`${NS}/Coordinator`] ?? []) as Array<{ name: string; status: string }>;
}

async function listCoordinatorNamespaces(server: MemorySubstrateServer): Promise<string[]> {
  const res = await server.inject({
    method: 'POST',
    path: '/substrate/v1/query',
    headers: { 'content-type': 'application/json' },
    body: Buffer.from(
      JSON.stringify({
        [`${NS}/CoordinatorNamespace`]: { params: {}, fields: { id: true, name: true } }
      })
    )
  });
  const rows = (jsonBody<PackEnvelope>(res).data[`${NS}/CoordinatorNamespace`] ?? []) as Array<{
    name: string;
  }>;
  return rows.map((r) => r.name).sort();
}

type Frames = AsyncIterator<Record<string, unknown>>;

function framesOf(res: SubstrateResponse): Frames {
  const it = decodeStreamFrames(res.body as ReadableStream<Uint8Array>)[Symbol.asyncIterator]();
  return {
    next: async () => {
      const r = await it.next();
      if (r.done === true) return { done: true, value: undefined };
      return { done: false, value: JSON.parse(Buffer.from(r.value).toString('utf8')) };
    },
    return: async () => {
      await it.return?.(undefined);
      return { done: true, value: undefined };
    }
  };
}

const register = (
  server: MemorySubstrateServer,
  body: Record<string, unknown>,
  headers = authHeaders()
) =>
  server.inject({
    method: 'POST',
    path: `${BASE}/register`,
    headers: { 'content-type': 'application/json', ...headers },
    body: Buffer.from(JSON.stringify(body))
  });

/** The register reply: the stream's first frame. */
async function registerReply(res: SubstrateResponse): Promise<Record<string, unknown>> {
  expect(res.status).toBe(200);
  return (await framesOf(res).next()).value as Record<string, unknown>;
}

const as = (sub: string, capabilities: string[] = ['read', 'mutate']) => ({
  authorization: `Bearer ${bearer(capabilities, sub)}`
});

const watch = (server: MemorySubstrateServer, headers = authHeaders()) =>
  server.inject({ method: 'GET', path: `${BASE}/watch`, headers });

const PEER = { name: 'hds-a', url: 'http://hds-a.example:3000', namespaces: ['claude'] };

let h: Harness | undefined;
afterEach(async () => {
  await h?.stop();
  h = undefined;
});

describe('sentinel frame-stream feeds', () => {
  it('register keeps the registrant online until its stream closes', async () => {
    h = await setup();
    const res = await register(h.server, PEER);
    expect(res.status).toBe(200);
    expect(res.headers?.['content-type']).toBe(FRAMES_JSON_MIME);
    const frames = framesOf(res);
    expect((await frames.next()).value).toMatchObject({ ok: true, registered: true });
    expect(await listCoordinators(h.server)).toEqual([
      expect.objectContaining({ name: 'hds-a', status: 'online' })
    ]);

    await frames.return?.();
    await expect
      .poll(() => listCoordinators(h?.server as MemorySubstrateServer))
      .toEqual([expect.objectContaining({ name: 'hds-a', status: 'offline' })]);
  });

  it.each([
    ['before the register starts', false],
    ['while the register is in flight', true]
  ])('a client that leaves %s leaves no coordinator online', async (_label, midFlight) => {
    h = await setup();
    const ac = new AbortController();
    if (!midFlight) ac.abort();
    const pending = h.server.inject({
      method: 'POST',
      path: `${BASE}/register`,
      headers: { 'content-type': 'application/json', ...authHeaders() },
      body: Buffer.from(JSON.stringify(PEER)),
      signal: ac.signal
    });
    if (midFlight) setImmediate(() => ac.abort());
    await pending;
    await flush();
    const rows = await listCoordinators(h.server);
    expect(rows.filter((r) => r.status === 'online')).toEqual([]);
  });

  it('watch receives online then offline', async () => {
    h = await setup();
    const w = framesOf(await watch(h.server));
    expect((await w.next()).value).toEqual({ ok: true, watching: true });
    const reg = framesOf(await register(h.server, PEER));
    await reg.next();
    expect((await w.next()).value).toMatchObject({ event: 'online', name: 'hds-a', url: PEER.url });
    await reg.return?.();
    expect((await w.next()).value).toEqual({ event: 'offline', name: 'hds-a', url: PEER.url });
    await w.return?.();
  });

  it('refuses before any stream opens: 400 without a name, 401 anonymous, 403 without read', async () => {
    h = await setup();
    const noName = await register(h.server, { url: PEER.url });
    expect(noName.status).toBe(400);
    expect(jsonBody<{ error: string }>(noName).error).toMatch(/name and url/);
    expect((await register(h.server, PEER, {})).status).toBe(401);
    expect(await listCoordinators(h.server)).toEqual([]);
    expect((await watch(h.server, {})).status).toBe(401);
    const writeOnly = { authorization: `Bearer ${bearer(['mutate'])}` };
    expect((await watch(h.server, writeOnly)).status).toBe(403);
  });

  it('stopping the server ends open feeds instead of hanging', async () => {
    h = await setup();
    const w = framesOf(await watch(h.server));
    await w.next();
    const stopped = h.stop();
    h = undefined;
    // Shutdown aborts the feed (dropping anything queued), so the read settles rather than hangs.
    expect(
      await w.next().then(
        () => 'ended',
        () => 'ended'
      )
    ).toBe('ended');
    await stopped;
  });
});

describe('sentinel register', () => {
  const HOME = { name: 'home', url: 'http://localhost:3200', namespaces: ['family', 'home'] };

  it('upserts a Coordinator row', async () => {
    h = await setup();
    const reply = await registerReply(await register(h.server, { ...HOME, version: '1.0.0' }));
    expect(reply).toMatchObject({ ok: true, registered: true, updated: false });
    expect(await listCoordinators(h.server)).toEqual([
      expect.objectContaining({ name: 'home', status: 'online' })
    ]);
  });

  it('a second register for the same name updates instead of creating', async () => {
    h = await setup();
    expect(await registerReply(await register(h.server, HOME))).toMatchObject({ updated: false });
    const again = await register(h.server, { ...HOME, url: 'http://localhost:3201' });
    expect(await registerReply(again)).toMatchObject({ ok: true, updated: true });
    expect(await listCoordinators(h.server)).toHaveLength(1);
  });

  // Regression: the reconcile must find existing rows by `coordinatorId` (a UUID
  // string). A refused filter reads as `[]`, which duplicates rows without failing.
  it('reconciles CoordinatorNamespace rows across re-registers instead of duplicating', async () => {
    h = await setup();
    await registerReply(await register(h.server, HOME));
    expect(await listCoordinatorNamespaces(h.server)).toEqual(['family', 'home']);
    await registerReply(await register(h.server, { ...HOME, namespaces: ['family', 'work'] }));
    expect(await listCoordinatorNamespaces(h.server)).toEqual(['family', 'work']);
  });

  it('closing the stream flips the row offline and broadcasts', async () => {
    h = await setup();
    const w = framesOf(await watch(h.server));
    await w.next();
    const reg = framesOf(await register(h.server, HOME));
    await reg.next();
    expect((await w.next()).value).toMatchObject({ event: 'online', name: 'home' });
    await reg.return?.();
    expect((await w.next()).value).toEqual({ event: 'offline', name: 'home', url: HOME.url });
    expect(await listCoordinators(h.server)).toEqual([
      expect.objectContaining({ name: 'home', status: 'offline' })
    ]);
    await w.return?.();
  });

  it('refuses (409) repointing a name another identity owns', async () => {
    h = await setup();
    await registerReply(await register(h.server, HOME));
    const res = await register(
      h.server,
      { name: 'home', url: 'http://evil.test' },
      as('someone-else')
    );
    expect(res.status).toBe(409);
    expect(jsonBody<{ error: string }>(res).error).toMatch(/another identity/);
  });

  it("refuses (409) a new name advertising another identity's url", async () => {
    h = await setup();
    await registerReply(await register(h.server, HOME));
    const res = await register(h.server, { name: 'decoy', url: HOME.url }, as('someone-else'));
    expect(res.status).toBe(409);
    expect(jsonBody<{ error: string }>(res).error).toMatch(/another identity/);
  });

  it('refuses (409) a name whose row the same id created under another kind', async () => {
    h = await setup();
    await h.sentinelDataset?.write(
      'Coordinator',
      [
        {
          id: '00000000-0000-4000-8000-0000000000aa',
          name: 'home',
          url: HOME.url,
          namespaces: '',
          status: 'offline',
          lastHeartbeat: '',
          registeredAt: '',
          version: ''
        }
      ],
      // The bearer's sub is 'sentinel-peer', but it is not recorded as an agent.
      { identity: { kind: 'agent', id: 'sentinel-peer' }, now: new Date() }
    );
    const res = await register(h.server, { name: 'home', url: 'http://evil.test' });
    expect(res.status).toBe(409);
    expect(jsonBody<{ error: string }>(res).error).toMatch(/another identity/);
  });

  it('lets only an admin reclaim a row with no recorded creator', async () => {
    h = await setup();
    await h.sentinelDataset?.write('Coordinator', [
      {
        id: '00000000-0000-4000-8000-0000000000bb',
        name: 'legacy',
        url: 'http://localhost:3300',
        namespaces: '',
        status: 'offline',
        lastHeartbeat: '',
        registeredAt: '',
        version: ''
      }
    ]);
    const legacy = { name: 'legacy', url: 'http://localhost:3300' };
    expect((await register(h.server, legacy, as('someone'))).status).toBe(409);
    const admin = await register(h.server, legacy, as('operator', ['read', 'mutate', 'admin']));
    expect(await registerReply(admin)).toMatchObject({ ok: true, updated: true });
  });

  it('answers 400 to a malformed JSON body', async () => {
    h = await setup();
    const res = await h.server.inject({
      method: 'POST',
      path: `${BASE}/register`,
      headers: { 'content-type': 'application/json', ...authHeaders() },
      body: Buffer.from('not-json')
    });
    expect(res.status).toBe(400);
    expect(jsonBody<{ error: string }>(res).error).toBe('invalid JSON');
  });

  // Changed from the WS route, which refused here: with no auth composed in, plugin
  // routes carry the deployment's declared system actor (read + mutate on '*').
  it('admits register and watch as the system actor when composed with no auth', async () => {
    h = await setup({ withAuth: false });
    const w = framesOf(await watch(h.server, {}));
    expect((await w.next()).value).toEqual({ ok: true, watching: true });
    expect(await registerReply(await register(h.server, HOME, {}))).toMatchObject({ ok: true });
    expect(await listCoordinators(h.server)).toEqual([
      expect.objectContaining({ name: 'home', status: 'online' })
    ]);
    await w.return?.();
  });
});

describe('sentinel register attribution', () => {
  it('refuses (403) an identity that cannot be recorded as a creator, before writing', async () => {
    const touched = async (): Promise<never> => {
      throw new Error('register touched the engine');
    };
    const engine = { query: touched, mutate: touched } as never;
    const registry = createLivenessRegistry();
    const sent: string[] = [];
    const peer = { send: (m: string) => sent.push(m), close: () => {} } as never;
    // No agentKeyId, no tokenId and not a system envelope: resolveIdentity cannot attribute it.
    const identity = {
      kind: 'agent',
      id: 'peer@host',
      grants: { [NS]: ['read', 'mutate'] }
    } as never;
    const refusal = await handleRegister(engine, NS, identity, registry, peer, {
      name: 'x',
      url: 'https://x.test'
    });
    expect(refusal).toMatchObject({
      status: 403,
      error: expect.stringMatching(/attributable identity/)
    });
    expect(sent).toEqual([]);
  });
});

describe('frame-stream peers and liveness', () => {
  it('the tick writes a frame peer a zero-length heartbeat frame', async () => {
    const registry = createLivenessRegistry();
    const { peer, body } = framePeer(() => {});
    registry.addWatcher(peer);
    expect(runLivenessTick(registry)).toEqual({ heartbeats: 1 });
    expect(registry.watchers()).toEqual([peer]);
    const reader = body.getReader();
    expect(Array.from((await reader.read()).value ?? [])).toEqual([0, 0, 0, 0]);
    await reader.cancel();
  });

  it('a reader that stops reading is dropped once its queue passes the cap', async () => {
    let ended = 0;
    const { peer } = framePeer(() => ended++);
    const big = JSON.stringify({ event: 'online', pad: 'x'.repeat(64 * 1024) });
    for (let i = 0; i < 40; i++) peer.send(big);
    expect(ended).toBe(1);
  });
});

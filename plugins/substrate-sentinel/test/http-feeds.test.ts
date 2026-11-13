/**
 * The frame-stream feeds: POST /register and GET /watch, beside the WS route.
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
import { createLivenessRegistry, framePeer, runLivenessTick } from '../src/index.js';
import { buildSentinelForTest } from './_helpers.js';

const NS = 'sentinel';
const BASE = '/substrate/v1/plugins/substrate-sentinel';

const HS_SECRET = 'sentinel-ws-route-test-secret';
const HS_KID = 'sentinel-ws-route';
const STREAM_TICKET_SECRET = 'sentinel-ws-route-stream-ticket-secret';
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

async function setup(): Promise<Harness> {
  const server = new MemorySubstrateServer();
  const defaultDataset = new MemoryDataset({ namespace: 'default' });
  const sentinelDataset = new MemoryDataset({ namespace: NS });
  const plugin = buildSentinelForTest({ namespace: NS });
  const composed: ComposeResult = await compose({
    // Auth is off in this harness, so the deployment must declare who it
    // writes as.
    systemActor: 'test',
    server,
    dataset: defaultDataset,
    datasets: { [NS]: sentinelDataset },
    coordinators: [plugin],
    auth: authConfig,
    streamTicketSecret: STREAM_TICKET_SECRET
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

describe('frame-stream peers and liveness', () => {
  it('a frame peer is never drained as stale; the tick sends it a heartbeat, not a ping', async () => {
    let now = 0;
    const registry = createLivenessRegistry({ staleThresholdMs: 10, now: () => now });
    const { peer, body } = framePeer(() => {});
    registry.addWatcher(peer);
    now = 1000;
    const engine = { mutate: async () => ({ data: {} }) } as never;
    const result = await runLivenessTick(registry, engine, NS);
    expect(result).toEqual({ stalePinged: 1, markedOffline: 0 });
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

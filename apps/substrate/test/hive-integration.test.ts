/**
 * Hive integration — Phase 1 (in-process).
 *
 * Exercises the multi-instance primitives — bridge routing, sentinel
 * topology, runtime BridgeRegistry mutation — via three FastifySubstrateServer
 * instances bound to ephemeral ports in a single Node process.
 *
 * Gated behind SUBSTRATE_HIVE_TEST=1 so the default `pnpm test` run skips it.
 * The main.ts subprocess boot path is not covered here.
 */

import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type AuthConfig,
  type ComposeResult,
  compose,
  signHs256
} from '@mnmal-ai/substrate-compose';
import { HttpBridgeClient, MemoryBridgeRegistry } from '@mnmal-ai/substrate-core';
import { MemoryDataset } from '@mnmal-ai/substrate-dataset-memory';
import { makeAuthorizationProvider } from '@mnmal-ai/substrate-policy';
import { defineNamespace, field } from '@mnmal-ai/substrate-sdk';
import { createSentinelPlugin } from '@mnmal-ai/substrate-sentinel';
import {
  type SentinelClientHandle,
  startSentinelClient
} from '@mnmal-ai/substrate-sentinel-client';
import { FastifySubstrateServer } from '@mnmal-ai/substrate-server-fastify';
import type {
  BridgeRegistry,
  CoordinatorPlugin,
  Dataset,
  NamespaceDefinition
} from '@mnmal-ai/substrate-types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';

const HIVE_ENABLED = process.env.SUBSTRATE_HIVE_TEST === '1';

/**
 * Sentinel's `register`/`watch` frames require `req.identity`, which a plugin
 * WS route only gets when the composing instance wires `auth`. A throwaway
 * HS256 key, plus the `streamTicketSecret` compose() requires whenever `auth`
 * is set (this suite never touches SSE, but compose() throws without it).
 */
const HS_SECRET = 'hive-integration-test-secret';
const HS_KID = 'hive-integration';
const STREAM_TICKET_SECRET = 'hive-integration-stream-ticket-secret';
const authConfig: AuthConfig = {
  keys: [{ kid: HS_KID, alg: 'HS256', publicKey: HS_SECRET }]
};

function bearer(capabilities: string[] = ['read', 'mutate']): string {
  return signHs256(
    { sub: 'hive-integration-peer', capabilities, exp: Math.floor(Date.now() / 1000) + 300 },
    HS_SECRET,
    { kid: HS_KID }
  );
}

function authHeaders(): Record<string, string> {
  return { authorization: `Bearer ${bearer()}` };
}

interface InstanceHandle {
  port: number;
  composed: ComposeResult;
  stop: () => Promise<void>;
}

interface StartInstanceOpts {
  coordinators?: Array<CoordinatorPlugin>;
  datasets?: Record<string, Dataset>;
  bridges?: BridgeRegistry;
  defaultNamespace?: string;
  /** Composed only by tests that exercise sentinel `register`/`watch` or a credentialled bridge. */
  auth?: AuthConfig;
  streamTicketSecret?: string;
}

async function startInstance(opts: StartInstanceOpts = {}): Promise<InstanceHandle> {
  const server = new FastifySubstrateServer({ logger: false });
  const ns = opts.defaultNamespace ?? 'default';
  const dataset = opts.datasets?.[ns] ?? new MemoryDataset({ namespace: ns });
  const composeArgs: Parameters<typeof compose>[0] = {
    server,
    dataset,
    // Required for the instances that compose without auth.
    systemActor: 'test'
  };
  if (opts.coordinators !== undefined) composeArgs.coordinators = opts.coordinators;
  if (opts.datasets !== undefined) composeArgs.datasets = opts.datasets;
  if (opts.bridges !== undefined) composeArgs.bridges = opts.bridges;
  if (opts.auth !== undefined) composeArgs.auth = opts.auth;
  if (opts.streamTicketSecret !== undefined)
    composeArgs.streamTicketSecret = opts.streamTicketSecret;
  const composed = await compose(composeArgs);
  const { port } = await server.start({ host: '127.0.0.1', port: 0 });
  return {
    port,
    composed,
    stop: async (): Promise<void> => {
      await composed.stop();
    }
  };
}

describe.skipIf(!HIVE_ENABLED)('hive integration — smoke', () => {
  let instance: InstanceHandle | null = null;

  afterEach(async () => {
    if (instance !== null) {
      await instance.stop();
      instance = null;
    }
  });

  it('starts a single Fastify instance on an ephemeral port and serves /substrate/v1/onboard', async () => {
    instance = await startInstance();
    const res = await fetch(`http://127.0.0.1:${instance.port}/substrate/v1/onboard`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { substrate: string };
    expect(body.substrate).toBe('agent-onboard');
  });
});

/** Fixture coordinator plugin: registers a `demo` namespace with a `Widget` type. */
function buildDemoPlugin(): CoordinatorPlugin {
  const demoNamespace: NamespaceDefinition = defineNamespace('demo', {
    Widget: {
      fields: {
        label: field.string(),
        qty: field.number()
      }
    }
  });
  return {
    name: 'hive-demo-fixture',
    contractVersion: '*',
    namespaces: [demoNamespace]
  };
}

async function createWidget(
  port: number,
  ns: string,
  params: { label: string; qty: number },
  headers: Record<string, string> = {}
): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${port}/substrate/v1/mutate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({
      [`${ns}/createWidget`]: {
        params,
        fields: { id: true, label: true, qty: true }
      }
    })
  });
  expect(res.status).toBe(200);
  const env = (await res.json()) as {
    data: Record<string, { id: string }>;
    errors?: Array<{ message: string; code: string }>;
  };
  expect(env.errors).toBeUndefined();
  const created = env.data[`${ns}/createWidget`];
  expect(created?.id).toBeTypeOf('string');
  return created?.id ?? '';
}

describe.skipIf(!HIVE_ENABLED)('hive integration — static-bridge leg', () => {
  let a: InstanceHandle | null = null;
  let b: InstanceHandle | null = null;

  afterEach(async () => {
    if (a !== null) await a.stop();
    if (b !== null) await b.stop();
    a = null;
    b = null;
  });

  it('routes A.query(demo/Widget) through HttpBridgeClient to B, returning B-resolved rows', async () => {
    // Instance B hosts the demo namespace with a Widget type.
    const demoDataset = new MemoryDataset({ namespace: 'demo' });
    b = await startInstance({
      coordinators: [buildDemoPlugin()],
      datasets: { demo: demoDataset }
    });

    // Seed B with two widgets via its own HTTP mutate.
    await createWidget(b.port, 'demo', { label: 'alpha', qty: 1 });
    await createWidget(b.port, 'demo', { label: 'beta', qty: 2 });

    // Instance A has a BridgeRegistry pre-pointing at B. No local demo types.
    const bridges = new MemoryBridgeRegistry();
    const bridgeClient = new HttpBridgeClient({
      name: 'demo',
      baseUrl: `http://127.0.0.1:${b.port}`,
      // Disable the health-probe timer — 1000s is "never" for the test window.
      healthCheckIntervalMs: 1_000_000
    });
    bridges.register('demo', bridgeClient);
    a = await startInstance({ bridges });

    try {
      // Querying A for demo/Widget should route through the bridge to B.
      const res = await fetch(`http://127.0.0.1:${a.port}/substrate/v1/query`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          'demo/Widget': { params: {}, fields: { id: true, label: true, qty: true } }
        })
      });
      expect(res.status).toBe(200);
      const env = (await res.json()) as {
        data: Record<string, Array<{ label: string; qty: number }> | undefined>;
      };
      const rows = env.data['demo/Widget'];
      expect(rows).toHaveLength(2);
      const labels = (rows ?? []).map((r) => r.label).sort();
      expect(labels).toEqual(['alpha', 'beta']);
    } finally {
      bridgeClient.dispose();
    }
  });
});

// ── WS helpers ────────────────────────────────────────────────────────────────

/**
 * Open a WS client to a sentinel instance; resolves when the socket is open.
 * `headers` (e.g. `authHeaders()`) is only needed by callers that go on to
 * send `register`/`watch` — connections that don't stay anonymous.
 */
async function openSentinelWs(port: number, headers?: Record<string, string>): Promise<WebSocket> {
  const url = `ws://127.0.0.1:${port}/substrate/v1/plugins/substrate-sentinel/ws`;
  const ws = headers === undefined ? new WebSocket(url) : new WebSocket(url, { headers });
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  return ws;
}

function sendJson(ws: WebSocket, payload: unknown): void {
  ws.send(JSON.stringify(payload));
}

/** Wait for the next JSON frame matching the predicate. 5s default timeout. */
async function waitForFrame<T extends Record<string, unknown>>(
  ws: WebSocket,
  predicate: (frame: Record<string, unknown>) => boolean,
  timeoutMs = 5_000
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => {
      ws.off('message', onMessage);
      reject(new Error(`waitForFrame timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    const onMessage = (buf: Buffer): void => {
      try {
        const parsed = JSON.parse(buf.toString('utf8')) as Record<string, unknown>;
        if (predicate(parsed)) {
          clearTimeout(timeout);
          ws.off('message', onMessage);
          resolve(parsed as T);
        }
      } catch {
        // Non-JSON or parse failure — ignore, keep waiting.
      }
    };
    ws.on('message', onMessage);
  });
}

async function closeWs(ws: WebSocket): Promise<void> {
  if (ws.readyState === WebSocket.CLOSED) return;
  return new Promise<void>((resolve) => {
    ws.once('close', () => resolve());
    ws.close();
  });
}

// ── Sentinel topology ─────────────────────────────────────────────────────────

describe.skipIf(!HIVE_ENABLED)('hive integration — sentinel topology', () => {
  let s: InstanceHandle | null = null;
  const openSockets: Array<WebSocket> = [];

  afterEach(async () => {
    for (const ws of openSockets) await closeWs(ws);
    openSockets.length = 0;
    if (s !== null) await s.stop();
    s = null;
  });

  it('broadcasts online event to watchers when a coordinator registers', async () => {
    // Sentinel on a dedicated namespace. Fast pingInterval is inert here
    // because we don't start the scheduler; ticks don't fire.
    const sentinelPlugin = createSentinelPlugin({
      namespace: 'sentinel',
      pingIntervalMs: 1_000,
      staleThresholdMs: 3_000
    });
    // register/watch require an authenticated caller, so S composes a real
    // AuthConfig + streamTicketSecret.
    s = await startInstance({
      coordinators: [sentinelPlugin],
      datasets: { sentinel: new MemoryDataset({ namespace: 'sentinel' }) },
      auth: authConfig,
      streamTicketSecret: STREAM_TICKET_SECRET
    });

    // Open a watcher and send { type: 'watch' }.
    const watcher = await openSentinelWs(s.port, authHeaders());
    openSockets.push(watcher);
    const watchAckPromise = waitForFrame<{ ok: boolean; watching: boolean }>(
      watcher,
      (f) => f.ok === true && f.watching === true
    );
    sendJson(watcher, { type: 'watch' });
    const watchAck = await watchAckPromise;
    expect(watchAck.watching).toBe(true);

    // Arm the broadcast listener BEFORE the register frame arrives.
    const onlinePromise = waitForFrame<{
      event: string;
      name: string;
      url: string;
      namespaces: Array<string>;
    }>(watcher, (f) => f.event === 'online');

    // Open a second socket and register as a fake coordinator.
    const coordinator = await openSentinelWs(s.port, authHeaders());
    openSockets.push(coordinator);
    const registerAckPromise = waitForFrame<{ ok: boolean; registered: boolean }>(
      coordinator,
      (f) => f.ok === true && typeof f.registered === 'boolean'
    );
    sendJson(coordinator, {
      type: 'register',
      name: 'fake-B',
      url: 'http://127.0.0.1:65535',
      namespaces: ['demo']
    });
    const registerAck = await registerAckPromise;
    expect(registerAck.registered).toBe(true);

    // Watcher should have received the online broadcast.
    const online = await onlinePromise;
    expect(online.event).toBe('online');
    expect(online.name).toBe('fake-B');
    expect(online.url).toBe('http://127.0.0.1:65535');
    expect(online.namespaces).toEqual(['demo']);
  }, 15_000);
});

describe.skipIf(!HIVE_ENABLED)('hive integration — sentinel liveness', () => {
  let s: InstanceHandle | null = null;
  const openSockets: Array<WebSocket> = [];

  afterEach(async () => {
    for (const ws of openSockets) await closeWs(ws);
    openSockets.length = 0;
    if (s !== null) await s.stop();
    s = null;
  });

  it('broadcasts offline event to watchers when a coordinator disconnects', async () => {
    const sentinelPlugin = createSentinelPlugin({
      namespace: 'sentinel',
      pingIntervalMs: 1_000,
      staleThresholdMs: 3_000
    });
    // register/watch require an authenticated caller.
    s = await startInstance({
      coordinators: [sentinelPlugin],
      datasets: { sentinel: new MemoryDataset({ namespace: 'sentinel' }) },
      auth: authConfig,
      streamTicketSecret: STREAM_TICKET_SECRET
    });

    // Watcher first.
    const watcher = await openSentinelWs(s.port, authHeaders());
    openSockets.push(watcher);
    const watchAckPromise = waitForFrame<{ ok: boolean; watching: boolean }>(
      watcher,
      (f) => f.ok === true && f.watching === true
    );
    sendJson(watcher, { type: 'watch' });
    await watchAckPromise;

    // Coordinator register — NOT pushed to openSockets because we close it mid-test.
    const coordinator = await openSentinelWs(s.port, authHeaders());
    const registerAckPromise = waitForFrame<{ ok: boolean; registered: boolean }>(
      coordinator,
      (f) => f.ok === true && typeof f.registered === 'boolean'
    );
    sendJson(coordinator, {
      type: 'register',
      name: 'fake-C',
      url: 'http://127.0.0.1:65534',
      namespaces: ['demo']
    });
    await registerAckPromise;

    // Drain the online broadcast so the next waitForFrame doesn't grab it
    // instead of the offline event.
    await waitForFrame(watcher, (f) => f.event === 'online');

    // Arm the offline listener, then close the coordinator socket.
    const offlinePromise = waitForFrame<{ event: string; name: string; url: string }>(
      watcher,
      (f) => f.event === 'offline'
    );
    await closeWs(coordinator);

    const offline = await offlinePromise;
    expect(offline.event).toBe('offline');
    expect(offline.name).toBe('fake-C');
    expect(offline.url).toBe('http://127.0.0.1:65534');
  }, 15_000);
});

describe.skipIf(!HIVE_ENABLED)('hive integration — full-hive smoke', () => {
  let a: InstanceHandle | null = null;
  let b: InstanceHandle | null = null;
  let s: InstanceHandle | null = null;
  const openSockets: Array<WebSocket> = [];

  afterEach(async () => {
    for (const ws of openSockets) await closeWs(ws);
    openSockets.length = 0;
    if (a !== null) await a.stop();
    if (b !== null) await b.stop();
    if (s !== null) await s.stop();
    a = null;
    b = null;
    s = null;
  });

  it('A watches S → B registers → A runtime-registers bridge → A queries B via bridge', async () => {
    // --- Instance B: demo namespace producer ---
    const demoDataset = new MemoryDataset({ namespace: 'demo' });
    b = await startInstance({
      coordinators: [buildDemoPlugin()],
      datasets: { demo: demoDataset }
    });
    await createWidget(b.port, 'demo', { label: 'shipped', qty: 42 });

    // --- Instance S: sentinel ---
    const sentinelPlugin = createSentinelPlugin({
      namespace: 'sentinel',
      pingIntervalMs: 1_000,
      staleThresholdMs: 3_000
    });
    // register/watch require an authenticated caller. Only S (which hosts the
    // sentinel WS route) needs auth; A and B compose without it.
    s = await startInstance({
      coordinators: [sentinelPlugin],
      datasets: { sentinel: new MemoryDataset({ namespace: 'sentinel' }) },
      auth: authConfig,
      streamTicketSecret: STREAM_TICKET_SECRET
    });

    // --- Instance A: consumer with an empty, live BridgeRegistry ---
    const aBridges = new MemoryBridgeRegistry();
    a = await startInstance({ bridges: aBridges });

    // Test acts as A's sentinel-client: open watcher, observe online events,
    // runtime-register the bridge on A by hand.
    const watcher = await openSentinelWs(s.port, authHeaders());
    openSockets.push(watcher);
    const watchAckPromise = waitForFrame<{ ok: boolean; watching: boolean }>(
      watcher,
      (f) => f.ok === true && f.watching === true
    );
    sendJson(watcher, { type: 'watch' });
    await watchAckPromise;

    // B registers with S. NOT pushed to openSockets — we close it manually mid-test.
    const bRegister = await openSentinelWs(s.port, authHeaders());
    const registerAckPromise = waitForFrame<{ ok: boolean; registered: boolean }>(
      bRegister,
      (f) => f.ok === true && typeof f.registered === 'boolean'
    );
    sendJson(bRegister, {
      type: 'register',
      name: 'B',
      url: `http://127.0.0.1:${b.port}`,
      namespaces: ['demo']
    });
    await registerAckPromise;

    // Watcher receives online; test reacts by runtime-registering the bridge.
    const online = await waitForFrame<{
      event: string;
      name: string;
      url: string;
      namespaces: Array<string>;
    }>(watcher, (f) => f.event === 'online');
    expect(online.name).toBe('B');
    expect(online.url).toBe(`http://127.0.0.1:${b.port}`);
    expect(online.namespaces).toContain('demo');

    const bridgeClient = new HttpBridgeClient({
      name: 'demo',
      baseUrl: online.url,
      healthCheckIntervalMs: 1_000_000
    });
    try {
      aBridges.register('demo', bridgeClient);
      // Post-compose bridge registration requires manual refresh — the engine's
      // initial refreshBridgeSchemas() only saw bridges present at compose time.
      await a.composed.engine.refreshBridgeSchemas();

      // A queries demo/Widget — must route through the newly-registered bridge.
      const queryRes = await fetch(`http://127.0.0.1:${a.port}/substrate/v1/query`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          'demo/Widget': { params: {}, fields: { id: true, label: true, qty: true } }
        })
      });
      expect(queryRes.status).toBe(200);
      const queryEnv = (await queryRes.json()) as {
        data: Record<string, Array<{ label: string; qty: number }>>;
      };
      const rows = queryEnv.data['demo/Widget'];
      expect(rows).toHaveLength(1);
      expect(rows![0]?.label).toBe('shipped');
      expect(rows![0]?.qty).toBe(42);

      // B disappears → S broadcasts offline → A reacts by unregistering.
      const offlinePromise = waitForFrame<{ event: string; name: string }>(
        watcher,
        (f) => f.event === 'offline' && f.name === 'B'
      );
      await closeWs(bRegister);
      const offline = await offlinePromise;
      expect(offline.name).toBe('B');

      aBridges.unregister('demo');

      // Query after unregister — either an error envelope (e.g. unknown_name)
      // or an empty data array is acceptable. Assert one of the two happened.
      const postUnregister = await fetch(`http://127.0.0.1:${a.port}/substrate/v1/query`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          'demo/Widget': { params: {}, fields: { id: true } }
        })
      });
      const env = (await postUnregister.json()) as {
        data?: Record<string, unknown>;
        errors?: Array<{ message: string; code: string }>;
      };
      const hasErrors = Array.isArray(env.errors) && env.errors.length > 0;
      const rowsAfter = env.data?.['demo/Widget'];
      const hasEmptyRows = Array.isArray(rowsAfter) && rowsAfter.length === 0;
      expect(hasErrors || hasEmptyRows).toBe(true);
    } finally {
      bridgeClient.dispose();
    }
  }, 15_000);
});

// ── Bridge federation trust ─────────────────────────────────────────────────

/** Writes a fresh Ed25519 keypair to a throwaway temp dir; returns both PEM forms + the dir. */
function writeEd25519Keypair(prefix: string): {
  keyPath: string;
  publicKeyPem: string;
  dir: string;
} {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const keyPath = join(dir, 'bridge.key');
  writeFileSync(keyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }).toString());
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  return { keyPath, publicKeyPem, dir };
}

describe.skipIf(!HIVE_ENABLED)('hive integration — bridge federation trust', () => {
  let a: InstanceHandle | null = null;
  let b: InstanceHandle | null = null;
  let bridgeClient: HttpBridgeClient | null = null;
  const keyDirs: Array<string> = [];

  afterEach(async () => {
    bridgeClient?.dispose();
    bridgeClient = null;
    if (a !== null) await a.stop();
    if (b !== null) await b.stop();
    a = null;
    b = null;
    for (const dir of keyDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('a credentialled bridge authenticates and returns remote rows', async () => {
    // Instance B requires a valid EdDSA-signed bearer carrying read+mutate.
    const kid = 'a-bridge@hive-test';
    const { keyPath, publicKeyPem, dir } = writeEd25519Keypair('substrate-hive-bridge-');
    keyDirs.push(dir);
    const demoDataset = new MemoryDataset({ namespace: 'demo' });
    b = await startInstance({
      coordinators: [buildDemoPlugin()],
      datasets: { demo: demoDataset },
      auth: { keys: [{ kid, alg: 'EdDSA', publicKey: publicKeyPem }] },
      streamTicketSecret: STREAM_TICKET_SECRET
    });

    // B now requires auth on every route, including the seeding mutate below —
    // present the same credential the bridge itself will use.
    const auth = makeAuthorizationProvider({ keyPath, kid });
    await createWidget(b.port, 'demo', { label: 'alpha', qty: 1 }, { authorization: auth() });
    await createWidget(b.port, 'demo', { label: 'beta', qty: 2 }, { authorization: auth() });

    // Record every Authorization header the bridge actually sends over the
    // wire — forwarding to the real fetch, not stubbing the network away.
    const seen: Array<string | undefined> = [];
    const recordingFetch = ((input: string | URL | Request, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string> | undefined;
      seen.push(headers?.authorization);
      return fetch(input, init);
    }) as typeof fetch;

    const bridges = new MemoryBridgeRegistry();
    bridgeClient = new HttpBridgeClient({
      name: 'demo',
      baseUrl: `http://127.0.0.1:${b.port}`,
      // Disable the health-probe timer — its own periodic fetch would also
      // land in `seen` and muddy the assertion below.
      healthCheckIntervalMs: 1_000_000,
      fetch: recordingFetch,
      auth
    });
    bridges.register('demo', bridgeClient);
    a = await startInstance({ bridges });

    const res = await fetch(`http://127.0.0.1:${a.port}/substrate/v1/query`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        'demo/Widget': { fields: { id: true, label: true, qty: true } }
      })
    });
    expect(res.status).toBe(200);
    const env = (await res.json()) as {
      data: Record<string, Array<{ label: string; qty: number }> | undefined>;
      errors?: Array<{ message: string; code: string }>;
    };
    expect(env.errors).toBeUndefined();
    const rows = env.data['demo/Widget'];
    expect(rows).toHaveLength(2);
    const labels = (rows ?? []).map((r) => r.label).sort();
    expect(labels).toEqual(['alpha', 'beta']);

    // Every request B saw for this query carried an Authorization header.
    expect(seen.length).toBeGreaterThan(0);
    for (const value of seen) expect(value).toMatch(/^Bearer /);
  }, 15_000);

  it('a remote rejecting the token surfaces as a non-fatal read', async () => {
    // B only trusts a specific EdDSA kid/keypair.
    const { publicKeyPem, dir: bDir } = writeEd25519Keypair('substrate-hive-bridge-b-');
    keyDirs.push(bDir);
    const demoDataset = new MemoryDataset({ namespace: 'demo' });
    b = await startInstance({
      coordinators: [buildDemoPlugin()],
      datasets: { demo: demoDataset },
      auth: { keys: [{ kid: 'b-only@hive-test', alg: 'EdDSA', publicKey: publicKeyPem }] },
      streamTicketSecret: STREAM_TICKET_SECRET
    });

    // The bridge signs with an entirely unrelated keypair — B's auth
    // verifies the signature against its own registered key and rejects it
    // outright (401), never seeing a token it merely lacks a capability for.
    const { keyPath: wrongKeyPath, dir: wrongDir } = writeEd25519Keypair(
      'substrate-hive-bridge-wrong-'
    );
    keyDirs.push(wrongDir);
    const auth = makeAuthorizationProvider({ keyPath: wrongKeyPath, kid: 'wrong-kid@hive-test' });

    const bridges = new MemoryBridgeRegistry();
    bridgeClient = new HttpBridgeClient({
      name: 'demo',
      baseUrl: `http://127.0.0.1:${b.port}`,
      healthCheckIntervalMs: 1_000_000,
      auth
    });
    bridges.register('demo', bridgeClient);
    a = await startInstance({ bridges });

    const res = await fetch(`http://127.0.0.1:${a.port}/substrate/v1/query`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        'demo/Widget': { fields: { id: true } }
      })
    });
    expect(res.status).toBe(200); // §6.6 — reads are non-fatal
    const env = (await res.json()) as {
      data: Record<string, unknown>;
      _completeness?: Record<string, { complete: boolean; unreachable?: Array<string> }>;
    };
    expect(env._completeness?.['demo/Widget']?.complete).toBe(false);
  }, 15_000);
});

// ── Discovery allowlist (sentinel-client) ────────────────────────────────────

describe.skipIf(!HIVE_ENABLED)('hive integration — discovery allowlist', () => {
  let a: InstanceHandle | null = null;
  let s: InstanceHandle | null = null;
  let clientHandle: SentinelClientHandle | null = null;
  const openSockets: Array<WebSocket> = [];

  afterEach(async () => {
    if (clientHandle !== null) await clientHandle.stop();
    clientHandle = null;
    for (const ws of openSockets) await closeWs(ws);
    openSockets.length = 0;
    if (a !== null) await a.stop();
    if (s !== null) await s.stop();
    a = null;
    s = null;
  });

  it('an unprovisioned discovered coordinator produces no bridge and no outbound request', async () => {
    const sentinelPlugin = createSentinelPlugin({
      namespace: 'sentinel',
      pingIntervalMs: 1_000,
      staleThresholdMs: 3_000
    });
    s = await startInstance({
      coordinators: [sentinelPlugin],
      datasets: { sentinel: new MemoryDataset({ namespace: 'sentinel' }) },
      auth: authConfig,
      streamTicketSecret: STREAM_TICKET_SECRET
    });

    // A's own BridgeRegistry + an EMPTY credential allowlist — 'evil' is
    // never provisioned.
    const aBridges = new MemoryBridgeRegistry();
    a = await startInstance({ bridges: aBridges });

    // "No bridge" alone would still pass if a schema fetch had already
    // fired (e.g. for validation/logging before the credential check) —
    // spy on the real global fetch so a stray outbound call fails the test
    // even if it isn't the one that would have built the bridge.
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    let resolveConnected: () => void;
    const connected = new Promise<void>((resolve) => {
      resolveConnected = resolve;
    });
    let resolveRejected: () => void;
    const rejected = new Promise<void>((resolve) => {
      resolveRejected = resolve;
    });

    clientHandle = startSentinelClient({
      sentinelUrl: `ws://127.0.0.1:${s.port}/substrate/v1/plugins/substrate-sentinel/ws`,
      bridges: aBridges,
      engine: a.composed.engine,
      creds: { get: () => undefined },
      metric: (name) => {
        if (name === 'sentinel_client_connected') resolveConnected();
        if (name === 'bridge_discovery_rejected') resolveRejected();
      },
      reconnectBaseMs: 10,
      reconnectMaxMs: 100,
      // S requires an authenticated caller for `watch`; `wsFactory` is the
      // only way to attach credentials to the client's topology connection.
      wsFactory: (url: string) => new WebSocket(url, { headers: authHeaders() })
    });
    await connected;

    // A rogue coordinator registers itself with S under the name 'evil'.
    // The register frame itself only needs to pass sentinel's own WS auth
    // gate (any bearer with `mutate`) — the credential-store gate below is
    // a separate trust boundary the sentinel-client applies on top.
    const evilSocket = await openSentinelWs(s.port, authHeaders());
    openSockets.push(evilSocket);
    const registerAckPromise = waitForFrame<{ ok: boolean; registered: boolean }>(
      evilSocket,
      (f) => f.ok === true && typeof f.registered === 'boolean'
    );
    sendJson(evilSocket, {
      type: 'register',
      name: 'evil',
      url: 'https://evil.test',
      namespaces: ['pirate']
    });
    await registerAckPromise;

    // Deterministic instead of a fixed sleep: the client's own metric hook
    // fires exactly when handleOnline's credential-store miss is reached.
    await rejected;

    expect(aBridges.has('pirate')).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  }, 15_000);
});

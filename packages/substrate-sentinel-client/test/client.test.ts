import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import * as http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FetchLike } from '@mnmal-ai/substrate-client';
import { type AuthConfig, compose, signHs256 } from '@mnmal-ai/substrate-compose';
import { MemoryBridgeRegistry } from '@mnmal-ai/substrate-core';
import { MemoryDataset } from '@mnmal-ai/substrate-dataset-memory';
import { encodeStreamFrame, FRAMES_JSON_MIME } from '@mnmal-ai/substrate-pack';
import { defineNamespace, field } from '@mnmal-ai/substrate-sdk';
import { createSentinelPlugin } from '@mnmal-ai/substrate-sentinel';
import { FastifySubstrateServer } from '@mnmal-ai/substrate-server-fastify';
import type {
  BridgeClient,
  BridgeCredential,
  CoordinatorPlugin,
  NamespaceDefinition
} from '@mnmal-ai/substrate-types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startSentinelClient, type WritableBridgeRegistry } from '../src/client.js';

function writeKey(): string {
  const { privateKey } = generateKeyPairSync('ed25519');
  const dir = mkdtempSync(join(tmpdir(), 'substrate-sentinel-client-'));
  const path = join(dir, 'test.key');
  writeFileSync(path, privateKey.export({ type: 'pkcs8', format: 'pem' }).toString());
  return path;
}

const KEY_PATH = writeKey();

/**
 * Every test below that expects a real register/watch round-trip composes
 * `auth` in and presents a bearer on both the raw register request and the
 * sentinel-client's own watch request, through the `fetch` seam.
 */
const HS_SECRET = 'sentinel-client-test-secret';
const HS_KID = 'sentinel-client-test';
const authConfig: AuthConfig = {
  keys: [{ kid: HS_KID, alg: 'HS256', publicKey: HS_SECRET }]
};

function bearer(): string {
  return signHs256(
    {
      sub: 'sentinel-client-peer',
      capabilities: ['read', 'mutate'],
      exp: Math.floor(Date.now() / 1000) + 300
    },
    HS_SECRET,
    { kid: HS_KID }
  );
}

function authHeaders(): Record<string, string> {
  return { authorization: `Bearer ${bearer()}` };
}

/**
 * The round-trip tests register a coordinator named `'B'`; this allowlist
 * fixture provisions exactly that name so they exercise the real
 * register → online → bridge-construction path.
 *
 * A credential is bound to an ORIGIN as well as a name, and B's port is only
 * known at runtime, so the fixture is a factory over B's base URL.
 */
function allowB(bUrl: string): { get: (n: string) => BridgeCredential | undefined } {
  const origin = new URL(bUrl).origin;
  return {
    get: (n: string) =>
      n === 'B' ? { keyPath: KEY_PATH, kid: 'b@sentinel-test', origin } : undefined
  };
}

interface SpyEngine {
  calls: number;
  refreshBridgeSchemas(): Promise<void>;
  registryFor(ns: string): undefined;
}

function makeSpyEngine(): SpyEngine {
  const state = { calls: 0 };
  return {
    get calls() {
      return state.calls;
    },
    async refreshBridgeSchemas(): Promise<void> {
      state.calls++;
    },
    registryFor: () => undefined
  };
}

function buildDemoPlugin(): CoordinatorPlugin {
  const ns: NamespaceDefinition = defineNamespace('demo', {
    Widget: { fields: { label: field.string(), qty: field.number() } }
  });
  return { name: 'demo-fixture', contractVersion: '*', namespaces: [ns] };
}

interface Instance {
  port: number;
  stop: () => Promise<void>;
}

async function startFastify(opts: {
  coordinators?: Array<CoordinatorPlugin>;
  datasets?: Record<string, MemoryDataset>;
  auth?: AuthConfig;
}): Promise<Instance> {
  const server = new FastifySubstrateServer({ logger: false });
  const defaultDataset = new MemoryDataset({ namespace: 'default' });
  const composeArgs: Parameters<typeof compose>[0] = {
    server,
    dataset: defaultDataset,
    // Declared, because a harness without auth still writes rows and a write
    // says who made it.
    systemActor: 'test'
  };
  if (opts.coordinators !== undefined) composeArgs.coordinators = opts.coordinators;
  if (opts.datasets !== undefined) composeArgs.datasets = opts.datasets;
  if (opts.auth !== undefined) composeArgs.auth = opts.auth;
  const composed = await compose(composeArgs);
  const { port } = await server.start({ host: '127.0.0.1', port: 0 });
  return {
    port,
    stop: async (): Promise<void> => {
      await composed.stop();
    }
  };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`waitUntil timed out after ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('startSentinelClient — online handler', () => {
  let s: Instance | null = null;
  let b: Instance | null = null;
  let clientStop: (() => Promise<void>) | null = null;
  let bRegistration: { close(): Promise<void> } | null = null;

  afterEach(async () => {
    if (clientStop !== null) await clientStop();
    if (bRegistration !== null) await bRegistration.close();
    if (b !== null) await b.stop();
    if (s !== null) await s.stop();
    clientStop = null;
    bRegistration = null;
    b = null;
    s = null;
  });

  it('registers a bridge in the caller-owned BridgeRegistry on online event', async () => {
    s = await startFastify({
      coordinators: [
        createSentinelPlugin({
          namespace: 'sentinel',
          pingIntervalMs: 1000
        })
      ],
      datasets: { sentinel: new MemoryDataset({ namespace: 'sentinel' }) },
      auth: authConfig
    });
    b = await startFastify({
      coordinators: [buildDemoPlugin()],
      datasets: { demo: new MemoryDataset({ namespace: 'demo' }) }
    });

    const bridges = new MemoryBridgeRegistry();
    const engine = makeSpyEngine();

    const handle = startSentinelClient({
      sentinelUrl: `http://127.0.0.1:${s.port}`,
      bridges,
      engine,
      creds: allowB(`http://127.0.0.1:${b.port}`),
      reconnectBaseMs: 10,
      reconnectMaxMs: 100,
      auth: () => `Bearer ${bearer()}`
    });
    clientStop = handle.stop;
    await waitUntil(() => handle.isConnected());

    bRegistration = await registerWith(s.port, {
      name: 'B',
      url: `http://127.0.0.1:${b.port}`,
      namespaces: ['demo']
    });

    await waitUntil(() => bridges.has('demo'));
    expect(bridges.has('demo')).toBe(true);
    expect(bridges.get('demo')?.baseUrl).toBe(`http://127.0.0.1:${b.port}`);
    expect(engine.calls).toBeGreaterThanOrEqual(1);
  }, 15_000);
});

describe('startSentinelClient — offline + stop', () => {
  let s: Instance | null = null;
  let b: Instance | null = null;
  let clientStop: (() => Promise<void>) | null = null;
  let bRegistration: { close(): Promise<void> } | null = null;

  afterEach(async () => {
    if (clientStop !== null) await clientStop();
    if (bRegistration !== null) await bRegistration.close();
    if (b !== null) await b.stop();
    if (s !== null) await s.stop();
    clientStop = null;
    bRegistration = null;
    b = null;
    s = null;
  });

  it('unregisters the bridge and disposes the client on offline event', async () => {
    s = await startFastify({
      coordinators: [
        createSentinelPlugin({
          namespace: 'sentinel',
          pingIntervalMs: 1000
        })
      ],
      datasets: { sentinel: new MemoryDataset({ namespace: 'sentinel' }) },
      auth: authConfig
    });
    b = await startFastify({
      coordinators: [buildDemoPlugin()],
      datasets: { demo: new MemoryDataset({ namespace: 'demo' }) }
    });

    const bridges = new MemoryBridgeRegistry();
    const engine = makeSpyEngine();

    const handle = startSentinelClient({
      sentinelUrl: `http://127.0.0.1:${s.port}`,
      bridges,
      engine,
      creds: allowB(`http://127.0.0.1:${b.port}`),
      reconnectBaseMs: 10,
      reconnectMaxMs: 100,
      auth: () => `Bearer ${bearer()}`
    });
    clientStop = handle.stop;
    await waitUntil(() => handle.isConnected());

    bRegistration = await registerWith(s.port, {
      name: 'B',
      url: `http://127.0.0.1:${b.port}`,
      namespaces: ['demo']
    });

    await waitUntil(() => bridges.has('demo'));
    expect(bridges.has('demo')).toBe(true);

    await bRegistration?.close();
    bRegistration = null;

    await waitUntil(() => !bridges.has('demo'));
    expect(bridges.has('demo')).toBe(false);
  }, 15_000);

  it('stop() closes WS, unregisters owned bridges, and is idempotent', async () => {
    s = await startFastify({
      coordinators: [
        createSentinelPlugin({
          namespace: 'sentinel',
          pingIntervalMs: 1000
        })
      ],
      datasets: { sentinel: new MemoryDataset({ namespace: 'sentinel' }) },
      auth: authConfig
    });
    b = await startFastify({
      coordinators: [buildDemoPlugin()],
      datasets: { demo: new MemoryDataset({ namespace: 'demo' }) }
    });

    const bridges = new MemoryBridgeRegistry();
    const engine = makeSpyEngine();

    const handle = startSentinelClient({
      sentinelUrl: `http://127.0.0.1:${s.port}`,
      bridges,
      engine,
      creds: allowB(`http://127.0.0.1:${b.port}`),
      reconnectBaseMs: 10,
      reconnectMaxMs: 100,
      auth: () => `Bearer ${bearer()}`
    });
    clientStop = null; // Call stop manually inside this test.
    await waitUntil(() => handle.isConnected());

    bRegistration = await registerWith(s.port, {
      name: 'B',
      url: `http://127.0.0.1:${b.port}`,
      namespaces: ['demo']
    });
    await waitUntil(() => bridges.has('demo'));

    await handle.stop();
    expect(handle.isConnected()).toBe(false);
    expect(bridges.has('demo')).toBe(false);

    await expect(handle.stop()).resolves.toBeUndefined();
  }, 15_000);
});

describe('startSentinelClient — end-to-end through compose', () => {
  let s: Instance | null = null;
  let b: Instance | null = null;
  let a: Instance | null = null;
  let clientStop: (() => Promise<void>) | null = null;
  let bRegistration: { close(): Promise<void> } | null = null;

  afterEach(async () => {
    if (clientStop !== null) await clientStop();
    if (bRegistration !== null) await bRegistration.close();
    if (a !== null) await a.stop();
    if (b !== null) await b.stop();
    if (s !== null) await s.stop();
    clientStop = null;
    bRegistration = null;
    a = null;
    b = null;
    s = null;
  });

  it('routes a query through a sentinel-discovered bridge when the registry is wired into compose', async () => {
    s = await startFastify({
      coordinators: [
        createSentinelPlugin({
          namespace: 'sentinel',
          pingIntervalMs: 1000
        })
      ],
      datasets: { sentinel: new MemoryDataset({ namespace: 'sentinel' }) },
      auth: authConfig
    });
    b = await startFastify({
      coordinators: [buildDemoPlugin()],
      datasets: { demo: new MemoryDataset({ namespace: 'demo' }) }
    });

    // Seed B with a Widget so the query below has something to return.
    const seedRes = await fetch(`http://127.0.0.1:${b.port}/substrate/v1/mutate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        'demo/createWidget': {
          params: { label: 'shipped', qty: 7 },
          fields: { id: true }
        }
      })
    });
    expect(seedRes.status).toBe(200);

    // Instance A: empty BridgeRegistry, wired into compose.
    const bridges = new MemoryBridgeRegistry();
    const aServer = new FastifySubstrateServer({ logger: false });
    const aDataset = new MemoryDataset({ namespace: 'default' });
    const aComposed = await compose({
      // Auth is off in this harness, so the deployment declares who it writes
      // as — `resolveIdentity` does not invent one.
      systemActor: 'test',
      server: aServer,
      dataset: aDataset,
      bridges
    });
    const { port: aPort } = await aServer.start({ host: '127.0.0.1', port: 0 });
    a = {
      port: aPort,
      stop: async (): Promise<void> => {
        await aComposed.stop();
      }
    };

    // Start the sentinel client pointed at S, mutating A's bridges + A's engine.
    const handle = startSentinelClient({
      sentinelUrl: `http://127.0.0.1:${s.port}`,
      bridges,
      engine: aComposed.engine,
      creds: allowB(`http://127.0.0.1:${b.port}`),
      reconnectBaseMs: 10,
      reconnectMaxMs: 100,
      auth: () => `Bearer ${bearer()}`
    });
    clientStop = handle.stop;
    await waitUntil(() => handle.isConnected());

    // B registers itself with S — triggers online broadcast → A learns about B.
    bRegistration = await registerWith(s.port, {
      name: 'B',
      url: `http://127.0.0.1:${b.port}`,
      namespaces: ['demo']
    });

    await waitUntil(() => bridges.has('demo'));

    // Now the real assertion: query A for demo/Widget. Should route through
    // the sentinel-discovered bridge to B and return the seeded Widget.
    const queryRes = await fetch(`http://127.0.0.1:${a.port}/substrate/v1/query`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        'demo/Widget': { params: {}, fields: { id: true, label: true, qty: true } }
      })
    });
    expect(queryRes.status).toBe(200);
    const env = (await queryRes.json()) as {
      data: Record<string, Array<{ label: string; qty: number }>>;
      errors?: Array<{ message: string; code: string }>;
    };
    expect(env.errors).toBeUndefined();
    const rows = env.data['demo/Widget'] ?? [];
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row?.label).toBe('shipped');
    expect(row?.qty).toBe(7);
  }, 15_000);
});

describe('startSentinelClient — reconnect', () => {
  let s: Instance | null = null;
  let clientStop: (() => Promise<void>) | null = null;

  afterEach(async () => {
    if (clientStop !== null) await clientStop();
    if (s !== null) await s.stop();
    clientStop = null;
    s = null;
  });

  it('reconnects after the sentinel socket is forcibly closed', async () => {
    s = await startFastify({
      coordinators: [
        createSentinelPlugin({
          namespace: 'sentinel',
          pingIntervalMs: 1000
        })
      ],
      datasets: { sentinel: new MemoryDataset({ namespace: 'sentinel' }) }
    });

    const bridges = new MemoryBridgeRegistry();
    const engine = makeSpyEngine();

    const handle = startSentinelClient({
      sentinelUrl: `http://127.0.0.1:${s.port}`,
      bridges,
      engine,
      // No B in this test — nothing ever comes online, so the origin the
      // fixture is bound to is irrelevant here.
      creds: allowB('http://127.0.0.1:1'),
      reconnectBaseMs: 10,
      reconnectMaxMs: 100
    });
    clientStop = handle.stop;
    await waitUntil(() => handle.isConnected());

    // Shut down sentinel — client's WS closes, reconnect loop starts.
    await s.stop();
    s = null;

    await waitUntil(() => !handle.isConnected(), 2000);
    expect(handle.isConnected()).toBe(false);

    // Several backoff cycles; client shouldn't crash or throw.
    await new Promise((r) => setTimeout(r, 200));
    expect(handle.isConnected()).toBe(false);

    // stop() must still work cleanly from a never-reconnected state.
    await handle.stop();
    clientStop = null;
    expect(handle.isConnected()).toBe(false);
  });
});

function makeMockBridges(registered: Array<string>): WritableBridgeRegistry {
  return {
    has: () => false,
    get: () => undefined,
    isUnreachable: () => false,
    entries: () => [],
    register: (ns: string) => {
      registered.push(ns);
    },
    unregister: () => {}
  };
}

/**
 * A fake sentinel feed for driving `handleOnline` directly with adversarial
 * frames (e.g. a coordinator name that never went through real sentinel
 * registration) that the real route would reject upstream before they ever
 * reached a watcher. `fetch` is the client's designated test seam for exactly
 * this: the watch request gets a frame stream the test writes into.
 */
let activeFeed: ReadableStreamDefaultController<Uint8Array> | null = null;

function makeFakeFeed(): FetchLike {
  return async (_url, init) => {
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        activeFeed = c;
      }
    });
    init?.signal?.addEventListener('abort', () => {
      try {
        activeFeed?.error(new DOMException('aborted', 'AbortError'));
      } catch {
        // Already closed.
      }
    });
    return new Response(body, { headers: { 'content-type': FRAMES_JSON_MIME } });
  };
}

/** Drains enough turns for the client to read the frame and settle what it triggers. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}

/** Writes one frame into the fake feed, then lets the client act on it. */
async function emitFrame(payload: Record<string, unknown>): Promise<void> {
  if (activeFeed === null) {
    throw new Error('emitFrame called before startSentinelClient made its watch request');
  }
  activeFeed.enqueue(encodeStreamFrame(payload, 'json'));
  await settle();
}

/** Simulates the sentinel broadcasting an `online` event. */
async function emitOnline(payload: Record<string, unknown>): Promise<void> {
  await emitFrame({ event: 'online', ...payload });
}

/** Registers a coordinator with a real sentinel; `close()` ends the registration's stream. */
async function registerWith(
  sentinelPort: number,
  body: Record<string, unknown>
): Promise<{ close(): Promise<void> }> {
  const ctrl = new AbortController();
  const res = await fetch(
    `http://127.0.0.1:${sentinelPort}/substrate/v1/plugins/substrate-sentinel/register`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders() },
      body: JSON.stringify(body),
      signal: ctrl.signal
    }
  );
  if (res.status !== 200 || res.body === null) throw new Error(`register answered ${res.status}`);
  const reader = res.body.getReader();
  await reader.read(); // the register reply
  return {
    close: async () => {
      await reader.cancel().catch(() => {});
      ctrl.abort();
    }
  };
}

describe('discovery allowlist', () => {
  afterEach(() => {
    activeFeed = null;
  });

  it('ignores an online frame for an unprovisioned coordinator and issues no request', async () => {
    const registered: Array<string> = [];
    const fetches: Array<string> = [];
    // The mock assertions (registered/fetches) prove the credential check runs
    // before refreshBridgeSchemas(), but cannot see a bridge constructed and
    // never registered. `HttpBridgeClient`'s constructor schedules a
    // health-probe `fetch` on its own timer, so spying on the real `fetch`
    // guards that no bridge — and no outbound request — was ever formed.
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    try {
      const handle = startSentinelClient({
        sentinelUrl: 'http://sentinel.test',
        bridges: makeMockBridges(registered),
        engine: {
          refreshBridgeSchemas: async () => {
            fetches.push('refresh');
          },
          registryFor: () => undefined
        },
        creds: { get: () => undefined },
        fetch: makeFakeFeed()
      });

      await emitOnline({ name: 'evil', url: 'https://evil.test', namespaces: ['cortext'] });

      expect(registered).toEqual([]);
      expect(fetches).toEqual([]);
      expect(fetchSpy).not.toHaveBeenCalled();
      await handle.stop();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('drops a bridge on offline when the coordinator advertised a trailing-slash url', async () => {
    const unregistered: Array<string> = [];
    const handle = startSentinelClient({
      sentinelUrl: 'http://sentinel.test',
      bridges: { ...makeMockBridges([]), unregister: (ns: string) => unregistered.push(ns) },
      engine: { refreshBridgeSchemas: async () => {}, registryFor: () => undefined },
      creds: { get: () => ({ keyPath: KEY_PATH, kid: 'k@h', origin: 'https://a.test' }) },
      fetch: makeFakeFeed()
    });
    await emitOnline({ name: 'peripheral-a', url: 'https://a.test/', namespaces: ['alpha'] });
    await emitFrame({ event: 'offline', name: 'peripheral-a', url: 'https://a.test/' });
    expect(unregistered).toEqual(['alpha']);
    await handle.stop();
  });

  it('keeps a bridge when an offline names a different coordinator at the same url', async () => {
    const unregistered: Array<string> = [];
    const handle = startSentinelClient({
      sentinelUrl: 'http://sentinel.test',
      bridges: { ...makeMockBridges([]), unregister: (ns: string) => unregistered.push(ns) },
      engine: { refreshBridgeSchemas: async () => {}, registryFor: () => undefined },
      creds: { get: () => ({ keyPath: KEY_PATH, kid: 'k@h', origin: 'https://a.test' }) },
      fetch: makeFakeFeed()
    });
    await emitOnline({ name: 'peripheral-a', url: 'https://a.test', namespaces: ['alpha'] });
    await emitFrame({ event: 'offline', name: 'impostor', url: 'https://a.test' });
    expect(unregistered).toEqual([]);
    await handle.stop();
  });

  it('registers every advertised namespace for a provisioned coordinator', async () => {
    const registered: Array<string> = [];
    const handle = startSentinelClient({
      sentinelUrl: 'http://sentinel.test',
      bridges: makeMockBridges(registered),
      engine: { refreshBridgeSchemas: async () => {}, registryFor: () => undefined },
      creds: {
        get: (n: string) =>
          n === 'peripheral-a'
            ? { keyPath: KEY_PATH, kid: 'k@h', origin: 'https://a.test' }
            : undefined
      },
      fetch: makeFakeFeed()
    });

    await emitOnline({
      name: 'peripheral-a',
      url: 'https://a.test',
      namespaces: ['alpha', 'beta']
    });

    expect(registered).toEqual(['alpha', 'beta']);
    await handle.stop();
  });

  it('does not bridge a namespace this server hosts', async () => {
    const registered: Array<string> = [];
    const handle = startSentinelClient({
      sentinelUrl: 'http://sentinel.test',
      bridges: makeMockBridges(registered),
      engine: {
        refreshBridgeSchemas: async () => {},
        registryFor: (ns: string) => (ns === 'local' ? {} : undefined)
      },
      creds: { get: () => ({ keyPath: KEY_PATH, kid: 'k@h', origin: 'https://a.test' }) },
      fetch: makeFakeFeed()
    });

    await emitOnline({
      name: 'peripheral-a',
      url: 'https://a.test',
      namespaces: ['local', 'alpha']
    });

    expect(registered).toEqual(['alpha']);
    await handle.stop();
  });

  it('rejects an online frame with no name', async () => {
    const registered: Array<string> = [];
    const handle = startSentinelClient({
      sentinelUrl: 'http://sentinel.test',
      bridges: makeMockBridges(registered),
      engine: { refreshBridgeSchemas: async () => {}, registryFor: () => undefined },
      creds: { get: () => ({ keyPath: KEY_PATH, kid: 'k@h', origin: 'https://a.test' }) },
      fetch: makeFakeFeed()
    });

    await emitOnline({ url: 'https://a.test', namespaces: ['alpha'] });

    expect(registered).toEqual([]);
    await handle.stop();
  });
});

/**
 * A credential is bound to an ORIGIN, not just a coordinator name. Without
 * that binding a provisioned NAME is enough for one injected topology entry to
 * point the bridge at an attacker's host — and every outbound call then
 * carries a freshly minted, validly signed bearer for the real peer's kid.
 */
describe('discovery origin binding', () => {
  afterEach(() => {
    activeFeed = null;
  });

  it('rejects a provisioned coordinator advertising a foreign origin, and issues no request', async () => {
    const registered: Array<string> = [];
    const refreshes: Array<string> = [];
    const metrics: Array<{ name: string; payload?: unknown }> = [];
    // Same reasoning as the unprovisioned-coordinator test above: the mock
    // assertions prove ordering, the fetch spy proves no bridge — and thus no
    // outbound request of any kind — was ever formed.
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    try {
      const handle = startSentinelClient({
        sentinelUrl: 'http://sentinel.test',
        bridges: makeMockBridges(registered),
        engine: {
          refreshBridgeSchemas: async () => {
            refreshes.push('refresh');
          },
          registryFor: () => undefined
        },
        creds: {
          get: (n: string) =>
            n === 'peripheral-a'
              ? { keyPath: KEY_PATH, kid: 'k@h', origin: 'https://a.test' }
              : undefined
        },
        metric: (name, payload) => {
          metrics.push({ name, payload });
        },
        fetch: makeFakeFeed()
      });

      await emitOnline({
        name: 'peripheral-a',
        url: 'https://evil.test',
        namespaces: ['alpha']
      });

      expect(registered).toEqual([]);
      expect(refreshes).toEqual([]);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(metrics).toContainEqual({
        name: 'bridge_discovery_origin_mismatch',
        payload: { name: 'peripheral-a', url: 'https://evil.test', expected: 'https://a.test' }
      });
      await handle.stop();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('rejects a malformed advertised url rather than throwing', async () => {
    const registered: Array<string> = [];
    const metrics: Array<string> = [];
    const handle = startSentinelClient({
      sentinelUrl: 'http://sentinel.test',
      bridges: makeMockBridges(registered),
      engine: { refreshBridgeSchemas: async () => {}, registryFor: () => undefined },
      creds: { get: () => ({ keyPath: KEY_PATH, kid: 'k@h', origin: 'https://a.test' }) },
      metric: (name) => {
        metrics.push(name);
      },
      fetch: makeFakeFeed()
    });

    await emitOnline({ name: 'peripheral-a', url: 'not-a-url', namespaces: ['alpha'] });

    expect(registered).toEqual([]);
    expect(metrics).toContain('bridge_discovery_origin_mismatch');
    await handle.stop();
  });

  it('accepts a matching origin, ignoring path and default-port differences', async () => {
    const registered: Array<string> = [];
    const handle = startSentinelClient({
      sentinelUrl: 'http://sentinel.test',
      bridges: makeMockBridges(registered),
      engine: { refreshBridgeSchemas: async () => {}, registryFor: () => undefined },
      creds: { get: () => ({ keyPath: KEY_PATH, kid: 'k@h', origin: 'https://a.test' }) },
      fetch: makeFakeFeed()
    });

    await emitOnline({ name: 'peripheral-a', url: 'https://a.test:443/', namespaces: ['alpha'] });

    expect(registered).toEqual(['alpha']);
    await handle.stop();
  });

  it('names the bridge client after the coordinator, not the namespace', async () => {
    const clients: Array<BridgeClient> = [];
    const bridges: WritableBridgeRegistry = {
      has: () => false,
      get: () => undefined,
      isUnreachable: () => false,
      entries: () => [],
      register: (_ns: string, client: BridgeClient) => {
        clients.push(client);
      },
      unregister: () => {}
    };
    const handle = startSentinelClient({
      sentinelUrl: 'http://sentinel.test',
      bridges,
      engine: { refreshBridgeSchemas: async () => {}, registryFor: () => undefined },
      creds: { get: () => ({ keyPath: KEY_PATH, kid: 'k@h', origin: 'https://a.test' }) },
      fetch: makeFakeFeed()
    });

    await emitOnline({ name: 'peripheral-a', url: 'https://a.test', namespaces: ['alpha'] });

    // `_completeness.unreachable[]` carries this string; a static bridge puts a
    // coordinator name there, so a discovered one must too.
    expect(clients.map((c) => c.name)).toEqual(['peripheral-a']);
    await handle.stop();
  });

  it("mints the discovered bridge's token for the credential's origin", async () => {
    const clients: Array<BridgeClient> = [];
    const bridges: WritableBridgeRegistry = {
      has: () => false,
      get: () => undefined,
      isUnreachable: () => false,
      entries: () => [],
      register: (_ns: string, client: BridgeClient) => {
        clients.push(client);
      },
      unregister: () => {}
    };
    const auths: Array<string | null> = [];
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_u, init) => {
      auths.push(new Headers(init?.headers).get('authorization'));
      return new Response('{}', { headers: { 'content-type': 'application/json' } });
    });
    try {
      const handle = startSentinelClient({
        sentinelUrl: 'http://sentinel.test',
        bridges,
        engine: { refreshBridgeSchemas: async () => {}, registryFor: () => undefined },
        creds: { get: () => ({ keyPath: KEY_PATH, kid: 'k@h', origin: 'https://a.test' }) },
        fetch: makeFakeFeed()
      });
      await emitOnline({ name: 'peripheral-a', url: 'https://a.test', namespaces: ['alpha'] });
      await clients[0]?.federatedSchema().catch(() => {});
      const jwt = (auths.find((a) => a !== null) ?? '').replace(/^Bearer /, '');
      const claims = JSON.parse(Buffer.from(jwt.split('.')[1] ?? '', 'base64url').toString('utf8'));
      expect(claims.aud).toBe('https://a.test');
      await handle.stop();
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

describe('sentinel refusals', () => {
  // An auth-enabled sentinel answers an unsigned or under-granted watch with
  // 401 or 403. The metric is the only signal that topology is not being watched.
  it('surfaces a refused watch as a metric and retries', async () => {
    const metrics: Array<{ name: string; payload?: unknown }> = [];
    let calls = 0;
    const handle = startSentinelClient({
      sentinelUrl: 'http://sentinel.test',
      bridges: makeMockBridges([]),
      engine: { refreshBridgeSchemas: async () => {}, registryFor: () => undefined },
      creds: { get: () => undefined },
      metric: (name, payload) => {
        metrics.push({ name, payload });
      },
      reconnectBaseMs: 5,
      fetch: async () => {
        calls++;
        return new Response('{"error":"unauthorized"}', {
          status: 401,
          headers: { 'content-type': 'application/json' }
        });
      }
    });
    await waitUntil(() => calls >= 2);
    expect(handle.isConnected()).toBe(false);
    expect(metrics).toContainEqual({
      name: 'sentinel_client_error',
      payload: { status: 401, error: 'watch answered 401 application/json' }
    });
    await handle.stop();
  });
});

describe('startSentinelClient — backoff', () => {
  it('reconnects with doubling backoff while the watch stream keeps dropping', async () => {
    const at: number[] = [];
    const handle = startSentinelClient({
      sentinelUrl: 'http://sentinel.test',
      bridges: makeMockBridges([]),
      engine: { refreshBridgeSchemas: async () => {}, registryFor: () => undefined },
      creds: { get: () => undefined },
      reconnectBaseMs: 10,
      reconnectMaxMs: 1000,
      fetch: async () => {
        at.push(Date.now());
        // Opens, then drops at once: a stream that never lasted proves nothing.
        return new Response(new ReadableStream({ start: (c) => c.close() }), {
          headers: { 'content-type': FRAMES_JSON_MIME }
        });
      }
    });
    await waitUntil(() => at.length >= 5);
    await handle.stop();
    const gaps = at.slice(1, 5).map((t, i) => t - (at[i] as number));
    // 10, 20, 40, 80 ms; a reset on every connect would keep each near 10.
    expect(gaps[3]).toBeGreaterThanOrEqual(70);
  });
});

describe('startSentinelClient — backoff reset', () => {
  it('a stream that lasted reconnectMaxMs resets the delay to the base', async () => {
    const at: number[] = [];
    const handle = startSentinelClient({
      sentinelUrl: 'http://sentinel.test',
      bridges: makeMockBridges([]),
      engine: { refreshBridgeSchemas: async () => {}, registryFor: () => undefined },
      creds: { get: () => undefined },
      reconnectBaseMs: 10,
      reconnectMaxMs: 100,
      fetch: async () => {
        at.push(Date.now());
        // Three quick drops grow the delay; the fourth stream lasts past reconnectMaxMs.
        const lasts = at.length === 4 ? 150 : 0;
        return new Response(
          new ReadableStream({
            start: (c) => {
              setTimeout(() => c.close(), lasts);
            }
          }),
          { headers: { 'content-type': FRAMES_JSON_MIME } }
        );
      }
    });
    await waitUntil(() => at.length >= 5);
    await handle.stop();
    const before = (at[3] as number) - (at[2] as number);
    const after = (at[4] as number) - (at[3] as number) - 150;
    expect(before).toBeGreaterThanOrEqual(35); // 10, 20, then 40
    expect(after).toBeLessThan(30); // back to the 10 ms base
  });
});

describe('sentinel-client authenticates its own connection', () => {
  /**
   * Exercises the DEFAULT fetch deliberately — no `fetch` is passed. Injecting
   * one would test the seam rather than the shipped path.
   */
  async function captureWatchHeader(auth: (() => string) | undefined): Promise<string | undefined> {
    let resolveSeen: (h: string | undefined) => void = () => {};
    const seen = new Promise<string | undefined>((resolve) => {
      resolveSeen = resolve;
    });
    const server = http.createServer((req, res) => {
      resolveSeen(req.headers.authorization);
      res.writeHead(200, { 'content-type': FRAMES_JSON_MIME });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;

    const handle = startSentinelClient({
      sentinelUrl: `http://127.0.0.1:${port}`,
      bridges: makeMockBridges([]),
      engine: { refreshBridgeSchemas: async () => {}, registryFor: () => undefined },
      creds: { get: () => undefined },
      ...(auth === undefined ? {} : { auth })
    });

    const header = await seen;
    await handle.stop();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    return header;
  }

  it('sends Authorization on the watch request when auth is configured', async () => {
    expect(await captureWatchHeader(() => 'Bearer TOKEN-650')).toBe('Bearer TOKEN-650');
  }, 15_000);

  it('sends no Authorization when auth is not configured', async () => {
    expect(await captureWatchHeader(undefined)).toBeUndefined();
  }, 15_000);
});

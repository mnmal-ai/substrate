import { generateKeyPairSync } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type AuthConfig, compose, signHs256 } from '@mnmal-ai/substrate-compose';
import { MemoryBridgeRegistry } from '@mnmal-ai/substrate-core';
import { MemoryDataset } from '@mnmal-ai/substrate-dataset-memory';
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
import WebSocket, { WebSocketServer } from 'ws';
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
 * Sentinel's `register`/`watch` frames require `req.identity`, and a sentinel
 * composed with no `auth` refuses both. Every test below that expects a real
 * register/watch round-trip must compose `auth` + `streamTicketSecret` in and
 * present a bearer on both the raw register socket and the sentinel-client's
 * own `wsFactory`-driven watch connection.
 */
const HS_SECRET = 'sentinel-client-test-secret';
const HS_KID = 'sentinel-client-test';
const STREAM_TICKET_SECRET = 'sentinel-client-test-stream-ticket-secret';
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
  streamTicketSecret?: string;
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
  if (opts.streamTicketSecret !== undefined)
    composeArgs.streamTicketSecret = opts.streamTicketSecret;
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
  let bRegisterSocket: WebSocket | null = null;

  afterEach(async () => {
    if (clientStop !== null) await clientStop();
    if (bRegisterSocket !== null && bRegisterSocket.readyState !== WebSocket.CLOSED) {
      await new Promise<void>((resolve) => {
        bRegisterSocket?.once('close', () => resolve());
        bRegisterSocket?.close();
      });
    }
    if (b !== null) await b.stop();
    if (s !== null) await s.stop();
    clientStop = null;
    bRegisterSocket = null;
    b = null;
    s = null;
  });

  it('registers a bridge in the caller-owned BridgeRegistry on online event', async () => {
    s = await startFastify({
      coordinators: [
        createSentinelPlugin({
          namespace: 'sentinel',
          pingIntervalMs: 1000,
          staleThresholdMs: 3000
        })
      ],
      datasets: { sentinel: new MemoryDataset({ namespace: 'sentinel' }) },
      auth: authConfig,
      streamTicketSecret: STREAM_TICKET_SECRET
    });
    b = await startFastify({
      coordinators: [buildDemoPlugin()],
      datasets: { demo: new MemoryDataset({ namespace: 'demo' }) }
    });

    const bridges = new MemoryBridgeRegistry();
    const engine = makeSpyEngine();

    const handle = startSentinelClient({
      sentinelUrl: `ws://127.0.0.1:${s.port}/substrate/v1/plugins/substrate-sentinel/ws`,
      bridges,
      engine,
      creds: allowB(`http://127.0.0.1:${b.port}`),
      reconnectBaseMs: 10,
      reconnectMaxMs: 100,
      wsFactory: (url: string) => new WebSocket(url, { headers: authHeaders() })
    });
    clientStop = handle.stop;
    await waitUntil(() => handle.isConnected());

    bRegisterSocket = new WebSocket(
      `ws://127.0.0.1:${s.port}/substrate/v1/plugins/substrate-sentinel/ws`,
      {
        headers: authHeaders()
      }
    );
    await new Promise<void>((resolve, reject) => {
      bRegisterSocket?.once('open', () => resolve());
      bRegisterSocket?.once('error', reject);
    });
    bRegisterSocket.send(
      JSON.stringify({
        type: 'register',
        name: 'B',
        url: `http://127.0.0.1:${b.port}`,
        namespaces: ['demo']
      })
    );

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
  let bRegisterSocket: WebSocket | null = null;

  afterEach(async () => {
    if (clientStop !== null) await clientStop();
    if (bRegisterSocket !== null && bRegisterSocket.readyState !== WebSocket.CLOSED) {
      await new Promise<void>((resolve) => {
        bRegisterSocket?.once('close', () => resolve());
        bRegisterSocket?.close();
      });
    }
    if (b !== null) await b.stop();
    if (s !== null) await s.stop();
    clientStop = null;
    bRegisterSocket = null;
    b = null;
    s = null;
  });

  it('unregisters the bridge and disposes the client on offline event', async () => {
    s = await startFastify({
      coordinators: [
        createSentinelPlugin({
          namespace: 'sentinel',
          pingIntervalMs: 1000,
          staleThresholdMs: 3000
        })
      ],
      datasets: { sentinel: new MemoryDataset({ namespace: 'sentinel' }) },
      auth: authConfig,
      streamTicketSecret: STREAM_TICKET_SECRET
    });
    b = await startFastify({
      coordinators: [buildDemoPlugin()],
      datasets: { demo: new MemoryDataset({ namespace: 'demo' }) }
    });

    const bridges = new MemoryBridgeRegistry();
    const engine = makeSpyEngine();

    const handle = startSentinelClient({
      sentinelUrl: `ws://127.0.0.1:${s.port}/substrate/v1/plugins/substrate-sentinel/ws`,
      bridges,
      engine,
      creds: allowB(`http://127.0.0.1:${b.port}`),
      reconnectBaseMs: 10,
      reconnectMaxMs: 100,
      wsFactory: (url: string) => new WebSocket(url, { headers: authHeaders() })
    });
    clientStop = handle.stop;
    await waitUntil(() => handle.isConnected());

    bRegisterSocket = new WebSocket(
      `ws://127.0.0.1:${s.port}/substrate/v1/plugins/substrate-sentinel/ws`,
      {
        headers: authHeaders()
      }
    );
    await new Promise<void>((resolve, reject) => {
      bRegisterSocket?.once('open', () => resolve());
      bRegisterSocket?.once('error', reject);
    });
    bRegisterSocket.send(
      JSON.stringify({
        type: 'register',
        name: 'B',
        url: `http://127.0.0.1:${b.port}`,
        namespaces: ['demo']
      })
    );

    await waitUntil(() => bridges.has('demo'));
    expect(bridges.has('demo')).toBe(true);

    await new Promise<void>((resolve) => {
      bRegisterSocket?.once('close', () => resolve());
      bRegisterSocket?.close();
    });
    bRegisterSocket = null;

    await waitUntil(() => !bridges.has('demo'));
    expect(bridges.has('demo')).toBe(false);
  }, 15_000);

  it('stop() closes WS, unregisters owned bridges, and is idempotent', async () => {
    s = await startFastify({
      coordinators: [
        createSentinelPlugin({
          namespace: 'sentinel',
          pingIntervalMs: 1000,
          staleThresholdMs: 3000
        })
      ],
      datasets: { sentinel: new MemoryDataset({ namespace: 'sentinel' }) },
      auth: authConfig,
      streamTicketSecret: STREAM_TICKET_SECRET
    });
    b = await startFastify({
      coordinators: [buildDemoPlugin()],
      datasets: { demo: new MemoryDataset({ namespace: 'demo' }) }
    });

    const bridges = new MemoryBridgeRegistry();
    const engine = makeSpyEngine();

    const handle = startSentinelClient({
      sentinelUrl: `ws://127.0.0.1:${s.port}/substrate/v1/plugins/substrate-sentinel/ws`,
      bridges,
      engine,
      creds: allowB(`http://127.0.0.1:${b.port}`),
      reconnectBaseMs: 10,
      reconnectMaxMs: 100,
      wsFactory: (url: string) => new WebSocket(url, { headers: authHeaders() })
    });
    clientStop = null; // Call stop manually inside this test.
    await waitUntil(() => handle.isConnected());

    bRegisterSocket = new WebSocket(
      `ws://127.0.0.1:${s.port}/substrate/v1/plugins/substrate-sentinel/ws`,
      {
        headers: authHeaders()
      }
    );
    await new Promise<void>((resolve, reject) => {
      bRegisterSocket?.once('open', () => resolve());
      bRegisterSocket?.once('error', reject);
    });
    bRegisterSocket.send(
      JSON.stringify({
        type: 'register',
        name: 'B',
        url: `http://127.0.0.1:${b.port}`,
        namespaces: ['demo']
      })
    );
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
  let bRegisterSocket: WebSocket | null = null;

  afterEach(async () => {
    if (clientStop !== null) await clientStop();
    if (bRegisterSocket !== null && bRegisterSocket.readyState !== WebSocket.CLOSED) {
      await new Promise<void>((resolve) => {
        bRegisterSocket?.once('close', () => resolve());
        bRegisterSocket?.close();
      });
    }
    if (a !== null) await a.stop();
    if (b !== null) await b.stop();
    if (s !== null) await s.stop();
    clientStop = null;
    bRegisterSocket = null;
    a = null;
    b = null;
    s = null;
  });

  it('routes a query through a sentinel-discovered bridge when the registry is wired into compose', async () => {
    s = await startFastify({
      coordinators: [
        createSentinelPlugin({
          namespace: 'sentinel',
          pingIntervalMs: 1000,
          staleThresholdMs: 3000
        })
      ],
      datasets: { sentinel: new MemoryDataset({ namespace: 'sentinel' }) },
      auth: authConfig,
      streamTicketSecret: STREAM_TICKET_SECRET
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
      sentinelUrl: `ws://127.0.0.1:${s.port}/substrate/v1/plugins/substrate-sentinel/ws`,
      bridges,
      engine: aComposed.engine,
      creds: allowB(`http://127.0.0.1:${b.port}`),
      reconnectBaseMs: 10,
      reconnectMaxMs: 100,
      wsFactory: (url: string) => new WebSocket(url, { headers: authHeaders() })
    });
    clientStop = handle.stop;
    await waitUntil(() => handle.isConnected());

    // B registers itself with S — triggers online broadcast → A learns about B.
    bRegisterSocket = new WebSocket(
      `ws://127.0.0.1:${s.port}/substrate/v1/plugins/substrate-sentinel/ws`,
      {
        headers: authHeaders()
      }
    );
    await new Promise<void>((resolve, reject) => {
      bRegisterSocket?.once('open', () => resolve());
      bRegisterSocket?.once('error', reject);
    });
    bRegisterSocket.send(
      JSON.stringify({
        type: 'register',
        name: 'B',
        url: `http://127.0.0.1:${b.port}`,
        namespaces: ['demo']
      })
    );

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
          pingIntervalMs: 1000,
          staleThresholdMs: 3000
        })
      ],
      datasets: { sentinel: new MemoryDataset({ namespace: 'sentinel' }) }
    });

    const bridges = new MemoryBridgeRegistry();
    const engine = makeSpyEngine();

    const handle = startSentinelClient({
      sentinelUrl: `ws://127.0.0.1:${s.port}/substrate/v1/plugins/substrate-sentinel/ws`,
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
 * Minimal fake WebSocket for driving `handleOnline` directly with adversarial
 * frames (e.g. a coordinator name that never went through real sentinel
 * registration) that the real WS route would reject upstream before they
 * ever reached a watcher. `wsFactory` is the client's designated test seam
 * for exactly this.
 */
class FakeSentinelSocket extends EventEmitter {
  readyState: number = WebSocket.OPEN;

  send(_payload: string): void {
    // No-op — these tests don't inspect outbound sentinel frames (watch/pong).
  }

  close(): void {
    if (this.readyState === WebSocket.CLOSED) return;
    this.readyState = WebSocket.CLOSED;
    this.emit('close');
  }
}

let activeFakeSocket: FakeSentinelSocket | null = null;

/** `wsFactory` test seam — captures the created socket for `emitOnline` to drive. */
function makeFakeSocket(): (url: string) => WebSocket {
  return (_url: string): WebSocket => {
    const socket = new FakeSentinelSocket();
    activeFakeSocket = socket;
    return socket as unknown as WebSocket;
  };
}

/**
 * Simulates the sentinel broadcasting an `online` event, then drains the
 * microtask queue via `setImmediate` so `handleOnline`'s awaited chain
 * (credential lookup, registration, `refreshBridgeSchemas()`) fully settles
 * before assertions run — Node drains all pending microtasks, however deeply
 * chained, before any macrotask (timer/immediate) callback fires.
 */
async function emitOnline(payload: Record<string, unknown>): Promise<void> {
  if (activeFakeSocket === null) {
    throw new Error('emitOnline called before startSentinelClient created a socket');
  }
  activeFakeSocket.emit(
    'message',
    Buffer.from(JSON.stringify({ event: 'online', ...payload }), 'utf8')
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe('discovery allowlist', () => {
  afterEach(() => {
    activeFakeSocket = null;
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
        sentinelUrl: 'ws://sentinel.test',
        bridges: makeMockBridges(registered),
        engine: {
          refreshBridgeSchemas: async () => {
            fetches.push('refresh');
          },
          registryFor: () => undefined
        },
        creds: { get: () => undefined },
        wsFactory: makeFakeSocket()
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
      sentinelUrl: 'ws://sentinel.test',
      bridges: { ...makeMockBridges([]), unregister: (ns: string) => unregistered.push(ns) },
      engine: { refreshBridgeSchemas: async () => {}, registryFor: () => undefined },
      creds: { get: () => ({ keyPath: KEY_PATH, kid: 'k@h', origin: 'https://a.test' }) },
      wsFactory: makeFakeSocket()
    });
    await emitOnline({ name: 'peripheral-a', url: 'https://a.test/', namespaces: ['alpha'] });
    activeFakeSocket?.emit(
      'message',
      Buffer.from(
        JSON.stringify({ event: 'offline', name: 'peripheral-a', url: 'https://a.test/' })
      )
    );
    expect(unregistered).toEqual(['alpha']);
    await handle.stop();
  });

  it('keeps a bridge when an offline names a different coordinator at the same url', async () => {
    const unregistered: Array<string> = [];
    const handle = startSentinelClient({
      sentinelUrl: 'ws://sentinel.test',
      bridges: { ...makeMockBridges([]), unregister: (ns: string) => unregistered.push(ns) },
      engine: { refreshBridgeSchemas: async () => {}, registryFor: () => undefined },
      creds: { get: () => ({ keyPath: KEY_PATH, kid: 'k@h', origin: 'https://a.test' }) },
      wsFactory: makeFakeSocket()
    });
    await emitOnline({ name: 'peripheral-a', url: 'https://a.test', namespaces: ['alpha'] });
    activeFakeSocket?.emit(
      'message',
      Buffer.from(JSON.stringify({ event: 'offline', name: 'impostor', url: 'https://a.test' }))
    );
    expect(unregistered).toEqual([]);
    await handle.stop();
  });

  it('registers every advertised namespace for a provisioned coordinator', async () => {
    const registered: Array<string> = [];
    const handle = startSentinelClient({
      sentinelUrl: 'ws://sentinel.test',
      bridges: makeMockBridges(registered),
      engine: { refreshBridgeSchemas: async () => {}, registryFor: () => undefined },
      creds: {
        get: (n: string) =>
          n === 'peripheral-a'
            ? { keyPath: KEY_PATH, kid: 'k@h', origin: 'https://a.test' }
            : undefined
      },
      wsFactory: makeFakeSocket()
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
      sentinelUrl: 'ws://sentinel.test',
      bridges: makeMockBridges(registered),
      engine: {
        refreshBridgeSchemas: async () => {},
        registryFor: (ns: string) => (ns === 'local' ? {} : undefined)
      },
      creds: { get: () => ({ keyPath: KEY_PATH, kid: 'k@h', origin: 'https://a.test' }) },
      wsFactory: makeFakeSocket()
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
      sentinelUrl: 'ws://sentinel.test',
      bridges: makeMockBridges(registered),
      engine: { refreshBridgeSchemas: async () => {}, registryFor: () => undefined },
      creds: { get: () => ({ keyPath: KEY_PATH, kid: 'k@h', origin: 'https://a.test' }) },
      wsFactory: makeFakeSocket()
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
    activeFakeSocket = null;
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
        sentinelUrl: 'ws://sentinel.test',
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
        wsFactory: makeFakeSocket()
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
      sentinelUrl: 'ws://sentinel.test',
      bridges: makeMockBridges(registered),
      engine: { refreshBridgeSchemas: async () => {}, registryFor: () => undefined },
      creds: { get: () => ({ keyPath: KEY_PATH, kid: 'k@h', origin: 'https://a.test' }) },
      metric: (name) => {
        metrics.push(name);
      },
      wsFactory: makeFakeSocket()
    });

    await emitOnline({ name: 'peripheral-a', url: 'not-a-url', namespaces: ['alpha'] });

    expect(registered).toEqual([]);
    expect(metrics).toContain('bridge_discovery_origin_mismatch');
    await handle.stop();
  });

  it('accepts a matching origin, ignoring path and default-port differences', async () => {
    const registered: Array<string> = [];
    const handle = startSentinelClient({
      sentinelUrl: 'ws://sentinel.test',
      bridges: makeMockBridges(registered),
      engine: { refreshBridgeSchemas: async () => {}, registryFor: () => undefined },
      creds: { get: () => ({ keyPath: KEY_PATH, kid: 'k@h', origin: 'https://a.test' }) },
      wsFactory: makeFakeSocket()
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
      sentinelUrl: 'ws://sentinel.test',
      bridges,
      engine: { refreshBridgeSchemas: async () => {}, registryFor: () => undefined },
      creds: { get: () => ({ keyPath: KEY_PATH, kid: 'k@h', origin: 'https://a.test' }) },
      wsFactory: makeFakeSocket()
    });

    await emitOnline({ name: 'peripheral-a', url: 'https://a.test', namespaces: ['alpha'] });

    // `_completeness.unreachable[]` carries this string; a static bridge puts a
    // coordinator name there, so a discovered one must too.
    expect(clients.map((c) => c.name)).toEqual(['peripheral-a']);
    await handle.stop();
  });
});

describe('sentinel error frames', () => {
  afterEach(() => {
    activeFakeSocket = null;
  });

  // Sentinel replies `{error:'unauthorized'}` and, under attribute-mode auth,
  // leaves the socket open. Without surfacing it the client reports
  // isConnected() === true and believes it is watching topology forever.
  it('surfaces an error frame as a metric rather than swallowing it', async () => {
    const metrics: Array<{ name: string; payload?: unknown }> = [];
    const handle = startSentinelClient({
      sentinelUrl: 'ws://sentinel.test',
      bridges: makeMockBridges([]),
      engine: { refreshBridgeSchemas: async () => {}, registryFor: () => undefined },
      creds: { get: () => undefined },
      metric: (name, payload) => {
        metrics.push({ name, payload });
      },
      wsFactory: makeFakeSocket()
    });

    if (activeFakeSocket === null) throw new Error('no socket');
    activeFakeSocket.emit(
      'message',
      Buffer.from(JSON.stringify({ error: 'unauthorized' }), 'utf8')
    );
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(metrics).toContainEqual({
      name: 'sentinel_client_error',
      payload: { error: 'unauthorized' }
    });
    await handle.stop();
  });
});

describe('sentinel-client authenticates its own connection', () => {
  /**
   * Exercises the DEFAULT wsFactory deliberately — no `wsFactory` is passed.
   * Injecting one would test the seam rather than the shipped path.
   */
  async function captureUpgradeHeader(
    auth: (() => string) | undefined
  ): Promise<string | undefined> {
    const server = new WebSocketServer({ port: 0 });
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    const port = (server.address() as { port: number }).port;

    const seen = new Promise<string | undefined>((resolve) => {
      server.once('connection', (_sock, req) => resolve(req.headers.authorization));
    });

    const handle = startSentinelClient({
      sentinelUrl: `ws://127.0.0.1:${port}/substrate/v1/plugins/substrate-sentinel/ws`,
      bridges: {
        has: () => false,
        get: () => undefined,
        isUnreachable: () => false,
        entries: () => [],
        register: () => {},
        unregister: () => {}
      },
      engine: { refreshBridgeSchemas: async () => {}, registryFor: () => undefined },
      creds: { get: () => undefined },
      ...(auth === undefined ? {} : { auth })
    });

    const header = await seen;
    handle.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    return header;
  }

  it('sends Authorization on the WS upgrade when auth is configured', async () => {
    expect(await captureUpgradeHeader(() => 'Bearer TOKEN-650')).toBe('Bearer TOKEN-650');
  }, 15_000);

  it('sends no Authorization when auth is not configured', async () => {
    expect(await captureUpgradeHeader(undefined)).toBeUndefined();
  }, 15_000);
});

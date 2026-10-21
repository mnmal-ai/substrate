import type { PackEnvelope, SubstrateResponse } from '@mnmal-ai/substrate/sdk';
import {
  type AuthConfig,
  type ComposeResult,
  compose,
  MemoryDataset,
  MemorySubstrateServer,
  type MemoryWsClient,
  signHs256
} from '@mnmal-ai/substrate/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { buildSentinelForTest } from './_helpers.js';

const NS = 'sentinel';
const WS_PATH = '/substrate/v1/plugins/substrate-sentinel/ws';

// Sentinel's `register`/`watch` frames require `req.identity` — a plugin serving its own frame protocol at `/substrate/v1/plugins/<name>/ws` gets no
// identity unless the composing binary wires `auth`. These tests exercise
// that authenticated path with a throwaway HS256 key; `streamTicketSecret`
// is required by `compose()` whenever `auth` is set (SSE stream tickets),
// even though this suite never touches SSE.
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

// A sentinel composed with `auth` left undefined resolves no identity, so it
// must refuse register/watch outright (fail-closed).
async function setupNoAuth(): Promise<Harness> {
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
    coordinators: [plugin]
    // auth intentionally omitted.
  });
  await server.start();
  return {
    server,
    stop: async (): Promise<void> => {
      await composed.stop();
    }
  };
}

/** Drain up to `expected` frames from a client with a short upper bound. */
function collectFrames(client: MemoryWsClient): { frames: Record<string, unknown>[] } {
  const frames: Record<string, unknown>[] = [];
  client.onMessage((buf: Buffer) => {
    try {
      const parsed = JSON.parse(buf.toString('utf8')) as unknown;
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        frames.push(parsed as Record<string, unknown>);
      }
    } catch {
      // Ignore malformed frames.
    }
  });
  return { frames };
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

async function listCoordinatorNamespaces(
  server: MemorySubstrateServer
): Promise<Array<{ coordinatorId: string; name: string }>> {
  const res = await server.inject({
    method: 'POST',
    path: '/substrate/v1/query',
    headers: { 'content-type': 'application/json' },
    body: Buffer.from(
      JSON.stringify({
        [`${NS}/CoordinatorNamespace`]: {
          params: {},
          fields: { id: true, coordinatorId: true, name: true }
        }
      })
    )
  });
  const env = jsonBody<PackEnvelope>(res);
  return (env.data[`${NS}/CoordinatorNamespace`] ?? []) as Array<{
    coordinatorId: string;
    name: string;
  }>;
}

describe('registerSentinelWsRoute', () => {
  let harness: Harness | null = null;

  afterEach(async () => {
    if (harness !== null) {
      await harness.stop();
      harness = null;
    }
  });

  it('a register frame upserts a Coordinator row', async () => {
    harness = await setup();
    const client = harness.server.connectWebsocket(WS_PATH, authHeaders());
    const { frames } = collectFrames(client);
    await flush();
    client.send(
      JSON.stringify({
        type: 'register',
        name: 'home',
        url: 'http://localhost:3200',
        namespaces: ['family', 'home'],
        version: '1.0.0'
      })
    );
    await flush();

    const okFrame = frames.find((f) => f.ok === true && 'registered' in f);
    expect(okFrame).toBeDefined();
    expect(okFrame?.registered).toBe(true);
    expect(okFrame?.updated).toBe(false);

    const rows = await listCoordinators(harness.server);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.name).toBe('home');
    expect(rows[0]?.status).toBe('online');
  });

  it('a watcher receives an online event after a peer registers', async () => {
    harness = await setup();
    const watcher = harness.server.connectWebsocket(WS_PATH, authHeaders());
    const { frames: watcherFrames } = collectFrames(watcher);
    await flush();
    watcher.send(JSON.stringify({ type: 'watch' }));
    await flush();
    // Clear the watching-ack frame so we only inspect events after.
    watcherFrames.length = 0;

    const coord = harness.server.connectWebsocket(WS_PATH, authHeaders());
    collectFrames(coord);
    await flush();
    coord.send(
      JSON.stringify({
        type: 'register',
        name: 'home',
        url: 'http://localhost:3200',
        namespaces: ['family']
      })
    );
    await flush();

    const online = watcherFrames.find((f) => f.event === 'online');
    expect(online).toBeDefined();
    expect(online?.name).toBe('home');
    expect(online?.url).toBe('http://localhost:3200');
  });

  it('returns an error frame for an unknown type', async () => {
    harness = await setup();
    const client = harness.server.connectWebsocket(WS_PATH);
    const { frames } = collectFrames(client);
    await flush();
    client.send(JSON.stringify({ type: 'whatever' }));
    await flush();
    const err = frames.find((f) => typeof f.error === 'string');
    expect(err?.error).toBe('unknown frame type');
  });

  it('returns an error frame for malformed JSON', async () => {
    harness = await setup();
    const client = harness.server.connectWebsocket(WS_PATH);
    const { frames } = collectFrames(client);
    await flush();
    client.send(Buffer.from('not-json'));
    await flush();
    const err = frames.find((f) => typeof f.error === 'string');
    expect(err?.error).toBe('invalid JSON');
  });

  it('closing a registered coordinator flips its row to offline and broadcasts', async () => {
    harness = await setup();
    const watcher = harness.server.connectWebsocket(WS_PATH, authHeaders());
    const { frames: watcherFrames } = collectFrames(watcher);
    await flush();
    watcher.send(JSON.stringify({ type: 'watch' }));
    await flush();
    watcherFrames.length = 0;

    const coord = harness.server.connectWebsocket(WS_PATH, authHeaders());
    collectFrames(coord);
    await flush();
    coord.send(
      JSON.stringify({
        type: 'register',
        name: 'home',
        url: 'http://localhost:3200',
        namespaces: ['family']
      })
    );
    await flush();

    coord.close();
    await flush();

    const offline = watcherFrames.find((f) => f.event === 'offline');
    expect(offline).toBeDefined();
    expect(offline?.name).toBe('home');

    const rows = await listCoordinators(harness.server);
    expect(rows[0]?.status).toBe('offline');
  });

  it('a second register for the same name updates instead of creating', async () => {
    harness = await setup();
    const first = harness.server.connectWebsocket(WS_PATH, authHeaders());
    const firstFrames = collectFrames(first).frames;
    await flush();
    first.send(
      JSON.stringify({
        type: 'register',
        name: 'home',
        url: 'http://localhost:3200',
        namespaces: ['family']
      })
    );
    await flush();
    expect(firstFrames.find((f) => f.ok === true)?.updated).toBe(false);

    const second = harness.server.connectWebsocket(WS_PATH, authHeaders());
    const secondFrames = collectFrames(second).frames;
    await flush();
    second.send(
      JSON.stringify({
        type: 'register',
        name: 'home',
        url: 'http://localhost:3201',
        namespaces: ['family', 'home']
      })
    );
    await flush();

    const ok = secondFrames.find((f) => f.ok === true);
    expect(ok?.updated).toBe(true);
    const rows = await listCoordinators(harness.server);
    expect(rows).toHaveLength(1);
  });

  it('refuses a register that would repoint a name another identity owns', async () => {
    harness = await setup();
    const owner = harness.server.connectWebsocket(WS_PATH, authHeaders());
    await flush();
    owner.send(JSON.stringify({ type: 'register', name: 'home', url: 'http://localhost:3200' }));
    await flush();

    const other = harness.server.connectWebsocket(WS_PATH, {
      authorization: `Bearer ${bearer(['read', 'mutate'], 'someone-else')}`
    });
    const otherFrames = collectFrames(other).frames;
    await flush();
    other.send(JSON.stringify({ type: 'register', name: 'home', url: 'http://evil.test' }));
    await flush();

    expect(otherFrames.find((f) => f.ok === true)).toBeUndefined();
    expect(String(otherFrames.find((f) => 'error' in f)?.error)).toMatch(/another identity/);
  });

  it('refuses a name whose row was created by the same id under another kind', async () => {
    harness = await setup();
    await harness.sentinelDataset?.write(
      'Coordinator',
      [
        {
          id: '00000000-0000-4000-8000-0000000000aa',
          name: 'home',
          url: 'http://localhost:3200',
          namespaces: '',
          status: 'offline',
          lastHeartbeat: '',
          registeredAt: '',
          version: ''
        }
      ],
      { identity: { kind: 'agent', id: 'sentinel-peer' }, now: new Date() }
    );
    const client = harness.server.connectWebsocket(WS_PATH, authHeaders());
    const frames = collectFrames(client).frames;
    await flush();
    client.send(JSON.stringify({ type: 'register', name: 'home', url: 'http://evil.test' }));
    await flush();
    expect(String(frames.find((f) => 'error' in f)?.error)).toMatch(/another identity/);
  });

  it('lets only an admin reclaim a row with no recorded creator', async () => {
    harness = await setup();
    await harness.sentinelDataset?.write('Coordinator', [
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
    const register = async (token: string) => {
      const client = harness?.server.connectWebsocket(WS_PATH, {
        authorization: `Bearer ${token}`
      }) as MemoryWsClient;
      const frames = collectFrames(client).frames;
      await flush();
      client.send(
        JSON.stringify({ type: 'register', name: 'legacy', url: 'http://localhost:3300' })
      );
      await flush();
      return frames;
    };

    const plain = await register(bearer(['read', 'mutate'], 'someone'));
    expect(String(plain.find((f) => 'error' in f)?.error)).toMatch(/another identity/);
    const admin = await register(bearer(['read', 'mutate', 'admin'], 'operator'));
    expect(admin.find((f) => f.ok === true)).toMatchObject({ updated: true });
  });

  it("refuses a new name advertising another identity's url", async () => {
    harness = await setup();
    const owner = harness.server.connectWebsocket(WS_PATH, authHeaders());
    await flush();
    owner.send(JSON.stringify({ type: 'register', name: 'home', url: 'http://localhost:3200' }));
    await flush();

    const other = harness.server.connectWebsocket(WS_PATH, {
      authorization: `Bearer ${bearer(['read', 'mutate'], 'someone-else')}`
    });
    const otherFrames = collectFrames(other).frames;
    await flush();
    other.send(JSON.stringify({ type: 'register', name: 'decoy', url: 'http://localhost:3200' }));
    await flush();
    expect(otherFrames.find((f) => f.ok === true)).toBeUndefined();
    expect(String(otherFrames.find((f) => 'error' in f)?.error)).toMatch(/another identity/);
  });

  // Regression: the reconcile must actually find existing rows by
  // `coordinatorId` (a UUID string). A refused filter reads as `[]`, which
  // looks like "nothing exists" and duplicates rows without failing.
  it('reconciles CoordinatorNamespace rows across re-registers instead of duplicating', async () => {
    harness = await setup();
    const first = harness.server.connectWebsocket(WS_PATH, authHeaders());
    collectFrames(first);
    await flush();
    first.send(
      JSON.stringify({
        type: 'register',
        name: 'home',
        url: 'http://localhost:3200',
        namespaces: ['family', 'home']
      })
    );
    await flush();

    const afterFirst = await listCoordinatorNamespaces(harness.server);
    expect(afterFirst.map((r) => r.name).sort()).toEqual(['family', 'home']);

    // Re-register the SAME coordinator dropping one namespace and adding one.
    const second = harness.server.connectWebsocket(WS_PATH, authHeaders());
    collectFrames(second);
    await flush();
    second.send(
      JSON.stringify({
        type: 'register',
        name: 'home',
        url: 'http://localhost:3200',
        namespaces: ['family', 'work']
      })
    );
    await flush();

    const afterSecond = await listCoordinatorNamespaces(harness.server);
    // `family` is kept (not duplicated), `home` is removed, `work` is added.
    expect(afterSecond.map((r) => r.name).sort()).toEqual(['family', 'work']);
  });

  it('rejects register from an anonymous caller end-to-end, with auth composed in', async () => {
    // Unit coverage for this lives in ws-route-auth.test.ts (identity injected
    // directly). This exercises the same rejection through the real compose()
    // + wrapWsHandler + MemorySubstrateServer stack, with no Authorization header
    // on the connection — closing the loop that `auth` being wired at all does
    // not, by itself, let an unauthenticated caller through.
    harness = await setup();
    const client = harness.server.connectWebsocket(WS_PATH); // no auth header
    const { frames } = collectFrames(client);
    await flush();
    client.send(
      JSON.stringify({
        type: 'register',
        name: 'intruder',
        url: 'http://localhost:9999',
        namespaces: ['family']
      })
    );
    await flush();

    expect(frames).toEqual([{ error: 'unauthorized' }]);
    const rows = await listCoordinators(harness.server);
    expect(rows).toHaveLength(0);
  });

  it('refuses register and watch when the binary is composed with no auth at all', async () => {
    // `wrapWsHandler` never runs when `compose()`'s `auth` option is omitted,
    // so `req.identity` is never populated whatever the caller presents —
    // register/watch are refused unconditionally (fail-closed).
    harness = await setupNoAuth();
    const client = harness.server.connectWebsocket(WS_PATH);
    const { frames } = collectFrames(client);
    await flush();

    client.send(JSON.stringify({ type: 'watch' }));
    await flush();
    client.send(
      JSON.stringify({
        type: 'register',
        name: 'intruder',
        url: 'http://localhost:9999',
        namespaces: ['family']
      })
    );
    await flush();

    expect(frames).toEqual([{ error: 'unauthorized' }, { error: 'unauthorized' }]);
    const rows = await listCoordinators(harness.server);
    expect(rows).toHaveLength(0);
  });
});

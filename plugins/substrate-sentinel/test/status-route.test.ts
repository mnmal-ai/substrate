import type {
  Dataset,
  EngineHandle,
  NamespaceConfig,
  PackEnvelope,
  PluginRouteContext,
  PluginRouter,
  Registry,
  SubstrateResponse
} from '@mnmal-ai/substrate/sdk';
import {
  type ComposeResult,
  compose,
  MemoryDataset,
  MemorySubstrateServer
} from '@mnmal-ai/substrate/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerSentinelStatusRoute } from '../src/status-route.js';
import { buildSentinelForTest } from './_helpers.js';

const NS = 'sentinel';
const PATH = '/substrate/v1/plugins/substrate-sentinel/status';

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

async function setup(): Promise<{
  server: MemorySubstrateServer;
  stop: () => Promise<void>;
}> {
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
  });
  await server.start();
  return {
    server,
    stop: async (): Promise<void> => {
      await composed.stop();
    }
  };
}

describe('registerSentinelStatusRoute', () => {
  let cleanup: (() => Promise<void>) | null = null;

  afterEach(async () => {
    if (cleanup !== null) {
      await cleanup();
      cleanup = null;
    }
  });

  it('returns { coordinators: [] } on an empty store', async () => {
    const { server, stop } = await setup();
    cleanup = stop;

    const res = await server.inject({ method: 'GET', path: PATH });
    expect(res.status).toBe(200);
    expect(res.headers?.['content-type']).toContain('application/json');
    const body = jsonBody<{ coordinators: Array<unknown> }>(res);
    expect(body.coordinators).toEqual([]);
  });

  it('returns populated list after createCoordinator', async () => {
    const { server, stop } = await setup();
    cleanup = stop;

    const create = await server.inject({
      method: 'POST',
      path: '/substrate/v1/mutate',
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(
        JSON.stringify({
          [`${NS}/createCoordinator`]: {
            params: {
              name: 'home',
              url: 'http://localhost:3200',
              namespaces: 'family',
              status: 'online',
              lastHeartbeat: '2026-04-19T00:00:00Z',
              registeredAt: '2026-04-19T00:00:00Z',
              version: '1.0.0'
            },
            fields: { id: true }
          }
        })
      )
    });
    const createEnv = jsonBody<PackEnvelope>(create);
    expect(createEnv.errors).toBeUndefined();

    const res = await server.inject({ method: 'GET', path: PATH });
    expect(res.status).toBe(200);
    const body = jsonBody<{ coordinators: Array<{ name: string; url: string; status: string }> }>(
      res
    );
    expect(body.coordinators).toHaveLength(1);
    expect(body.coordinators[0]?.name).toBe('home');
    expect(body.coordinators[0]?.url).toBe('http://localhost:3200');
    expect(body.coordinators[0]?.status).toBe('online');
  });

  /** Wire the route against a mock router + an engine whose `query` is supplied. */
  function wireRoute(query: EngineHandle['query']): {
    handler: (req: {
      method: 'GET';
      path: string;
      identity?: unknown;
    }) => Promise<SubstrateResponse>;
    calls: Array<{ name: string; payload: unknown }>;
  } {
    const calls: Array<{ name: string; payload: unknown }> = [];
    let handler:
      | ((req: { method: 'GET'; path: string; identity?: unknown }) => Promise<SubstrateResponse>)
      | undefined;
    const router: PluginRouter = {
      get: (_p, h) => {
        handler = h as typeof handler;
      },
      post: vi.fn(),
      put: vi.fn(),
      delete: vi.fn(),
      patch: vi.fn(),
      websocket: vi.fn()
    };
    const engine: EngineHandle = {
      query,
      mutate: async () => {
        throw new Error('not used');
      },
      invalidateSchemaCaches: (): void => {},
      addNamespace: (_ns: string, _config: NamespaceConfig): void => {
        throw new Error('test fake: addNamespace not supported');
      },
      tombstoneNamespace: (_ns: string): void => {},
      removeNamespace: () => {},
      namespaceState: () => 'absent' as const,
      onNamespaceTombstoned: () => () => {},
      addDropParticipant: () => () => {},
      dropParticipants: () => [],
      evaluateReadPolicy: () => ({ allow: true }),
      createRegistry: (): Registry => {
        throw new Error('test fake: createRegistry not supported');
      },
      datasetFor: (_ns: string): Dataset | undefined => undefined
    };
    const ctx: PluginRouteContext = {
      pluginName: 'substrate-sentinel',
      engine,
      metric: (name, payload): void => {
        calls.push({ name, payload });
      }
    };
    registerSentinelStatusRoute(router, ctx, NS);
    if (handler === undefined) throw new Error('handler was not registered');
    return { handler, calls };
  }

  it('swallows engine errors into an empty list and emits sentinel_status_error metric', async () => {
    // A deterministic fault source; the composed path would hit the real engine.
    const { handler, calls } = wireRoute(async () => {
      throw new Error('boom');
    });
    const response = await handler({ method: 'GET', path: PATH });
    expect(response.status).toBe(200);
    const body = JSON.parse(Buffer.from(response.body as Buffer).toString('utf8')) as {
      coordinators: Array<unknown>;
    };
    expect(body.coordinators).toEqual([]);
    expect(calls.map((c) => c.name)).toContain('sentinel_status_error');
  });

  it("queries as the caller, so the engine applies the caller's grant on the sentinel namespace", async () => {
    // A null identity is the system actor, which the engine's namespace gate waves through.
    const seen: unknown[] = [];
    const { handler } = wireRoute(async (input) => {
      seen.push(input.ctx?.identity);
      return { data: { [`${NS}/Coordinator`]: [] } } as unknown as PackEnvelope;
    });
    const caller = { kind: 'agent', id: 'peer@host', grants: { other: ['read'] } };
    await handler({ method: 'GET', path: PATH, identity: caller });
    expect(seen).toEqual([caller]);
  });
});

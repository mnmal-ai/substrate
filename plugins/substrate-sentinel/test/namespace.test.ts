import type { PackEnvelope, SubstrateResponse } from '@mnmal-ai/substrate/sdk';
import { compose, MemoryDataset, MemorySubstrateServer } from '@mnmal-ai/substrate/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { SENTINEL_TYPE_NAMES } from '../src/namespace.js';
import { buildSentinelForTest } from './_helpers.js';

const NS = 'sentinel';

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

interface FederatedSchemaShape {
  [ns: string]: {
    types: Record<string, { fields: Record<string, unknown> }>;
    mutations: Record<string, { params: Record<string, unknown>; returns: unknown }>;
  };
}

async function setup(): Promise<{
  server: MemorySubstrateServer;
  stop: () => Promise<void>;
}> {
  const server = new MemorySubstrateServer();
  const defaultDataset = new MemoryDataset({ namespace: 'default' });
  const sentinelDataset = new MemoryDataset({ namespace: NS });
  const plugin = buildSentinelForTest({ namespace: NS });
  const composed = await compose({
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

describe('buildSentinelNamespace', () => {
  let cleanup: (() => Promise<void>) | null = null;

  afterEach(async () => {
    if (cleanup !== null) {
      await cleanup();
      cleanup = null;
    }
  });

  it('publishes every sentinel type in the federated schema', async () => {
    const { server, stop } = await setup();
    cleanup = stop;
    const res = await server.inject({ method: 'GET', path: '/substrate/v1/federated-schema' });
    const schema = jsonBody<FederatedSchemaShape>(res);
    const typeNames = Object.keys(schema[NS]?.types ?? {}).sort();
    expect(typeNames).toEqual([...SENTINEL_TYPE_NAMES].sort());
  });

  it('exposes autoCRUD mutations (create/get/update/delete) for each type', async () => {
    const { server, stop } = await setup();
    cleanup = stop;
    const res = await server.inject({ method: 'GET', path: '/substrate/v1/federated-schema' });
    const schema = jsonBody<FederatedSchemaShape>(res);
    const mutations = Object.keys(schema[NS]?.mutations ?? {});
    for (const type of SENTINEL_TYPE_NAMES) {
      for (const prefix of ['create', 'get', 'update', 'delete']) {
        expect(mutations).toContain(`${prefix}${type}`);
      }
    }
  });

  it('round-trips createCoordinator and reads it back via the Coordinator list', async () => {
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
              namespaces: 'family,home',
              status: 'online',
              lastHeartbeat: '2026-04-19T00:00:00Z',
              registeredAt: '2026-04-19T00:00:00Z',
              version: '1.0.0'
            },
            fields: { id: true, name: true }
          }
        })
      )
    });
    expect(create.status).toBe(200);
    const createdEnv = jsonBody<PackEnvelope>(create);
    expect(createdEnv.errors).toBeUndefined();

    const list = await server.inject({
      method: 'POST',
      path: '/substrate/v1/query',
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(
        JSON.stringify({
          [`${NS}/Coordinator`]: {
            params: {},
            fields: { id: true, name: true, url: true, status: true }
          }
        })
      )
    });
    expect(list.status).toBe(200);
    const listEnv = jsonBody<PackEnvelope>(list);
    const rows = listEnv.data[`${NS}/Coordinator`] as Array<{
      name: string;
      url: string;
      status: string;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.name).toBe('home');
    expect(rows[0]?.url).toBe('http://localhost:3200');
    expect(rows[0]?.status).toBe('online');
  });

  it('exposes every declared field (including FK coordinatorId) in the schema', async () => {
    const { server, stop } = await setup();
    cleanup = stop;
    const res = await server.inject({ method: 'GET', path: '/substrate/v1/federated-schema' });
    const schema = jsonBody<FederatedSchemaShape>(res);
    const nsFields = schema[NS]?.types.CoordinatorNamespace?.fields ?? {};
    const bridgeFields = schema[NS]?.types.CoordinatorBridge?.fields ?? {};
    expect(Object.keys(nsFields)).toContain('coordinatorId');
    expect(Object.keys(bridgeFields)).toContain('coordinatorId');
    expect(Object.keys(bridgeFields)).toContain('allowMutate');
    expect(Object.keys(bridgeFields)).toContain('allowPropose');
  });
});

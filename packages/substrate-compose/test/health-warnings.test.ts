/** /health carries post-write hook failures as warnings and stays `ok`. */

import { MemoryDataset } from '@mnmal-ai/substrate-dataset-memory';
import { defineNamespace, field } from '@mnmal-ai/substrate-sdk';
import { FastifySubstrateServer } from '@mnmal-ai/substrate-server-fastify';
import type { CoordinatorPlugin } from '@mnmal-ai/substrate-types';
import { afterEach, describe, expect, it } from 'vitest';
import { createH2Fetch } from '../../substrate-client/src/transport/h2-fetch.js';
import { compose } from '../src/compose.js';

// The server speaks HTTP/2 only; the platform fetch speaks HTTP/1.1.
const h2fetch = createH2Fetch();

const NS = 'shop';
let server: FastifySubstrateServer;
afterEach(async () => {
  await server.stop({ grace: 0 });
});

describe('/health warnings', () => {
  it('a throwing onCommittedWrites hook names the plugin; status stays ok', async () => {
    const plugin: CoordinatorPlugin = {
      name: 'indexer',
      contractVersion: '*',
      namespaces: [defineNamespace(NS, { Order: { fields: { note: field.string() } } })],
      onCommittedWrites: () => {
        throw new Error('index down');
      }
    };
    server = new FastifySubstrateServer();
    const app = await compose({
      systemActor: 'test',
      server,
      dataset: new MemoryDataset({ namespace: 'default' }),
      datasets: { [NS]: new MemoryDataset({ namespace: NS }) },
      coordinators: [plugin]
    });
    const { address, port } = await server.start({ host: '127.0.0.1', port: 0 });
    const url = `http://${address}:${port}`;
    expect((await (await h2fetch(`${url}/health`)).json()).warnings).toEqual([]);

    const env = await app.engine.mutate({
      frame: { [`${NS}/createOrder`]: { params: { note: 'x' }, fields: { id: true } } },
      ctx: {
        namespace: NS,
        identity: { id: 'sys', kind: 'system', grants: { '*': ['read', 'mutate'] } }
      } as never
    });
    expect(env.errors ?? []).toEqual([]);
    await app.engine.hooksSettled();

    const body = await (await h2fetch(`${url}/health`)).json();
    expect(body.status).toBe('ok');
    expect(body.warnings).toHaveLength(1);
    // /health needs no key, so the hook's own message must not appear.
    expect(body.warnings[0]).toMatch(/^post-write hook indexer failed at \S+$/);
    expect(JSON.stringify(body)).not.toContain('index down');
  });
});

describe('/health pool', () => {
  it('reports the store pool counts when the dataset has a pool, and omits them otherwise', async () => {
    const stats = { connections: 3, opening: 0, idle: 2, leased: 1, waiting: 0 };
    const pooled = Object.assign(new MemoryDataset({ namespace: 'default' }), {
      poolStats: () => stats
    });
    server = new FastifySubstrateServer();
    await compose({ systemActor: 'test', server, dataset: pooled, datasets: {}, coordinators: [] });
    const { address, port } = await server.start({ host: '127.0.0.1', port: 0 });
    expect((await (await h2fetch(`http://${address}:${port}/health`)).json()).pool).toEqual(stats);
    await server.stop({ grace: 0 });

    server = new FastifySubstrateServer();
    await compose({
      systemActor: 'test',
      server,
      dataset: new MemoryDataset({ namespace: 'default' }),
      datasets: {},
      coordinators: []
    });
    const bare = await server.start({ host: '127.0.0.1', port: 0 });
    const body = await (await h2fetch(`http://${bare.address}:${bare.port}/health`)).json();
    expect(body.status).toBe('ok');
    expect(body).not.toHaveProperty('pool');
  });
});

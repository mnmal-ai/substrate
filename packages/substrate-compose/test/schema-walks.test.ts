/** The schema routes tell an agent where a walk can start and what a hop is served on. */

import { MemoryDataset } from '@mnmal-ai/substrate-dataset-memory';
import { defineNamespace, field } from '@mnmal-ai/substrate-sdk';
import { FastifySubstrateServer } from '@mnmal-ai/substrate-server-fastify';
import type { CoordinatorPlugin, IndexPlan } from '@mnmal-ai/substrate-types';
import { afterEach, describe, expect, it } from 'vitest';
import { compose } from '../src/compose.js';

const NS = 'shop';
const plugin: CoordinatorPlugin = {
  name: 'walks-fixture',
  contractVersion: '*',
  namespaces: [
    defineNamespace(NS, {
      Order: { fields: { note: field.string() } },
      Item: {
        fields: { order: field.crossRef(NS, 'Order'), price: field.number({ indexed: true }) }
      }
    })
  ]
};

class PlannedDataset extends MemoryDataset {
  async indexPlan(): Promise<IndexPlan> {
    return {
      indexes: [
        {
          name: 'a',
          keys: [
            ['order', 'asc'],
            ['createdAt', 'desc']
          ],
          unique: false
        },
        {
          name: 'b',
          keys: [
            ['order', 'asc'],
            ['price', 'asc']
          ],
          unique: false
        },
        {
          name: 'c',
          keys: [
            ['order', 'asc'],
            ['note', 'asc']
          ],
          unique: false,
          only: { x: true }
        }
      ]
    };
  }
}

let server: FastifySubstrateServer;
afterEach(async () => {
  await server.stop({ grace: 0 });
});

async function boot(dataset: MemoryDataset, walksEnabled = false) {
  server = new FastifySubstrateServer();
  await compose({
    systemActor: 'test',
    server,
    dataset: new MemoryDataset({ namespace: 'default' }),
    datasets: { [NS]: dataset },
    coordinators: [plugin],
    walksEnabled
  });
  const { address, port } = await server.start({ host: '127.0.0.1', port: 0 });
  return `http://${address}:${port}`;
}

// biome-ignore lint/suspicious/noExplicitAny: schema JSON is read by deep path
const get = async (url: string) => (await fetch(url)).json() as Promise<Record<string, any>>;

describe('walk discoverability in the schema', () => {
  it('schema lists inbound crossRefs', async () => {
    const url = await boot(new MemoryDataset({ namespace: NS }));
    const fed = await get(`${url}/substrate/v1/federated-schema`);
    expect(fed[NS].types.Order.inboundRefs).toEqual([{ type: 'Item', field: 'order' }]);
    expect(fed[NS].types.Item.inboundRefs).toBeUndefined();
  });

  it('per-type schema lists fields served after each hop', async () => {
    const url = await boot(new PlannedDataset({ namespace: NS }));
    const item = await get(`${url}/substrate/v1/schema/${NS}/Item`);
    expect(item.servedAfterHop).toEqual({ order: ['createdAt', 'price'] });
  });

  it('omits servedAfterHop where the store keeps no index plan', async () => {
    const url = await boot(new MemoryDataset({ namespace: NS }));
    expect(await get(`${url}/substrate/v1/schema/${NS}/Item`)).not.toHaveProperty('servedAfterHop');
  });

  it('health says walks are on only when the flag is', async () => {
    const url = await boot(new MemoryDataset({ namespace: NS }));
    expect(await get(`${url}/health`)).not.toHaveProperty('walks');
    await server.stop({ grace: 0 });
    const on = await boot(new MemoryDataset({ namespace: NS }), true);
    expect((await get(`${on}/health`)).walks).toBe(true);
  });
});

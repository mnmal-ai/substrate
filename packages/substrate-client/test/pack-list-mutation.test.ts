/**
 * A mutation whose declared `returns` is a list answers under pack as it does
 * under JSON: every element positioned by the list's element shape.
 */

import { type ComposeResult, compose } from '@mnmal-ai/substrate-compose';
import { MemoryDataset } from '@mnmal-ai/substrate-dataset-memory';
import { FastifySubstrateServer } from '@mnmal-ai/substrate-server-fastify';
import type { CoordinatorPlugin, FieldDef } from '@mnmal-ai/substrate-types';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { SubstrateClient } from '../src/index.js';

const ROW: FieldDef = {
  kind: 'struct',
  fields: {
    id: { kind: 'scalar', type: 'string' },
    name: { kind: 'scalar', type: 'string' },
    n: { kind: 'scalar', type: 'number' }
  }
};

const listPlugin: CoordinatorPlugin = {
  name: 'lists',
  contractVersion: '*',
  namespaces: [
    {
      namespace: 'lists',
      install: async ({ registry }) => {
        registry.register('makeRows', {
          kind: 'mutation',
          params: { count: { kind: 'scalar', type: 'number' } },
          returns: { kind: 'list', of: ROW },
          resolver: async (_ctx, args) => {
            const count = (args.params as { count: number }).count;
            return Array.from({ length: count }, (_, i) => ({ id: `id${i}`, name: `r${i}`, n: i }));
          }
        });
      }
    }
  ]
};

let composed: ComposeResult;
let client: SubstrateClient;

beforeEach(async () => {
  const server = new FastifySubstrateServer({ logger: false });
  composed = await compose({
    systemActor: 'test',
    server,
    dataset: new MemoryDataset({ namespace: 'lists' }),
    coordinators: [listPlugin]
  });
  const { port } = await server.start({ host: '127.0.0.1', port: 0 });
  client = new SubstrateClient({ endpoint: `http://127.0.0.1:${port}` });
});

afterEach(async () => {
  await client.close();
  await composed.stop();
});

it.each([0, 1, 3])(
  'a list-returning mutation with %i rows decodes the same on both wires',
  async (count) => {
    const frame = { 'lists/makeRows': { params: { count } } };
    const json = await client.mutate(frame);
    const pack = await client.mutate(frame, { wire: 'pack' });
    expect(pack.errors ?? []).toEqual([]);
    expect(json.data['lists/makeRows']).toHaveLength(count);
    expect(pack.data['lists/makeRows']).toEqual(json.data['lists/makeRows']);
  }
);

it('a batch of list-returning mutations decodes per frame', async () => {
  const frame = { 'lists/makeRows': [{ params: { count: 2 } }, { params: { count: 1 } }] };
  const json = await client.mutate(frame);
  const pack = await client.mutate(frame, { wire: 'pack' });
  expect(pack.errors ?? []).toEqual([]);
  expect(pack.data['lists/makeRows']).toEqual(json.data['lists/makeRows']);
});

it('fields narrow each element of a list-returning mutation on both wires', async () => {
  const frame = { 'lists/makeRows': { params: { count: 2 }, fields: { name: true } } };
  const json = await client.mutate(frame);
  const pack = await client.mutate(frame, { wire: 'pack' });
  expect(pack.data['lists/makeRows']).toEqual([{ name: 'r0' }, { name: 'r1' }]);
  expect(pack.data['lists/makeRows']).toEqual(json.data['lists/makeRows']);
});

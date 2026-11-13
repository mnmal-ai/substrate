/**
 * `updateMany<T>` / `deleteMany<T>` over a real server: the published schema
 * lists them under their type, and the client decodes the
 * `{ count, ids, idsTruncated }` result on both wires.
 */

import { type ComposeResult, compose } from '@mnmal-ai/substrate-compose';
import { MemoryDataset } from '@mnmal-ai/substrate-dataset-memory';
import { FastifySubstrateServer } from '@mnmal-ai/substrate-server-fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SubstrateClient } from '../src/index.js';
import { createH2Fetch } from '../src/transport/h2-fetch.js';
import { demoPlugin } from './fixtures/demo-plugin.js';

// The server speaks HTTP/2 only; the platform fetch speaks HTTP/1.1.
const h2fetch = createH2Fetch();

let baseUrl: string;
let composed: ComposeResult;

beforeEach(async () => {
  const server = new FastifySubstrateServer({ logger: false });
  composed = await compose({
    systemActor: 'test',
    server,
    dataset: new MemoryDataset({ namespace: 'default' }),
    coordinators: [demoPlugin]
  });
  const { port } = await server.start({ host: '127.0.0.1', port: 0 });
  baseUrl = `http://127.0.0.1:${port}`;
});

afterEach(async () => {
  await composed.stop();
});

describe('by-filter writes on the wire', () => {
  it("schema lists updateManyTodo under Todo's mutations", async () => {
    const res = await h2fetch(`${baseUrl}/substrate/v1/schema/default/Todo`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { mutations: Record<string, unknown> };
    expect(Object.keys(body.mutations)).toEqual(
      expect.arrayContaining(['updateTodo', 'updateManyTodo', 'deleteManyTodo'])
    );
    const other = (await (await h2fetch(`${baseUrl}/substrate/v1/schema/default/Tag`)).json()) as {
      mutations: Record<string, unknown>;
    };
    expect(Object.keys(other.mutations)).not.toContain('updateManyTodo');
  });

  it('client decodes the result on JSON and msgpack', async () => {
    const client = new SubstrateClient({ endpoint: baseUrl });
    try {
      for (const title of ['a', 'b', 'c']) {
        await client.mutate({
          'default/createTodo': {
            params: { id: title, title, status: 'open' },
            fields: { id: true }
          }
        });
      }
      const sel = { count: true, ids: true, idsTruncated: true };
      for (const wire of ['json', 'pack'] as const) {
        const env = await client.mutate(
          {
            'default/updateManyTodo': {
              params: { where: { status: { eq: 'open' } }, set: { title: wire } },
              fields: sel
            }
          },
          { wire }
        );
        expect(env.errors).toBeUndefined();
        expect(env.data['default/updateManyTodo']).toEqual({
          count: 3,
          ids: ['a', 'b', 'c'],
          idsTruncated: false
        });
      }
      const del = await client.mutate(
        { 'default/deleteManyTodo': { params: { where: { title: { eq: 'pack' } } }, fields: sel } },
        { wire: 'pack' }
      );
      expect(del.data['default/deleteManyTodo']).toEqual({
        count: 3,
        ids: ['a', 'b', 'c'],
        idsTruncated: false
      });
    } finally {
      await client.close();
    }
  });
});

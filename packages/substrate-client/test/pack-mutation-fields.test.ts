/**
 * Under pack, a mutation answers by the frame's `fields`, and a create or
 * update with none answers `{ id, shortId }`, exactly as JSON does. Each case sends the same frame
 * over both wires and compares the decoded results.
 */

import { type ComposeResult, compose } from '@mnmal-ai/substrate-compose';
import { MemoryDataset } from '@mnmal-ai/substrate-dataset-memory';
import { FastifySubstrateServer } from '@mnmal-ai/substrate-server-fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type QualifiedFrame, SubstrateClient } from '../src/index.js';
import { demoPlugin } from './fixtures/demo-plugin.js';

let composed: ComposeResult;
let client: SubstrateClient;

beforeEach(async () => {
  const server = new FastifySubstrateServer({ logger: false });
  composed = await compose({
    systemActor: 'test',
    server,
    dataset: new MemoryDataset({ namespace: 'default' }),
    coordinators: [demoPlugin]
  });
  const { port } = await server.start({ host: '127.0.0.1', port: 0 });
  client = new SubstrateClient({ endpoint: `http://127.0.0.1:${port}` });
});

afterEach(async () => {
  await client.close();
  await composed.stop();
});

/** A result with its server-generated values replaced, so two writes compare. */
function shape(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(shape);
  if (value === null || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = k === 'id' || k === 'shortId' ? typeof v : v;
  }
  return out;
}

async function both(frame: QualifiedFrame): Promise<{ json: unknown; pack: unknown }> {
  const json = await client.mutate(frame);
  const pack = await client.mutate(frame, { wire: 'pack' });
  expect(pack.errors ?? []).toEqual([]);
  const key = Object.keys(frame)[0] as string;
  return { json: json.data[key], pack: pack.data[key] };
}

describe('pack mutation results honour fields', () => {
  it('a create with no fields answers { id, shortId } on both wires', async () => {
    const { json, pack } = await both({ 'default/createTodo': { params: { title: 'a' } } });
    expect(shape(pack)).toEqual({ id: 'string', shortId: 'number' });
    expect(shape(pack)).toEqual(shape(json));
  });

  it('a create with fields answers exactly those fields', async () => {
    const { json, pack } = await both({
      'default/createTodo': {
        params: { title: 'b', priority: 3 },
        fields: { title: true, priority: true }
      }
    });
    expect(pack).toEqual({ title: 'b', priority: 3 });
    expect(pack).toEqual(json);
  });

  it('fields: true answers the whole row on both wires', async () => {
    const { json, pack } = await both({
      'default/createTodo': { params: { title: 'all' }, fields: true as never }
    });
    // Pack positions by the declared fields: no `_metadata`, and an unset field decodes as null.
    const { _metadata, ...declared } = shape(json) as Record<string, unknown>;
    expect(_metadata).toBeDefined();
    expect(shape(pack)).toEqual({ ...declared, project: null, status: null });
  });

  it('an update with fields answers those fields', async () => {
    const created = await client.mutate({
      'default/createTodo': { params: { title: 'c' }, fields: { id: true } }
    });
    const id = (created.data['default/createTodo'] as { id: string }).id;
    const { json, pack } = await both({
      'default/updateTodo': { params: { id, done: true }, fields: { id: true, done: true } }
    });
    expect(pack).toEqual({ id, done: true });
    expect(pack).toEqual(json);
  });

  it('a batch answers each frame by its own fields', async () => {
    const { json, pack } = await both({
      'default/createTodo': [
        { params: { title: 'd1' } },
        { params: { title: 'd2' }, fields: { title: true } },
        { params: { title: 'd3', priority: 7 }, fields: { title: true, priority: true } }
      ]
    });
    expect(shape(pack)).toEqual([
      { id: 'string', shortId: 'number' },
      { title: 'd2' },
      { title: 'd3', priority: 7 }
    ]);
    expect(shape(pack)).toEqual(shape(json));
  });

  it('updateMany with no fields keeps its own { count, ids } shape on both wires', async () => {
    for (const title of ['m', 'm']) {
      await client.mutate({ 'default/createTodo': { params: { title } } });
    }
    const frame = (done: boolean): QualifiedFrame => ({
      'default/updateManyTodo': { params: { where: { title: { eq: 'm' } }, set: { done } } }
    });
    const json = await client.mutate(frame(true));
    const pack = await client.mutate(frame(false), { wire: 'pack' });
    expect(json.data['default/updateManyTodo']).toMatchObject({ count: 2 });
    expect(shape(pack.data['default/updateManyTodo'])).toEqual(
      shape(json.data['default/updateManyTodo'])
    );
  });

  it('the schema marks only create and update as writing rows', async () => {
    const schema = (await client.federatedSchema()).default;
    const marked = Object.entries(schema?.mutations ?? {})
      .filter(([, m]) => m.writesRows === true)
      .map(([name]) => name)
      .sort();
    expect(marked).toEqual(['createTag', 'createTodo', 'updateTag', 'updateTodo']);
  });

  it('a delete with fields is trimmed on both wires', async () => {
    const ids: string[] = [];
    for (const title of ['f1', 'f2']) {
      const env = await client.mutate({
        'default/createTodo': { params: { title }, fields: { id: true } }
      });
      ids.push((env.data['default/createTodo'] as { id: string }).id);
    }
    const json = await client.mutate({
      'default/deleteTodo': { params: { id: ids[0] }, fields: { deleted: true } }
    });
    const pack = await client.mutate(
      { 'default/deleteTodo': { params: { id: ids[1] }, fields: { deleted: true } } },
      { wire: 'pack' }
    );
    expect(pack.data['default/deleteTodo']).toEqual({ deleted: true });
    expect(pack.data['default/deleteTodo']).toEqual(json.data['default/deleteTodo']);
  });

  it('a delete with no fields keeps its own { id, deleted } shape', async () => {
    const created = await client.mutate({
      'default/createTodo': { params: { title: 'e' }, fields: { id: true } }
    });
    const id = (created.data['default/createTodo'] as { id: string }).id;
    const pack = await client.mutate(
      { 'default/deleteTodo': { params: { id } } },
      { wire: 'pack' }
    );
    expect(pack.data['default/deleteTodo']).toEqual({ id, deleted: true });
  });
});

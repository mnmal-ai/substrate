/**
 * On the JSON wire, a mutation that writes a row and names no `fields` answers
 * with `{ id, shortId }`, not the whole row. `fields` still selects, per frame,
 * and a mutation whose result is not a row (delete) keeps its result whole.
 */

import { MemoryDataset } from '@mnmal-ai/substrate-dataset-memory';
import { defineNamespace, field } from '@mnmal-ai/substrate-sdk';
import { MemorySubstrateServer } from '@mnmal-ai/substrate-server-memory';
import type { PackEnvelope } from '@mnmal-ai/substrate-types';
import { afterEach, describe, expect, it } from 'vitest';
import { compose } from '../src/compose.js';

let stop: (() => Promise<void>) | undefined;
afterEach(async () => {
  await stop?.();
  stop = undefined;
});

async function setup(): Promise<(frame: unknown) => Promise<PackEnvelope>> {
  const server = new MemorySubstrateServer();
  const composed = await compose({
    systemActor: 'test',
    server,
    dataset: new MemoryDataset({ namespace: 'default' }),
    coordinators: [
      {
        name: 'notes',
        contractVersion: '*',
        namespaces: [
          defineNamespace('default', {
            Note: { fields: { title: field.string(), body: field.string({ nullable: true }) } }
          })
        ]
      }
    ]
  });
  await server.start();
  stop = () => composed.stop();
  return async (frame) => {
    const res = await server.inject({
      method: 'POST',
      path: '/substrate/v1/mutate',
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(JSON.stringify(frame))
    });
    return JSON.parse(Buffer.from(res.body as Buffer).toString()) as PackEnvelope;
  };
}

const keysOf = (v: unknown): string[] => Object.keys(v as object).sort();

describe('mutation acknowledgement on the JSON wire', () => {
  it('a create or update with no fields answers { id, shortId }', async () => {
    const mutate = await setup();
    const created = await mutate({
      'default/createNote': { params: { title: 't', body: 'long body' } }
    });
    const row = created.data['default/createNote'] as { id: string; shortId: number };
    expect(keysOf(row)).toEqual(['id', 'shortId']);

    const updated = await mutate({ 'default/updateNote': { params: { id: row.id, title: 'u' } } });
    expect(keysOf(updated.data['default/updateNote'])).toEqual(['id', 'shortId']);
  });

  it('a batched create projects each element by its own fields, defaulting the same way', async () => {
    const mutate = await setup();
    const env = await mutate({
      'default/createNote': [
        { params: { title: 'a', body: 'x' } },
        { params: { title: 'b', body: 'x' }, fields: { title: true } },
        { params: { title: 'c', body: 'x' }, fields: true }
      ]
    });
    const out = env.data['default/createNote'] as unknown[];
    expect(keysOf(out[0])).toEqual(['id', 'shortId']);
    expect(out[1]).toEqual({ title: 'b' });
    expect(keysOf(out[2])).toEqual(expect.arrayContaining(['body', 'id', 'shortId', 'title']));
  });

  it('fields still selects on a single frame', async () => {
    const mutate = await setup();
    const env = await mutate({
      'default/createNote': {
        params: { title: 't', body: 'b' },
        fields: { title: true, body: true }
      }
    });
    expect(env.data['default/createNote']).toEqual({ title: 't', body: 'b' });
  });

  it('a delete keeps its { id, deleted } result whole', async () => {
    const mutate = await setup();
    const created = await mutate({ 'default/createNote': { params: { title: 't' } } });
    const { id } = created.data['default/createNote'] as { id: string };
    const env = await mutate({ 'default/deleteNote': { params: { id } } });
    expect(env.data['default/deleteNote']).toEqual({ id, deleted: true });
  });
});

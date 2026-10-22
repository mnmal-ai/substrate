/**
 * A pack reply is positional, so it can only be decoded against the schema
 * that encoded it. The client decoded against its cached schema FIRST and
 * compared schemaVersion after: a type added since (propose_type) failed to
 * decode every time, and the refetch that would fix it never ran.
 */

import { encodeEnvelope } from '@mnmal-ai/substrate-pack';
import { HttpResponse, http } from 'msw';
import { expect, it } from 'vitest';
import { SubstrateClient } from '../src/client.js';
import { mockHandlers } from './_setup.js';

const ENDPOINT = 'http://substrate.test';
const scalar = (type: 'string' | 'number') => ({ kind: 'scalar' as const, type });
const todo = { fields: { id: scalar('string'), title: scalar('string') } };
const V1 = { default: { schemaVersion: 'v1', types: { Todo: todo }, mutations: {} } };
const V2 = {
  default: { schemaVersion: 'v2', types: { Todo: todo, Foo: todo }, mutations: {} }
};

function packBody(schemaVersion: 'v1' | 'v2', type: 'Todo' | 'Foo', rows: unknown[]) {
  const key = `default/${type}`;
  const bytes = encodeEnvelope(
    { schemaVersion, data: { [key]: rows }, shapes: { [key]: 'list' } },
    {
      fieldsByKey: { [key]: { id: true, title: true } },
      typeByKey: { [key]: type },
      currentNsByKey: { [key]: 'default' },
      schemas: (schemaVersion === 'v1' ? V1 : V2) as never
    }
  );
  return new HttpResponse(bytes, {
    headers: { 'content-type': 'application/vnd.substrate.pack' }
  });
}

it('refetches the schema before decoding a pack reply from a newer schema', async () => {
  let schemaFetches = 0;
  mockHandlers(
    http.get(`${ENDPOINT}/substrate/v1/federated-schema`, () => {
      schemaFetches += 1;
      return HttpResponse.json(schemaFetches === 1 ? V1 : V2);
    }),
    http.post(`${ENDPOINT}/substrate/v1/query`, async ({ request }) => {
      const frame = (await request.json()) as Record<string, unknown>;
      return 'default/Foo' in frame
        ? packBody('v2', 'Foo', [{ id: 'f1', title: 'new type' }])
        : packBody('v1', 'Todo', [{ id: 't1', title: 'old type' }]);
    })
  );

  const client = new SubstrateClient({ endpoint: ENDPOINT });
  try {
    const first = await client.query(
      { 'default/Todo': { params: {}, fields: { id: true, title: true } } },
      { wire: 'pack' }
    );
    expect(first.data['default/Todo']).toEqual([{ id: 't1', title: 'old type' }]);

    // Foo was added after this client cached v1.
    const second = await client.query(
      { 'default/Foo': { params: {}, fields: { id: true, title: true } } },
      { wire: 'pack' }
    );
    expect(second.data['default/Foo']).toEqual([{ id: 'f1', title: 'new type' }]);
    expect(schemaFetches).toBe(2);
  } finally {
    await client.close();
  }
});

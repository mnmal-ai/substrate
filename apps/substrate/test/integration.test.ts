import { type ComposeResult, compose } from '@mnmal-ai/substrate-compose';
import { MemoryDataset } from '@mnmal-ai/substrate-dataset-memory';
import {
  decodeEnvelope,
  decodePositional,
  encodePositional,
  PACK_MIME,
  packFrame,
  unpackFrame,
  WS_SUBPROTOCOL_SUBSTRATE_PACK
} from '@mnmal-ai/substrate-pack';
import { MemorySubstrateServer } from '@mnmal-ai/substrate-server-memory';
import type {
  FieldInput,
  PackEnvelope,
  Schema,
  SubstrateResponse,
  WsResponseFrame
} from '@mnmal-ai/substrate-types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fixturePlugin } from './_fixtures/fixture-plugin.js';

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

describe('apps/substrate integration', () => {
  let server: MemorySubstrateServer;
  let dataset: MemoryDataset;
  let composed: ComposeResult;

  beforeEach(async () => {
    server = new MemorySubstrateServer();
    dataset = new MemoryDataset({ namespace: 'default' });
    composed = await compose({
      // Auth is off, so the deployment must declare who it writes as.
      systemActor: 'test',
      server,
      dataset,
      coordinators: [fixturePlugin]
    });
    await server.start();
  });

  afterEach(async () => {
    await composed.stop();
  });

  it('GET /substrate/v1/schema returns the default namespace schema', async () => {
    const res = await server.inject({ method: 'GET', path: '/substrate/v1/schema' });
    expect(res.status).toBe(200);
    const schema = jsonBody<Schema>(res);
    expect(schema.schemaVersion).toMatch(/^[0-9a-f]{12}$/);
    expect(schema.types.Todo).toBeDefined();
    expect(schema.types.Todo?.fields.title).toEqual({
      kind: 'scalar',
      type: 'string',
      indexed: true
    });
    expect(schema.types.Tag).toBeDefined();
    expect(schema.types.Tag?.fields.todoId).toEqual({
      kind: 'crossRef',
      ns: 'default',
      type: 'Todo',
      onDelete: 'set_null'
    });
    expect(schema.mutations.createTodo).toBeDefined();
    expect(schema.mutations.getTodo).toBeDefined();
    expect(schema.mutations.updateTodo).toBeDefined();
    expect(schema.mutations.deleteTodo).toBeDefined();
    expect(schema.mutations.createTag).toBeDefined();
    expect(schema.mutations.deleteTag).toBeDefined();
  });

  it('GET /substrate/v1/federated-schema includes the default namespace (and `_system`)', async () => {
    const res = await server.inject({ method: 'GET', path: '/substrate/v1/federated-schema' });
    expect(res.status).toBe(200);
    const federated = jsonBody<Record<string, Schema>>(res);
    // `_system` is always mounted alongside user-facing namespaces (§5.12 Phase 2).
    expect(Object.keys(federated).sort()).toEqual(['_system', 'default']);
    const defSchema = federated.default;
    expect(defSchema).toBeDefined();
    expect(defSchema?.schemaVersion).toMatch(/^[0-9a-f]{12}$/);
    expect(defSchema?.types.Todo).toBeDefined();
    expect(defSchema?.mutations.createTodo).toBeDefined();
    expect(defSchema?.mutations.getTodo).toBeDefined();
  });

  it('GET /substrate/v1/schema/:namespace returns one namespace schema', async () => {
    const res = await server.inject({ method: 'GET', path: '/substrate/v1/schema/default' });
    expect(res.status).toBe(200);
    const schema = jsonBody<Schema>(res);
    expect(schema.schemaVersion).toMatch(/^[0-9a-f]{12}$/);
    expect(schema.types.Todo).toBeDefined();
    expect(schema.mutations.createTodo).toBeDefined();
  });

  it('GET /substrate/v1/schema/:namespace 404s on an unknown namespace', async () => {
    const res = await server.inject({ method: 'GET', path: '/substrate/v1/schema/nope' });
    expect(res.status).toBe(404);
    expect(jsonBody<{ error: string }>(res).error).toMatch(/unknown namespace 'nope'/);
  });

  it('GET /substrate/v1/schema/:namespace/:type returns one type write contract', async () => {
    const res = await server.inject({ method: 'GET', path: '/substrate/v1/schema/default/Todo' });
    expect(res.status).toBe(200);
    const body = jsonBody<{
      schemaVersion: string;
      namespace: string;
      type: string;
      fields: Record<string, unknown>;
      mutations: Record<string, unknown>;
    }>(res);
    expect(body.namespace).toBe('default');
    expect(body.type).toBe('Todo');
    expect(body.fields.title).toEqual({ kind: 'scalar', type: 'string', indexed: true });
    // Only Todo-targeting mutations are surfaced — createTag must NOT leak in.
    expect(body.mutations.createTodo).toBeDefined();
    expect(body.mutations.updateTodo).toBeDefined();
    expect(body.mutations.createTag).toBeUndefined();
  });

  it('GET /substrate/v1/schema/:namespace/:type 404s on an unknown type with availableTypes', async () => {
    const res = await server.inject({ method: 'GET', path: '/substrate/v1/schema/default/Nope' });
    expect(res.status).toBe(404);
    const body = jsonBody<{ error: string; availableTypes: string[] }>(res);
    expect(body.error).toMatch(/unknown type 'Nope'/);
    expect(body.availableTypes).toContain('Todo');
  });

  it('POST /substrate/v1/query with empty Todo list returns envelope with data:[]', async () => {
    const res = await server.inject({
      method: 'POST',
      path: '/substrate/v1/query',
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(
        JSON.stringify({
          'default/Todo': { params: { limit: 10 }, fields: { id: true, title: true, done: true } }
        })
      )
    });
    expect(res.status).toBe(200);
    const envelope = jsonBody<PackEnvelope>(res);
    expect(envelope.data['default/Todo']).toEqual([]);
    expect(envelope.shapes['default/Todo']).toBe('list');
    expect(envelope.errors).toBeUndefined();
  });

  it('POST /substrate/v1/mutate createTodo returns the created row', async () => {
    const res = await server.inject({
      method: 'POST',
      path: '/substrate/v1/mutate',
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(
        JSON.stringify({
          'default/createTodo': {
            params: { title: 'write tests', done: false },
            fields: { id: true, title: true, done: true }
          }
        })
      )
    });
    expect(res.status).toBe(200);
    const envelope = jsonBody<PackEnvelope>(res);
    expect(envelope.shapes['default/createTodo']).toBe('single');
    const created = envelope.data['default/createTodo'] as {
      id: string;
      title: string;
      done: boolean;
    };
    expect(created.title).toBe('write tests');
    expect(created.done).toBe(false);
    expect(typeof created.id).toBe('string');
    expect(created.id.length).toBeGreaterThan(0);
  });

  it('created todo appears in a subsequent list query', async () => {
    await server.inject({
      method: 'POST',
      path: '/substrate/v1/mutate',
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(
        JSON.stringify({ 'default/createTodo': { params: { title: 'one', done: false } } })
      )
    });
    await server.inject({
      method: 'POST',
      path: '/substrate/v1/mutate',
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(
        JSON.stringify({ 'default/createTodo': { params: { title: 'two', done: true } } })
      )
    });
    const res = await server.inject({
      method: 'POST',
      path: '/substrate/v1/query',
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(
        JSON.stringify({ 'default/Todo': { params: {}, fields: { id: true, title: true } } })
      )
    });
    const envelope = jsonBody<PackEnvelope>(res);
    expect(Array.isArray(envelope.data['default/Todo'])).toBe(true);
    expect(envelope.data['default/Todo']).toHaveLength(2);
  });

  it('schemaVersion is stable across calls', async () => {
    const a = jsonBody<Schema>(
      await server.inject({ method: 'GET', path: '/substrate/v1/schema' })
    );
    const b = jsonBody<Schema>(
      await server.inject({ method: 'GET', path: '/substrate/v1/schema' })
    );
    expect(a.schemaVersion).toBe(b.schemaVersion);
  });

  it('malformed JSON body returns 400', async () => {
    const res = await server.inject({
      method: 'POST',
      path: '/substrate/v1/query',
      headers: { 'content-type': 'application/json' },
      body: Buffer.from('{not json}')
    });
    expect(res.status).toBe(400);
  });

  it('empty body returns 400', async () => {
    const res = await server.inject({
      method: 'POST',
      path: '/substrate/v1/query',
      headers: { 'content-type': 'application/json' },
      body: Buffer.from('')
    });
    expect(res.status).toBe(400);
  });

  it('unknown name in query frame surfaces as envelope error', async () => {
    const res = await server.inject({
      method: 'POST',
      path: '/substrate/v1/query',
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(JSON.stringify({ 'default/Mystery': { params: {}, fields: {} } }))
    });
    expect(res.status).toBe(200);
    const envelope = jsonBody<PackEnvelope>(res);
    expect(envelope.errors).toBeDefined();
    expect(envelope.errors?.[0]?.code).toBe('unknown_name');
    expect(envelope.errors?.[0]?.message).toContain('Mystery');
  });

  it('unqualified key in query frame surfaces as envelope error', async () => {
    const res = await server.inject({
      method: 'POST',
      path: '/substrate/v1/query',
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(JSON.stringify({ Todo: { params: {}, fields: {} } }))
    });
    expect(res.status).toBe(200);
    const envelope = jsonBody<PackEnvelope>(res);
    expect(envelope.errors).toBeDefined();
    expect(envelope.errors?.[0]?.code).toBe('unqualified_key');
    expect(envelope.errors?.[0]?.message).toContain("'Todo'");
  });

  it('getTodo returns null when id is missing', async () => {
    const res = await server.inject({
      method: 'POST',
      path: '/substrate/v1/query',
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(JSON.stringify({ 'default/getTodo': { params: { id: 'does-not-exist' } } }))
    });
    expect(res.status).toBe(200);
    const envelope = jsonBody<PackEnvelope>(res);
    expect(envelope.data['default/getTodo']).toBeNull();
    expect(envelope.shapes['default/getTodo']).toBe('single');
  });

  it('Query with Accept: application/json returns a JSON envelope (default)', async () => {
    const res = await server.inject({
      method: 'POST',
      path: '/substrate/v1/query',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: Buffer.from(
        JSON.stringify({
          'default/Todo': { params: { limit: 10 }, fields: { id: true, title: true } }
        })
      )
    });
    expect(res.status).toBe(200);
    expect(res.headers?.['content-type']).toBe('application/json');
    const envelope = jsonBody<PackEnvelope>(res);
    expect(envelope.data['default/Todo']).toEqual([]);
  });

  it('Query without Accept header defaults to JSON', async () => {
    const res = await server.inject({
      method: 'POST',
      path: '/substrate/v1/query',
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(
        JSON.stringify({
          'default/Todo': { params: { limit: 10 }, fields: { id: true, title: true } }
        })
      )
    });
    expect(res.status).toBe(200);
    expect(res.headers?.['content-type']).toBe('application/json');
  });

  it('Query with Accept: application/vnd.substrate.pack returns msgpack envelope w/ positional data', async () => {
    await server.inject({
      method: 'POST',
      path: '/substrate/v1/mutate',
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(
        JSON.stringify({ 'default/createTodo': { params: { title: 'hi', done: false } } })
      )
    });
    const fields: FieldInput = { id: true, title: true, done: true };
    const res = await server.inject({
      method: 'POST',
      path: '/substrate/v1/query',
      headers: { 'content-type': 'application/json', accept: PACK_MIME },
      body: Buffer.from(JSON.stringify({ 'default/Todo': { params: {}, fields } }))
    });
    expect(res.status).toBe(200);
    expect(res.headers?.['content-type']).toBe(PACK_MIME);
    expect(Buffer.isBuffer(res.body)).toBe(true);

    const schema = jsonBody<Schema>(
      await server.inject({ method: 'GET', path: '/substrate/v1/schema' })
    );
    const decoded = decodeEnvelope(res.body as Buffer, {
      fieldsByKey: { 'default/Todo': fields },
      typeByKey: { 'default/Todo': 'Todo' },
      schemas: { default: schema },
      currentNsByKey: { 'default/Todo': 'default' }
    });
    expect(decoded.schemaVersion).toBe(schema.schemaVersion);
    expect(decoded.shapes['default/Todo']).toBe('list');
    const rows = decoded.data['default/Todo'] as Array<{
      id: string;
      title: string;
      done: boolean;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.title).toBe('hi');
    expect(rows[0]?.done).toBe(false);
  });

  it('Query substrate-pack body is truly positional (verify tuple shape)', async () => {
    await server.inject({
      method: 'POST',
      path: '/substrate/v1/mutate',
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(
        JSON.stringify({ 'default/createTodo': { params: { title: 'only', done: true } } })
      )
    });
    const fields: FieldInput = { id: true, title: true, done: true };
    const res = await server.inject({
      method: 'POST',
      path: '/substrate/v1/query',
      headers: { 'content-type': 'application/json', accept: PACK_MIME },
      body: Buffer.from(JSON.stringify({ 'default/Todo': { params: {}, fields } }))
    });
    // Dig into the raw msgpack by decoding with no schema context — we should
    // see the positional tuple form (arrays), not named objects.
    const raw = decodeEnvelope(res.body as Buffer, {
      fieldsByKey: {},
      typeByKey: {},
      schemas: {},
      currentNsByKey: {}
    });
    const rows = raw.data['default/Todo'] as Array<unknown>;
    expect(Array.isArray(rows)).toBe(true);
    expect(rows).toHaveLength(1);
    const tuple = rows[0];
    expect(Array.isArray(tuple)).toBe(true);
    expect((tuple as Array<unknown>).length).toBe(3);
  });

  it('Mutate with Accept: application/vnd.substrate.pack returns msgpack envelope w/ positional data', async () => {
    const res = await server.inject({
      method: 'POST',
      path: '/substrate/v1/mutate',
      headers: { 'content-type': 'application/json', accept: PACK_MIME },
      body: Buffer.from(
        JSON.stringify({
          'default/createTodo': {
            params: { title: 'via pack', done: false },
            fields: { id: true, title: true, done: true }
          }
        })
      )
    });
    expect(res.status).toBe(200);
    expect(res.headers?.['content-type']).toBe(PACK_MIME);

    // Raw decode (no schema context) exposes the positional tuple — confirms
    // the encoder is FieldDef-driven now, not passthrough.
    const raw = decodeEnvelope(res.body as Buffer, {
      fieldsByKey: {},
      typeByKey: {},
      schemas: {},
      currentNsByKey: {}
    });
    expect(raw.shapes['default/createTodo']).toBe('single');
    const tuple = raw.data['default/createTodo'];
    expect(Array.isArray(tuple)).toBe(true);

    // Schema-aware decode reconstructs the named object using the mutation's
    // declared return shape.
    const schema = jsonBody<Schema>(
      await server.inject({ method: 'GET', path: '/substrate/v1/schema' })
    );
    const returns = schema.mutations.createTodo?.returns;
    expect(returns).toBeDefined();
    if (!returns) return;
    const decoded = decodeEnvelope(res.body as Buffer, {
      fieldsByKey: {},
      typeByKey: {},
      schemas: { default: schema },
      currentNsByKey: { 'default/createTodo': 'default' },
      returnsByKey: { 'default/createTodo': returns }
    });
    const created = decoded.data['default/createTodo'] as {
      id: string;
      title: string;
      done: boolean;
    };
    expect(created.title).toBe('via pack');
    expect(created.done).toBe(false);
    expect(typeof created.id).toBe('string');
  });

  it('Error-only envelope (unqualified key) serialises as substrate-pack with no data encoding', async () => {
    const res = await server.inject({
      method: 'POST',
      path: '/substrate/v1/query',
      headers: { 'content-type': 'application/json', accept: PACK_MIME },
      body: Buffer.from(JSON.stringify({ Todo: { params: {}, fields: { id: true } } }))
    });
    expect(res.status).toBe(200);
    expect(res.headers?.['content-type']).toBe(PACK_MIME);
    const decoded = decodeEnvelope(res.body as Buffer, {
      fieldsByKey: {},
      typeByKey: {},
      schemas: {},
      currentNsByKey: {}
    });
    expect(decoded.errors?.[0]?.code).toBe('unqualified_key');
  });

  it('encodePositional matches what the server emits for a query', async () => {
    await server.inject({
      method: 'POST',
      path: '/substrate/v1/mutate',
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(
        JSON.stringify({ 'default/createTodo': { params: { title: 'sync', done: false } } })
      )
    });
    const fields: FieldInput = { id: true, title: true, done: true };
    const jsonRes = await server.inject({
      method: 'POST',
      path: '/substrate/v1/query',
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(JSON.stringify({ 'default/Todo': { params: {}, fields } }))
    });
    const jsonEnv = jsonBody<PackEnvelope>(jsonRes);

    const packRes = await server.inject({
      method: 'POST',
      path: '/substrate/v1/query',
      headers: { 'content-type': 'application/json', accept: PACK_MIME },
      body: Buffer.from(JSON.stringify({ 'default/Todo': { params: {}, fields } }))
    });
    const rawPack = decodeEnvelope(packRes.body as Buffer, {
      fieldsByKey: {},
      typeByKey: {},
      schemas: {},
      currentNsByKey: {}
    });
    const schema = jsonBody<Schema>(
      await server.inject({ method: 'GET', path: '/substrate/v1/schema' })
    );
    const expectedPositional = encodePositional(
      jsonEnv.data['default/Todo'],
      fields,
      schema,
      'Todo',
      { currentNs: 'default', schemas: { default: schema } }
    );
    expect(rawPack.data['default/Todo']).toEqual(expectedPositional);
  });

  it('edge-aware delete: deleting a Todo nulls the Tag.todoId after the sweep runs', async () => {
    // Create todo t1.
    await server.inject({
      method: 'POST',
      path: '/substrate/v1/mutate',
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(
        JSON.stringify({
          'default/createTodo': { params: { id: 't1', title: 'parent', done: false } }
        })
      )
    });
    // Create tag tag1 referencing t1 via its crossRef field (set_null policy).
    await server.inject({
      method: 'POST',
      path: '/substrate/v1/mutate',
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(
        JSON.stringify({
          'default/createTag': { params: { id: 'tag1', label: 'blue', todoId: 't1' } }
        })
      )
    });

    // Sanity: the autoCRUD create wrapper should have emitted a live edge.
    const edgesPre = await composed.edges.findEdgesTo({
      ns: 'default',
      type: 'Todo',
      id: 't1'
    });
    expect(edgesPre).toHaveLength(1);
    expect(edgesPre[0]?.policy).toBe('set_null');

    // Delete t1.
    const del = await server.inject({
      method: 'POST',
      path: '/substrate/v1/mutate',
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(JSON.stringify({ 'default/deleteTodo': { params: { id: 't1' } } }))
    });
    expect(del.status).toBe(200);
    const delEnv = jsonBody<PackEnvelope>(del);
    expect(delEnv.data['default/deleteTodo']).toEqual({ id: 't1', deleted: true });

    // Before sweep: Tag's todoId is still 't1' — Phase 2 is sweep-driven, not
    // synchronous.
    const beforeSweep = await server.inject({
      method: 'POST',
      path: '/substrate/v1/query',
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(JSON.stringify({ 'default/getTag': { params: { id: 'tag1' } } }))
    });
    const tagBefore = jsonBody<PackEnvelope>(beforeSweep).data['default/getTag'] as {
      id: string;
      todoId: unknown;
    };
    expect(tagBefore.todoId).toBe('t1');

    // Drive one sweep cycle; set_null policy nulls the source field + tombstones the edge.
    await composed.runSweepNow();

    const afterSweep = await server.inject({
      method: 'POST',
      path: '/substrate/v1/query',
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(JSON.stringify({ 'default/getTag': { params: { id: 'tag1' } } }))
    });
    const tagAfter = jsonBody<PackEnvelope>(afterSweep).data['default/getTag'] as {
      id: string;
      todoId: unknown;
    };
    expect(tagAfter.id).toBe('tag1');
    expect(tagAfter.todoId).toBeNull();

    // Edge is tombstoned.
    const edgesPost = await composed.edges.findEdgesTo({
      ns: 'default',
      type: 'Todo',
      id: 't1'
    });
    expect(edgesPost).toHaveLength(0);
  });

  // --------------------------------------------------------------------
  // §5.2 filter contract integration coverage
  // --------------------------------------------------------------------

  it('Todo where { done: { eq: false } } returns only open todos', async () => {
    await server.inject({
      method: 'POST',
      path: '/substrate/v1/mutate',
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(
        JSON.stringify({
          'default/createTodo': { params: { id: 'a', title: 'open-a', done: false } }
        })
      )
    });
    await server.inject({
      method: 'POST',
      path: '/substrate/v1/mutate',
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(
        JSON.stringify({
          'default/createTodo': { params: { id: 'b', title: 'done-b', done: true } }
        })
      )
    });
    const res = await server.inject({
      method: 'POST',
      path: '/substrate/v1/query',
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(
        JSON.stringify({
          'default/Todo': {
            params: { where: { done: { eq: false } } },
            fields: { id: true, done: true }
          }
        })
      )
    });
    const env = jsonBody<PackEnvelope>(res);
    const rows = env.data['default/Todo'] as Array<{ id: string; done: boolean }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe('a');
  });

  it('Todo orderBy createdAt desc returns rows in descending order', async () => {
    for (let i = 1; i <= 4; i++) {
      await server.inject({
        method: 'POST',
        path: '/substrate/v1/mutate',
        headers: { 'content-type': 'application/json' },
        body: Buffer.from(
          JSON.stringify({
            'default/createTodo': {
              params: {
                id: `t${i}`,
                title: `t${i}`,
                done: false
              }
            }
          })
        )
      });
      // Server-set createdAt: delay so ctx.now advances between rows.
      await new Promise<void>((resolve) => setTimeout(resolve, 2));
    }
    const res = await server.inject({
      method: 'POST',
      path: '/substrate/v1/query',
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(
        JSON.stringify({
          'default/Todo': {
            params: { orderBy: [{ createdAt: 'desc' }] },
            fields: { id: true }
          }
        })
      )
    });
    const env = jsonBody<PackEnvelope>(res);
    const rows = env.data['default/Todo'] as Array<{ id: string }>;
    expect(rows.map((r) => r.id)).toEqual(['t4', 't3', 't2', 't1']);
  });

  it('Todo pagination: limit + cursor walks the full set without dupes', async () => {
    for (let i = 1; i <= 8; i++) {
      await server.inject({
        method: 'POST',
        path: '/substrate/v1/mutate',
        headers: { 'content-type': 'application/json' },
        body: Buffer.from(
          JSON.stringify({
            'default/createTodo': {
              params: {
                id: `t${String(i).padStart(2, '0')}`,
                title: `t${i}`,
                done: false
              }
            }
          })
        )
      });
      // Server-set createdAt: delay so ctx.now advances between rows.
      await new Promise<void>((resolve) => setTimeout(resolve, 2));
    }

    const seen = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < 3; page++) {
      const res = await server.inject({
        method: 'POST',
        path: '/substrate/v1/query',
        headers: { 'content-type': 'application/json' },
        body: Buffer.from(
          JSON.stringify({
            'default/Todo': {
              params: {
                orderBy: [{ createdAt: 'asc' }],
                limit: 3,
                ...(cursor !== undefined ? { cursor } : {})
              },
              fields: { id: true }
            }
          })
        )
      });
      const env = jsonBody<PackEnvelope>(res);
      const rows = env.data['default/Todo'] as Array<{ id: string }>;
      for (const r of rows) {
        expect(seen.has(r.id)).toBe(false);
        seen.add(r.id);
      }
      const pg = env._pagination?.['default/Todo'];
      if (!pg?.hasMore) break;
      cursor = pg?.nextCursor;
    }
    expect(seen.size).toBe(8);
  });

  it('unknown field in where returns envelope error with code unknown_field', async () => {
    const res = await server.inject({
      method: 'POST',
      path: '/substrate/v1/query',
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(
        JSON.stringify({
          'default/Todo': { params: { where: { ghost: { eq: 'x' } } }, fields: { id: true } }
        })
      )
    });
    const env = jsonBody<PackEnvelope>(res);
    expect(env.errors?.[0]?.code).toBe('unknown_field');
  });

  it('unindexed field in where without _allowTableScan is rejected', async () => {
    const res = await server.inject({
      method: 'POST',
      path: '/substrate/v1/query',
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(
        JSON.stringify({
          'default/Todo': {
            params: { where: { priority: { eq: 5 } } },
            fields: { id: true }
          }
        })
      )
    });
    const env = jsonBody<PackEnvelope>(res);
    expect(env.errors?.[0]?.code).toBe('unindexed_field');
  });

  it('unindexed field in where is allowed when _allowTableScan: true', async () => {
    await server.inject({
      method: 'POST',
      path: '/substrate/v1/mutate',
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(
        JSON.stringify({
          'default/createTodo': {
            params: { id: 'pri', title: 'p', done: false, priority: 5 }
          }
        })
      )
    });
    const res = await server.inject({
      method: 'POST',
      path: '/substrate/v1/query',
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(
        JSON.stringify({
          'default/Todo': {
            params: { where: { priority: { eq: 5 } }, _allowTableScan: true },
            fields: { id: true, priority: true }
          }
        })
      )
    });
    const env = jsonBody<PackEnvelope>(res);
    expect(env.errors).toBeUndefined();
    const rows = env.data['default/Todo'] as Array<{ id: string }>;
    expect(rows.map((r) => r.id)).toEqual(['pri']);
  });

  it('updateTodo updates a field and getTodo reflects it', async () => {
    await server.inject({
      method: 'POST',
      path: '/substrate/v1/mutate',
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(
        JSON.stringify({
          'default/createTodo': {
            params: { id: 'u1', title: 'orig', done: false }
          }
        })
      )
    });
    const up = await server.inject({
      method: 'POST',
      path: '/substrate/v1/mutate',
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(
        JSON.stringify({
          'default/updateTodo': {
            params: { id: 'u1', title: 'new' },
            fields: { id: true, title: true }
          }
        })
      )
    });
    const upEnv = jsonBody<PackEnvelope>(up);
    expect(upEnv.data['default/updateTodo']).toMatchObject({ id: 'u1', title: 'new' });

    const got = await server.inject({
      method: 'POST',
      path: '/substrate/v1/query',
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(JSON.stringify({ 'default/getTodo': { params: { id: 'u1' } } }))
    });
    const gotEnv = jsonBody<PackEnvelope>(got);
    expect(gotEnv.data['default/getTodo']).toMatchObject({ id: 'u1', title: 'new' });
  });

  it('restrict edge blocks deleteTodo; row stays live, restrict_violation surfaces in envelope', async () => {
    // Create todo t1 — plain autoCRUD create.
    await server.inject({
      method: 'POST',
      path: '/substrate/v1/mutate',
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(
        JSON.stringify({
          'default/createTodo': { params: { id: 't1', title: 'pinned', done: false } }
        })
      )
    });
    // Hand-write a restrict edge pointing at t1 via the exposed edges store.
    // Registering a second type just to flip one policy would sprawl the
    // fixture; the autoCRUD create path doesn't yet take a per-call policy
    // override, and the sweep-side restrict tests already cover the full
    // policy surface. The `from` ref's source row doesn't need to exist for
    // Phase 0 — `canDelete` only inspects live incoming edges.
    await composed.edges.write({
      from: { ns: 'default', type: 'RestrictTag', id: 'rt1' },
      to: { ns: 'default', type: 'Todo', id: 't1' },
      fieldName: 'todoId',
      policy: 'restrict'
    });

    const del = await server.inject({
      method: 'POST',
      path: '/substrate/v1/mutate',
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(JSON.stringify({ 'default/deleteTodo': { params: { id: 't1' } } }))
    });
    expect(del.status).toBe(200);
    const env = jsonBody<PackEnvelope>(del);
    expect(env.errors).toBeDefined();
    expect(env.errors?.[0]?.code).toBe('restrict_violation');

    const got = await server.inject({
      method: 'POST',
      path: '/substrate/v1/query',
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(JSON.stringify({ 'default/getTodo': { params: { id: 't1' } } }))
    });
    const todo = jsonBody<PackEnvelope>(got).data['default/getTodo'] as {
      id: string;
      title: string;
    };
    expect(todo.title).toBe('pinned');
  });

  // --------------------------------------------------------------------
  // §5.13 batched mutate — array-valued op-keys over POST /substrate/v1/mutate
  // --------------------------------------------------------------------

  describe('POST /substrate/v1/mutate batched arrays', () => {
    it('accepts an array of frames under one op-key and returns per-frame results', async () => {
      const res = await server.inject({
        method: 'POST',
        path: '/substrate/v1/mutate',
        headers: { 'content-type': 'application/json' },
        body: Buffer.from(
          JSON.stringify({
            'default/createTodo': [
              { params: { title: 'a', done: false }, fields: { id: true, title: true } },
              { params: { title: 'b', done: false }, fields: { id: true, title: true } },
              { params: { title: 'c', done: false }, fields: { id: true, title: true } }
            ]
          })
        )
      });
      expect(res.status).toBe(200);
      const envelope = jsonBody<PackEnvelope>(res);
      expect(envelope.errors).toBeUndefined();

      const data = envelope.data['default/createTodo'] as Array<{ id: string; title: string }>;
      expect(Array.isArray(data)).toBe(true);
      expect(data.map((d) => d.title)).toEqual(['a', 'b', 'c']);
      expect(envelope.shapes['default/createTodo']).toEqual(['single', 'single', 'single']);

      // All three rows are visible via a follow-up list query.
      const listRes = await server.inject({
        method: 'POST',
        path: '/substrate/v1/query',
        headers: { 'content-type': 'application/json' },
        body: Buffer.from(
          JSON.stringify({
            'default/Todo': { params: {}, fields: { id: true, title: true } }
          })
        )
      });
      const list = jsonBody<PackEnvelope>(listRes);
      const rows = list.data['default/Todo'] as Array<{ title: string }>;
      expect(rows).toHaveLength(3);
    });

    it('rejects an empty array with `empty_frame_array`', async () => {
      const res = await server.inject({
        method: 'POST',
        path: '/substrate/v1/mutate',
        headers: { 'content-type': 'application/json' },
        body: Buffer.from(JSON.stringify({ 'default/createTodo': [] }))
      });
      expect(res.status).toBe(200);
      const envelope = jsonBody<PackEnvelope>(res);
      const err = envelope.errors?.[0];
      expect(err?.code).toBe('empty_frame_array');
      expect(err?.path).toEqual(['default/createTodo']);
    });

    it('accepts a mix of single-frame and array-frame op-keys in one request', async () => {
      const res = await server.inject({
        method: 'POST',
        path: '/substrate/v1/mutate',
        headers: { 'content-type': 'application/json' },
        body: Buffer.from(
          JSON.stringify({
            'default/createTodo': [
              { params: { title: 'arr-1', done: false }, fields: { id: true } },
              { params: { title: 'arr-2', done: false }, fields: { id: true } }
            ],
            'default/createTag': {
              params: { label: 'single-tag' },
              fields: { id: true }
            }
          })
        )
      });
      expect(res.status).toBe(200);
      const envelope = jsonBody<PackEnvelope>(res);
      expect(envelope.errors).toBeUndefined();

      expect(Array.isArray(envelope.data['default/createTodo'])).toBe(true);
      expect(envelope.data['default/createTodo']).toHaveLength(2);
      expect(envelope.data['default/createTag']).toMatchObject({});
      expect(envelope.shapes['default/createTodo']).toEqual(['single', 'single']);
      expect(envelope.shapes['default/createTag']).toBe('single');
    });
  });

  // --------------------------------------------------------------------
  // §5.4 subscriptions over the WS endpoint
  // --------------------------------------------------------------------

  describe('GET /substrate/v1/ws subscriptions', () => {
    async function connectJson(): Promise<{
      frames: Array<WsResponseFrame>;
      send: (req: unknown) => void;
      close: () => void;
    }> {
      const client = server.connectWebsocket('/substrate/v1/ws');
      const frames: Array<WsResponseFrame> = [];
      client.onMessage((buf) => {
        frames.push(JSON.parse(buf.toString('utf8')) as WsResponseFrame);
      });
      // MemorySubstrateServer dispatches the handler on a microtask so caller
      // listeners register first. Flush a microtask so the handler's own
      // listeners are live before we start sending.
      await Promise.resolve();
      return {
        frames,
        send: (req) => client.send(JSON.stringify(req)),
        close: () => client.close()
      };
    }

    async function waitFor(predicate: () => boolean, timeoutMs = 500): Promise<void> {
      const deadline = Date.now() + timeoutMs;
      while (!predicate()) {
        if (Date.now() > deadline) throw new Error('timed out waiting for condition');
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
      }
    }

    async function mutateHttp(frame: Record<string, unknown>): Promise<SubstrateResponse> {
      return server.inject({
        method: 'POST',
        path: '/substrate/v1/mutate',
        headers: { 'content-type': 'application/json' },
        body: Buffer.from(JSON.stringify(frame))
      });
    }

    it('subscribe → snapshot → add → update → remove on a Todo feed', async () => {
      const { frames, send, close } = await connectJson();
      send({
        id: 'sub-1',
        op: 'subscribe',
        frame: {
          'default/Todo': { params: {}, fields: { id: true, title: true, done: true } }
        }
      });
      await waitFor(() => frames.length >= 1);
      expect(frames[0]?.kind).toBe('snapshot');
      expect((frames[0]!.data as Record<string, unknown>)['default/Todo']).toEqual([]);

      await mutateHttp({
        'default/createTodo': { params: { id: 't1', title: 'one', done: false } }
      });
      await waitFor(() => frames.length >= 2);
      expect(frames[1]?.kind).toBe('add');
      const added = (frames[1]!.data as Record<string, unknown>)['default/Todo'] as {
        id: string;
        title: string;
      };
      expect(added.id).toBe('t1');

      await mutateHttp({
        'default/updateTodo': { params: { id: 't1', title: 'renamed' } }
      });
      await waitFor(() => frames.length >= 3);
      expect(frames[2]?.kind).toBe('update');

      await mutateHttp({ 'default/deleteTodo': { params: { id: 't1' } } });
      await waitFor(() => frames.length >= 4);
      expect(frames[3]?.kind).toBe('remove');
      expect(frames[3]?.removedId).toBe('t1');

      send({ id: 'sub-1', op: 'cancel' });
      await waitFor(() => frames.length >= 5);
      expect(frames[4]?.kind).toBe('end');
      expect(frames[4]?.final).toBe(true);

      // After cancel, further mutations produce no frames.
      await mutateHttp({
        'default/createTodo': { params: { id: 't2', title: 'post-cancel' } }
      });
      await new Promise<void>((r) => setImmediate(r));
      expect(frames).toHaveLength(5);

      close();
    });

    it('filtered subscription: where { done: { eq: false } } only fires on matching rows', async () => {
      const { frames, send } = await connectJson();
      send({
        id: 'sub-open',
        op: 'subscribe',
        frame: {
          'default/Todo': {
            params: { where: { done: { eq: false } } },
            fields: { id: true, title: true, done: true }
          }
        }
      });
      await waitFor(() => frames.length >= 1); // snapshot

      // A done:true Todo should produce nothing.
      await mutateHttp({
        'default/createTodo': { params: { id: 'done1', title: 'x', done: true } }
      });
      await new Promise<void>((r) => setImmediate(r));
      expect(frames).toHaveLength(1);

      // A done:false Todo should produce an add.
      await mutateHttp({
        'default/createTodo': { params: { id: 'open1', title: 'y', done: false } }
      });
      await waitFor(() => frames.length >= 2);
      expect(frames[1]?.kind).toBe('add');

      // Updating the open Todo to done:true should produce remove.
      await mutateHttp({
        'default/updateTodo': { params: { id: 'open1', done: true } }
      });
      await waitFor(() => frames.length >= 3);
      expect(frames[2]?.kind).toBe('remove');
      expect(frames[2]?.removedId).toBe('open1');
    });

    it('subscribing to an unknown name emits an error frame', async () => {
      const { frames, send } = await connectJson();
      send({
        id: 'bad',
        op: 'subscribe',
        frame: { 'default/Nope': { params: {}, fields: {} } }
      });
      await waitFor(() => frames.length >= 1);
      expect(frames[0]?.kind).toBe('error');
      expect(frames[0]?.errors?.[0]?.code).toBe('unknown_name');
    });

    // §5.5 — streaming integration coverage.

    it('streamTodos yields one chunk per row then a final end frame', async () => {
      // Seed 3 todos so the stream has content to yield.
      for (let i = 1; i <= 3; i++) {
        await mutateHttp({
          'default/createTodo': { params: { id: `s${i}`, title: `row-${i}`, done: false } }
        });
      }
      const { frames, send } = await connectJson();
      send({
        id: 'str-happy',
        op: 'stream',
        frame: {
          'default/streamTodos': { params: {}, fields: { id: true, title: true } }
        }
      });
      await waitFor(() => frames.some((f) => f.kind === 'end'), 2000);
      const chunks = frames.filter((f) => f.kind === 'chunk');
      expect(chunks).toHaveLength(3);
      expect(chunks.map((c) => c.sequence)).toEqual([0, 1, 2]);
      for (const c of chunks) {
        expect(c.shapes).toEqual({ 'default/streamTodos': 'single' });
      }
      const end = frames[frames.length - 1];
      expect(end?.kind).toBe('end');
      expect(end?.final).toBe(true);
    });

    it('cancel mid-stream produces end with cancelled meta; no further chunks', async () => {
      for (let i = 1; i <= 5; i++) {
        await mutateHttp({
          'default/createTodo': { params: { id: `c${i}`, title: `cancel-${i}`, done: false } }
        });
      }
      const { frames, send } = await connectJson();
      send({
        id: 'str-cancel',
        op: 'stream',
        frame: { 'default/streamTodos': { params: {}, fields: { id: true } } }
      });
      // Wait for at least one chunk to arrive — the 1ms inter-chunk delay in
      // the demo resolver opens a deterministic window to cancel.
      await waitFor(() => frames.some((f) => f.kind === 'chunk'), 2000);
      send({ id: 'str-cancel', op: 'cancel' });
      // Wait for the engine's terminal end frame (the one carrying
      // _meta.cancelled). The route also emits a plain `end` on cancel, so
      // we specifically wait for the engine-emitted frame rather than just
      // "any end".
      await waitFor(
        () =>
          frames.some(
            (f) =>
              f.kind === 'end' &&
              (f as unknown as { _meta?: { cancelled?: boolean } })._meta?.cancelled === true
          ),
        2000
      );
      // Cancellation can race chunk emission; ensure we got fewer than the
      // full set and saw the cancelled marker.
      expect(frames.filter((f) => f.kind === 'chunk').length).toBeLessThan(5);
      const cancelled = frames.find(
        (f) =>
          f.kind === 'end' &&
          (f as unknown as { _meta?: { cancelled?: boolean } })._meta?.cancelled === true
      );
      expect(cancelled).toBeDefined();
      expect(cancelled?.final).toBe(true);
    });

    it('multi-key stream frame → stream_multi_key error + end', async () => {
      const { frames, send } = await connectJson();
      send({
        id: 'str-multi',
        op: 'stream',
        frame: {
          'default/streamTodos': { params: {}, fields: { id: true } },
          'default/Todo': { params: {}, fields: { id: true } }
        }
      });
      await waitFor(() => frames.some((f) => f.kind === 'end'));
      const err = frames.find((f) => f.kind === 'error');
      expect(err?.errors?.[0]?.code).toBe('stream_multi_key');
    });

    it('stream against a non-iterable resolver → not_streamable error', async () => {
      // `default/Todo` is the autoCRUD list resolver — returns a ReadResult,
      // not an async iterable.
      const { frames, send } = await connectJson();
      send({
        id: 'str-plain',
        op: 'stream',
        frame: { 'default/Todo': { params: {}, fields: { id: true } } }
      });
      await waitFor(() => frames.some((f) => f.kind === 'end'));
      const err = frames.find((f) => f.kind === 'error');
      expect(err?.errors?.[0]?.code).toBe('not_streamable');
    });

    it('streaming over substrate-pack subprotocol: chunk data is positionally encoded', async () => {
      await mutateHttp({
        'default/createTodo': { params: { id: 'pk1', title: 'pack-stream', done: false } }
      });
      const client = server.connectWebsocket('/substrate/v1/ws', {
        'sec-websocket-protocol': WS_SUBPROTOCOL_SUBSTRATE_PACK
      });
      const frames: Array<WsResponseFrame> = [];
      client.onMessage((buf) => {
        frames.push(unpackFrame(buf) as WsResponseFrame);
      });
      await Promise.resolve();

      const fields: FieldInput = { id: true, title: true, done: true };
      client.send(
        packFrame({
          id: 'pack-str',
          op: 'stream',
          frame: { 'default/streamTodos': { params: {}, fields } }
        })
      );
      const deadline = Date.now() + 2000;
      while (!frames.some((f) => f.kind === 'end')) {
        if (Date.now() > deadline) throw new Error('timed out waiting for pack stream end');
        await new Promise<void>((r) => setImmediate(r));
      }
      const chunk = frames.find((f) => f.kind === 'chunk');
      expect(chunk).toBeDefined();
      const rawData = (chunk!.data as Record<string, unknown>)['default/streamTodos'];
      expect(Array.isArray(rawData)).toBe(true); // positional tuple, not named object

      const schemaRes = await server.inject({ method: 'GET', path: '/substrate/v1/schema' });
      const schema = JSON.parse((schemaRes.body as Buffer).toString('utf8')) as Schema;
      const decoded = decodePositional<{ id: string; title: string; done: boolean }>(
        rawData,
        fields,
        schema,
        'Todo',
        { schemas: { default: schema }, currentNs: 'default' }
      );
      expect(decoded.title).toBe('pack-stream');
      client.close();
    });

    it('malformed JSON frame emits an invalid_frame error', async () => {
      const client = server.connectWebsocket('/substrate/v1/ws');
      const frames: Array<WsResponseFrame> = [];
      client.onMessage((buf) => {
        frames.push(JSON.parse(buf.toString('utf8')) as WsResponseFrame);
      });
      await Promise.resolve();
      client.send('{not json}');
      await new Promise<void>((r) => setImmediate(r));
      expect(frames[0]?.kind).toBe('error');
      expect(frames[0]?.errors?.[0]?.code).toBe('invalid_frame');
    });

    it('subprotocol substrate-pack: snapshot `data` decodes positionally via substrate-pack', async () => {
      const client = server.connectWebsocket('/substrate/v1/ws', {
        'sec-websocket-protocol': WS_SUBPROTOCOL_SUBSTRATE_PACK
      });
      const frames: Array<WsResponseFrame> = [];
      client.onMessage((buf) => {
        frames.push(unpackFrame(buf) as WsResponseFrame);
      });
      await Promise.resolve();

      await mutateHttp({
        'default/createTodo': { params: { id: 'p1', title: 'pack', done: false } }
      });

      const fields: FieldInput = { id: true, title: true, done: true };
      client.send(
        packFrame({
          id: 'pack-sub',
          op: 'subscribe',
          frame: { 'default/Todo': { params: {}, fields } }
        })
      );
      await new Promise<void>((r) => {
        // Two setImmediates — the subscribe is async inside the route handler
        // so we need to let the engine's snapshot path resolve before
        // asserting.
        setImmediate(() => setImmediate(r));
      });
      expect(frames.length).toBeGreaterThan(0);
      const snap = frames[0];
      expect(snap?.kind).toBe('snapshot');

      // `data['default/Todo']` under substrate-pack is an array of positional
      // tuples — decode against the schema to get named objects back.
      const schemaRes = await server.inject({ method: 'GET', path: '/substrate/v1/schema' });
      const schema = JSON.parse((schemaRes.body as Buffer).toString('utf8')) as Schema;
      const rawList = (snap!.data as Record<string, unknown>)['default/Todo'];
      expect(Array.isArray(rawList)).toBe(true);
      const first = (rawList as Array<unknown>)[0];
      expect(Array.isArray(first)).toBe(true); // positional tuple

      const decoded = decodePositional<Array<{ id: string; title: string; done: boolean }>>(
        rawList,
        fields,
        schema,
        'Todo',
        { schemas: { default: schema }, currentNs: 'default' }
      );
      expect(decoded[0]?.title).toBe('pack');
    });
  });
});

import { buildContext, type ComposeResult, compose } from '@mnmal-ai/substrate-compose';
import { MemoryDataset } from '@mnmal-ai/substrate-dataset-memory';
import { createNlPlugin } from '@mnmal-ai/substrate-nl';
import { MemorySubstrateServer } from '@mnmal-ai/substrate-server-memory';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mountKernelRoute } from '../../src/_kernel.js';
import {
  createDropNamespaceHandler,
  createDropTypeHandler,
  createMcpServer,
  createMutateHandler,
  createNlHandler,
  createProposeFieldHandler,
  createProposeIndexHandler,
  createProposeTypeHandler,
  createQueryHandler,
  createSchemaHandler,
  payloadSchema,
  type ToolResult
} from '../../src/mcp/server.js';
import { fixturePlugin } from '../_fixtures/fixture-plugin.js';

/**
 * Mount the NL plugin's kernel route on a composed test server. NL is a
 * plugin, not core; the `ask` MCP tool is a thin HTTP proxy, so it only
 * does anything against a server with the plugin installed.
 */
function mountNlPlugin(server: MemorySubstrateServer, composed: ComposeResult): void {
  const plugin = createNlPlugin({
    engine: {
      federatedSchema: () => composed.engine.federatedSchema(),
      operators: () => undefined,
      query: async (frame, req) =>
        composed.engine.query({
          frame,
          ctx: buildContext(req, new Set<string>()),
          ...(req.signal !== undefined ? { signal: req.signal } : {})
        })
    }
  });
  for (const claim of plugin.kernelRoutes ?? []) mountKernelRoute(server, claim, null);
}

const TEST_ENDPOINT = 'http://test.local';

function injectAsFetch(server: MemorySubstrateServer): typeof fetch {
  return async (input, init) => {
    const urlStr =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const u = new URL(urlStr);
    const headers: Record<string, string> = {};
    const rawHeaders = init?.headers;
    if (rawHeaders !== undefined) {
      if (rawHeaders instanceof Headers) {
        rawHeaders.forEach((v, k) => {
          headers[k.toLowerCase()] = v;
        });
      } else if (Array.isArray(rawHeaders)) {
        for (const [k, v] of rawHeaders) headers[k.toLowerCase()] = v;
      } else {
        for (const [k, v] of Object.entries(rawHeaders as Record<string, string>)) {
          headers[k.toLowerCase()] = v;
        }
      }
    }
    const raw = init?.body;
    let body: Buffer | null = null;
    if (typeof raw === 'string') body = Buffer.from(raw);
    else if (raw instanceof Uint8Array) body = Buffer.from(raw);
    const res = await server.inject({
      method: (init?.method ?? 'GET') as 'GET' | 'POST',
      path: u.pathname + u.search,
      headers,
      body
    });
    const resHeaders = new Headers();
    if (res.headers !== undefined) {
      for (const [k, v] of Object.entries(res.headers)) resHeaders.set(k, v);
    }
    const resBody = res.body;
    let payload: string | Uint8Array | ReadableStream | null = null;
    if (resBody === undefined || resBody === null) payload = null;
    else if (typeof resBody === 'string') payload = resBody;
    else if (Buffer.isBuffer(resBody)) payload = new Uint8Array(resBody);
    else if (resBody instanceof Uint8Array) payload = resBody;
    else payload = resBody;
    return new Response(payload, { status: res.status, headers: resHeaders });
  };
}

function parseToolText(result: ToolResult): unknown {
  const first = result.content[0];
  if (first === undefined) throw new Error('tool result has no content');
  return JSON.parse(first.text);
}

describe('substrate-mcp tool handlers', () => {
  let server: MemorySubstrateServer;
  let dataset: MemoryDataset;
  let composed: ComposeResult;
  let origFetch: typeof fetch;

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
    // Handlers POST/GET to the Substrate HTTP endpoint via the global fetch; route
    // that at the in-memory server (the same shim the NL/drop handler tests use).
    origFetch = globalThis.fetch;
    globalThis.fetch = injectAsFetch(server);
  });

  afterEach(async () => {
    globalThis.fetch = origFetch;
    await composed.stop();
  });

  it('schema handler with no args returns the compact overview', async () => {
    const result = await createSchemaHandler(TEST_ENDPOINT)();
    expect(result.isError).toBeUndefined();
    const parsed = parseToolText(result) as {
      legend: string;
      overview: Record<string, { types: Record<string, string> }>;
    };
    expect(parsed.legend).toContain('field: type');
    expect(typeof parsed.overview.default?.types.Todo).toBe('string');
  });

  it('schema handler with full: true returns the federated schema', async () => {
    const result = await createSchemaHandler(TEST_ENDPOINT)({ full: true });
    const parsed = parseToolText(result) as Record<string, { types: Record<string, unknown> }>;
    expect(parsed.default?.types.Todo).toBeDefined();
  });

  it('tool results are compact JSON, not pretty-printed', async () => {
    // Every tool result is re-read on every later model call, so indentation
    // is paid for once per call for the rest of the session.
    const result = await createSchemaHandler(TEST_ENDPOINT)();
    const text = result.content[0]?.text ?? '';
    expect(text).toBe(JSON.stringify(JSON.parse(text)));
  });

  it('schema handler surfaces transport errors as isError', async () => {
    globalThis.fetch = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    const handler = createSchemaHandler(TEST_ENDPOINT);
    const result = await handler();
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/Error:/);
    expect(result.content[0]?.text).toMatch(/ECONNREFUSED/);
  });

  it('query handler accepts an object payload and posts to /substrate/v1/query', async () => {
    const handler = createQueryHandler(TEST_ENDPOINT);
    const result = await handler({
      payload: {
        'default/Todo': { params: { limit: 5 }, fields: { id: true, title: true } }
      }
    });
    expect(result.isError).toBeUndefined();
    const envelope = parseToolText(result) as {
      shapes: Record<string, string>;
      data: Record<string, unknown>;
    };
    expect(envelope.shapes['default/Todo']).toBe('list');
    expect(envelope.data['default/Todo']).toEqual([]);
  });

  it('mutate handler creates an entity and the new row comes back on query', async () => {
    const mutate = createMutateHandler(TEST_ENDPOINT);
    const created = await mutate({
      payload: {
        'default/createTodo': {
          params: { title: 'via mcp', done: false },
          fields: { id: true, title: true }
        }
      }
    });
    expect(created.isError).toBeUndefined();
    const createdEnv = parseToolText(created) as {
      data: Record<string, { id: string; title: string }>;
    };
    expect(createdEnv.data['default/createTodo']?.title).toBe('via mcp');

    const query = createQueryHandler(TEST_ENDPOINT);
    const listed = await query({
      payload: { 'default/Todo': { params: {}, fields: { id: true, title: true } } }
    });
    const listedEnv = parseToolText(listed) as {
      data: Record<string, Array<{ title: string }>>;
    };
    expect(listedEnv.data['default/Todo']?.map((r) => r.title)).toContain('via mcp');
  });

  it('query handler surfaces transport throw as isError result', async () => {
    globalThis.fetch = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    const handler = createQueryHandler(TEST_ENDPOINT);
    const result = await handler({
      payload: { 'default/Todo': { params: {}, fields: { id: true } } }
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/ECONNREFUSED/);
  });

  it('mutate handler passes a 200 envelope with envelope-level errors through (not isError)', async () => {
    const handler = createMutateHandler(TEST_ENDPOINT);
    const result = await handler({
      payload: { unqualified: { params: {}, fields: {} } }
    });
    // The server accepts but the envelope carries errors. We want the raw
    // envelope to pass through the handler; so isError must NOT fire on a 200
    // with envelope-level errors — those are surfaced inside the JSON text.
    expect(result.isError).toBeUndefined();
    const env = parseToolText(result) as { errors?: Array<{ code?: string }> };
    expect(env.errors?.[0]?.code).toBe('unqualified_key');
  });

  it('payloadSchema accepts a pre-parsed object unchanged', () => {
    const schema = payloadSchema('demo');
    const parsed = schema.parse({
      'default/Todo': { params: { limit: 3 }, fields: { id: true } }
    });
    expect(parsed).toEqual({
      'default/Todo': { params: { limit: 3 }, fields: { id: true } }
    });
  });

  it('payloadSchema parses a JSON string into an object', () => {
    const schema = payloadSchema('demo');
    const src = JSON.stringify({
      'default/Todo': { params: { limit: 3 }, fields: { id: true } }
    });
    const parsed = schema.parse(src);
    expect(parsed).toEqual({
      'default/Todo': { params: { limit: 3 }, fields: { id: true } }
    });
  });

  it('payloadSchema rejects malformed JSON strings with a helpful issue', () => {
    const schema = payloadSchema('demo');
    const result = schema.safeParse('{not json}');
    expect(result.success).toBe(false);
    if (result.success) return;
    const messages = result.error.issues.map((i) => i.message);
    expect(messages.join(' ')).toMatch(/valid JSON/);
  });

  it('passing a JSON-string payload through handler after schema parse round-trips', async () => {
    const schema = payloadSchema('demo');
    const jsonStr = JSON.stringify({
      'default/Todo': { params: { limit: 3 }, fields: { id: true } }
    });
    const parsed = schema.parse(jsonStr) as Record<string, unknown>;
    const handler = createQueryHandler(TEST_ENDPOINT);
    const result = await handler({ payload: parsed });
    expect(result.isError).toBeUndefined();
  });
});

/**
 * Propose tool handler coverage. End-to-end correctness of the server-side
 * propose resolver is exercised by the substrate-proposals plugin's own suite.
 * These tests verify only the MCP handler's own
 * responsibilities: (a) construct the correct qualified-frame mutate payload
 * from tool args, (b) pass through the envelope, (c) surface transport
 * errors as isError.
 *
 * We capture the POST body the handler sends to /substrate/v1/mutate (via a fetch
 * mock) rather than routing through a real server, because the propose
 * capability gate needs JWT auth setup — overkill for what this layer proves.
 */
describe('propose_type / propose_field handlers', () => {
  interface CapturedMutate {
    frame: Record<string, unknown> | undefined;
  }

  let origFetch: typeof fetch;
  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  /** Patch global fetch to capture the POSTed mutate frame + return `response`. */
  function captureMutateFetch(response: Record<string, unknown>): { captured: CapturedMutate } {
    const captured: CapturedMutate = { frame: undefined };
    origFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
      captured.frame = JSON.parse(init?.body ?? '{}') as Record<string, unknown>;
      return new Response(JSON.stringify(response), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }) as unknown as typeof fetch;
    return { captured };
  }

  it('propose_type builds a home/propose_type mutation frame', async () => {
    const { captured } = captureMutateFetch({
      shapes: { 'home/propose_type': 'single' },
      data: {
        'home/propose_type': {
          id: 'abc',
          typeName: 'Dress',
          applied: true,
          appliedAt: '2026-04-22T00:00:00Z'
        }
      }
    });

    const handler = createProposeTypeHandler(TEST_ENDPOINT);
    const result = await handler({
      namespace: 'home',
      typeName: 'Dress',
      fields: {
        name: { kind: 'scalar', type: 'string' },
        owner: { kind: 'crossRef', ns: 'household', type: 'Person', onDelete: 'set_null' }
      },
      proposedReason: 'unit test'
    });

    expect(result.isError).toBeUndefined();
    const frame = captured.frame?.['home/propose_type'] as {
      params: Record<string, unknown>;
      fields: Record<string, unknown>;
    };
    expect(frame.params.typeName).toBe('Dress');
    expect(frame.params).not.toHaveProperty('proposedBy');
    expect(frame.params.proposedReason).toBe('unit test');
    expect(frame.params.fields).toMatchObject({
      name: { kind: 'scalar', type: 'string' }
    });
    expect(frame.fields).toMatchObject({ id: true, typeName: true, applied: true });

    const env = parseToolText(result) as {
      data: Record<string, { applied: boolean; typeName: string }>;
    };
    expect(env.data['home/propose_type']?.applied).toBe(true);
  });

  it('propose_field builds a home/propose_field mutation frame', async () => {
    const { captured } = captureMutateFetch({
      shapes: { 'home/propose_field': 'single' },
      data: {
        'home/propose_field': {
          id: 'fid',
          targetType: 'Dress',
          fieldName: 'color',
          applied: true,
          appliedAt: '2026-04-22T00:00:00Z'
        }
      }
    });

    const handler = createProposeFieldHandler(TEST_ENDPOINT);
    const result = await handler({
      namespace: 'home',
      targetType: 'Dress',
      fieldName: 'color',
      fieldSpec: { kind: 'scalar', type: 'string' },
      proposedReason: 'add color'
    });

    expect(result.isError).toBeUndefined();
    const frame = captured.frame?.['home/propose_field'] as {
      params: Record<string, unknown>;
    };
    expect(frame.params.targetType).toBe('Dress');
    expect(frame.params.fieldName).toBe('color');
    expect(frame.params.fieldSpec).toEqual({ kind: 'scalar', type: 'string' });
    expect(frame.params).not.toHaveProperty('proposedBy');
  });

  it('propose_index builds a _system_proposals/propose_index frame naming the target', async () => {
    const { captured } = captureMutateFetch({ data: {} });
    const result = await createProposeIndexHandler(TEST_ENDPOINT)({
      namespace: 'home',
      type: 'Dress',
      action: 'remove',
      indexName: 'home_dress_x_0123abcd_idx',
      reason: 'unused',
      recommendationId: undefined
    });
    expect(result.isError).toBeUndefined();
    const frame = captured.frame?.['_system_proposals/propose_index'] as {
      params: Record<string, unknown>;
    };
    expect(frame.params).toEqual({
      namespace: 'home',
      type: 'Dress',
      action: 'remove',
      indexName: 'home_dress_x_0123abcd_idx',
      reason: 'unused'
    });
  });

  it('propose_type surfaces transport errors as isError', async () => {
    origFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    const handler = createProposeTypeHandler(TEST_ENDPOINT);
    const result = await handler({
      namespace: 'home',
      typeName: 'Dress',
      fields: { name: { kind: 'scalar', type: 'string' } },
      proposedReason: 'r'
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/ECONNREFUSED/);
  });
});

/**
 * `ask` takes `{ namespace, question, project? }` and proxies POST
 * /substrate/v1/nl, returning the route's `{ outcome, trail }` JSON.
 *
 * createNlHandler takes an endpoint string and posts directly to /substrate/v1/nl,
 * so a fetch shim tests routing/error paths without network.
 */
describe('ask handler', () => {
  let server: MemorySubstrateServer;
  let dataset: MemoryDataset;
  let composed: ComposeResult;

  async function boot(withNl: boolean): Promise<void> {
    server = new MemorySubstrateServer();
    dataset = new MemoryDataset({ namespace: 'default' });
    composed = await compose({
      // Auth is off, so the deployment must declare who it writes as.
      systemActor: 'test',
      server,
      dataset,
      coordinators: [fixturePlugin]
    });
    if (withNl) mountNlPlugin(server, composed);
    await server.start();
  }

  afterEach(async () => {
    await composed.stop();
  });

  it('forwards { namespace, question } and returns { outcome, trail } as JSON', async () => {
    await boot(true);
    const origFetch = globalThis.fetch;
    globalThis.fetch = injectAsFetch(server);
    try {
      const handler = createNlHandler(TEST_ENDPOINT);
      const result = await handler({ namespace: 'default', question: 'todos' });
      expect(result.isError).not.toBe(true);
      const parsed = parseToolText(result) as { outcome: { kind: string }; trail: unknown[] };
      expect(parsed.outcome.kind).toBe('rows');
      expect(Array.isArray(parsed.trail)).toBe(true);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('surfaces 404 as an isError result when the NL route is not registered', async () => {
    await boot(false);
    const origFetch = globalThis.fetch;
    globalThis.fetch = injectAsFetch(server);
    try {
      const handler = createNlHandler(TEST_ENDPOINT);
      const result = await handler({ namespace: 'default', question: 'anything' });
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toMatch(/404/);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('surfaces network failure as isError with the failing URL', async () => {
    await boot(false);
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    try {
      const handler = createNlHandler(TEST_ENDPOINT);
      const result = await handler({ namespace: 'default', question: 'q' });
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toMatch(/\/substrate\/v1\/nl/);
      expect(result.content[0]?.text).toMatch(/ECONNREFUSED/);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('the registered input schema accepts an optional type and forwards it', async () => {
    await boot(false);
    const origFetch = globalThis.fetch;
    const posted: unknown[] = [];
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      posted.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ outcome: null, trail: [] }), {
        headers: { 'content-type': 'application/json' }
      });
    }) as unknown as typeof fetch;
    const mcp = createMcpServer('http://127.0.0.1:1', { tools: 'ask' });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await mcp.connect(serverSide);
    const client = new Client({ name: 'nl-type-test', version: '0.0.0' });
    await client.connect(clientSide);
    try {
      const listed = await client.listTools();
      const props = (listed.tools[0]?.inputSchema.properties ?? {}) as Record<
        string,
        { description?: string }
      >;
      expect(props.type?.description).toBe(
        'force the reading to this type (resubmit a clarify option)'
      );
      await client.callTool({
        name: 'ask',
        arguments: { namespace: 'default', question: 'open', type: 'Todo' }
      });
      expect(posted).toEqual([{ namespace: 'default', question: 'open', type: 'Todo' }]);
    } finally {
      globalThis.fetch = origFetch;
      await client.close();
      await mcp.close();
    }
  });

  it('the registered input schema rejects a { prompt }-only call', async () => {
    await boot(false); // only so afterEach has a composed server to stop
    const mcp = createMcpServer('http://127.0.0.1:1', { tools: 'ask' });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await mcp.connect(serverSide);
    const client = new Client({ name: 'nl-schema-test', version: '0.0.0' });
    await client.connect(clientSide);
    try {
      let rejected = false;
      try {
        const res = await client.callTool({
          name: 'ask',
          arguments: { prompt: 'list todos' }
        });
        rejected = res.isError === true;
      } catch {
        rejected = true;
      }
      expect(rejected).toBe(true);
    } finally {
      await client.close();
      await mcp.close();
    }
  });
});

/**
 * Drop-namespace / drop-type handler coverage. These handlers post to admin
 * HTTP routes, not qualified frame endpoints, so they use the same raw-fetch
 * pattern as createNlHandler. Tests verify:
 *   (a) successful 200 response is returned as okResult JSON
 *   (b) non-2xx responses surface as isError with the status
 *   (c) network failure surfaces as isError with the failing URL
 */
describe('drop_namespace / drop_type handlers', () => {
  function makeFetch(status: number, body: unknown): typeof fetch {
    return (async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' }
      })) as unknown as typeof fetch;
  }

  function makeFetchThrow(message: string): typeof fetch {
    return (async () => {
      throw new Error(message);
    }) as unknown as typeof fetch;
  }

  it('drop-namespace: 200 response is returned as okResult JSON', async () => {
    const payload = { droppedRows: 5, droppedShortIds: 5, droppedEdges: 0, dryRun: false };
    const origFetch = globalThis.fetch;
    globalThis.fetch = makeFetch(200, payload);
    try {
      const handler = createDropNamespaceHandler(TEST_ENDPOINT);
      const result = await handler({ namespace: 'test', confirm: 'test' });
      expect(result.isError).toBeUndefined();
      const parsed = parseToolText(result) as typeof payload;
      expect(parsed.droppedRows).toBe(5);
      expect(parsed.dryRun).toBe(false);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('drop-namespace: 409 (edge conflict) surfaces as isError', async () => {
    const errBody = { code: 'has_edges', message: 'namespace has referencing edges' };
    const origFetch = globalThis.fetch;
    globalThis.fetch = makeFetch(409, errBody);
    try {
      const handler = createDropNamespaceHandler(TEST_ENDPOINT);
      const result = await handler({ namespace: 'test', confirm: 'test' });
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toMatch(/409/);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('drop-namespace: network failure surfaces as isError with the failing URL', async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = makeFetchThrow('ECONNREFUSED');
    try {
      const handler = createDropNamespaceHandler(TEST_ENDPOINT);
      const result = await handler({ namespace: 'test', confirm: 'test' });
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toMatch(/drop-namespace/);
      expect(result.content[0]?.text).toMatch(/ECONNREFUSED/);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('drop-namespace: dryRun=true passes through and response is returned', async () => {
    const payload = { droppedRows: 3, droppedShortIds: 3, droppedEdges: 0, dryRun: true };
    const origFetch = globalThis.fetch;
    globalThis.fetch = makeFetch(200, payload);
    try {
      const handler = createDropNamespaceHandler(TEST_ENDPOINT);
      const result = await handler({ namespace: 'test', confirm: 'test', dryRun: true });
      expect(result.isError).toBeUndefined();
      const parsed = parseToolText(result) as typeof payload;
      expect(parsed.dryRun).toBe(true);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('drop-type: 200 response is returned as okResult JSON', async () => {
    const payload = { droppedRows: 2, droppedShortIds: 2, droppedEdges: 0, dryRun: false };
    const origFetch = globalThis.fetch;
    globalThis.fetch = makeFetch(200, payload);
    try {
      const handler = createDropTypeHandler(TEST_ENDPOINT);
      const result = await handler({ namespace: 'test', type: 'Todo', confirm: 'test/Todo' });
      expect(result.isError).toBeUndefined();
      const parsed = parseToolText(result) as typeof payload;
      expect(parsed.droppedRows).toBe(2);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('drop-type: 404 (type not found) surfaces as isError', async () => {
    const errBody = { code: 'type_not_found', message: 'no such type' };
    const origFetch = globalThis.fetch;
    globalThis.fetch = makeFetch(404, errBody);
    try {
      const handler = createDropTypeHandler(TEST_ENDPOINT);
      const result = await handler({ namespace: 'test', type: 'Ghost', confirm: 'test/Ghost' });
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toMatch(/404/);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('drop-type: network failure surfaces as isError with the failing URL', async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = makeFetchThrow('ECONNREFUSED');
    try {
      const handler = createDropTypeHandler(TEST_ENDPOINT);
      const result = await handler({ namespace: 'test', type: 'Todo', confirm: 'test/Todo' });
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toMatch(/drop-type/);
      expect(result.content[0]?.text).toMatch(/ECONNREFUSED/);
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});

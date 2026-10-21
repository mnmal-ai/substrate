/**
 * §9.4 cross-server acceptance harness. Protocol neutrality (§2.5) is enforced
 * here, not by code review: the same scenarios run against every reference
 * `SubstrateServer` implementation and must produce byte-identical results for
 * deterministic outputs (schemas, sorted queries, mutation returns).
 *
 * The harness abstracts the two transports behind a tiny adapter interface:
 *   - `MemorySubstrateServer` — zero-socket, `server.inject()` everywhere and
 *     `server.connectWebsocket()` for the WS flows.
 *   - `FastifySubstrateServer` — same `inject()` contract (Fastify exposes it),
 *     but WS requires a real port; the harness starts the server on an
 *     ephemeral port and the adapter dials out via the `ws` package.
 *
 * Scenarios tested per server: schema, list + single + cursor-paginated
 * queries, errors-only envelope, the full mutation lifecycle, edge-aware
 * delete with sweep reconciliation, crossRef onMissing:'reject' enforcement
 * (create + update, no row written on rejection), subscribe
 * (snapshot + add) and streaming (chunks in order + terminal end frame).
 * The streaming scenarios run over BOTH stream transports (WS and SSE) via a
 * `StreamDriver`, so each runs 4× — {memory, fastify} × {ws, sse}.
 * Bridge-federated query and subscribe-with-pushed-update from §9.4 are not
 * covered here.
 */

import { type ComposeResult, compose } from '@mnmal-ai/substrate-compose';
import { MemoryEdgesStore } from '@mnmal-ai/substrate-core';
import { MemoryDataset } from '@mnmal-ai/substrate-dataset-memory';
import { FakeEmbedder } from '@mnmal-ai/substrate-embedder/fake';
import { clearExtensionOperators, registerExtensionOperator } from '@mnmal-ai/substrate-filter';
import {
  type ClusterProvenance,
  createRecallPlugin,
  InMemoryClusterStore,
  InMemoryEmbeddingsStore
} from '@mnmal-ai/substrate-recall';
import { FastifySubstrateServer } from '@mnmal-ai/substrate-server-fastify';
import { MemorySubstrateServer } from '@mnmal-ai/substrate-server-memory';
import type {
  Dataset,
  EdgesStore,
  FilterOperatorDef,
  PackEnvelope,
  Schema,
  SubstrateRequest,
  SubstrateResponse,
  SubstrateServer,
  WsResponseFrame
} from '@mnmal-ai/substrate-types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { fixturePlugin } from './_fixtures/fixture-plugin.js';

// ---------------------------------------------------------------------------
// Adapter layer. A HarnessHandle hides the transport so the per-server
// `describe` block passes the SAME test function to both impls.
// ---------------------------------------------------------------------------

interface WsHandle {
  send(payload: unknown): void;
  onFrame(cb: (frame: WsResponseFrame) => void): void;
  close(): void;
}

/** An open SSE response: status plus the still-flowing body, never buffered. */
interface SseHandle {
  readonly status: number;
  /** Null when the route refused before opening a stream — pre-stream failures are ordinary HTTP. */
  readonly body: ReadableStream<Uint8Array> | null;
}

interface HarnessHandle {
  inject(req: Partial<SubstrateRequest>): Promise<SubstrateResponse>;
  openWebsocket(path: string): Promise<WsHandle>;
  /**
   * POST an SSE stream/subscribe frame and hand back the live body. POST rather
   * than GET because GET is ticket-authenticated (EventSource can set neither a
   * body nor headers) and the ticket buys nothing here — the harness composes
   * without auth, so the POST gate is the identity function.
   */
  openSse(path: string, frame: Record<string, unknown>, signal: AbortSignal): Promise<SseHandle>;
  composed: ComposeResult;
  server: SubstrateServer;
  /**
   * The recall embeddings store backing this harness's `recall/*` virtual
   * namespace. Each harness owns its own store so a fresh seed is isolated per
   * server (the byte-identical recall scenarios seed both servers identically
   * under fixed ids — see seedRecall).
   */
  recallStore: InMemoryEmbeddingsStore;
  /** The deterministic embedder the recall substrate uses (dim RECALL_DIM). */
  recallEmbedder: FakeEmbedder;
  /**
   * The `ClusterStore` backing this harness's `recall/{Cluster,ClusterMember,
   * labelCluster}` virtual-namespace surface (§cluster-frame parity). Seeded
   * directly under fixed ids — see `seedClusters` — rather than via
   * `recall/crystallise`, which is deliberately excluded from this gate (see
   * that section's comment).
   */
  clusters: InMemoryClusterStore;
  teardown(): Promise<void>;
}

function jsonBody<T>(res: SubstrateResponse): T {
  const b = res.body;
  if (Buffer.isBuffer(b)) return JSON.parse(b.toString('utf8')) as T;
  if (typeof b === 'string') return JSON.parse(b) as T;
  if (b instanceof Uint8Array) return JSON.parse(Buffer.from(b).toString('utf8')) as T;
  throw new Error('response body is not parseable JSON');
}

/**
 * An SSE route answers with the transport's `ReadableStream` verbatim; anything
 * else (a JSON error envelope, say) is not a stream and the caller must see
 * that as "no body" rather than a decode failure further downstream.
 */
function asSseBody(body: SubstrateResponse['body']): ReadableStream<Uint8Array> | null {
  return body instanceof ReadableStream ? body : null;
}

function asJsonRequest(
  path: string,
  payload: Record<string, unknown>,
  method: 'POST' | 'GET' = 'POST'
): Partial<SubstrateRequest> {
  return {
    method,
    path,
    headers: { 'content-type': 'application/json' },
    body: Buffer.from(JSON.stringify(payload))
  };
}

// ---------------------------------------------------------------------------
// Recall substrate wiring. Both harnesses boot the SAME recall plugin
// surface so the acceptance gate covers the virtual-namespace `recall/*` frames
// (recall/Hit query + recall/boost mutation) byte-identically across transports.
//
// Each harness owns its own InMemoryEmbeddingsStore + FakeEmbedder; the store's
// datasetFor join is late-bound to the composed dataset registry (main.ts idiom)
// so knnSearch can substratete seeded `default/Memo` bodies.
// ---------------------------------------------------------------------------

/** Embedding dimension for the deterministic recall FakeEmbedder. */
const RECALL_DIM = 8;

interface RecallWiring {
  store: InMemoryEmbeddingsStore;
  embedder: FakeEmbedder;
  plugin: ReturnType<typeof createRecallPlugin>;
  edges: EdgesStore;
  clusters: InMemoryClusterStore;
  /** Bound after compose so the store's datasetFor join resolves. */
  bindDatasets: (datasets: { get: (ns: string) => Dataset | undefined }) => void;
}

function buildRecallWiring(): RecallWiring {
  const datasetRegistryRef: { current: { get: (ns: string) => Dataset | undefined } | null } = {
    current: null
  };
  const store = new InMemoryEmbeddingsStore({
    // Second arg (rowType) intentionally unused — same single-arg form as main.ts.
    datasetFor: (ns) => datasetRegistryRef.current?.get(ns)
  });
  const embedder = new FakeEmbedder({ dimension: RECALL_DIM });
  const edges = new MemoryEdgesStore({ now: () => new Date() });
  // Fresh per harness (own txScopeId); the cluster scenarios seed both
  // servers' stores identically under fixed ids (see seedClusters).
  const clusters = new InMemoryClusterStore();
  // Stands in for a host: the bundled binary wires checkWritePolicy from
  // engine.evaluateWritePolicy, and without it the mutating recall surfaces
  // refuse to write. Allowing here keeps this suite about PARITY rather than
  // about authorisation.
  const plugin = createRecallPlugin({
    store,
    edges,
    embedder,
    clusters,
    checkWritePolicy: () => ({ allow: true })
  });
  return {
    store,
    embedder,
    plugin,
    edges,
    clusters,
    bindDatasets: (datasets) => {
      datasetRegistryRef.current = datasets;
    }
  };
}

async function memoryHarness(): Promise<HarnessHandle> {
  const server = new MemorySubstrateServer();
  const dataset = new MemoryDataset({ namespace: 'default' });
  const recall = buildRecallWiring();
  const composed = await compose({
    // Auth is off, so the deployment must declare who it writes as.
    systemActor: 'test',
    server,
    dataset,
    edges: recall.edges,
    coordinators: [fixturePlugin],
    kernelPlugins: [recall.plugin]
  });
  recall.bindDatasets(composed.datasets);
  await server.start();
  return {
    composed,
    server,
    recallStore: recall.store,
    recallEmbedder: recall.embedder,
    clusters: recall.clusters,
    async inject(req) {
      return server.inject(req);
    },
    async openSse(path, frame, signal) {
      // `inject()` hands back the handler's response object untouched, so the
      // body arrives as the live ReadableStream — no socket needed.
      const res = await server.inject({ ...asJsonRequest(path, frame), signal });
      return { status: res.status, body: asSseBody(res.body) };
    },
    async openWebsocket(path) {
      const client = server.connectWebsocket(path);
      const listeners: Array<(frame: WsResponseFrame) => void> = [];
      client.onMessage((buf) => {
        const frame = JSON.parse(buf.toString('utf8')) as WsResponseFrame;
        for (const cb of listeners.slice()) cb(frame);
      });
      // MemorySubstrateServer dispatches the handler on a microtask so caller
      // listeners register first. Flush before returning.
      await Promise.resolve();
      return {
        send: (payload) => client.send(JSON.stringify(payload)),
        onFrame: (cb) => {
          listeners.push(cb);
        },
        close: () => client.close()
      };
    },
    async teardown() {
      await composed.stop();
    }
  };
}

async function fastifyHarness(): Promise<HarnessHandle> {
  const server = new FastifySubstrateServer();
  const dataset = new MemoryDataset({ namespace: 'default' });
  const recall = buildRecallWiring();
  const composed = await compose({
    // Auth is off, so the deployment must declare who it writes as.
    systemActor: 'test',
    server,
    dataset,
    edges: recall.edges,
    coordinators: [fixturePlugin],
    kernelPlugins: [recall.plugin]
  });
  recall.bindDatasets(composed.datasets);
  const { port } = await server.start({ host: '127.0.0.1', port: 0 });
  return {
    composed,
    server,
    recallStore: recall.store,
    recallEmbedder: recall.embedder,
    clusters: recall.clusters,
    async inject(req) {
      // Both reference SubstrateServer impls expose inject(). The type has it
      // optional because networked impls MAY omit it; the Fastify impl does
      // not, so we guard with a hard error rather than a non-null assertion.
      if (server.inject === undefined) throw new Error('FastifySubstrateServer.inject unavailable');
      return server.inject(req);
    },
    async openSse(path, frame, signal) {
      // A real socket, NOT `inject()`: Fastify's inject buffers `rawPayload` and
      // resolves only once the response ends, so a subscribe (which ends only on
      // disconnect) would deadlock and a stream would arrive as one flush —
      // neither of which is the behaviour under test.
      const res = await fetch(`http://127.0.0.1:${port}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(frame),
        signal
      });
      return { status: res.status, body: res.body };
    },
    async openWebsocket(path) {
      const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`);
      const listeners: Array<(frame: WsResponseFrame) => void> = [];
      ws.on('message', (data: Buffer | Buffer[] | ArrayBuffer) => {
        const buf = Buffer.isBuffer(data)
          ? data
          : Array.isArray(data)
            ? Buffer.concat(data as Buffer[])
            : Buffer.from(data);
        const frame = JSON.parse(buf.toString('utf8')) as WsResponseFrame;
        for (const cb of listeners.slice()) cb(frame);
      });
      await new Promise<void>((resolve, reject) => {
        ws.once('open', () => resolve());
        ws.once('error', reject);
      });
      return {
        send: (payload) => ws.send(JSON.stringify(payload)),
        onFrame: (cb) => {
          listeners.push(cb);
        },
        close: () => ws.close()
      };
    },
    async teardown() {
      await composed.stop();
    }
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
}

// ---------------------------------------------------------------------------
// Scenario implementations. Each receives a `HarnessHandle` and asserts the
// same expected behaviour regardless of transport.
// ---------------------------------------------------------------------------

async function scenarioSchema(h: HarnessHandle): Promise<Schema> {
  const res = await h.inject({ method: 'GET', path: '/substrate/v1/schema' });
  expect(res.status).toBe(200);
  const schema = jsonBody<Schema>(res);
  expect(schema.schemaVersion).toMatch(/^[0-9a-f]{12}$/);
  expect(schema.types.Todo).toBeDefined();
  expect(schema.types.Tag).toBeDefined();
  expect(schema.mutations.createTodo).toBeDefined();
  expect(schema.mutations.updateTodo).toBeDefined();
  expect(schema.mutations.deleteTodo).toBeDefined();
  return schema;
}

async function scenarioScopedSchema(h: HarnessHandle): Promise<void> {
  // Per-namespace scope.
  const nsRes = await h.inject({ method: 'GET', path: '/substrate/v1/schema/default' });
  expect(nsRes.status).toBe(200);
  const nsSchema = jsonBody<Schema>(nsRes);
  expect(nsSchema.types.Todo).toBeDefined();
  expect(nsSchema.mutations.createTodo).toBeDefined();

  // Per-type scope — the write contract: declared fields + only this type's mutations.
  const typeRes = await h.inject({ method: 'GET', path: '/substrate/v1/schema/default/Todo' });
  expect(typeRes.status).toBe(200);
  const contract = jsonBody<{
    namespace: string;
    type: string;
    fields: Record<string, unknown>;
    mutations: Record<string, unknown>;
  }>(typeRes);
  expect(contract.namespace).toBe('default');
  expect(contract.type).toBe('Todo');
  expect(contract.fields.title).toBeDefined();
  expect(contract.mutations.createTodo).toBeDefined();
  expect(contract.mutations.updateTodo).toBeDefined();
  expect(contract.mutations.createTag).toBeUndefined();

  // Unknown namespace + unknown type both 404 (parity across transports).
  const badNs = await h.inject({ method: 'GET', path: '/substrate/v1/schema/nope' });
  expect(badNs.status).toBe(404);
  const badType = await h.inject({ method: 'GET', path: '/substrate/v1/schema/default/Nope' });
  expect(badType.status).toBe(404);
  expect(jsonBody<{ availableTypes: string[] }>(badType).availableTypes).toContain('Todo');
}

async function scenarioEmptyList(h: HarnessHandle): Promise<void> {
  const res = await h.inject(
    asJsonRequest('/substrate/v1/query', {
      'default/Todo': { params: { limit: 10 }, fields: { id: true, title: true, done: true } }
    })
  );
  expect(res.status).toBe(200);
  const env = jsonBody<PackEnvelope>(res);
  expect(env.data['default/Todo']).toEqual([]);
  expect(env.shapes['default/Todo']).toBe('list');
  expect(env.errors).toBeUndefined();
}

async function scenarioUnqualifiedKeyError(h: HarnessHandle): Promise<void> {
  const res = await h.inject(
    asJsonRequest('/substrate/v1/query', { Todo: { params: {}, fields: { id: true } } })
  );
  expect(res.status).toBe(200);
  const env = jsonBody<PackEnvelope>(res);
  expect(env.errors?.[0]?.code).toBe('unqualified_key');
}

async function scenarioEnumRejection(h: HarnessHandle): Promise<void> {
  const res = await h.inject(
    asJsonRequest('/substrate/v1/mutate', {
      'default/createTodo': { params: { id: 'enum1', title: 't', status: 'bogus' } }
    })
  );
  expect(res.status).toBe(200);
  const env = jsonBody<PackEnvelope>(res);
  expect(env.errors?.[0]?.code).toBe('invalid_enum_value');

  const getRes = await h.inject(
    asJsonRequest('/substrate/v1/query', { 'default/getTodo': { params: { id: 'enum1' } } })
  );
  expect(jsonBody<PackEnvelope>(getRes).data['default/getTodo']).toBeNull();
}

async function scenarioSingleFilter(h: HarnessHandle): Promise<void> {
  await h.inject(
    asJsonRequest('/substrate/v1/mutate', {
      'default/createTodo': { params: { id: 'a', title: 'open-a', done: false } }
    })
  );
  await h.inject(
    asJsonRequest('/substrate/v1/mutate', {
      'default/createTodo': { params: { id: 'b', title: 'done-b', done: true } }
    })
  );
  const res = await h.inject(
    asJsonRequest('/substrate/v1/query', {
      'default/Todo': {
        params: { where: { done: { eq: false } } },
        fields: { id: true, done: true }
      }
    })
  );
  const env = jsonBody<PackEnvelope>(res);
  const rows = env.data['default/Todo'] as Array<{ id: string; done: boolean }>;
  expect(rows).toHaveLength(1);
  expect(rows[0]?.id).toBe('a');
  expect(rows[0]?.done).toBe(false);
}

async function scenarioCursorPagination(h: HarnessHandle): Promise<void> {
  for (let i = 1; i <= 8; i++) {
    await h.inject(
      asJsonRequest('/substrate/v1/mutate', {
        'default/createTodo': {
          params: {
            id: `t${String(i).padStart(2, '0')}`,
            title: `t${i}`,
            done: false
          }
        }
      })
    );
    // Server-set createdAt: small delay so ctx.now advances between rows.
    await new Promise<void>((resolve) => setTimeout(resolve, 2));
  }
  const seen: Array<string> = [];
  let cursor: string | undefined;
  for (let page = 0; page < 4; page++) {
    const res = await h.inject(
      asJsonRequest('/substrate/v1/query', {
        'default/Todo': {
          params: {
            orderBy: [{ createdAt: 'asc' }],
            limit: 3,
            ...(cursor !== undefined ? { cursor } : {})
          },
          fields: { id: true }
        }
      })
    );
    const env = jsonBody<PackEnvelope>(res);
    const rows = env.data['default/Todo'] as Array<{ id: string }>;
    for (const r of rows) {
      expect(seen.includes(r.id)).toBe(false);
      seen.push(r.id);
    }
    const pg = env._pagination?.['default/Todo'];
    if (!pg?.hasMore) break;
    cursor = pg?.nextCursor;
  }
  // Parity across servers: identical orderBy + limit + cursor walk must
  // visit the full set in the same order.
  expect(seen).toEqual(['t01', 't02', 't03', 't04', 't05', 't06', 't07', 't08']);
}

async function scenarioArchivedProjectFilter(h: HarnessHandle): Promise<void> {
  // Cold-start hot-path filter shape: exercises the body-promoted
  // archived + project columns end-to-end via the HTTP transport. PG routes
  // to indexed columns with a body-fallback OR-branch; memory evaluates
  // against the body directly. Both must produce the same row set.
  const seed = [
    { id: 'ap1', title: 'live-substrate', done: false, archived: false, project: 'substrate' },
    { id: 'ap2', title: 'archived-substrate', done: false, archived: true, project: 'substrate' },
    { id: 'ap3', title: 'live-other', done: false, archived: false, project: 'other' },
    { id: 'ap4', title: 'live-cross-cutting', done: false, archived: false, project: null },
    { id: 'ap5', title: 'live-no-project-key', done: false, archived: false }
  ];
  for (const params of seed) {
    await h.inject(asJsonRequest('/substrate/v1/mutate', { 'default/createTodo': { params } }));
  }

  // archived: { eq: false } — non-archived rows.
  const r1 = await h.inject(
    asJsonRequest('/substrate/v1/query', {
      'default/Todo': {
        params: { where: { archived: { eq: false } }, orderBy: [{ id: 'asc' }] },
        fields: { id: true }
      }
    })
  );
  const ids1 = (jsonBody<PackEnvelope>(r1).data['default/Todo'] as Array<{ id: string }>).map(
    (r) => r.id
  );
  expect(ids1).toEqual(['ap1', 'ap3', 'ap4', 'ap5']);

  // project: { eq: null } — cross-cutting (explicit null + absent key).
  const r2 = await h.inject(
    asJsonRequest('/substrate/v1/query', {
      'default/Todo': {
        params: { where: { project: { eq: null } }, orderBy: [{ id: 'asc' }] },
        fields: { id: true }
      }
    })
  );
  const ids2 = (jsonBody<PackEnvelope>(r2).data['default/Todo'] as Array<{ id: string }>).map(
    (r) => r.id
  );
  expect(ids2).toEqual(['ap4', 'ap5']);

  // project: { in: ['substrate', null] } — substrate-scoped + cross-cutting.
  const r3 = await h.inject(
    asJsonRequest('/substrate/v1/query', {
      'default/Todo': {
        params: {
          where: { project: { in: ['substrate', null] } },
          orderBy: [{ id: 'asc' }]
        },
        fields: { id: true }
      }
    })
  );
  const ids3 = (jsonBody<PackEnvelope>(r3).data['default/Todo'] as Array<{ id: string }>).map(
    (r) => r.id
  );
  expect(ids3).toEqual(['ap1', 'ap2', 'ap4', 'ap5']);

  // Composite cold-start hot-path: { archived: { eq: false }, project: { in: ['substrate', null] } }.
  const r4 = await h.inject(
    asJsonRequest('/substrate/v1/query', {
      'default/Todo': {
        params: {
          where: { archived: { eq: false }, project: { in: ['substrate', null] } },
          orderBy: [{ id: 'asc' }]
        },
        fields: { id: true }
      }
    })
  );
  const ids4 = (jsonBody<PackEnvelope>(r4).data['default/Todo'] as Array<{ id: string }>).map(
    (r) => r.id
  );
  expect(ids4).toEqual(['ap1', 'ap4', 'ap5']);
}

async function scenarioExtensionOperator(h: HarnessHandle): Promise<void> {
  // Seed three Todos. The stub operator returns row-shaped results for two of
  // them; the third should be excluded from the resolved set.
  await h.inject(
    asJsonRequest('/substrate/v1/mutate', {
      'default/createTodo': [
        { params: { id: 'eo1', title: 'one', archived: false }, fields: { id: true } },
        { params: { id: 'eo2', title: 'two', archived: false }, fields: { id: true } },
        { params: { id: 'eo3', title: 'three', archived: true }, fields: { id: true } }
      ]
    })
  );

  const fakeRowResults: FilterOperatorDef = {
    validate: (v) => ({ ok: true, value: v }),
    execute: async () => ({
      hits: [
        { id: 'eo1', score: 0.9 },
        { id: 'eo3', score: 0.8 }
      ]
    })
  };
  registerExtensionOperator('parityFakeOp', fakeRowResults);

  try {
    const res = await h.inject(
      asJsonRequest('/substrate/v1/query', {
        'default/Todo': {
          params: {
            where: { parityFakeOp: { to: 'anything' } },
            orderBy: [{ id: 'asc' }]
          },
          fields: { id: true }
        }
      })
    );
    const ids = (jsonBody<PackEnvelope>(res).data['default/Todo'] as Array<{ id: string }>).map(
      (r) => r.id
    );
    expect(ids).toEqual(['eo1', 'eo3']);
  } finally {
    clearExtensionOperators();
  }
}

async function scenarioMutationLifecycle(h: HarnessHandle): Promise<void> {
  // create → query → update → query → delete → query (includeDeleted)
  const createRes = await h.inject(
    asJsonRequest('/substrate/v1/mutate', {
      'default/createTodo': {
        params: { id: 'lc1', title: 'initial', done: false },
        fields: { id: true, title: true, done: true }
      }
    })
  );
  const createEnv = jsonBody<PackEnvelope>(createRes);
  expect(createEnv.data['default/createTodo']).toMatchObject({
    id: 'lc1',
    title: 'initial',
    done: false
  });
  expect(createEnv.shapes['default/createTodo']).toBe('single');

  const getRes = await h.inject(
    asJsonRequest('/substrate/v1/query', { 'default/getTodo': { params: { id: 'lc1' } } })
  );
  expect(jsonBody<PackEnvelope>(getRes).data['default/getTodo']).toMatchObject({
    id: 'lc1',
    title: 'initial'
  });

  const updateRes = await h.inject(
    asJsonRequest('/substrate/v1/mutate', {
      'default/updateTodo': {
        params: { id: 'lc1', title: 'renamed', done: true },
        fields: { id: true, title: true, done: true }
      }
    })
  );
  expect(jsonBody<PackEnvelope>(updateRes).data['default/updateTodo']).toMatchObject({
    id: 'lc1',
    title: 'renamed',
    done: true
  });

  const postUpdate = await h.inject(
    asJsonRequest('/substrate/v1/query', { 'default/getTodo': { params: { id: 'lc1' } } })
  );
  expect(jsonBody<PackEnvelope>(postUpdate).data['default/getTodo']).toMatchObject({
    id: 'lc1',
    title: 'renamed',
    done: true
  });

  const deleteRes = await h.inject(
    asJsonRequest('/substrate/v1/mutate', {
      'default/deleteTodo': { params: { id: 'lc1' } }
    })
  );
  expect(jsonBody<PackEnvelope>(deleteRes).data['default/deleteTodo']).toEqual({
    id: 'lc1',
    deleted: true
  });

  // Post-delete visibility: default query excludes the soft-deleted row.
  const afterDelete = await h.inject(
    asJsonRequest('/substrate/v1/query', {
      'default/Todo': { params: {}, fields: { id: true } }
    })
  );
  const liveRows = jsonBody<PackEnvelope>(afterDelete).data['default/Todo'] as Array<{
    id: string;
  }>;
  expect(liveRows.find((r) => r.id === 'lc1')).toBeUndefined();

  // Soft-delete tombstone inspection reads the dataset directly. Both
  // transports share the same dataset instance per harness, so this
  // observation is the same across servers.
  const ds = h.composed.datasets.get('default');
  if (ds === undefined) throw new Error('default namespace dataset missing');
  const datasetRead = await ds.read('Todo', { id: 'lc1', includeDeleted: true });
  expect(datasetRead.rows).toHaveLength(1);
  const tombstone = datasetRead.rows[0] as { id: string; _deletedAt?: unknown };
  expect(tombstone.id).toBe('lc1');
  expect(tombstone._deletedAt).toBeDefined();
}

async function scenarioEdgeAwareDelete(h: HarnessHandle): Promise<void> {
  await h.inject(
    asJsonRequest('/substrate/v1/mutate', {
      'default/createTodo': { params: { id: 'ed1', title: 'parent', done: false } }
    })
  );
  await h.inject(
    asJsonRequest('/substrate/v1/mutate', {
      'default/createTag': { params: { id: 'tag-ed1', label: 'linked', todoId: 'ed1' } }
    })
  );
  const pre = await h.composed.edges.findEdgesTo({
    ns: 'default',
    type: 'Todo',
    id: 'ed1'
  });
  expect(pre).toHaveLength(1);
  expect(pre[0]?.policy).toBe('set_null');

  await h.inject(
    asJsonRequest('/substrate/v1/mutate', { 'default/deleteTodo': { params: { id: 'ed1' } } })
  );

  // Pre-sweep: Tag.todoId still points at 'ed1' — the null happens on the
  // reconciler, not synchronously in the delete.
  const preSweep = await h.inject(
    asJsonRequest('/substrate/v1/query', {
      'default/getTag': { params: { id: 'tag-ed1' } }
    })
  );
  const tagPre = jsonBody<PackEnvelope>(preSweep).data['default/getTag'] as {
    id: string;
    todoId: unknown;
  };
  expect(tagPre.todoId).toBe('ed1');

  await h.composed.runSweepNow();

  const postSweep = await h.inject(
    asJsonRequest('/substrate/v1/query', {
      'default/getTag': { params: { id: 'tag-ed1' } }
    })
  );
  const tagPost = jsonBody<PackEnvelope>(postSweep).data['default/getTag'] as {
    id: string;
    todoId: unknown;
  };
  expect(tagPost.id).toBe('tag-ed1');
  expect(tagPost.todoId).toBeNull();

  const post = await h.composed.edges.findEdgesTo({
    ns: 'default',
    type: 'Todo',
    id: 'ed1'
  });
  expect(post).toHaveLength(0);
}

async function scenarioOnMissingReject(h: HarnessHandle): Promise<void> {
  // 1. target exists -> create referrer succeeds.
  await h.inject(
    asJsonRequest('/substrate/v1/mutate', {
      'default/createTarget': { params: { id: 'tg1' }, fields: { id: true } }
    })
  );
  const okRes = await h.inject(
    asJsonRequest('/substrate/v1/mutate', {
      'default/createOwner': {
        params: { id: 'om1', ref: 'tg1' },
        fields: { id: true }
      }
    })
  );
  const okEnv = jsonBody<PackEnvelope>(okRes);
  expect(okEnv.errors).toBeUndefined();
  expect(okEnv.data['default/createOwner']).toMatchObject({ id: 'om1' });

  // 2. target missing -> missing_referent error, no row written.
  const badRes = await h.inject(
    asJsonRequest('/substrate/v1/mutate', {
      'default/createOwner': {
        params: { id: 'om2', ref: 'ghost' },
        fields: { id: true }
      }
    })
  );
  const badEnv = jsonBody<PackEnvelope>(badRes);
  expect(badEnv.errors?.[0]?.code).toBe('missing_referent');
  // The failed create must not surface a data payload alongside the error.
  expect(badEnv.data['default/createOwner']).toBeUndefined();

  const checkRes = await h.inject(
    asJsonRequest('/substrate/v1/query', {
      'default/Owner': { params: { where: { id: { eq: 'om2' } } }, fields: { id: true } }
    })
  );
  expect(jsonBody<PackEnvelope>(checkRes).data['default/Owner']).toHaveLength(0);

  // 3. update-repoint to a missing target -> missing_referent.
  const badUpdateRes = await h.inject(
    asJsonRequest('/substrate/v1/mutate', {
      'default/updateOwner': {
        params: { id: 'om1', ref: 'ghost' },
        fields: { id: true }
      }
    })
  );
  expect(jsonBody<PackEnvelope>(badUpdateRes).errors?.[0]?.code).toBe('missing_referent');

  // The rejected update must write nothing — re-query and confirm `ref` still
  // holds the ORIGINAL valid target ('tg1'), not the missing 'ghost' value.
  const afterBadUpdateRes = await h.inject(
    asJsonRequest('/substrate/v1/query', {
      'default/getOwner': { params: { id: 'om1' }, fields: { id: true, ref: true } }
    })
  );
  const afterBadUpdate = jsonBody<PackEnvelope>(afterBadUpdateRes).data['default/getOwner'] as {
    id: string;
    ref: string;
  };
  expect(afterBadUpdate.ref).toBe('tg1');
}

// ---------------------------------------------------------------------------
// Stream-transport drivers (§2.5). WS and SSE carry the same information in
// different envelopes — WS multiplexes `{id, op, frame}` over one socket and
// answers with `WsResponseFrame`s; SSE dedicates one HTTP response per session,
// takes the frame in the request, and answers with `event:`/`data:` blocks.
// Normalizing both onto `ObservedFrame` is what lets ONE scenario body prove
// both transports instead of two scenarios that drift apart.
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** The transport-neutral intersection the shared scenarios assert against. */
interface ObservedFrame {
  kind: string;
  key?: string;
  rows?: unknown[];
  row?: unknown;
  sequence?: number;
  code?: string;
}

interface StreamDriver {
  open(mode: 'subscribe' | 'stream', id: string, frame: Record<string, unknown>): Promise<void>;
  frames(): ObservedFrame[];
  /** WS sends an explicit cancel op; for SSE, cancellation IS disconnection. */
  cancel(id: string): void;
  close(): void;
}

function wsDriver(h: HarnessHandle): StreamDriver {
  const observed: ObservedFrame[] = [];
  let ws: WsHandle | null = null;
  return {
    async open(mode, id, frame) {
      ws = await h.openWebsocket('/substrate/v1/ws');
      ws.onFrame((f) => {
        // Terminal frames carry no `data` at all, hence the empty-record floor.
        const data = isRecord(f.data) ? f.data : {};
        const key = Object.keys(data)[0];
        const value = key === undefined ? undefined : data[key];
        observed.push({
          kind: f.kind,
          ...(key !== undefined ? { key } : {}),
          ...(Array.isArray(value) ? { rows: value } : value !== undefined ? { row: value } : {}),
          ...(f.sequence !== undefined ? { sequence: f.sequence } : {}),
          ...(f.errors?.[0]?.code !== undefined ? { code: f.errors[0].code } : {})
        });
      });
      ws.send({ id, op: mode, frame });
    },
    frames: () => observed,
    cancel(id) {
      ws?.send({ id, op: 'cancel' });
    },
    close: () => ws?.close()
  };
}

/** The `data:` payload shapes `sse-frame.ts` emits, per frame kind. */
interface SsePayload {
  key?: string;
  rows?: unknown[];
  row?: unknown;
  sequence?: number;
  code?: string;
}

/**
 * One `event:`/`data:` block. Returns null for blocks that carry no frame — the
 * opening `retry:` and the `: keepalive` comments a long-lived subscribe emits.
 */
function parseSseBlock(block: string): ObservedFrame | null {
  let kind: string | undefined;
  let data: string | undefined;
  for (const line of block.split('\n')) {
    if (line.startsWith('event: ')) kind = line.slice(7);
    else if (line.startsWith('data: ')) data = line.slice(6);
  }
  if (kind === undefined || data === undefined) return null;
  const payload = JSON.parse(data) as SsePayload;
  return {
    kind,
    ...(payload.key !== undefined ? { key: payload.key } : {}),
    ...(payload.rows !== undefined ? { rows: payload.rows } : {}),
    ...(payload.row !== undefined ? { row: payload.row } : {}),
    ...(payload.sequence !== undefined ? { sequence: payload.sequence } : {}),
    ...(payload.code !== undefined ? { code: payload.code } : {})
  };
}

/** Reads to EOF, appending each complete block to `sink`. */
async function drainSse(body: ReadableStream<Uint8Array>, sink: ObservedFrame[]): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffered = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });
      for (let at = buffered.indexOf('\n\n'); at !== -1; at = buffered.indexOf('\n\n')) {
        const parsed = parseSseBlock(buffered.slice(0, at));
        buffered = buffered.slice(at + 2);
        if (parsed !== null) sink.push(parsed);
      }
    }
  } catch {
    // Cancelling an SSE session means killing the connection, so the pending
    // read rejects by design. Frames observed before that stand.
  }
}

function sseDriver(h: HarnessHandle): StreamDriver {
  const observed: ObservedFrame[] = [];
  const abort = new AbortController();
  return {
    async open(mode, _id, frame) {
      const res = await h.openSse(
        mode === 'stream' ? '/substrate/v1/stream' : '/substrate/v1/subscribe',
        frame,
        abort.signal
      );
      expect(res.status).toBe(200);
      const body = res.body;
      if (body === null) throw new Error('SSE route returned no stream body');
      // Drained detached, NOT awaited: a subscribe has no terminal frame until
      // the client disconnects, so awaiting the drain here would deadlock the
      // scenario that is supposed to go on and provoke an `add`.
      void drainSse(body, observed);
    },
    frames: () => observed,
    cancel() {
      abort.abort();
    },
    close() {
      abort.abort();
    }
  };
}

/**
 * Every driver here closes in a `finally`, which is not tidiness: an SSE session
 * owns a real HTTP response and Fastify's shutdown waits on in-flight requests,
 * so a driver left open by a failing assertion turns one clear failure into a
 * 10s afterEach timeout that buries it.
 */
async function scenarioSubscribe(h: HarnessHandle, driver: StreamDriver): Promise<void> {
  try {
    await driver.open('subscribe', 'sub-par', {
      'default/Todo': { params: {}, fields: { id: true, title: true, done: true } }
    });
    await waitFor(() => driver.frames().length >= 1);
    expect(driver.frames()[0]?.kind).toBe('snapshot');
    expect(driver.frames()[0]?.rows).toEqual([]);

    await h.inject(
      asJsonRequest('/substrate/v1/mutate', {
        'default/createTodo': { params: { id: 'sub1', title: 'pushed', done: false } }
      })
    );
    await waitFor(() => driver.frames().length >= 2);
    const added = driver.frames()[1];
    expect(added?.kind).toBe('add');
    expect(added?.key).toBe('default/Todo');
    expect(added?.row).toMatchObject({ id: 'sub1', title: 'pushed' });

    // The terminal `end { final: true }` a WS cancel acks lives in a WS-only
    // test: an SSE cancel is a disconnect, so no frame can follow it here.
    driver.cancel('sub-par');
  } finally {
    driver.close();
  }
}

async function scenarioStream(h: HarnessHandle, driver: StreamDriver): Promise<void> {
  for (let i = 1; i <= 3; i++) {
    await h.inject(
      asJsonRequest('/substrate/v1/mutate', {
        'default/createTodo': { params: { id: `st${i}`, title: `row-${i}`, done: false } }
      })
    );
  }
  try {
    await driver.open('stream', 'stream-par', {
      'default/streamTodos': { params: {}, fields: { id: true, title: true } }
    });
    await waitFor(() => driver.frames().some((f) => f.kind === 'end'), 5000);

    const chunks = driver.frames().filter((f) => f.kind === 'chunk');
    expect(chunks).toHaveLength(3);
    expect(chunks.map((c) => c.sequence)).toEqual([0, 1, 2]);
    expect(chunks.map((c) => c.key)).toEqual([
      'default/streamTodos',
      'default/streamTodos',
      'default/streamTodos'
    ]);
    expect(driver.frames().at(-1)?.kind).toBe('end');
  } finally {
    driver.close();
  }
}

// ---------------------------------------------------------------------------
// §recall-frame parity: the virtual `recall/*` namespace surface
// (recall/Hit query + recall/boost mutation) must behave byte-identically
// across MemorySubstrateServer and FastifySubstrateServer.
//
// Determinism: rows are seeded under FIXED ids (not engine-assigned UUIDs) so
// both servers produce identical id sets; vectors come from the deterministic
// FakeEmbedder over fixed seed texts; queries pass `boost: false` so no
// salience side-effect drifts the result between the two runs; the Hit
// projection keeps only id/score/kind (no `row` join, hence no _metadata
// timestamps) so the envelope is byte-stable. recall/Hit rows carry no
// server-generated timestamps and recall timings are not part of frame output.
// ---------------------------------------------------------------------------

/**
 * Fixed seed rows. Texts chosen so cosine vs the query text is distinct AND
 * positive under FakeEmbedder(dim 8), making relevance order observable while
 * every row clears the recall path's implicit threshold=0 floor (mirrors the
 * route-vs-frame parity suite's seed reasoning).
 */
const RECALL_QUERY = 'target text';
const RECALL_SEED = [
  { id: 'recall-seed-a', text: 'seed-row-4' },
  { id: 'recall-seed-b', text: 'seed-row-6' },
  { id: 'recall-seed-c', text: 'seed-row-1' }
];

/** Seed the harness's recall store + backing default/Memo rows under fixed ids. */
async function seedRecall(h: HarnessHandle): Promise<void> {
  for (const s of RECALL_SEED) {
    const writeRes = await h.inject(
      asJsonRequest('/substrate/v1/mutate', {
        'default/createMemo': {
          params: {
            id: s.id,
            name: `seed-${s.text}`,
            description: s.text,
            body: s.text,
            archived: false,
            project: null
          },
          fields: { id: true }
        }
      })
    );
    expect(jsonBody<PackEnvelope>(writeRes).errors).toBeUndefined();
    const vector = await h.recallEmbedder.embed(s.text);
    await h.recallStore.upsert({
      rowNamespace: 'default',
      rowType: 'Memo',
      rowId: s.id,
      vector,
      model: h.recallEmbedder.modelId
    });
  }
}

/** Run a recall/Hit frame, returning the projected (deterministic) hit rows. */
async function recallHit(
  h: HarnessHandle
): Promise<Array<{ id: string; score: number; kind: string }>> {
  const res = await h.inject(
    asJsonRequest('/substrate/v1/query', {
      'recall/Hit': {
        params: {
          to: RECALL_QUERY,
          namespace: 'default',
          type: 'Memo',
          k: 3,
          boost: false
        },
        // Project only deterministic scalars — omitting `row` drops the joined
        // default/Memo body (and its _metadata timestamps), keeping the
        // envelope byte-stable across servers.
        fields: { id: true, score: true, kind: true }
      }
    })
  );
  expect(res.status).toBe(200);
  const env = jsonBody<PackEnvelope>(res);
  expect(env.errors).toBeUndefined();
  return env.data['recall/Hit'] as Array<{ id: string; score: number; kind: string }>;
}

async function scenarioRecallHitQuery(h: HarnessHandle): Promise<void> {
  await seedRecall(h);
  const rows = await recallHit(h);
  // Non-empty, all seeds present, every row is a knn 'seed' (no expansion).
  expect(rows.length).toBeGreaterThanOrEqual(2);
  expect(rows.every((r) => r.kind === 'seed')).toBe(true);
  // Relevance order: scores strictly descending (distinct cosines by design).
  for (let i = 1; i < rows.length; i++) {
    expect(rows[i - 1]?.score).toBeGreaterThan(rows[i]?.score ?? Number.POSITIVE_INFINITY);
  }
  // Expected ids in relevance order under the fixed vectors (cosine vs
  // 'target text': seed-row-4 ~0.53 > seed-row-6 ~0.40 > seed-row-1 ~0.25).
  expect(rows.map((r) => r.id)).toEqual(['recall-seed-a', 'recall-seed-b', 'recall-seed-c']);
}

async function scenarioRecallBoostMutation(h: HarnessHandle): Promise<void> {
  await seedRecall(h);
  const targets = RECALL_SEED.slice(0, 2).map((s) => ({
    namespace: 'default',
    type: 'Memo',
    id: s.id
  }));
  const res = await h.inject(
    asJsonRequest('/substrate/v1/mutate', {
      'recall/boost': { params: { targets }, fields: { id: true, ok: true, requested: true } }
    })
  );
  expect(res.status).toBe(200);
  const env = jsonBody<PackEnvelope>(res);
  expect(env.errors).toBeUndefined();
  // The 'ack' sentinel id is the documented mutation-Row divergence; ok +
  // requested mirror the route ack.
  expect(env.data['recall/boost']).toEqual({ id: 'ack', ok: true, requested: 2 });
}

// ---------------------------------------------------------------------------
// §cluster-frame parity: `recall/Cluster`, `recall/ClusterMember` and
// `recall/labelCluster` must behave byte-identically across
// MemorySubstrateServer and FastifySubstrateServer.
//
// `recall/crystallise` is deliberately excluded: it is process-local-guarded
// (`CrystalliseGuard`), so the two harnesses would need separate guard
// instances, defeating a SHARED-behaviour assertion.
//
// Determinism: the `ClusterStore` is seeded DIRECTLY under fixed ids with a
// pinned `now`, bypassing `recall/crystallise` entirely — this exercises the
// READ surface the same way `seedRecall` seeds `recall/Hit`'s store directly
// rather than by running an embed pipeline.
// ---------------------------------------------------------------------------

const CLUSTER_FIXED_NOW = new Date('2026-01-01T00:00:00.000Z');

const CLUSTER_PROVENANCE: ClusterProvenance = {
  backend: 'wasm',
  backendVersion: '0.1.0',
  regime: 'normalised',
  seed: 42,
  params: { nComponents: 10, nNeighbors: 15, minClusterSize: 2 },
  model: 'fake-recall-model:8'
};

const CLUSTER_FIELDS_ALL = {
  id: true,
  shortId: true,
  memberCount: true,
  departedCount: true,
  cohesion: true,
  label: true,
  labelledBy: true,
  provenance: true,
  formedAt: true,
  lastAccretedAt: true,
  retiredAt: true
};

const CLUSTER_MEMBER_FIELDS_ALL = {
  id: true,
  shortId: true,
  cluster: true,
  memberNs: true,
  memberType: true,
  memberId: true,
  origin: true,
  similarity: true,
  attachedAt: true,
  departedAt: true
};

/** Seed the harness's `ClusterStore` directly under fixed ids + a pinned `now`. */
async function seedClusters(h: HarnessHandle): Promise<void> {
  await h.clusters.createCluster({
    id: 'cluster-fixed-a',
    centroid: new Float32Array(RECALL_DIM).fill(1),
    cohesion: 0.9,
    label: 'fixed label a',
    labelledBy: 'medoid',
    provenance: CLUSTER_PROVENANCE,
    now: CLUSTER_FIXED_NOW
  });
  await h.clusters.attachMembers([
    {
      id: 'member-fixed-1',
      clusterId: 'cluster-fixed-a',
      ref: { namespace: 'default', type: 'Memo', id: 'recall-seed-a' },
      origin: 'formation',
      similarity: 0.95,
      now: CLUSTER_FIXED_NOW
    },
    {
      id: 'member-fixed-2',
      clusterId: 'cluster-fixed-a',
      ref: { namespace: 'default', type: 'Memo', id: 'recall-seed-b' },
      origin: 'accretion',
      similarity: 0.8,
      now: CLUSTER_FIXED_NOW
    }
  ]);
}

async function recallClusterList(h: HarnessHandle): Promise<Array<Record<string, unknown>>> {
  const res = await h.inject(
    asJsonRequest('/substrate/v1/query', {
      'recall/Cluster': { params: {}, fields: CLUSTER_FIELDS_ALL }
    })
  );
  expect(res.status).toBe(200);
  const env = jsonBody<PackEnvelope>(res);
  expect(env.errors).toBeUndefined();
  return env.data['recall/Cluster'] as Array<Record<string, unknown>>;
}

async function scenarioClusterQuery(h: HarnessHandle): Promise<void> {
  await seedClusters(h);
  const rows = await recallClusterList(h);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    id: 'cluster-fixed-a',
    memberCount: 2,
    departedCount: 0,
    label: 'fixed label a',
    labelledBy: 'medoid',
    retiredAt: null
  });
  // `centroid` is deliberately never published — see CLUSTER_FIELDS' doc.
  expect('centroid' in (rows[0] ?? {})).toBe(false);
}

async function recallClusterMemberList(h: HarnessHandle): Promise<Array<Record<string, unknown>>> {
  const res = await h.inject(
    asJsonRequest('/substrate/v1/query', {
      'recall/ClusterMember': {
        params: { cluster: 'cluster-fixed-a' },
        fields: CLUSTER_MEMBER_FIELDS_ALL
      }
    })
  );
  expect(res.status).toBe(200);
  const env = jsonBody<PackEnvelope>(res);
  expect(env.errors).toBeUndefined();
  return env.data['recall/ClusterMember'] as Array<Record<string, unknown>>;
}

async function scenarioClusterMemberQuery(h: HarnessHandle): Promise<void> {
  await seedClusters(h);
  const rows = await recallClusterMemberList(h);
  expect(rows.map((r) => r.memberId)).toEqual(['recall-seed-a', 'recall-seed-b']);
  expect(rows.map((r) => r.origin)).toEqual(['formation', 'accretion']);
  expect(rows.every((r) => r.cluster === 'cluster-fixed-a')).toBe(true);
}

/** memberResolver's bad_request refusal: neither `cluster` nor the full member triple. */
async function scenarioClusterMemberBadRequest(h: HarnessHandle): Promise<void> {
  await seedClusters(h);
  const res = await h.inject(
    asJsonRequest('/substrate/v1/query', {
      'recall/ClusterMember': { params: {}, fields: { id: true } }
    })
  );
  expect(res.status).toBe(200);
  const env = jsonBody<PackEnvelope>(res);
  expect(env.errors?.[0]?.code).toBe('bad_request');
}

async function labelClusterMutate(h: HarnessHandle): Promise<Record<string, unknown>> {
  const res = await h.inject(
    asJsonRequest('/substrate/v1/mutate', {
      'recall/labelCluster': {
        params: { id: 'cluster-fixed-a', label: 'renamed by agent' },
        fields: { id: true, label: true, labelledBy: true }
      }
    })
  );
  expect(res.status).toBe(200);
  const env = jsonBody<PackEnvelope>(res);
  expect(env.errors).toBeUndefined();
  return env.data['recall/labelCluster'] as Record<string, unknown>;
}

async function scenarioLabelClusterMutation(h: HarnessHandle): Promise<void> {
  await seedClusters(h);
  const row = await labelClusterMutate(h);
  expect(row).toEqual({ id: 'cluster-fixed-a', label: 'renamed by agent', labelledBy: 'agent' });
}

async function captureClusterRows(
  factory: () => Promise<HarnessHandle>
): Promise<Array<Record<string, unknown>>> {
  const h = await factory();
  try {
    await seedClusters(h);
    return await recallClusterList(h);
  } finally {
    await h.teardown();
  }
}

async function captureClusterMemberRows(
  factory: () => Promise<HarnessHandle>
): Promise<Array<Record<string, unknown>>> {
  const h = await factory();
  try {
    await seedClusters(h);
    return await recallClusterMemberList(h);
  } finally {
    await h.teardown();
  }
}

async function captureLabelClusterAck(
  factory: () => Promise<HarnessHandle>
): Promise<Record<string, unknown>> {
  const h = await factory();
  try {
    await seedClusters(h);
    return await labelClusterMutate(h);
  } finally {
    await h.teardown();
  }
}

// ---------------------------------------------------------------------------
// Parity-across-servers: snapshot deterministic outputs and confirm both
// impls produce the same value. One section (schema bytes), one section
// (sorted query result).
// ---------------------------------------------------------------------------

async function captureSchema(factory: () => Promise<HarnessHandle>): Promise<Schema> {
  const h = await factory();
  try {
    return await scenarioSchema(h);
  } finally {
    await h.teardown();
  }
}

async function captureOrderedTodos(
  factory: () => Promise<HarnessHandle>
): Promise<Array<{ id: string; title: string; done: boolean }>> {
  const h = await factory();
  try {
    for (let i = 1; i <= 3; i++) {
      await h.inject(
        asJsonRequest('/substrate/v1/mutate', {
          'default/createTodo': {
            params: {
              id: `p${i}`,
              title: `par-${i}`,
              done: i === 2
            }
          }
        })
      );
      // Server-set createdAt: small delay so ctx.now advances between rows.
      await new Promise<void>((resolve) => setTimeout(resolve, 2));
    }
    const res = await h.inject(
      asJsonRequest('/substrate/v1/query', {
        'default/Todo': {
          params: { orderBy: [{ createdAt: 'asc' }] },
          fields: { id: true, title: true, done: true }
        }
      })
    );
    return jsonBody<PackEnvelope>(res).data['default/Todo'] as Array<{
      id: string;
      title: string;
      done: boolean;
    }>;
  } finally {
    await h.teardown();
  }
}

async function captureRecallHits(
  factory: () => Promise<HarnessHandle>
): Promise<Array<{ id: string; score: number; kind: string }>> {
  const h = await factory();
  try {
    await seedRecall(h);
    return await recallHit(h);
  } finally {
    await h.teardown();
  }
}

async function captureRecallBoostAck(
  factory: () => Promise<HarnessHandle>
): Promise<Record<string, unknown>> {
  const h = await factory();
  try {
    await seedRecall(h);
    const targets = RECALL_SEED.slice(0, 2).map((s) => ({
      namespace: 'default',
      type: 'Memo',
      id: s.id
    }));
    const res = await h.inject(
      asJsonRequest('/substrate/v1/mutate', {
        'recall/boost': { params: { targets }, fields: { id: true, ok: true, requested: true } }
      })
    );
    return jsonBody<PackEnvelope>(res).data['recall/boost'] as Record<string, unknown>;
  } finally {
    await h.teardown();
  }
}

// ---------------------------------------------------------------------------
// The server table. Every scenario runs against every entry. The per-server
// describe is generated in a loop, not by `describe.each`, because the outer
// lifecycle (start/stop + ephemeral port + edges registry) is async and
// shares state with each test via the mutable `harness` closure.
// ---------------------------------------------------------------------------

interface ServerEntry {
  readonly name: string;
  readonly factory: () => Promise<HarnessHandle>;
}

const SERVERS: Array<ServerEntry> = [
  { name: 'memory', factory: memoryHarness },
  { name: 'fastify', factory: fastifyHarness }
];

for (const { name, factory } of SERVERS) {
  describe(`§9.4 parity: ${name}`, () => {
    let harness: HarnessHandle;

    beforeEach(async () => {
      harness = await factory();
    });

    afterEach(async () => {
      await harness.teardown();
    });

    it('GET /substrate/v1/schema returns a well-formed schema', async () => {
      await scenarioSchema(harness);
    });

    it('GET /substrate/v1/schema/:ns and /:ns/:type return scoped shapes (404 on miss)', async () => {
      await scenarioScopedSchema(harness);
    });

    it('POST /substrate/v1/query returns an empty list envelope', async () => {
      await scenarioEmptyList(harness);
    });

    it('unqualified key surfaces as envelope error', async () => {
      await scenarioUnqualifiedKeyError(harness);
    });

    it('out-of-vocab enum write is rejected (memory + fastify parity)', async () => {
      await scenarioEnumRejection(harness);
    });

    it('single-value filter restricts the returned set', async () => {
      await scenarioSingleFilter(harness);
    });

    it('cursor pagination walks the full ordered set', async () => {
      await scenarioCursorPagination(harness);
    });

    it('archived + project filter (cold-start hot-path)', async () => {
      await scenarioArchivedProjectFilter(harness);
    });

    it('extension operator: registered op resolves to id IN', async () => {
      await scenarioExtensionOperator(harness);
    });

    it('mutation lifecycle: create → update → delete → includeDeleted visibility', async () => {
      await scenarioMutationLifecycle(harness);
    });

    it('edge-aware delete: sweep nulls the crossRef source field', async () => {
      await scenarioEdgeAwareDelete(harness);
    });

    it("onMissing:'reject' refuses a missing referent and writes no row", async () => {
      await scenarioOnMissingReject(harness);
    });

    // The same scenario body over both stream transports: §2.5 protocol
    // neutrality is enforced here, not asserted in a docstring.
    for (const [transport, makeDriver] of [
      ['ws', wsDriver],
      ['sse', sseDriver]
    ] as const) {
      it(`subscribe [${transport}]: snapshot + add`, async () => {
        await scenarioSubscribe(harness, makeDriver(harness));
      });

      it(`stream [${transport}]: chunks in order + terminal end frame`, async () => {
        await scenarioStream(harness, makeDriver(harness));
      });
    }

    // Two WS-envelope behaviours with no SSE equivalent. They are asserted here
    // rather than dropped from the shared scenario's reach entirely — the
    // parity gate narrows to the intersection, the coverage does not.
    it('stream chunks carry per-key shapes [ws]', async () => {
      // Seeded, not empty: `streamTodos` yields one chunk per stored row, so an
      // unseeded harness would stream zero chunks and the per-chunk assertion
      // below would pass without ever running.
      for (const id of ['sh1', 'sh2']) {
        await harness.inject(
          asJsonRequest('/substrate/v1/mutate', {
            'default/createTodo': { params: { id, title: id, done: false } }
          })
        );
      }
      const ws = await harness.openWebsocket('/substrate/v1/ws');
      const frames: Array<WsResponseFrame> = [];
      ws.onFrame((f) => frames.push(f));
      ws.send({
        id: 'shapes-par',
        op: 'stream',
        frame: { 'default/streamTodos': { params: {}, fields: { id: true } } }
      });
      await waitFor(() => frames.some((f) => f.kind === 'end'), 5000);

      const chunks = frames.filter((f) => f.kind === 'chunk');
      expect(chunks).toHaveLength(2);
      for (const c of chunks) {
        expect(c.shapes).toEqual({ 'default/streamTodos': 'single' });
      }
      expect(frames.at(-1)?.final).toBe(true);
      ws.close();
    });

    it('subscribe cancel is acknowledged with end { final: true } [ws]', async () => {
      const ws = await harness.openWebsocket('/substrate/v1/ws');
      const frames: Array<WsResponseFrame> = [];
      ws.onFrame((f) => frames.push(f));
      ws.send({
        id: 'cancel-par',
        op: 'subscribe',
        frame: { 'default/Todo': { params: {}, fields: { id: true } } }
      });
      await waitFor(() => frames.length >= 1);

      ws.send({ id: 'cancel-par', op: 'cancel' });
      await waitFor(() => frames.some((f) => f.kind === 'end'));
      expect(frames.find((f) => f.kind === 'end')?.final).toBe(true);
      ws.close();
    });

    it('reconnect yields a fresh snapshot, not a resume [sse]', async () => {
      // Subscriptions are state-convergent, not event-sourced (spec §4): there
      // is no durable change log, so a second connection must re-snapshot
      // rather than replay what it missed. This pins the contract that
      // `sse-frame.ts` deliberately emits no `id:` for.
      const frame: Record<string, unknown> = {
        'default/Todo': { params: {}, fields: { id: true } }
      };
      await harness.inject(
        asJsonRequest('/substrate/v1/mutate', {
          'default/createTodo': { params: { id: 'rc1', title: 'before', done: false } }
        })
      );

      const first = sseDriver(harness);
      try {
        await first.open('subscribe', 'rc-1', frame);
        await waitFor(() => first.frames().length >= 1);
        expect(first.frames()[0]?.kind).toBe('snapshot');
        expect(first.frames()[0]?.rows).toHaveLength(1);
      } finally {
        first.close();
      }

      // Written while nobody is subscribed — a resuming transport would replay
      // it as an `add`; a re-snapshotting one folds it into the new snapshot.
      await harness.inject(
        asJsonRequest('/substrate/v1/mutate', {
          'default/createTodo': { params: { id: 'rc2', title: 'during-gap', done: false } }
        })
      );

      const second = sseDriver(harness);
      try {
        await second.open('subscribe', 'rc-2', frame);
        await waitFor(() => second.frames().length >= 1);
        expect(second.frames()[0]?.kind).toBe('snapshot');
        expect(second.frames()[0]?.rows).toHaveLength(2);
        expect(second.frames().some((f) => f.kind === 'add')).toBe(false);
      } finally {
        second.close();
      }
    });

    it('recall/Hit query: seeded virtual-namespace frame returns ordered hits', async () => {
      await scenarioRecallHitQuery(harness);
    });

    it('recall/boost mutation: virtual-namespace frame acks { id: ack, ok, requested }', async () => {
      await scenarioRecallBoostMutation(harness);
    });

    it('recall/Cluster query: seeded cluster surface returns its fields, no centroid', async () => {
      await scenarioClusterQuery(harness);
    });

    it('recall/ClusterMember query: lists members of a cluster in attach order', async () => {
      await scenarioClusterMemberQuery(harness);
    });

    it('recall/ClusterMember query: refused as bad_request without cluster or member triple', async () => {
      await scenarioClusterMemberBadRequest(harness);
    });

    it('recall/labelCluster mutation: replaces the label and marks it agent-authored', async () => {
      await scenarioLabelClusterMutation(harness);
    });
  });
}

describe('§9.4 parity: cross-server byte-identical outputs', () => {
  it('schema JSON is identical across servers', async () => {
    const [memSchema, fastSchema] = await Promise.all([
      captureSchema(memoryHarness),
      captureSchema(fastifyHarness)
    ]);
    expect(fastSchema).toEqual(memSchema);
  });

  it('ordered Todo list is identical across servers for the same seeded data', async () => {
    const [memRows, fastRows] = await Promise.all([
      captureOrderedTodos(memoryHarness),
      captureOrderedTodos(fastifyHarness)
    ]);
    expect(fastRows).toEqual(memRows);
  });

  it('recall/Hit hits are identical across servers for the same fixed-vector seed', async () => {
    const [memHits, fastHits] = await Promise.all([
      captureRecallHits(memoryHarness),
      captureRecallHits(fastifyHarness)
    ]);
    expect(fastHits).toEqual(memHits);
  });

  it('recall/boost ack is identical across servers', async () => {
    const [memAck, fastAck] = await Promise.all([
      captureRecallBoostAck(memoryHarness),
      captureRecallBoostAck(fastifyHarness)
    ]);
    expect(fastAck).toEqual(memAck);
    expect(memAck).toEqual({ id: 'ack', ok: true, requested: 2 });
  });

  it('recall/Cluster rows are identical across servers for the same fixed seed', async () => {
    const [memRows, fastRows] = await Promise.all([
      captureClusterRows(memoryHarness),
      captureClusterRows(fastifyHarness)
    ]);
    expect(fastRows).toEqual(memRows);
  });

  it('recall/ClusterMember rows are identical across servers for the same fixed seed', async () => {
    const [memRows, fastRows] = await Promise.all([
      captureClusterMemberRows(memoryHarness),
      captureClusterMemberRows(fastifyHarness)
    ]);
    expect(fastRows).toEqual(memRows);
  });

  it('recall/labelCluster ack is identical across servers', async () => {
    const [memAck, fastAck] = await Promise.all([
      captureLabelClusterAck(memoryHarness),
      captureLabelClusterAck(fastifyHarness)
    ]);
    expect(fastAck).toEqual(memAck);
  });
});

// ---------------------------------------------------------------------------
// §shortId parity: identical shortId behaviour across MemorySubstrateServer and
// FastifySubstrateServer.  The `demo-types.ts` Todo type ships with a readonly
// `shortId` field (indexed) so the scenarios below can exercise the full
// HTTP path rather than calling the engine directly.
// ---------------------------------------------------------------------------

async function scenarioShortIdMonotonic(h: HarnessHandle): Promise<void> {
  // Create two Todos — each should get sequential shortIds starting at 1.
  const r1 = await h.inject(
    asJsonRequest('/substrate/v1/mutate', {
      'default/createTodo': {
        params: { title: 'short-first', done: false },
        fields: { id: true, shortId: true }
      }
    })
  );
  expect(r1.status).toBe(200);
  const t1 = jsonBody<PackEnvelope>(r1).data['default/createTodo'] as {
    id: string;
    shortId: number;
  };
  expect(typeof t1.shortId).toBe('number');
  expect(t1.shortId).toBeGreaterThanOrEqual(1);

  const r2 = await h.inject(
    asJsonRequest('/substrate/v1/mutate', {
      'default/createTodo': {
        params: { title: 'short-second', done: false },
        fields: { id: true, shortId: true }
      }
    })
  );
  const t2 = jsonBody<PackEnvelope>(r2).data['default/createTodo'] as {
    id: string;
    shortId: number;
  };
  expect(t2.shortId).toBe(t1.shortId + 1);
}

async function scenarioShortIdUpdateByShortId(h: HarnessHandle): Promise<void> {
  // Create a Todo, then update it by passing the shortId as the `id` param.
  const createRes = await h.inject(
    asJsonRequest('/substrate/v1/mutate', {
      'default/createTodo': {
        params: { title: 'original-title', done: false },
        fields: { id: true, shortId: true }
      }
    })
  );
  const created = jsonBody<PackEnvelope>(createRes).data['default/createTodo'] as {
    id: string;
    shortId: number;
  };
  const uuid = created.id;
  const shortId = created.shortId;

  // Update using the string-form shortId as the id parameter.
  const updateRes = await h.inject(
    asJsonRequest('/substrate/v1/mutate', {
      'default/updateTodo': {
        params: { id: String(shortId), title: 'updated-title' },
        fields: { id: true, title: true, shortId: true }
      }
    })
  );
  expect(updateRes.status).toBe(200);
  const updated = jsonBody<PackEnvelope>(updateRes).data['default/updateTodo'] as {
    id: string;
    title: string;
    shortId: number;
  };
  // The update must resolve to the original UUID row.
  expect(updated.id).toBe(uuid);
  expect(updated.title).toBe('updated-title');
  // shortId is preserved after update.
  expect(updated.shortId).toBe(shortId);
}

async function scenarioShortIdWhereFilter(h: HarnessHandle): Promise<void> {
  // Create 3 Todos and confirm where.shortId.eq returns only the matching row.
  const ids: Array<{ id: string; shortId: number }> = [];
  for (let i = 1; i <= 3; i++) {
    const r = await h.inject(
      asJsonRequest('/substrate/v1/mutate', {
        'default/createTodo': {
          params: { title: `filter-todo-${i}`, done: false },
          fields: { id: true, shortId: true }
        }
      })
    );
    const t = jsonBody<PackEnvelope>(r).data['default/createTodo'] as {
      id: string;
      shortId: number;
    };
    ids.push(t);
  }

  // Query by the second Todo's shortId.
  const target = ids[1];
  if (target === undefined) throw new Error('expected at least 3 todos');

  const listRes = await h.inject(
    asJsonRequest('/substrate/v1/query', {
      'default/Todo': {
        params: { where: { shortId: { eq: target.shortId } } },
        fields: { id: true, shortId: true }
      }
    })
  );
  expect(listRes.status).toBe(200);
  const rows = jsonBody<PackEnvelope>(listRes).data['default/Todo'] as Array<{
    id: string;
    shortId: number;
  }>;
  expect(rows).toHaveLength(1);
  expect(rows[0]?.id).toBe(target.id);
  expect(rows[0]?.shortId).toBe(target.shortId);
}

async function scenarioShortIdRejectCallerSupplied(h: HarnessHandle): Promise<void> {
  // Supplying shortId explicitly on createTodo must be rejected.
  const res = await h.inject(
    asJsonRequest('/substrate/v1/mutate', {
      'default/createTodo': {
        params: { title: 'bad-create', done: false, shortId: 42 },
        fields: { id: true }
      }
    })
  );
  expect(res.status).toBe(200);
  const env = jsonBody<PackEnvelope>(res);
  // The engine surfaces resolver errors as envelope errors, not HTTP errors.
  const err = env.errors?.[0];
  expect(err).toBeDefined();
  const errStr = JSON.stringify(err ?? {});
  expect(errStr).toMatch(/shortId|readonly/i);
}

for (const { name, factory } of SERVERS) {
  describe(`§shortId parity: ${name}`, () => {
    let harness: HarnessHandle;

    beforeEach(async () => {
      harness = await factory();
    });

    afterEach(async () => {
      await harness.teardown();
    });

    it('shortId is monotonic per type across creates', async () => {
      await scenarioShortIdMonotonic(harness);
    });

    it('update-by-shortId resolves to the UUID row', async () => {
      await scenarioShortIdUpdateByShortId(harness);
    });

    it('where.shortId.eq filter returns only the matching row', async () => {
      await scenarioShortIdWhereFilter(harness);
    });

    it('caller-supplied shortId on create is rejected', async () => {
      await scenarioShortIdRejectCallerSupplied(harness);
    });
  });
}

// ---------------------------------------------------------------------------
// §5.12 drop-namespace + drop-type parity.  The same three scenarios run
// against both MemorySubstrateServer and FastifySubstrateServer to exercise the admin
// routes POST /substrate/v1/_system/drop-namespace and POST /substrate/v1/_system/drop-type.
// Auth is disabled in both harnesses (no `auth` passed to compose), so admin
// routes are open — mirroring the pattern used for every other scenario above.
// ---------------------------------------------------------------------------

async function scenarioDropNamespaceDryRunThenReal(h: HarnessHandle): Promise<void> {
  // Seed two Todo rows in the default namespace.
  await h.inject(
    asJsonRequest('/substrate/v1/mutate', {
      'default/createTodo': [
        { params: { id: 'dn-a', title: 'drop-ns-a', done: false }, fields: { id: true } },
        { params: { id: 'dn-b', title: 'drop-ns-b', done: false }, fields: { id: true } }
      ]
    })
  );

  // Verify rows are present before dry-run.
  const before = await h.inject(
    asJsonRequest('/substrate/v1/query', {
      'default/Todo': {
        params: { where: { title: { startsWith: 'drop-ns-' } } },
        fields: { id: true }
      }
    })
  );
  const beforeRows = jsonBody<PackEnvelope>(before).data['default/Todo'] as Array<{
    id: string;
  }>;
  expect(beforeRows).toHaveLength(2);

  // Dry-run drop — should report 2+ rows deleted but mutate nothing.
  const dry = await h.inject(
    asJsonRequest('/substrate/v1/_system/drop-namespace', {
      namespace: 'default',
      confirm: 'default',
      dryRun: true
    })
  );
  expect(dry.status).toBe(200);
  const dryBody = jsonBody<Record<string, unknown>>(dry);
  expect(dryBody.dryRun).toBe(true);
  expect(dryBody.cascade).toBe('refuse');
  // rowsDeleted must be at least 2 (could include rows from other tests if
  // they somehow leaked, but fresh beforeEach guarantees isolation).
  expect(dryBody.rowsDeleted).toBeGreaterThanOrEqual(2);

  // Rows must still be present after dry-run.
  const stillThere = await h.inject(
    asJsonRequest('/substrate/v1/query', {
      'default/Todo': {
        params: { where: { title: { startsWith: 'drop-ns-' } } },
        fields: { id: true }
      }
    })
  );
  const stillRows = jsonBody<PackEnvelope>(stillThere).data['default/Todo'] as Array<{
    id: string;
  }>;
  expect(stillRows).toHaveLength(2);

  // Real drop — wipes the entire namespace.
  const drop = await h.inject(
    asJsonRequest('/substrate/v1/_system/drop-namespace', {
      namespace: 'default',
      confirm: 'default'
    })
  );
  expect(drop.status).toBe(200);
  const dropBody = jsonBody<Record<string, unknown>>(drop);
  expect(dropBody.dryRun).toBe(false);
  expect(dropBody.cascade).toBe('refuse');
  expect(dropBody.rowsDeleted).toBeGreaterThanOrEqual(2);
  expect(typeof dropBody.auditEventId).toBe('string');

  // After the real drop the namespace is tombstoned on the engine, so a
  // follow-up query against `default/*` returns a per-key
  // `namespace_tombstoned` error rather than an empty list. This is the
  // contract: drop hides the namespace from the schema/dispatch surface in
  // the same operation that wipes the rows, not at the next restart.
  const after = await h.inject(
    asJsonRequest('/substrate/v1/query', {
      'default/Todo': {
        params: { where: { title: { startsWith: 'drop-ns-' } } },
        fields: { id: true }
      }
    })
  );
  const afterEnv = jsonBody<PackEnvelope>(after);
  expect(afterEnv.data['default/Todo']).toBeUndefined();
  expect(afterEnv.errors?.[0]?.code).toBe('namespace_tombstoned');
}

async function scenarioDropNamespace409DanglingEdges(h: HarnessHandle): Promise<void> {
  // Seed a Todo and a Tag that cross-references it.  The autoCRUD Tag resolver
  // writes an EdgesStore edge from (default, Tag, tagId) → (default, Todo, todoId)
  // when todoId is provided.  Both endpoints are in the default namespace, so
  // findEdgesTouchingNamespace('default', …) returns ≥1 entry.
  await h.inject(
    asJsonRequest('/substrate/v1/mutate', {
      'default/createTodo': { params: { id: 'de-todo', title: 'edge-parent', done: false } }
    })
  );
  await h.inject(
    asJsonRequest('/substrate/v1/mutate', {
      'default/createTag': { params: { id: 'de-tag', label: 'linked', todoId: 'de-todo' } }
    })
  );

  // Confirm the edge was recorded before we try the drop.
  const edgesBefore = await h.composed.edges.findEdgesTouchingNamespace('default', 10);
  expect(edgesBefore.length).toBeGreaterThan(0);

  // Drop without cascade — should refuse with 409.
  const res = await h.inject(
    asJsonRequest('/substrate/v1/_system/drop-namespace', {
      namespace: 'default',
      confirm: 'default'
    })
  );
  expect(res.status).toBe(409);
  const body = jsonBody<Record<string, unknown>>(res);
  expect(body.code).toBe('dangling_edges');
  expect(typeof body.edgeCount === 'number' && body.edgeCount > 0).toBe(true);

  // Rows are NOT deleted — the namespace is intact.
  const check = await h.inject(
    asJsonRequest('/substrate/v1/query', {
      'default/Todo': { params: { where: { id: { eq: 'de-todo' } } }, fields: { id: true } }
    })
  );
  const checkRows = jsonBody<PackEnvelope>(check).data['default/Todo'] as Array<{
    id: string;
  }>;
  expect(checkRows).toHaveLength(1);
}

async function scenarioDropTypeScoped(h: HarnessHandle): Promise<void> {
  // Seed one Todo and one Tag.  No crossRef edge — pass no todoId to Tag so
  // the edges store stays clean and cascade=refuse on drop-type won't 409.
  await h.inject(
    asJsonRequest('/substrate/v1/mutate', {
      'default/createTodo': { params: { id: 'dt-todo', title: 'will-be-dropped', done: false } }
    })
  );
  await h.inject(
    asJsonRequest('/substrate/v1/mutate', {
      'default/createTag': { params: { id: 'dt-tag', label: 'survivor' } }
    })
  );

  // Drop only the Todo type.
  const drop = await h.inject(
    asJsonRequest('/substrate/v1/_system/drop-type', {
      namespace: 'default',
      type: 'Todo',
      confirm: 'default/Todo'
    })
  );
  expect(drop.status).toBe(200);
  const dropBody = jsonBody<Record<string, unknown>>(drop);
  expect(dropBody.namespace).toBe('default');
  expect(dropBody.type).toBe('Todo');
  expect(dropBody.dryRun).toBe(false);
  expect((dropBody.rowsDeleted as number) >= 1).toBe(true);

  // Todo is gone.
  const todoCheck = await h.inject(
    asJsonRequest('/substrate/v1/query', {
      'default/Todo': { params: { where: { id: { eq: 'dt-todo' } } }, fields: { id: true } }
    })
  );
  const todoRows = jsonBody<PackEnvelope>(todoCheck).data['default/Todo'] as Array<{
    id: string;
  }>;
  expect(todoRows).toHaveLength(0);

  // Tag is intact.
  const tagCheck = await h.inject(
    asJsonRequest('/substrate/v1/query', {
      'default/getTag': { params: { id: 'dt-tag' } }
    })
  );
  const tag = jsonBody<PackEnvelope>(tagCheck).data['default/getTag'] as {
    id: string;
    label: string;
  } | null;
  expect(tag).not.toBeNull();
  expect(tag?.id).toBe('dt-tag');
  expect(tag?.label).toBe('survivor');
}

for (const { name, factory } of SERVERS) {
  describe(`§5.12 drop parity: ${name}`, () => {
    let harness: HarnessHandle;

    beforeEach(async () => {
      harness = await factory();
    });

    afterEach(async () => {
      await harness.teardown();
    });

    it('drop-namespace: dry-run reports counts but leaves rows intact, then real drop removes them', async () => {
      await scenarioDropNamespaceDryRunThenReal(harness);
    });

    it('drop-namespace: refuses with 409 when dangling edges reference the namespace', async () => {
      await scenarioDropNamespace409DanglingEdges(harness);
    });

    it('drop-type: drops only the targeted type, leaves other types intact', async () => {
      await scenarioDropTypeScoped(harness);
    });
  });
}

// ---------------------------------------------------------------------------
// §row-metadata parity.
//
// Verifies that MemorySubstrateServer and FastifySubstrateServer behave identically
// for the five row-metadata invariants:
//   1. create populates _metadata from ctx.now + resolveIdentity(ctx)
//   2. update bumps updatedAt + updatedBy
//   3. update preserves createdAt + createdBy
//   4. where filter on createdAt range
//   5. upsert without _metadata preserves existing metadata (COALESCE)
//
// Auth is not configured in either harness, which compose with
// `systemActor: 'test'`, so resolveIdentity returns { kind: 'system', id: 'test' }
// on both — proving the DECLARED actor reaches the row.
// ---------------------------------------------------------------------------

async function scenarioMetadataCreate(h: HarnessHandle): Promise<void> {
  const res = await h.inject(
    asJsonRequest('/substrate/v1/mutate', {
      'default/createTodo': {
        params: { id: 'meta-c1', title: 'meta-create', done: false },
        fields: { id: true, _metadata: true }
      }
    })
  );
  expect(res.status).toBe(200);
  const env = jsonBody<PackEnvelope>(res);
  const row = env.data['default/createTodo'] as {
    id: string;
    _metadata: {
      createdAt: string;
      updatedAt: string;
      createdBy: { kind: string; id: string };
      updatedBy: { kind: string; id: string };
    };
  };
  expect(row.id).toBe('meta-c1');
  // Both timestamps must be present ISO strings.
  expect(typeof row._metadata.createdAt).toBe('string');
  expect(typeof row._metadata.updatedAt).toBe('string');
  // createdAt === updatedAt on initial create.
  expect(row._metadata.createdAt).toBe(row._metadata.updatedAt);
  // No auth → the deployment's declared actor.
  expect(row._metadata.createdBy).toEqual({ kind: 'system', id: 'test' });
  expect(row._metadata.updatedBy).toEqual({ kind: 'system', id: 'test' });
}

async function scenarioMetadataUpdateBumps(h: HarnessHandle): Promise<void> {
  // Create first — capture createdAt from the response.
  const createRes = await h.inject(
    asJsonRequest('/substrate/v1/mutate', {
      'default/createTodo': {
        params: { id: 'meta-u1', title: 'before', done: false },
        fields: { id: true, _metadata: true }
      }
    })
  );
  const created = jsonBody<PackEnvelope>(createRes).data['default/createTodo'] as {
    _metadata: { createdAt: string; updatedAt: string };
  };
  const createdAt = created._metadata.createdAt;

  // Small delay to ensure updatedAt > createdAt (clock advances at least 1 ms).
  await new Promise<void>((resolve) => setTimeout(resolve, 2));

  // Update the row.
  const updateRes = await h.inject(
    asJsonRequest('/substrate/v1/mutate', {
      'default/updateTodo': {
        params: { id: 'meta-u1', title: 'after' },
        fields: { id: true, _metadata: true }
      }
    })
  );
  expect(updateRes.status).toBe(200);
  const updated = jsonBody<PackEnvelope>(updateRes).data['default/updateTodo'] as {
    _metadata: {
      createdAt: string;
      updatedAt: string;
      createdBy: { kind: string; id: string };
      updatedBy: { kind: string; id: string };
    };
  };
  // updatedAt must not precede createdAt.
  expect(new Date(updated._metadata.updatedAt).getTime()).toBeGreaterThanOrEqual(
    new Date(createdAt).getTime()
  );
  // createdAt must be preserved exactly.
  expect(updated._metadata.createdAt).toBe(createdAt);
  // Both actors remain the declared system actor (no auth in harness).
  expect(updated._metadata.updatedBy).toEqual({ kind: 'system', id: 'test' });
  expect(updated._metadata.createdBy).toEqual({ kind: 'system', id: 'test' });
}

async function scenarioMetadataCreatedAtFilter(h: HarnessHandle): Promise<void> {
  // Seed three rows in a controlled time range via explicit createdAt on the row.
  // The engine sets ctx.now for _metadata.createdAt — we need rows to arrive at
  // different wall-clock times so we can filter by range. Use a small real delay
  // between each create so the clock actually advances.
  const ids: Array<{ id: string; createdAt: string }> = [];
  for (let i = 1; i <= 3; i++) {
    const res = await h.inject(
      asJsonRequest('/substrate/v1/mutate', {
        'default/createTodo': {
          params: { id: `meta-f${i}`, title: `filter-row-${i}`, done: false },
          fields: { id: true, _metadata: true }
        }
      })
    );
    const row = jsonBody<PackEnvelope>(res).data['default/createTodo'] as {
      id: string;
      _metadata: { createdAt: string };
    };
    ids.push({ id: row.id, createdAt: row._metadata.createdAt });
    // Ensure each row has a distinct createdAt so the range filter is deterministic.
    await new Promise<void>((resolve) => setTimeout(resolve, 2));
  }

  // Use the second row's createdAt as the lower bound — expect rows 2 and 3.
  const cutoff = ids[1]?.createdAt;
  if (cutoff === undefined) throw new Error('expected at least 3 rows');

  const filterRes = await h.inject(
    asJsonRequest('/substrate/v1/query', {
      'default/Todo': {
        params: {
          where: { createdAt: { gte: cutoff } }
        },
        fields: { id: true }
      }
    })
  );
  expect(filterRes.status).toBe(200);
  const rows = jsonBody<PackEnvelope>(filterRes).data['default/Todo'] as Array<{
    id: string;
  }>;
  const returnedIds = rows.map((r) => r.id).sort();
  // Rows 2 and 3 should be present; row 1 was created before the cutoff.
  expect(returnedIds).toContain('meta-f2');
  expect(returnedIds).toContain('meta-f3');
  expect(returnedIds).not.toContain('meta-f1');
}

async function scenarioMetadataCreatedByKindFilter(h: HarnessHandle): Promise<void> {
  // All rows created without auth → the deployment's declared actor.
  // createdByKind is a virtual filter key the engine's schema validator
  // accepts, so this scenario goes through /substrate/v1/query like any other filter.
  await h.inject(
    asJsonRequest('/substrate/v1/mutate', {
      'default/createTodo': {
        params: { id: 'meta-k1', title: 'kind-row-1', done: false }
      }
    })
  );
  await h.inject(
    asJsonRequest('/substrate/v1/mutate', {
      'default/createTodo': {
        params: { id: 'meta-k2', title: 'kind-row-2', done: false }
      }
    })
  );

  // Filter by createdByKind = 'system' through the engine — both rows must appear.
  const sysRes = await h.inject(
    asJsonRequest('/substrate/v1/query', {
      'default/Todo': {
        params: { where: { createdByKind: { eq: 'system' } } },
        fields: { id: true }
      }
    })
  );
  expect(sysRes.status).toBe(200);
  const sysRows = jsonBody<PackEnvelope>(sysRes).data['default/Todo'] as Array<{
    id: string;
  }>;
  const sysIds = sysRows.map((r) => r.id);
  expect(sysIds).toContain('meta-k1');
  expect(sysIds).toContain('meta-k2');

  // Filter by createdByKind = 'agent' — neither row matches.
  const agentRes = await h.inject(
    asJsonRequest('/substrate/v1/query', {
      'default/Todo': {
        params: { where: { createdByKind: { eq: 'agent' } } },
        fields: { id: true }
      }
    })
  );
  expect(agentRes.status).toBe(200);
  const agentRows = jsonBody<PackEnvelope>(agentRes).data['default/Todo'] as Array<{
    id: string;
  }>;
  const agentIds = agentRows.map((r) => r.id);
  expect(agentIds).not.toContain('meta-k1');
  expect(agentIds).not.toContain('meta-k2');
}

async function scenarioMetadataCreatedByIdFilter(h: HarnessHandle): Promise<void> {
  // No auth → the deployment's declared actor.
  // Filter by createdById through the engine.
  await h.inject(
    asJsonRequest('/substrate/v1/mutate', {
      'default/createTodo': {
        params: { id: 'meta-bid1', title: 'byid-row-1', done: false }
      }
    })
  );

  const matchRes = await h.inject(
    asJsonRequest('/substrate/v1/query', {
      'default/Todo': {
        params: { where: { createdById: { eq: 'test' } } },
        fields: { id: true }
      }
    })
  );
  expect(matchRes.status).toBe(200);
  const matchRows = jsonBody<PackEnvelope>(matchRes).data['default/Todo'] as Array<{
    id: string;
  }>;
  expect(matchRows.map((r) => r.id)).toContain('meta-bid1');

  const noMatchRes = await h.inject(
    asJsonRequest('/substrate/v1/query', {
      'default/Todo': {
        params: { where: { createdById: { eq: 'nobody' } } },
        fields: { id: true }
      }
    })
  );
  expect(noMatchRes.status).toBe(200);
  const noMatchRows = jsonBody<PackEnvelope>(noMatchRes).data['default/Todo'] as Array<{
    id: string;
  }>;
  expect(noMatchRows.map((r) => r.id)).not.toContain('meta-bid1');
}

async function scenarioMetadataAuthorSpellings(h: HarnessHandle): Promise<void> {
  // No auth → the deployment's declared actor, { kind: 'system', id: 'test' }.
  // Every spelling the read path teaches filters like createdById / createdByKind.
  await h.inject(
    asJsonRequest('/substrate/v1/mutate', {
      'default/createTodo': { params: { id: 'meta-alias1', title: 'alias-row', done: false } }
    })
  );
  const idsFor = async (params: Record<string, unknown>): Promise<string[]> => {
    const res = await h.inject(
      asJsonRequest('/substrate/v1/query', { 'default/Todo': { params, fields: { id: true } } })
    );
    expect(res.status).toBe(200);
    const env = jsonBody<PackEnvelope>(res);
    expect(env.errors ?? []).toEqual([]);
    return (env.data['default/Todo'] as Array<{ id: string }>).map((r) => r.id);
  };

  const matching: Record<string, unknown>[] = [
    { createdBy: { eq: 'test' } },
    { createdBy: { eq: { kind: 'system', id: 'test' } } },
    { createdBy: { in: [{ kind: 'system', id: 'test' }, 'nobody'] } },
    { createdBy: { id: { eq: 'test' }, kind: { eq: 'system' } } },
    { 'createdBy.id': { eq: 'test' } },
    { createdBy: { path: ['kind'], eq: 'system' } },
    { _metadata: { createdBy: { eq: { kind: 'system', id: 'test' } } } },
    { '_metadata.updatedBy.kind': { eq: 'system' } },
    { updatedBy: { eq: 'test' } }
  ];
  for (const where of matching) {
    expect(await idsFor({ where }), JSON.stringify(where)).toContain('meta-alias1');
  }

  const excluding: Record<string, unknown>[] = [
    { createdBy: { eq: 'nobody' } },
    { createdBy: { eq: { kind: 'agent', id: 'test' } } },
    { createdBy: { neq: { kind: 'system', id: 'test' } } },
    { createdBy: { nin: [{ id: 'test' }] } }
  ];
  for (const where of excluding) {
    expect(await idsFor({ where }), JSON.stringify(where)).not.toContain('meta-alias1');
  }

  expect(
    await idsFor({ orderBy: [{ createdBy: 'asc' }, { '_metadata.createdAt': 'desc' }] })
  ).toContain('meta-alias1');
}

async function scenarioMetadataUnknownSpellingHint(h: HarnessHandle): Promise<void> {
  const res = await h.inject(
    asJsonRequest('/substrate/v1/query', {
      'default/Todo': {
        params: { where: { '_metadata.author': { eq: 'x' } } },
        fields: { id: true }
      }
    })
  );
  const env = jsonBody<PackEnvelope>(res);
  expect(env.data['default/Todo']).toBeUndefined();
  expect(env.errors?.[0]?.code).toBe('unknown_field');
  expect(env.errors?.[0]?.message).toContain('createdById');
}

async function scenarioMetadataUpdatedByKindFilter(h: HarnessHandle): Promise<void> {
  // Create a row, update it, then filter by updatedByKind through the engine.
  await h.inject(
    asJsonRequest('/substrate/v1/mutate', {
      'default/createTodo': {
        params: { id: 'meta-ubk1', title: 'ubykind-before', done: false }
      }
    })
  );
  await h.inject(
    asJsonRequest('/substrate/v1/mutate', {
      'default/updateTodo': {
        params: { id: 'meta-ubk1', title: 'ubykind-after' }
      }
    })
  );

  const res = await h.inject(
    asJsonRequest('/substrate/v1/query', {
      'default/Todo': {
        params: { where: { updatedByKind: { eq: 'system' } } },
        fields: { id: true }
      }
    })
  );
  expect(res.status).toBe(200);
  const rows = jsonBody<PackEnvelope>(res).data['default/Todo'] as Array<{ id: string }>;
  expect(rows.map((r) => r.id)).toContain('meta-ubk1');
}

async function scenarioMetadataUpdatedByIdFilter(h: HarnessHandle): Promise<void> {
  // Create a row, then filter by updatedById through the engine.
  await h.inject(
    asJsonRequest('/substrate/v1/mutate', {
      'default/createTodo': {
        params: { id: 'meta-ubid1', title: 'ubyid-row', done: false }
      }
    })
  );

  const res = await h.inject(
    asJsonRequest('/substrate/v1/query', {
      'default/Todo': {
        params: { where: { updatedById: { eq: 'test' } } },
        fields: { id: true }
      }
    })
  );
  expect(res.status).toBe(200);
  const rows = jsonBody<PackEnvelope>(res).data['default/Todo'] as Array<{ id: string }>;
  expect(rows.map((r) => r.id)).toContain('meta-ubid1');
}

async function scenarioMetadataCoalescePreservation(h: HarnessHandle): Promise<void> {
  // Create a row — captures the original createdAt.
  const createRes = await h.inject(
    asJsonRequest('/substrate/v1/mutate', {
      'default/createTodo': {
        params: { id: 'meta-coa1', title: 'coalesce', done: false },
        fields: { id: true, _metadata: true }
      }
    })
  );
  const original = jsonBody<PackEnvelope>(createRes).data['default/createTodo'] as {
    _metadata: { createdAt: string; createdBy: { kind: string; id: string } };
  };
  const originalCreatedAt = original._metadata.createdAt;
  const originalCreatedBy = original._metadata.createdBy;

  // Update using updateTodo — should preserve createdAt + createdBy (COALESCE fix).
  const updateRes = await h.inject(
    asJsonRequest('/substrate/v1/mutate', {
      'default/updateTodo': {
        params: { id: 'meta-coa1', title: 'coalesced' },
        fields: { id: true, _metadata: true }
      }
    })
  );
  expect(updateRes.status).toBe(200);
  const afterUpdate = jsonBody<PackEnvelope>(updateRes).data['default/updateTodo'] as {
    _metadata: { createdAt: string; createdBy: { kind: string; id: string }; updatedAt: string };
  };

  // createdAt + createdBy must be preserved exactly (COALESCE behaviour).
  expect(afterUpdate._metadata.createdAt).toBe(originalCreatedAt);
  expect(afterUpdate._metadata.createdBy).toEqual(originalCreatedBy);
  // updatedAt must be present (not null).
  expect(typeof afterUpdate._metadata.updatedAt).toBe('string');
}

for (const { name, factory } of SERVERS) {
  describe(`§row-metadata parity: ${name}`, () => {
    let harness: HarnessHandle;

    beforeEach(async () => {
      harness = await factory();
    });

    afterEach(async () => {
      await harness.teardown();
    });

    it('create populates _metadata with createdAt = updatedAt and system/anonymous actor', async () => {
      await scenarioMetadataCreate(harness);
    });

    it('update bumps updatedAt + updatedBy, preserves createdAt + createdBy', async () => {
      await scenarioMetadataUpdateBumps(harness);
    });

    it('where.createdAt.gte range filter returns only rows at or after the cutoff', async () => {
      await scenarioMetadataCreatedAtFilter(harness);
    });

    it('where.createdByKind.eq filter returns matching rows only (engine path)', async () => {
      await scenarioMetadataCreatedByKindFilter(harness);
    });

    it('where.createdById.eq filter returns matching rows only (engine path)', async () => {
      await scenarioMetadataCreatedByIdFilter(harness);
    });

    it('filters and orders on the author spellings the read path returns (createdBy, _metadata, paths)', async () => {
      await scenarioMetadataAuthorSpellings(harness);
    });

    it('an unrecognised _metadata spelling is refused naming the metadata columns', async () => {
      await scenarioMetadataUnknownSpellingHint(harness);
    });

    it('where.updatedByKind.eq filter returns matching rows only (engine path)', async () => {
      await scenarioMetadataUpdatedByKindFilter(harness);
    });

    it('where.updatedById.eq filter returns matching rows only (engine path)', async () => {
      await scenarioMetadataUpdatedByIdFilter(harness);
    });

    it('update without _metadata in params preserves previously-written metadata (COALESCE)', async () => {
      await scenarioMetadataCoalescePreservation(harness);
    });
  });
}

// ---------------------------------------------------------------------------
// §engine-metrics-surface parity: observeRequests fires identically on
// both transports for /substrate/v1/query and /substrate/v1/mutate.
//
// The harness uses compose() which already wires real routes — registering a
// second handler on the same path would conflict. Instead we construct bare
// server instances directly (no compose), register stub handlers, and iterate
// the two transports in one test. The goal: identical observations across both.
// ---------------------------------------------------------------------------

describe('§engine-metrics-surface parity: observeRequests identical across transports', () => {
  it('observeRequests reports query + mutate ops on MemorySubstrateServer and FastifySubstrateServer identically', async () => {
    // Use bare server instances (no compose) so we can register stub handlers
    // without conflicting with compose's real /substrate/v1/query + /substrate/v1/mutate routes.
    // Both inject calls include content-type: application/json so Fastify's built-in
    // body parser accepts the payload rather than returning 415.
    async function checkTransport(
      server: SubstrateServer
    ): Promise<Array<{ op: string; ok: boolean; durationMs: number }>> {
      // Guard-and-throw rather than `inject!` so a future transport lacking these
      // optional members fails loudly here, not with a cryptic TypeError downstream.
      if (server.observeRequests === undefined) throw new Error('observeRequests unavailable');
      if (server.inject === undefined) throw new Error('inject unavailable');
      const seen: Array<{ op: string; ok: boolean; durationMs: number }> = [];
      server.observeRequests((o) => seen.push({ op: o.op, ok: o.ok, durationMs: o.durationMs }));
      server.route('POST', '/substrate/v1/query', () => ({ status: 200 }));
      server.route('POST', '/substrate/v1/mutate', () => ({ status: 200 }));
      await server.inject({
        method: 'POST',
        path: '/substrate/v1/query',
        headers: { 'content-type': 'application/json' },
        body: Buffer.from('{}')
      });
      await server.inject({
        method: 'POST',
        path: '/substrate/v1/mutate',
        headers: { 'content-type': 'application/json' },
        body: Buffer.from('{}')
      });
      await server.stop();
      return seen;
    }

    const memorySeen = await checkTransport(new MemorySubstrateServer());
    const fastifySeen = await checkTransport(new FastifySubstrateServer());

    // durationMs is timing-dependent — assert it's a number, not a fixed value.
    const expected = [
      { op: 'query', ok: true, durationMs: expect.any(Number) },
      { op: 'mutate', ok: true, durationMs: expect.any(Number) }
    ];
    expect(memorySeen).toEqual(expected);
    expect(fastifySeen).toEqual(expected);
  });
});

// ---------------------------------------------------------------------------
// NOT COVERED: §9.4 also calls for bridge-federated query +
// subscribe-with-pushed-update parity. The scenarios above cover
// same-namespace crossRefs and the WS subscribe-push contract in isolation.
// ---------------------------------------------------------------------------

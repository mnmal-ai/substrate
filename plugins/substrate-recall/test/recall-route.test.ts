import type { Embedder } from '@mnmal-ai/substrate-embedder';
import { FakeEmbedder } from '@mnmal-ai/substrate-embedder/fake';
import type { Edge, EdgeRef, EdgesStore, SubstrateRequest } from '@mnmal-ai/substrate-types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEmbedStats } from '../src/embed-stats.js';
import type { EmbeddingsStore, EmbeddingsStoreKnnInput } from '../src/embeddings-store.js';
import { type ExpansionConfig, makeExpansionResolver } from '../src/expansion-resolver.js';
import { MAX_RECALL_QUERY_CHARS } from '../src/recall/handler.js';
import {
  type ExpansionResolver,
  handleRecallRequest,
  recallRouteHandler
} from '../src/recall-route.js';
import { SpreadEdgeRegistry } from '../src/spread-resolver.js';

function makeStore(
  opts: {
    knnImpl?: (input: EmbeddingsStoreKnnInput) => Promise<
      Array<{
        row: Record<string, unknown>;
        score: number;
        salience?: number;
        vector?: number[];
      }>
    >;
  } = {}
): { store: EmbeddingsStore; calls: EmbeddingsStoreKnnInput[] } {
  const calls: EmbeddingsStoreKnnInput[] = [];
  const knnImpl = opts.knnImpl ?? (async () => []);
  const store: EmbeddingsStore = {
    txScopeId: 'test-store',
    delete: async () => undefined,
    upsert: async () => undefined,
    knnSearch: async (input) => {
      calls.push(input);
      const raw = await knnImpl(input);
      return raw.map((r) => ({
        row: r.row,
        score: r.score,
        salience: r.salience ?? 0,
        ...(r.vector !== undefined ? { vector: r.vector } : {})
      }));
    },
    boostSalience: async () => [],
    fetchEmbeddings: async () => [],
    selectCandidates: async () => []
  };
  return { store, calls };
}

function makePostReq(body: unknown): SubstrateRequest {
  return {
    method: 'POST',
    path: '/substrate/v1/recall',
    headers: { 'content-type': 'application/json' },
    query: {},
    params: {},
    body: Buffer.from(JSON.stringify(body), 'utf8')
  };
}

/**
 * Pin the namespace for every test in this file.
 *
 * `handleRecallRequest` resolves its namespace from `process.env.SUBSTRATE_NAMESPACE`
 * when the request omits one, and turbo forwards only the env vars declared
 * in turbo.json, so an ambient value would make results depend on how the
 * suite was invoked. Tests that exercise resolution itself override or
 * delete it in their own body — `beforeEach` has already run by then.
 */
const PRIOR_SUBSTRATE_NS = process.env.SUBSTRATE_NAMESPACE;
beforeEach(() => {
  process.env.SUBSTRATE_NAMESPACE = 'ns-under-test';
});
afterEach(() => {
  if (PRIOR_SUBSTRATE_NS === undefined) delete process.env.SUBSTRATE_NAMESPACE;
  else process.env.SUBSTRATE_NAMESPACE = PRIOR_SUBSTRATE_NS;
});

describe('handleRecallRequest', () => {
  it('embeds query, calls store.knnSearch, returns rows + scores', async () => {
    const embedder = new FakeEmbedder({ dimension: 8 });
    const { store } = makeStore({
      knnImpl: async () => [
        { row: { id: 'd1', topic: 'auth' }, score: 0.92 },
        { row: { id: 'd2', topic: 'db' }, score: 0.41 }
      ]
    });
    const res = await handleRecallRequest(
      { query: 'auth tokens', k: 10, namespace: 'claude', type: 'Decision', threshold: 0 },
      { embedder, store }
    );
    expect(res.rows).toHaveLength(2);
    expect(res.rows[0]?.score).toBe(0.92);
    expect(res.model).toBe('fake:v1:8');
  });

  it('reports per-component timings (embed_ms, knn_ms, total_ms)', async () => {
    const embedder = new FakeEmbedder({ dimension: 8 });
    const { store } = makeStore({ knnImpl: async () => [] });
    const res = await handleRecallRequest({ query: 'x', type: 'Decision' }, { embedder, store });
    expect(res.timings.embed_ms).toBeGreaterThanOrEqual(0);
    expect(res.timings.knn_ms).toBeGreaterThanOrEqual(0);
    expect(res.timings.total_ms).toBeGreaterThanOrEqual(res.timings.embed_ms);
    expect(res.timings.total_ms).toBeGreaterThanOrEqual(res.timings.knn_ms);
  });

  it('passes embedder.modelId to the store so it can post-filter', async () => {
    const embedder = new FakeEmbedder({ dimension: 8 });
    const { store, calls } = makeStore();
    await handleRecallRequest({ query: 'x', type: 'Decision' }, { embedder, store });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.model).toBe(embedder.modelId);
  });

  it('clamps k to [1, 100] before reaching the store', async () => {
    const embedder = new FakeEmbedder({ dimension: 8 });
    {
      const { store, calls } = makeStore();
      await handleRecallRequest({ query: 'x', type: 'Decision', k: 5000 }, { embedder, store });
      expect(calls[0]?.k).toBe(100);
    }
    {
      const { store, calls } = makeStore();
      await handleRecallRequest({ query: 'x', type: 'Decision', k: -5 }, { embedder, store });
      expect(calls[0]?.k).toBe(1);
    }
  });

  it('throws when embedder fails (route surfaces as 503)', async () => {
    const embedder = {
      modelId: 'fake:v1:8',
      dimension: 8,
      embed: vi.fn().mockRejectedValue(new Error('ollama down'))
    };
    const { store, calls } = makeStore();
    await expect(
      handleRecallRequest({ query: 'x', type: 'Decision' }, { embedder, store })
    ).rejects.toThrow(/ollama down/);
    expect(calls).toHaveLength(0);
  });

  /**
   * Explicit namespace, then SUBSTRATE_NAMESPACE. Each test sets the env itself; there is
   * no hardcoded fallback namespace.
   */
  describe('namespace resolution', () => {
    it('prefers an explicit namespace over the environment', async () => {
      process.env.SUBSTRATE_NAMESPACE = 'from-env';
      const embedder = new FakeEmbedder({ dimension: 8 });
      const { store, calls } = makeStore();
      await handleRecallRequest(
        { query: 'x', type: 'Decision', namespace: 'explicit' },
        { embedder, store }
      );
      expect(calls[0]?.namespace).toBe('explicit');
    });

    it('falls back to SUBSTRATE_NAMESPACE when no namespace is given', async () => {
      process.env.SUBSTRATE_NAMESPACE = 'from-env';
      const embedder = new FakeEmbedder({ dimension: 8 });
      const { store, calls } = makeStore();
      await handleRecallRequest({ query: 'x', type: 'Decision' }, { embedder, store });
      expect(calls[0]?.namespace).toBe('from-env');
    });

    it('refuses to guess when neither is set, rather than searching a dead namespace', async () => {
      delete process.env.SUBSTRATE_NAMESPACE;
      const embedder = new FakeEmbedder({ dimension: 8 });
      const { store, calls } = makeStore();
      await expect(
        handleRecallRequest({ query: 'x', type: 'Decision' }, { embedder, store })
      ).rejects.toThrow(/SUBSTRATE_NAMESPACE/);
      expect(calls).toHaveLength(0);
    });
  });

  it('refuses a recall with no type: there is no default to guess', async () => {
    process.env.SUBSTRATE_NAMESPACE = 'ns-under-test';
    const embedder = new FakeEmbedder({ dimension: 8 });
    const { store, calls } = makeStore();
    await expect(handleRecallRequest({ query: 'x' }, { embedder, store })).rejects.toMatchObject({
      code: 'bad_request',
      message: expect.stringContaining('`type`')
    });
    expect(calls).toHaveLength(0);
  });

  it('refuses a query longer than the cap', async () => {
    process.env.SUBSTRATE_NAMESPACE = 'ns-under-test';
    const embedder = new FakeEmbedder({ dimension: 8 });
    const embedSpy = vi.spyOn(embedder, 'embed');
    const { store } = makeStore();
    await expect(
      handleRecallRequest(
        { query: 'x'.repeat(MAX_RECALL_QUERY_CHARS + 1), type: 'Decision' },
        { embedder, store }
      )
    ).rejects.toMatchObject({ code: 'bad_request' });
    expect(embedSpy).not.toHaveBeenCalled();
  });

  it('defaults k=10, threshold=0', async () => {
    process.env.SUBSTRATE_NAMESPACE = 'ns-under-test';
    const embedder = new FakeEmbedder({ dimension: 8 });
    const { store, calls } = makeStore();
    await handleRecallRequest({ query: 'x', type: 'Decision' }, { embedder, store });
    const call = calls[0];
    expect(call?.type).toBe('Decision');
    expect(call?.k).toBe(10);
    // threshold is omitted when zero — store treats undefined as 0 internally.
    expect(call?.threshold).toBeUndefined();
  });

  it('forwards explicit threshold to the store', async () => {
    const embedder = new FakeEmbedder({ dimension: 8 });
    const { store, calls } = makeStore();
    await handleRecallRequest(
      { query: 'x', type: 'Decision', threshold: 0.7 },
      { embedder, store }
    );
    expect(calls[0]?.threshold).toBe(0.7);
  });

  it('defaults namespace to $SUBSTRATE_NS when input.namespace is omitted', async () => {
    const embedder = new FakeEmbedder({ dimension: 8 });
    const { store, calls } = makeStore();
    const prev = process.env.SUBSTRATE_NAMESPACE;
    process.env.SUBSTRATE_NAMESPACE = 'cortext';
    try {
      await handleRecallRequest({ query: 'x', type: 'Decision' }, { embedder, store });
    } finally {
      if (prev === undefined) delete process.env.SUBSTRATE_NAMESPACE;
      else process.env.SUBSTRATE_NAMESPACE = prev;
    }
    expect(calls[0]?.namespace).toBe('cortext');
  });

  it('explicit input.namespace still wins over $SUBSTRATE_NS', async () => {
    const embedder = new FakeEmbedder({ dimension: 8 });
    const { store, calls } = makeStore();
    const prev = process.env.SUBSTRATE_NAMESPACE;
    process.env.SUBSTRATE_NAMESPACE = 'cortext';
    try {
      await handleRecallRequest(
        { query: 'x', type: 'Decision', namespace: 'architecture' },
        { embedder, store }
      );
    } finally {
      if (prev === undefined) delete process.env.SUBSTRATE_NAMESPACE;
      else process.env.SUBSTRATE_NAMESPACE = prev;
    }
    expect(calls[0]?.namespace).toBe('architecture');
  });
});

describe('recallRouteHandler', () => {
  it('returns 503 when no embedder configured', async () => {
    const { store } = makeStore();
    const handler = recallRouteHandler({ store });
    const res = await handler(makePostReq({ query: 'test', type: 'Decision' }));
    expect(res.status).toBe(503);
    expect(res.headers?.['content-type']).toBe('application/json');
    const body = JSON.parse(Buffer.from(res.body as Buffer).toString('utf8'));
    expect(body.error.code).toBe('embedder_unavailable');
  });

  it('returns 503 when no store configured', async () => {
    const embedder = new FakeEmbedder({ dimension: 8 });
    const handler = recallRouteHandler({ embedder });
    const res = await handler(makePostReq({ query: 'test', type: 'Decision' }));
    expect(res.status).toBe(503);
    const body = JSON.parse(Buffer.from(res.body as Buffer).toString('utf8'));
    expect(body.error.code).toBe('embedder_unavailable');
  });

  it('returns 400 when body is missing', async () => {
    const embedder = new FakeEmbedder({ dimension: 8 });
    const { store } = makeStore();
    const handler = recallRouteHandler({ embedder, store });
    const req: SubstrateRequest = {
      method: 'POST',
      path: '/substrate/v1/recall',
      headers: {},
      query: {},
      params: {},
      body: null
    };
    const res = await handler(req);
    expect(res.status).toBe(400);
    const body = JSON.parse(Buffer.from(res.body as Buffer).toString('utf8'));
    expect(body.code).toBe('bad_request');
  });

  it('returns 400 when query field missing', async () => {
    const embedder = new FakeEmbedder({ dimension: 8 });
    const { store } = makeStore();
    const handler = recallRouteHandler({ embedder, store });
    const res = await handler(makePostReq({ k: 5 }));
    expect(res.status).toBe(400);
    const body = JSON.parse(Buffer.from(res.body as Buffer).toString('utf8'));
    expect(body.code).toBe('bad_request');
  });

  it('happy path — returns 200 with rows + model', async () => {
    const embedder = new FakeEmbedder({ dimension: 8 });
    const { store } = makeStore({
      knnImpl: async () => [{ row: { id: 'r1', text: 'hello' }, score: 0.88 }]
    });
    const handler = recallRouteHandler({ embedder, store });
    const res = await handler(
      makePostReq({ query: 'hello world', namespace: 'claude', type: 'Memory', k: 5 })
    );
    expect(res.status).toBe(200);
    expect(res.headers?.['content-type']).toBe('application/json');
    const body = JSON.parse(Buffer.from(res.body as Buffer).toString('utf8'));
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0].score).toBe(0.88);
    expect(body.rows[0].row.id).toBe('r1');
    expect(body.model).toBe('fake:v1:8');
  });

  it('returns 503 when embedder throws with code=unavailable', async () => {
    const err = Object.assign(new Error('ollama down'), { code: 'unavailable' });
    const embedder = {
      modelId: 'fake:v1:8',
      dimension: 8,
      embed: vi.fn().mockRejectedValue(err)
    };
    const { store } = makeStore();
    const handler = recallRouteHandler({ embedder, store });
    const res = await handler(makePostReq({ query: 'x', type: 'Decision' }));
    expect(res.status).toBe(503);
    const body = JSON.parse(Buffer.from(res.body as Buffer).toString('utf8'));
    expect(body.error.code).toBe('embedder_unavailable');
  });

  it('returns 500 on unexpected internal error', async () => {
    const embedder = {
      modelId: 'fake:v1:8',
      dimension: 8,
      embed: vi.fn().mockRejectedValue(new Error('unexpected boom'))
    };
    const { store } = makeStore();
    const handler = recallRouteHandler({ embedder, store });
    const res = await handler(makePostReq({ query: 'x', type: 'Decision' }));
    expect(res.status).toBe(500);
    const body = JSON.parse(Buffer.from(res.body as Buffer).toString('utf8'));
    expect(body.error.code).toBe('internal');
  });
});

// ---------------------------------------------------------------------------
// Expansion tests
// ---------------------------------------------------------------------------

const DEFAULT_EXPANSION: ExpansionConfig = { maxNeighboursPerSeed: 8, maxTotalNeighbours: 50 };

function makeStoreWithFetch(
  knnRows: Array<{ row: Record<string, unknown>; score: number }>,
  embeddedNeighbours: Array<{
    ns: string;
    type: string;
    id: string;
    row: Record<string, unknown>;
    vector: Float32Array;
  }>
): EmbeddingsStore {
  return {
    txScopeId: 'test-store',
    delete: async () => undefined,
    upsert: async () => undefined,
    knnSearch: async () => knnRows.map((r) => ({ ...r, salience: 0 })),
    boostSalience: async () => [],
    fetchEmbeddings: async (ids) =>
      embeddedNeighbours
        .filter((n) => ids.some((i) => i.namespace === n.ns && i.type === n.type && i.id === n.id))
        .map((n) => ({
          namespace: n.ns,
          type: n.type,
          id: n.id,
          row: n.row,
          vector: n.vector,
          salience: 0
        })),
    selectCandidates: async () => []
  };
}

function fixedEmbedder(vector: Float32Array): Embedder {
  return { modelId: 'fake/test', dimension: vector.length, embed: async () => vector };
}

function makeEdgesStubForRecall(inboundByRef: Record<string, Edge[]>): EdgesStore {
  const key = (r: EdgeRef): string => `${r.ns}/${r.type}/${r.id}`;
  return {
    txScopeId: 'recall-test-edges',
    write: async () => {
      throw new Error('not implemented');
    },
    tombstone: async () => undefined,
    update: async () => undefined,
    readNextBatch: async () => ({ edges: [], lastId: null }),
    findEdgesTo: async (ref) => inboundByRef[key(ref)] ?? [],
    findEdgesToMany: async (refs) => refs.flatMap((r) => inboundByRef[key(r)] ?? []),
    findEdgesFrom: async () => [],
    canDelete: async () => ({ ok: true }),
    findBlocked: async () => [],
    findEdgesTouchingNamespace: async () => [],
    findEdgesTouchingType: async () => [],
    dropEdgesByNamespace: async () => 0,
    namespacesLinkedTo: async () => [],
    dropEdgesByType: async () => 0,
    withTransaction: async (fn) => fn(makeEdgesStubForRecall({}))
  };
}

describe('handleRecallRequest — expansion', () => {
  it('expand:false (default) is byte-identical to baseline', async () => {
    const embedder = fixedEmbedder(new Float32Array([1, 0, 0]));
    const store = makeStoreWithFetch(
      [{ row: { id: 'concept-1', name: 'Salience' }, score: 0.9 }],
      []
    );
    const resolver = makeExpansionResolver(new SpreadEdgeRegistry(), null, DEFAULT_EXPANSION);
    const out = await handleRecallRequest(
      { query: 'q', k: 3, type: 'Decision' },
      { embedder, store, expansionResolver: resolver, expansionEnabled: true }
    );
    expect(out.rows.every((r) => r._expandedFrom === undefined)).toBe(true);
    expect(out.rows[0]!.row.id).toBe('concept-1');
  });

  it('expand:true surfaces an opt-in forward neighbour whose cosine beats the top-K cut', async () => {
    const queryVec = new Float32Array([1, 0, 0]);
    const neighbourVec = new Float32Array([0.9, 0.1, 0]); // cosine ~0.99
    const embedder = fixedEmbedder(queryVec);
    const store = makeStoreWithFetch(
      // Top-K seed: Decision row whose own embedding is mediocre but supersedes a stronger Decision.
      // Same-type edge so the expansion scope filter doesn't drop the neighbour.
      [
        { row: { id: 'dec-1', topic: 'Salience', supersedes: 'dec-2' }, score: 0.6 },
        { row: { id: 'dec-noise', topic: 'unrelated' }, score: 0.55 }
      ],
      [
        {
          ns: 'claude',
          type: 'Decision',
          id: 'dec-2',
          row: { id: 'dec-2', topic: 'Salience-original' },
          vector: neighbourVec
        }
      ]
    );
    const registry = new SpreadEdgeRegistry();
    registry.add('claude', 'Decision', {
      fieldName: 'supersedes',
      targetNs: 'claude',
      targetType: 'Decision'
    });
    const resolver = makeExpansionResolver(registry, null, DEFAULT_EXPANSION);
    const out = await handleRecallRequest(
      { query: 'salience', k: 3, expand: true, namespace: 'claude', type: 'Decision' },
      { embedder, store, expansionResolver: resolver, expansionEnabled: true }
    );
    const expanded = out.rows.filter((r) => r._expandedFrom !== undefined);
    expect(expanded).toHaveLength(1);
    expect(expanded[0]!.row.id).toBe('dec-2');
    expect(expanded[0]!._expandedFrom).toEqual({
      namespace: 'claude',
      type: 'Decision',
      id: 'dec-1'
    });
  });

  it('dedup: same neighbour fetched via multiple expansion paths deduplicates via ns/type/id key', async () => {
    const queryVec = new Float32Array([1, 0, 0]);
    const sharedVec = new Float32Array([0.95, 0.05, 0]);
    const embedder = fixedEmbedder(queryVec);
    const store = makeStoreWithFetch(
      // Two decision seeds that both supersede the same earlier Decision.
      // Same-type edge so the scope filter passes the neighbour.
      [
        { row: { id: 'dec-1', topic: 'X', supersedes: 'dec-shared' }, score: 0.9 },
        { row: { id: 'dec-2', topic: 'Y', supersedes: 'dec-shared' }, score: 0.85 }
      ],
      [
        {
          ns: 'claude',
          type: 'Decision',
          id: 'dec-shared',
          row: { id: 'dec-shared' },
          vector: sharedVec
        }
      ]
    );
    const registry = new SpreadEdgeRegistry();
    registry.add('claude', 'Decision', {
      fieldName: 'supersedes',
      targetNs: 'claude',
      targetType: 'Decision'
    });
    const resolver = makeExpansionResolver(registry, null, DEFAULT_EXPANSION);
    const out = await handleRecallRequest(
      { query: 'q', k: 5, expand: true, namespace: 'claude', type: 'Decision' },
      { embedder, store, expansionResolver: resolver, expansionEnabled: true }
    );
    // The shared Decision should appear exactly once despite being reachable from both seeds.
    const sharedRows = out.rows.filter((r) => r.row.id === 'dec-shared');
    expect(sharedRows).toHaveLength(1);
    expect(sharedRows[0]?._expandedFrom).toBeDefined();
  });

  it('scope filter: forward Decision→Concept neighbour is dropped on Decision-typed query (no carve-out)', async () => {
    const queryVec = new Float32Array([1, 0, 0]);
    const conceptVec = new Float32Array([0.99, 0.01, 0]); // would beat the Decision seed if surfaced
    const embedder = fixedEmbedder(queryVec);
    const store = makeStoreWithFetch(
      [{ row: { id: 'dec-1', topic: 'X', establishesConcept: 'c-1' }, score: 0.6 }],
      [{ ns: 'claude', type: 'Concept', id: 'c-1', row: { id: 'c-1' }, vector: conceptVec }]
    );
    const registry = new SpreadEdgeRegistry();
    // expandCrossType:true on the edge — but forward walks NEVER cross type.
    registry.add('claude', 'Decision', {
      fieldName: 'establishesConcept',
      targetNs: 'claude',
      targetType: 'Concept',
      expandCrossType: true
    });
    const resolver = makeExpansionResolver(registry, null, DEFAULT_EXPANSION);
    const out = await handleRecallRequest(
      { query: 'q', k: 3, expand: true, namespace: 'claude', type: 'Decision' },
      { embedder, store, expansionResolver: resolver, expansionEnabled: true }
    );
    expect(out.rows).toHaveLength(1);
    expect(out.rows[0]!.row.id).toBe('dec-1');
  });

  it('scope filter carve-out: backward Concept←Decision neighbour surfaces on Concept-typed query when expandCrossType:true', async () => {
    const queryVec = new Float32Array([1, 0, 0]);
    const conceptVec = new Float32Array([0.92, 0.08, 0]);
    const decisionVec = new Float32Array([0.95, 0.05, 0]); // higher cosine than Concept seed
    const embedder = fixedEmbedder(queryVec);
    // Concept seed surfaces from knn; backward walk via inbound Decision.establishesConcept
    // edge should surface the establishing Decision (cross-type but opted in).
    const edges = makeEdgesStubForRecall({
      'claude/Concept/c-1': [
        {
          id: 'edge-1',
          from: { ns: 'claude', type: 'Decision', id: 'dec-99' },
          to: { ns: 'claude', type: 'Concept', id: 'c-1' },
          fieldName: 'establishesConcept',
          policy: 'set_null',
          createdAt: new Date()
        }
      ]
    });
    const store = makeStoreWithFetch(
      [{ row: { id: 'c-1', name: 'Salience' }, score: 0.7 }],
      [{ ns: 'claude', type: 'Decision', id: 'dec-99', row: { id: 'dec-99' }, vector: decisionVec }]
    );
    // Force the knn seed's stored embedding cosine to match conceptVec (so the
    // expanded Decision can out-rank it).
    void conceptVec;
    const registry = new SpreadEdgeRegistry();
    registry.add('claude', 'Decision', {
      fieldName: 'establishesConcept',
      targetNs: 'claude',
      targetType: 'Concept',
      expandCrossType: true
    });
    const resolver = makeExpansionResolver(registry, edges, DEFAULT_EXPANSION);
    const out = await handleRecallRequest(
      { query: 'salience', k: 5, expand: true, namespace: 'claude', type: 'Concept' },
      { embedder, store, expansionResolver: resolver, expansionEnabled: true }
    );
    const expanded = out.rows.filter((r) => r._expandedFrom !== undefined);
    expect(expanded).toHaveLength(1);
    expect(expanded[0]!.row.id).toBe('dec-99');
    expect(expanded[0]!._expandedFrom).toEqual({
      namespace: 'claude',
      type: 'Concept',
      id: 'c-1'
    });
  });

  it('scope filter: cross-NAMESPACE backward neighbour dropped even when expandCrossType:true', async () => {
    // expandCrossType is type-only — a backward neighbour in a DIFFERENT
    // namespace must always be rejected, regardless of the carve-out.
    const queryVec = new Float32Array([1, 0, 0]);
    const decisionVec = new Float32Array([0.95, 0.05, 0]);
    const embedder = fixedEmbedder(queryVec);
    const edges = makeEdgesStubForRecall({
      'claude/Concept/c-1': [
        {
          id: 'edge-1',
          from: { ns: 'other', type: 'Decision', id: 'dec-99' },
          to: { ns: 'claude', type: 'Concept', id: 'c-1' },
          fieldName: 'establishesConcept',
          policy: 'set_null',
          createdAt: new Date()
        }
      ]
    });
    const store = makeStoreWithFetch(
      [{ row: { id: 'c-1', name: 'Salience' }, score: 0.7 }],
      [{ ns: 'other', type: 'Decision', id: 'dec-99', row: { id: 'dec-99' }, vector: decisionVec }]
    );
    const registry = new SpreadEdgeRegistry();
    // Opt the cross-namespace source type in to spread + expandCrossType. The
    // route's namespace check must still drop the neighbour.
    registry.add('other', 'Decision', {
      fieldName: 'establishesConcept',
      targetNs: 'claude',
      targetType: 'Concept',
      expandCrossType: true
    });
    const resolver = makeExpansionResolver(registry, edges, DEFAULT_EXPANSION);
    const out = await handleRecallRequest(
      { query: 'salience', k: 5, expand: true, namespace: 'claude', type: 'Concept' },
      { embedder, store, expansionResolver: resolver, expansionEnabled: true }
    );
    expect(out.rows).toHaveLength(1);
    expect(out.rows[0]!.row.id).toBe('c-1');
    expect(out.rows.filter((r) => r._expandedFrom !== undefined)).toHaveLength(0);
  });

  it('scope filter: backward Concept←Decision dropped when expandCrossType is NOT set', async () => {
    const queryVec = new Float32Array([1, 0, 0]);
    const decisionVec = new Float32Array([0.95, 0.05, 0]);
    const embedder = fixedEmbedder(queryVec);
    const edges = makeEdgesStubForRecall({
      'claude/Concept/c-1': [
        {
          id: 'edge-1',
          from: { ns: 'claude', type: 'Decision', id: 'dec-99' },
          to: { ns: 'claude', type: 'Concept', id: 'c-1' },
          fieldName: 'establishesConcept',
          policy: 'set_null',
          createdAt: new Date()
        }
      ]
    });
    const store = makeStoreWithFetch(
      [{ row: { id: 'c-1', name: 'Salience' }, score: 0.7 }],
      [{ ns: 'claude', type: 'Decision', id: 'dec-99', row: { id: 'dec-99' }, vector: decisionVec }]
    );
    const registry = new SpreadEdgeRegistry();
    // spread:true but NO expandCrossType — backward Decision (cross-type) must still drop.
    registry.add('claude', 'Decision', {
      fieldName: 'establishesConcept',
      targetNs: 'claude',
      targetType: 'Concept'
    });
    const resolver = makeExpansionResolver(registry, edges, DEFAULT_EXPANSION);
    const out = await handleRecallRequest(
      { query: 'salience', k: 5, expand: true, namespace: 'claude', type: 'Concept' },
      { embedder, store, expansionResolver: resolver, expansionEnabled: true }
    );
    expect(out.rows).toHaveLength(1);
    expect(out.rows[0]!.row.id).toBe('c-1');
  });

  it('expand:true with no opt-in fields → no _expandedFrom annotations', async () => {
    const embedder = fixedEmbedder(new Float32Array([1, 0, 0]));
    const store = makeStoreWithFetch([{ row: { id: 'r1' }, score: 0.5 }], []);
    const resolver = makeExpansionResolver(new SpreadEdgeRegistry(), null, DEFAULT_EXPANSION);
    const out = await handleRecallRequest(
      { query: 'q', k: 3, expand: true, type: 'Decision' },
      { embedder, store, expansionResolver: resolver, expansionEnabled: true }
    );
    expect(out.rows.every((r) => r._expandedFrom === undefined)).toBe(true);
  });

  it('_expandedFrom carries the seed source row ns/type (forward case)', async () => {
    const queryVec = new Float32Array([1, 0, 0]);
    const neighbourVec = new Float32Array([0.95, 0.05, 0]);
    const embedder = fixedEmbedder(queryVec);
    const store = makeStoreWithFetch(
      [{ row: { id: 'dec-1', topic: 'Salience', supersedes: 'dec-prev' }, score: 0.6 }],
      [
        {
          ns: 'claude',
          type: 'Decision',
          id: 'dec-prev',
          row: { id: 'dec-prev' },
          vector: neighbourVec
        }
      ]
    );
    const registry = new SpreadEdgeRegistry();
    registry.add('claude', 'Decision', {
      fieldName: 'supersedes',
      targetNs: 'claude',
      targetType: 'Decision'
    });
    const resolver = makeExpansionResolver(registry, null, DEFAULT_EXPANSION);
    const out = await handleRecallRequest(
      { query: 'salience', k: 3, expand: true, namespace: 'claude', type: 'Decision' },
      { embedder, store, expansionResolver: resolver, expansionEnabled: true }
    );
    const neighbour = out.rows.find((r) => r.row.id === 'dec-prev');
    expect(neighbour?._expandedFrom).toEqual({
      namespace: 'claude',
      type: 'Decision',
      id: 'dec-1'
    });
  });
});

describe('handleRecallRequest — expansion fail-open', () => {
  it('ExpansionResolver throws → returns knn-only result', async () => {
    const embedder = fixedEmbedder(new Float32Array([1, 0, 0]));
    const store = makeStoreWithFetch(
      [
        { row: { id: 'r1' }, score: 0.9 },
        { row: { id: 'r2' }, score: 0.8 }
      ],
      []
    );
    const throwingResolver: ExpansionResolver = async () => {
      throw new Error('resolver boom');
    };
    const out = await handleRecallRequest(
      { query: 'q', k: 3, expand: true, type: 'Decision' },
      { embedder, store, expansionResolver: throwingResolver, expansionEnabled: true }
    );
    expect(out.rows.every((r) => r._expandedFrom === undefined)).toBe(true);
    expect(out.rows).toHaveLength(2);
  });

  it('fetchEmbeddings throws → returns knn-only result', async () => {
    const queryVec = new Float32Array([1, 0, 0]);
    const embedder = fixedEmbedder(queryVec);
    const brokenStore: EmbeddingsStore = {
      txScopeId: 'broken-store',
      delete: async () => undefined,
      upsert: async () => undefined,
      knnSearch: async () => [
        { row: { id: 'dec-1', establishesConcept: 'c-1' }, score: 0.7, salience: 0 }
      ],
      boostSalience: async () => [],
      fetchEmbeddings: async () => {
        throw new Error('fetch boom');
      },
      selectCandidates: async () => []
    };
    const registry = new SpreadEdgeRegistry();
    registry.add('claude', 'Decision', {
      fieldName: 'establishesConcept',
      targetNs: 'claude',
      targetType: 'Concept'
    });
    const resolver = makeExpansionResolver(registry, null, DEFAULT_EXPANSION);
    const out = await handleRecallRequest(
      { query: 'q', k: 3, expand: true, namespace: 'claude', type: 'Decision' },
      { embedder, store: brokenStore, expansionResolver: resolver, expansionEnabled: true }
    );
    expect(out.rows.every((r) => r._expandedFrom === undefined)).toBe(true);
    expect(out.rows).toHaveLength(1);
  });

  it('plugin-level expansionEnabled:false → expand:true honoured as no-op', async () => {
    const queryVec = new Float32Array([1, 0, 0]);
    const conceptVec = new Float32Array([0.95, 0.05, 0]);
    const embedder = fixedEmbedder(queryVec);
    const store = makeStoreWithFetch(
      [{ row: { id: 'dec-1', establishesConcept: 'c-1' }, score: 0.6 }],
      [{ ns: 'claude', type: 'Concept', id: 'c-1', row: { id: 'c-1' }, vector: conceptVec }]
    );
    const registry = new SpreadEdgeRegistry();
    registry.add('claude', 'Decision', {
      fieldName: 'establishesConcept',
      targetNs: 'claude',
      targetType: 'Concept'
    });
    const resolver = makeExpansionResolver(registry, null, DEFAULT_EXPANSION);
    const out = await handleRecallRequest(
      { query: 'q', k: 3, expand: true, namespace: 'claude', type: 'Decision' },
      { embedder, store, expansionResolver: resolver, expansionEnabled: false }
    );
    expect(out.rows.every((r) => r._expandedFrom === undefined)).toBe(true);
    expect(out.rows).toHaveLength(1);
  });

  it('expansion failure increments stats.expansionFailures', async () => {
    const embedder = fixedEmbedder(new Float32Array([1, 0, 0]));
    const store = makeStoreWithFetch([{ row: { id: 'r1' }, score: 0.9 }], []);
    const stats = createEmbedStats();
    const throwingResolver: ExpansionResolver = async () => {
      throw new Error('boom');
    };
    await handleRecallRequest(
      { query: 'q', k: 3, expand: true, type: 'Decision' },
      { embedder, store, expansionResolver: throwingResolver, expansionEnabled: true, stats }
    );
    expect(stats.snapshot().expansionFailures).toBe(1);
  });

  it('fetchEmbeddings failure increments stats.expansionFailures', async () => {
    const queryVec = new Float32Array([1, 0, 0]);
    const embedder = fixedEmbedder(queryVec);
    const brokenStore: EmbeddingsStore = {
      txScopeId: 'broken-store',
      delete: async () => undefined,
      upsert: async () => undefined,
      knnSearch: async () => [
        { row: { id: 'dec-1', establishesConcept: 'c-1' }, score: 0.7, salience: 0 }
      ],
      boostSalience: async () => [],
      fetchEmbeddings: async () => {
        throw new Error('fetch boom');
      },
      selectCandidates: async () => []
    };
    const registry = new SpreadEdgeRegistry();
    registry.add('claude', 'Decision', {
      fieldName: 'establishesConcept',
      targetNs: 'claude',
      targetType: 'Concept'
    });
    const resolver = makeExpansionResolver(registry, null, DEFAULT_EXPANSION);
    const stats = createEmbedStats();
    await handleRecallRequest(
      { query: 'q', k: 3, expand: true, namespace: 'claude', type: 'Decision' },
      { embedder, store: brokenStore, expansionResolver: resolver, expansionEnabled: true, stats }
    );
    expect(stats.snapshot().expansionFailures).toBe(1);
  });

  it('expansion success does NOT increment stats.expansionFailures', async () => {
    const queryVec = new Float32Array([1, 0, 0]);
    const conceptVec = new Float32Array([0.95, 0.05, 0]);
    const embedder = fixedEmbedder(queryVec);
    const store = makeStoreWithFetch(
      [{ row: { id: 'dec-1', topic: 'Salience', establishesConcept: 'concept-1' }, score: 0.6 }],
      [
        {
          ns: 'claude',
          type: 'Concept',
          id: 'concept-1',
          row: { id: 'concept-1', name: 'Salience' },
          vector: conceptVec
        }
      ]
    );
    const registry = new SpreadEdgeRegistry();
    registry.add('claude', 'Decision', {
      fieldName: 'establishesConcept',
      targetNs: 'claude',
      targetType: 'Concept'
    });
    const resolver = makeExpansionResolver(registry, null, DEFAULT_EXPANSION);
    const stats = createEmbedStats();
    await handleRecallRequest(
      { query: 'salience', k: 3, expand: true, namespace: 'claude', type: 'Decision' },
      { embedder, store, expansionResolver: resolver, expansionEnabled: true, stats }
    );
    expect(stats.snapshot().expansionFailures).toBe(0);
  });
});

describe('read-policy gate', () => {
  it('primary scope denied → rejects with policy_denied BEFORE touching embedder or store', async () => {
    const embedder = new FakeEmbedder({ dimension: 8 });
    const { store, calls } = makeStore({
      knnImpl: async () => [{ row: { id: 'd1' }, score: 0.9 }]
    });

    await expect(
      handleRecallRequest(
        { query: 'x', namespace: 'claude', type: 'Memory' },
        {
          embedder,
          store,
          checkReadPolicy: (ns, type) =>
            ns === 'claude' && type === 'Memory'
              ? { allow: false, reason: 'reads require an authenticated identity' }
              : { allow: true }
        }
      )
    ).rejects.toMatchObject({
      code: 'policy_denied',
      message: 'reads require an authenticated identity'
    });
    expect(calls).toHaveLength(0); // no knn ran — denied pre-embed
  });

  it('primary scope allowed → rows flow unchanged', async () => {
    const embedder = new FakeEmbedder({ dimension: 8 });
    const { store } = makeStore({
      knnImpl: async () => [{ row: { id: 'd1' }, score: 0.9 }]
    });

    const out = await handleRecallRequest(
      { query: 'x', namespace: 'claude', type: 'Decision' },
      { embedder, store, checkReadPolicy: () => ({ allow: true }) }
    );
    expect(out.rows).toHaveLength(1);
  });

  it('expansion neighbour of a denied type is silently dropped; primary rows survive', async () => {
    const queryVec = new Float32Array([1, 0, 0]);
    const decisionVec = new Float32Array([0.95, 0.05, 0]);
    const embedder = fixedEmbedder(queryVec);
    // Concept-typed query; backward carve-out surfaces a Decision neighbour —
    // but Decision reads are denied, so the neighbour must not appear.
    const edges = makeEdgesStubForRecall({
      'claude/Concept/c-1': [
        {
          id: 'edge-1',
          from: { ns: 'claude', type: 'Decision', id: 'dec-99' },
          to: { ns: 'claude', type: 'Concept', id: 'c-1' },
          fieldName: 'establishesConcept',
          policy: 'set_null',
          createdAt: new Date()
        }
      ]
    });
    const store = makeStoreWithFetch(
      [{ row: { id: 'c-1', name: 'Salience' }, score: 0.7 }],
      [{ ns: 'claude', type: 'Decision', id: 'dec-99', row: { id: 'dec-99' }, vector: decisionVec }]
    );
    const registry = new SpreadEdgeRegistry();
    registry.add('claude', 'Decision', {
      fieldName: 'establishesConcept',
      targetNs: 'claude',
      targetType: 'Concept',
      expandCrossType: true
    });
    const resolver = makeExpansionResolver(registry, edges, DEFAULT_EXPANSION);

    const out = await handleRecallRequest(
      { query: 'salience', k: 5, expand: true, namespace: 'claude', type: 'Concept' },
      {
        embedder,
        store,
        expansionResolver: resolver,
        expansionEnabled: true,
        checkReadPolicy: (_ns, type) =>
          type === 'Decision' ? { allow: false, reason: 'gated' } : { allow: true }
      }
    );
    expect(out.rows.filter((r) => r._expandedFrom !== undefined)).toHaveLength(0);
    expect(out.rows.map((r) => r.row.id)).toEqual(['c-1']);
  });

  it('recallRouteHandler binds req.identity into the check and maps denial to 403', async () => {
    const embedder = new FakeEmbedder({ dimension: 8 });
    const { store } = makeStore({ knnImpl: async () => [{ row: { id: 'd1' }, score: 0.9 }] });
    const seen: Array<{ ns: string; type: string; identity: unknown }> = [];
    const handler = recallRouteHandler({
      embedder,
      store,
      checkReadPolicy: (ns, type, identity) => {
        seen.push({ ns, type, identity });
        return identity === null
          ? { allow: false, reason: 'reads require an authenticated identity' }
          : { allow: true };
      }
    });

    // Anonymous → 403 with the policy reason.
    const denied = await handler(makePostReq({ query: 'x', namespace: 'claude', type: 'Memory' }));
    expect(denied.status).toBe(403);
    const deniedBody = JSON.parse(String(denied.body)) as {
      error: { code: string; message: string };
    };
    expect(deniedBody.error.code).toBe('policy_denied');
    expect(deniedBody.error.message).toContain('authenticated identity');
    expect(seen[0]).toEqual({ ns: 'claude', type: 'Memory', identity: null });

    // Identified → 200, identity threaded through.
    const req = makePostReq({ query: 'x', namespace: 'claude', type: 'Memory' });
    req.identity = { id: 'agent-1', grants: {} };
    const allowed = await handler(req);
    expect(allowed.status).toBe(200);
    expect(seen[1]?.identity).toEqual({ id: 'agent-1', grants: {} });
  });

  it("hands the check the caller's headers, stamped clientIp and authEnabled", async () => {
    const embedder = new FakeEmbedder({ dimension: 8 });
    const { store } = makeStore({ knnImpl: async () => [{ row: { id: 'd1' }, score: 0.9 }] });
    const handler = recallRouteHandler({
      embedder,
      store,
      checkReadPolicy: (_ns, _type, _identity, probe) =>
        probe?.clientIp === '203.0.113.9' ? { allow: false, reason: 'blocked ip' } : { allow: true }
    });

    const blocked = makePostReq({ query: 'x', namespace: 'claude', type: 'Memory' });
    blocked.clientIp = '203.0.113.9';
    expect((await handler(blocked)).status).toBe(403);

    const seen: Array<{
      headers: Record<string, string> | undefined;
      authEnabled: boolean | undefined;
    }> = [];
    const capturing = recallRouteHandler({
      embedder,
      store,
      checkReadPolicy: (_ns, _type, _identity, probe) => {
        seen.push({ headers: probe?.headers, authEnabled: probe?.authEnabled });
        return { allow: true };
      }
    });
    const req = makePostReq({ query: 'x', namespace: 'claude', type: 'Memory' });
    req.headers = { ...req.headers, 'x-tenant': 'a' };
    req.authEnabled = true;
    expect((await capturing(req)).status).toBe(200);
    expect(seen[0]?.headers?.['x-tenant']).toBe('a');
    expect(seen[0]?.authEnabled).toBe(true);
  });

  it('no checkReadPolicy configured → open (back-compat for hosts that do not wire it)', async () => {
    const embedder = new FakeEmbedder({ dimension: 8 });
    const { store } = makeStore({ knnImpl: async () => [{ row: { id: 'd1' }, score: 0.9 }] });
    const handler = recallRouteHandler({ embedder, store });

    const res = await handler(makePostReq({ query: 'x', namespace: 'claude', type: 'Memory' }));
    expect(res.status).toBe(200);
  });
});

describe('handleRecallRequest — boost opt-out', () => {
  function spyBoostStore() {
    const boostCalls: Array<{
      targets: ReadonlyArray<{ namespace: string; type: string; id: string }>;
      bump: number | undefined;
    }> = [];
    const store: import('../src/embeddings-store.js').EmbeddingsStore = {
      txScopeId: 'spy',
      delete: async () => undefined,
      upsert: async () => undefined,
      knnSearch: async () => [{ row: { id: 'd1' }, score: 0.9, salience: 0 }],
      boostSalience: async (targets, _halfLife, bump) => {
        boostCalls.push({ targets, bump });
        return targets;
      },
      fetchEmbeddings: async () => [],
      selectCandidates: async () => []
    };
    return { store, boostCalls };
  }

  it('reinforces by default (boost omitted) when writes are authorised', async () => {
    // Recall keeps boost-on by default — the asymmetry with embeddings/fetch
    // is deliberate. The write policy must still be answered before anything
    // is written.
    const embedder = new FakeEmbedder({ dimension: 8 });
    const { store, boostCalls } = spyBoostStore();
    await handleRecallRequest(
      { query: 'x', namespace: 'labs', type: 'Trace' },
      { embedder, store, checkWritePolicy: () => ({ allow: true }) }
    );
    expect(boostCalls).toHaveLength(1);
    expect(boostCalls[0]?.targets[0]).toMatchObject({ namespace: 'labs', type: 'Trace', id: 'd1' });
  });

  it('does NOT reinforce when the write policy denies — but still returns results', async () => {
    // Regression: recall's boost is a write, so it must obey the same write
    // policy that /substrate/v1/salience/boost enforces.
    const embedder = new FakeEmbedder({ dimension: 8 });
    const { store, boostCalls } = spyBoostStore();
    const out = await handleRecallRequest(
      { query: 'x', namespace: 'labs', type: 'Trace' },
      {
        embedder,
        store,
        checkWritePolicy: () => ({ allow: false, reason: 'writes require an identity' })
      }
    );
    // The read succeeded — a denied side effect must not cost the caller the
    // answer they actually asked for.
    expect(out.rows.length).toBeGreaterThan(0);
    expect(boostCalls).toHaveLength(0);
  });

  it('filters SPREAD targets per scope — authorising the queried type authorises nothing else', async () => {
    // Activation spreading reinforces neighbours in OTHER (namespace, type)
    // pairs, so a single check on the queried scope would wave through writes
    // to types the caller was never authorised for.
    const embedder = new FakeEmbedder({ dimension: 8 });
    const { store, boostCalls } = spyBoostStore();
    await handleRecallRequest(
      { query: 'x', namespace: 'labs', type: 'Trace' },
      {
        embedder,
        store,
        salience: { weight: 0, halfLifeHours: 168, spreadDamping: 0.3 },
        spreadResolver: async () => [
          { namespace: 'labs', type: 'Trace', id: 'neighbour-ok' },
          { namespace: 'labs', type: 'Secret', id: 'neighbour-denied' }
        ],
        checkWritePolicy: (_ns: string, type: string) => ({ allow: type === 'Trace' })
      }
    );
    // Spread runs in a detached promise chain; let it settle.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    const spread = boostCalls.filter((c) => c.targets.some((t) => t.id.startsWith('neighbour')));
    expect(spread).toHaveLength(1);
    expect(spread[0]?.targets.map((t) => t.id)).toEqual(['neighbour-ok']);
  });

  it('does NOT reinforce when no write policy is wired — absence is not permission', async () => {
    // Fails closed, opposite to checkReadPolicy whose absence means open.
    // Declining to reinforce costs a ranking signal; reinforcing without
    // authorisation is the defect.
    const embedder = new FakeEmbedder({ dimension: 8 });
    const { store, boostCalls } = spyBoostStore();
    await handleRecallRequest(
      { query: 'x', namespace: 'labs', type: 'Trace' },
      { embedder, store }
    );
    expect(boostCalls).toHaveLength(0);
  });

  it('skips reinforcement when boost:false (rows still returned)', async () => {
    const embedder = new FakeEmbedder({ dimension: 8 });
    const { store, boostCalls } = spyBoostStore();
    const out = await handleRecallRequest(
      { query: 'x', namespace: 'labs', type: 'Trace', boost: false },
      { embedder, store }
    );
    expect(out.rows).toHaveLength(1); // recall result is unchanged
    expect(boostCalls).toHaveLength(0); // but nothing was reinforced
  });
});

describe('returnVector (per-hit embeddings)', () => {
  const HIT_VECTOR = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8];

  it('threads returnVector to knnSearch and surfaces each row vector', async () => {
    const embedder = new FakeEmbedder({ dimension: 8 });
    const { store, calls } = makeStore({
      knnImpl: async () => [{ row: { id: 'd1' }, score: 0.9, vector: HIT_VECTOR }]
    });
    const out = await handleRecallRequest(
      { query: 'x', namespace: 'claude', type: 'Decision', returnVector: true },
      { embedder, store }
    );
    expect(calls[0]?.returnVector).toBe(true);
    expect(out.rows).toHaveLength(1);
    expect(out.rows[0]?.vector).toEqual(HIT_VECTOR);
    expect(out.rows[0]?.vector).toHaveLength(embedder.dimension);
    // The scored envelope is unchanged by the flag.
    expect(out.rows[0]?.score).toBe(0.9);
    expect(out.rows[0]?._salience).toBe(0);
    expect(out.rows[0]?._blendedScore).toBe(0.9);
  });

  it('default (flag absent) is byte-identical: no returnVector to the store, no vector key on rows', async () => {
    const embedder = new FakeEmbedder({ dimension: 8 });
    const { store, calls } = makeStore({
      knnImpl: async () => [{ row: { id: 'd1' }, score: 0.9 }]
    });
    const out = await handleRecallRequest(
      { query: 'x', namespace: 'claude', type: 'Decision' },
      { embedder, store }
    );
    expect(calls[0]?.returnVector).toBeUndefined();
    expect(out.rows[0]).not.toHaveProperty('vector');
  });

  it('returnVector: true on a denied scope still 403s before any store work (no vector leak)', async () => {
    const embedder = new FakeEmbedder({ dimension: 8 });
    const { store, calls } = makeStore({
      knnImpl: async () => [{ row: { id: 'd1' }, score: 0.9, vector: HIT_VECTOR }]
    });
    await expect(
      handleRecallRequest(
        { query: 'x', namespace: 'claude', type: 'Memory', returnVector: true },
        {
          embedder,
          store,
          checkReadPolicy: () => ({ allow: false, reason: 'denied' })
        }
      )
    ).rejects.toMatchObject({ code: 'policy_denied' });
    expect(calls).toHaveLength(0);
  });

  it('expansion rows carry the fetched neighbour vector; rows without a stored vector omit the key', async () => {
    const queryVec = new Float32Array([1, 0, 0]);
    const neighbourVec = new Float32Array([0.9, 0.1, 0]);
    const embedder = fixedEmbedder(queryVec);
    const edges = makeEdgesStubForRecall({
      'claude/Decision/d1': [
        {
          id: 'edge-1',
          from: { ns: 'claude', type: 'Decision', id: 'd2' },
          to: { ns: 'claude', type: 'Decision', id: 'd1' },
          fieldName: 'supersedes',
          policy: 'set_null',
          createdAt: new Date()
        }
      ]
    });
    // makeStoreWithFetch's knnSearch never returns a vector — so the direct
    // hit must omit the key even under returnVector: true, while the
    // expansion row carries the vector its cosine was scored from.
    const store = makeStoreWithFetch(
      [{ row: { id: 'd1' }, score: 0.7 }],
      [{ ns: 'claude', type: 'Decision', id: 'd2', row: { id: 'd2' }, vector: neighbourVec }]
    );
    const registry = new SpreadEdgeRegistry();
    registry.add('claude', 'Decision', {
      fieldName: 'supersedes',
      targetNs: 'claude',
      targetType: 'Decision'
    });
    const resolver = makeExpansionResolver(registry, edges, DEFAULT_EXPANSION);
    const out = await handleRecallRequest(
      { query: 'x', namespace: 'claude', type: 'Decision', expand: true, returnVector: true },
      { embedder, store, expansionResolver: resolver }
    );
    const direct = out.rows.find((r) => r.row.id === 'd1');
    const expanded = out.rows.find((r) => r.row.id === 'd2');
    expect(direct).toBeDefined();
    expect(direct).not.toHaveProperty('vector');
    expect(expanded?.vector).toEqual(Array.from(neighbourVec));
  });

  it('route rejects a non-boolean returnVector with 400', async () => {
    const embedder = new FakeEmbedder({ dimension: 8 });
    const { store } = makeStore();
    const handler = recallRouteHandler({ embedder, store });
    const res = await handler(makePostReq({ query: 'x', returnVector: 'yes' }));
    expect(res.status).toBe(400);
  });
});

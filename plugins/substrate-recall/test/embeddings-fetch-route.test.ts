/**
 * POST /substrate/v1/embeddings/fetch: EmbeddingsStore.fetchEmbeddings over HTTP.
 *
 * The route inherits the same ReadPolicyCheck as /substrate/v1/recall: raw vectors
 * leak content geometry, so a gated recall with an open embeddings route
 * would be decorative. Denial is LOUD: the caller names explicit refs, so any
 * denied (namespace, type) scope fails the whole request with a 403
 * policy_denied, never silent empties.
 */

import { FakeEmbedder } from '@mnmal-ai/substrate-embedder/fake';
import type { Identity, SubstrateRequest, SubstrateResponse } from '@mnmal-ai/substrate-types';
import { describe, expect, it } from 'vitest';
import {
  EMBEDDINGS_FETCH_MAX_REFS,
  embeddingsFetchRouteHandler
} from '../src/embeddings-fetch-route.js';
import type { EmbeddingsStore } from '../src/embeddings-store.js';
import { createRecallPlugin } from '../src/plugin.js';

// Boosting is a WRITE and needs a write policy that permits it. Absent, the
// boost is silently declined while the read is still served, so a test that
// expects a boost to land must authorise one.
const ALLOW_WRITES = () => ({ allow: true }) as const;

type FetchCall = {
  ids: ReadonlyArray<{ namespace: string; type: string; id: string }>;
  model: string;
};

function makeStore(
  rows: Array<{
    namespace: string;
    type: string;
    id: string;
    row: Record<string, unknown>;
    vector: Float32Array;
    salience: number;
  }> = []
): { store: EmbeddingsStore; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const store: EmbeddingsStore = {
    txScopeId: 'test-store',
    delete: async () => undefined,
    upsert: async () => undefined,
    knnSearch: async () => [],
    boostSalience: async () => [],
    fetchEmbeddings: async (ids, model) => {
      calls.push({ ids, model });
      const want = new Set(ids.map((r) => `${r.namespace}/${r.type}/${r.id}`));
      return rows.filter((r) => want.has(`${r.namespace}/${r.type}/${r.id}`));
    },
    selectCandidates: async () => []
  };
  return { store, calls };
}

function makeReq(body: unknown, identity?: Identity): SubstrateRequest {
  const req: SubstrateRequest = {
    method: 'POST',
    path: '/substrate/v1/embeddings/fetch',
    headers: { 'content-type': 'application/json' },
    query: {},
    params: {},
    body: Buffer.from(JSON.stringify(body), 'utf8')
  };
  if (identity !== undefined) req.identity = identity;
  return req;
}

function json<T>(res: SubstrateResponse): T {
  return JSON.parse(String(res.body)) as T;
}

const REF = { namespace: 'claude', type: 'Memory', id: 'm-1' };
const ROW = {
  ...REF,
  row: { id: 'm-1', name: 'x' },
  vector: new Float32Array([0.5, -0.25, 1]),
  salience: 0
};

describe('embeddingsFetchRouteHandler', () => {
  it('fetches vectors in one batched store call; Float32Array serialises to number[]', async () => {
    const { store, calls } = makeStore([ROW]);
    const handler = embeddingsFetchRouteHandler({
      store,
      checkWritePolicy: ALLOW_WRITES,
      embedder: new FakeEmbedder({ dimension: 3 })
    });

    const res = await handler(makeReq({ refs: [REF] }));
    expect(res.status).toBe(200);
    const body = json<{ vectors: Array<{ id: string; vector: number[] }>; model: string }>(res);
    expect(body.vectors).toHaveLength(1);
    expect(body.vectors[0]?.vector).toEqual([0.5, -0.25, 1]);
    expect(body.model).toBe('fake:v1:3');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.model).toBe('fake:v1:3');
  });

  it('explicit model overrides the embedder default; refs without embeddings are silently absent', async () => {
    const { store, calls } = makeStore([]);
    const handler = embeddingsFetchRouteHandler({
      store,
      checkWritePolicy: ALLOW_WRITES,
      embedder: new FakeEmbedder({ dimension: 3 })
    });

    const res = await handler(makeReq({ refs: [REF], model: 'older-model' }));
    expect(res.status).toBe(200);
    expect(json<{ vectors: unknown[] }>(res).vectors).toEqual([]);
    expect(calls[0]?.model).toBe('older-model');
  });

  it('400 when no model is supplied and no embedder is configured', async () => {
    const { store } = makeStore();
    const handler = embeddingsFetchRouteHandler({ store, checkWritePolicy: ALLOW_WRITES });
    const res = await handler(makeReq({ refs: [REF] }));
    expect(res.status).toBe(400);
    expect(json<{ code: string }>(res).code).toBe('bad_request');
  });

  it('400 on malformed bodies: missing/empty/ill-shaped refs', async () => {
    const { store } = makeStore();
    const handler = embeddingsFetchRouteHandler({
      store,
      checkWritePolicy: ALLOW_WRITES,
      embedder: new FakeEmbedder({ dimension: 3 })
    });
    for (const bad of [
      {},
      { refs: [] },
      { refs: 'nope' },
      { refs: [{ namespace: 'claude', type: 'Memory' }] },
      { refs: [{ namespace: 'claude', type: 'Memory', id: 7 }] }
    ]) {
      const res = await handler(makeReq(bad));
      expect(res.status).toBe(400);
    }
  });

  it(`400 when refs exceed the cap (${500})`, async () => {
    const { store } = makeStore();
    const handler = embeddingsFetchRouteHandler({
      store,
      checkWritePolicy: ALLOW_WRITES,
      embedder: new FakeEmbedder({ dimension: 3 })
    });
    const refs = Array.from({ length: EMBEDDINGS_FETCH_MAX_REFS + 1 }, (_, i) => ({
      namespace: 'claude',
      type: 'Memory',
      id: `m-${i}`
    }));
    const res = await handler(makeReq({ refs }));
    expect(res.status).toBe(400);
    expect(json<{ message: string }>(res).message).toContain(String(EMBEDDINGS_FETCH_MAX_REFS));
  });

  it('gate: any denied (namespace, type) scope fails the WHOLE request 403 — store untouched', async () => {
    const { store, calls } = makeStore([ROW]);
    const seen: Array<{ ns: string; type: string; identity: unknown }> = [];
    const handler = embeddingsFetchRouteHandler({
      store,
      checkWritePolicy: ALLOW_WRITES,
      embedder: new FakeEmbedder({ dimension: 3 }),
      checkReadPolicy: (ns, type, identity) => {
        seen.push({ ns, type, identity });
        return type === 'Memory'
          ? { allow: false, reason: 'reads require an authenticated identity' }
          : { allow: true };
      }
    });

    const res = await handler(
      makeReq({ refs: [REF, { namespace: 'claude', type: 'Decision', id: 'd-1' }] })
    );
    expect(res.status).toBe(403);
    const body = json<{ error: { code: string; message: string } }>(res);
    expect(body.error.code).toBe('policy_denied');
    expect(body.error.message).toContain('claude/Memory');
    expect(body.error.message).toContain('authenticated identity');
    expect(calls).toHaveLength(0);
    // Anonymous request → identity bound as null.
    expect(seen.every((s) => s.identity === null)).toBe(true);
  });

  it('gate: evaluates each DISTINCT scope once and binds req.identity', async () => {
    const { store } = makeStore([ROW]);
    const seen: Array<{ ns: string; type: string; identity: unknown }> = [];
    const handler = embeddingsFetchRouteHandler({
      store,
      checkWritePolicy: ALLOW_WRITES,
      embedder: new FakeEmbedder({ dimension: 3 }),
      checkReadPolicy: (ns, type, identity) => {
        seen.push({ ns, type, identity });
        return { allow: true };
      }
    });

    const res = await handler(
      makeReq(
        {
          refs: [
            REF,
            { namespace: 'claude', type: 'Memory', id: 'm-2' },
            { namespace: 'claude', type: 'Decision', id: 'd-1' }
          ]
        },
        { id: 'agent-1', grants: {} }
      )
    );
    expect(res.status).toBe(200);
    expect(seen).toHaveLength(2); // Memory + Decision — deduped
    expect(seen[0]?.identity).toEqual({ id: 'agent-1', grants: {} });
  });

  it('200 when a valid payload also carries a top-level "error" key', async () => {
    const { store } = makeStore([ROW]);
    const handler = embeddingsFetchRouteHandler({
      store,
      checkWritePolicy: ALLOW_WRITES,
      embedder: new FakeEmbedder({ dimension: 3 })
    });
    const res = await handler(makeReq({ error: 'boom', refs: [REF] }));
    expect(res.status).toBe(200);
    expect(json<{ vectors: unknown[] }>(res).vectors).toHaveLength(1);
  });

  it('no checkReadPolicy configured → open (back-compat)', async () => {
    const { store } = makeStore([ROW]);
    const handler = embeddingsFetchRouteHandler({
      store,
      checkWritePolicy: ALLOW_WRITES,
      embedder: new FakeEmbedder({ dimension: 3 })
    });
    const res = await handler(makeReq({ refs: [REF] }));
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Salience over HTTP — the transport half of the core's contract.
// ---------------------------------------------------------------------------

function boostSpyStore() {
  const boostCalls: Array<{
    targets: ReadonlyArray<{ namespace: string; type: string; id: string }>;
    halfLifeHours: number;
  }> = [];
  const store: EmbeddingsStore = {
    txScopeId: 'boost-spy',
    delete: async () => undefined,
    upsert: async () => undefined,
    knnSearch: async () => [],
    boostSalience: async (targets, halfLifeHours) => {
      boostCalls.push({ targets, halfLifeHours });
      return targets;
    },
    fetchEmbeddings: async () => [{ ...ROW, salience: 7 }],
    selectCandidates: async () => []
  };
  return { store, boostCalls };
}

describe('embeddingsFetchRouteHandler — salience', () => {
  it('surfaces _salience and reinforces the returned rows when boost:true', async () => {
    const { store, boostCalls } = boostSpyStore();
    const handler = embeddingsFetchRouteHandler({
      store,
      checkWritePolicy: ALLOW_WRITES,
      embedder: new FakeEmbedder({ dimension: 3 })
    });
    const res = await handler(makeReq({ refs: [REF], boost: true }));
    expect(res.status).toBe(200);
    expect(json<{ vectors: Array<{ _salience: number }> }>(res).vectors[0]?._salience).toBe(7);
    expect(boostCalls).toHaveLength(1);
    expect(boostCalls[0]?.targets).toEqual([REF]);
  });

  it('honours boost:false over the wire', async () => {
    const { store, boostCalls } = boostSpyStore();
    const handler = embeddingsFetchRouteHandler({
      store,
      checkWritePolicy: ALLOW_WRITES,
      embedder: new FakeEmbedder({ dimension: 3 })
    });
    const res = await handler(makeReq({ refs: [REF], boost: false }));
    expect(res.status).toBe(200);
    expect(json<{ vectors: unknown[] }>(res).vectors).toHaveLength(1);
    expect(boostCalls).toHaveLength(0);
  });

  it('rejects a non-boolean boost with 400 rather than coercing it', async () => {
    const { store } = boostSpyStore();
    const handler = embeddingsFetchRouteHandler({
      store,
      checkWritePolicy: ALLOW_WRITES,
      embedder: new FakeEmbedder({ dimension: 3 })
    });
    const res = await handler(makeReq({ refs: [REF], boost: 'yes' }));
    expect(res.status).toBe(400);
  });

  it('threads the route salience config half-life to the store', async () => {
    const { store, boostCalls } = boostSpyStore();
    const handler = embeddingsFetchRouteHandler({
      store,
      checkWritePolicy: ALLOW_WRITES,
      embedder: new FakeEmbedder({ dimension: 3 }),
      salience: { weight: 0, halfLifeHours: 12, spreadDamping: 0 }
    });
    await handler(makeReq({ refs: [REF], boost: true }));
    expect(boostCalls[0]?.halfLifeHours).toBe(12);
  });
});

describe('createRecallPlugin wiring', () => {
  it('passes the plugin salience config down to the fetch route', async () => {
    const { store, boostCalls } = boostSpyStore();
    const plugin = createRecallPlugin({
      store,
      embedder: new FakeEmbedder({ dimension: 3 }),
      salience: { weight: 0, halfLifeHours: 36, spreadDamping: 0 },
      // Authorised at the PLUGIN level: asserts createRecallPlugin threads
      // checkWritePolicy down to the route, not just that the route honours
      // one handed to it directly.
      checkWritePolicy: () => ({ allow: true })
    });
    const claim = plugin.kernelRoutes?.find((r) => r.path === 'embeddings/fetch');
    const res = await claim!.handler(makeReq({ refs: [REF], boost: true }));
    expect(res.status).toBe(200);
    expect(boostCalls[0]?.halfLifeHours).toBe(36);
  });

  it('registers embeddings/fetch as a kernel route with the plugin checkReadPolicy threaded', async () => {
    const { store } = makeStore([ROW]);
    const plugin = createRecallPlugin({
      store,
      embedder: new FakeEmbedder({ dimension: 3 }),
      checkReadPolicy: () => ({ allow: false, reason: 'gated' })
    });
    const claim = plugin.kernelRoutes?.find((r) => r.path === 'embeddings/fetch');
    expect(claim).toBeDefined();
    expect(claim?.method).toBe('POST');

    const res = await claim!.handler(makeReq({ refs: [REF] }));
    expect(res.status).toBe(403);
  });
});

/**
 * The FRAME adapters for the `recall` virtual namespace (frame-surface.ts):
 * they bind ctx.identity the way routes bind req.identity, delegate to the same
 * transport-agnostic cores (handleRecallRequest / handleSalienceBoost /
 * handleEmbeddingsFetch), and map coded throws to ResolverFrameError so the
 * engine surfaces the same code the route maps to an HTTP status.
 */

import type { Embedder } from '@mnmal-ai/substrate-embedder';
import { FakeEmbedder } from '@mnmal-ai/substrate-embedder/fake';
import type { Identity, PolicyDecision, RequestContext } from '@mnmal-ai/substrate-types';
import { isResolverFrameError } from '@mnmal-ai/substrate-types';
import { describe, expect, it, vi } from 'vitest';
import type { EmbeddingsStore, EmbeddingsStoreKnnInput } from '../src/embeddings-store.js';
import { makeExpansionResolver } from '../src/expansion-resolver.js';
import { buildRecallFrameSurface, HIT_FIELDS, type RecallFrameDeps } from '../src/frame-surface.js';
import { makeSpreadResolver, SpreadEdgeRegistry } from '../src/spread-resolver.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
    fetchImpl?: EmbeddingsStore['fetchEmbeddings'];
  } = {}
): {
  store: EmbeddingsStore;
  knnCalls: EmbeddingsStoreKnnInput[];
  boostCalls: Array<{
    targets: ReadonlyArray<{ namespace: string; type: string; id: string }>;
    halfLife: number;
    bump: number | undefined;
  }>;
} {
  const knnCalls: EmbeddingsStoreKnnInput[] = [];
  const boostCalls: Array<{
    targets: ReadonlyArray<{ namespace: string; type: string; id: string }>;
    halfLife: number;
    bump: number | undefined;
  }> = [];
  const knnImpl = opts.knnImpl ?? (async () => []);
  const store: EmbeddingsStore = {
    txScopeId: 'test-store',
    delete: async () => undefined,
    upsert: async () => undefined,
    knnSearch: async (input) => {
      knnCalls.push(input);
      const raw = await knnImpl(input);
      return raw.map((r) => ({
        row: r.row,
        score: r.score,
        salience: r.salience ?? 0,
        ...(r.vector !== undefined ? { vector: r.vector } : {})
      }));
    },
    boostSalience: async (targets, halfLife, bump) => {
      boostCalls.push({ targets, halfLife, bump });
      return targets;
    },
    fetchEmbeddings: opts.fetchImpl ?? (async () => []),
    selectCandidates: async () => []
  };
  return { store, knnCalls, boostCalls };
}

function makeCtx(identity: Identity | null = null): RequestContext {
  return {
    identity,
    namespace: 'recall',
    operation: 'query',
    now: new Date(),
    headers: {},
    meta: {}
  };
}

/** Default deps bag: store + (optional) embedder + spread/expansion resolvers. */
function makeDeps(
  store: EmbeddingsStore,
  overrides: Partial<RecallFrameDeps> = {}
): RecallFrameDeps {
  const registry = new SpreadEdgeRegistry();
  const spreadResolver = makeSpreadResolver(registry, null);
  const expansionResolver = makeExpansionResolver(registry, null, {
    maxNeighboursPerSeed: 8,
    maxTotalNeighbours: 50
  });
  return {
    store,
    spreadResolver,
    expansionResolver,
    expansionEnabled: true,
    // Writes authorised by default so the read-oriented cases are unaffected;
    // the boost cases override it to assert the gate, which the frame path
    // needs because it reaches the same mutating cores as the routes.
    checkWritePolicy: () => ({ allow: true }),
    ...overrides
  };
}

/** Resolve a frame resolver result that may be Row | Row[] | ... to a Row[]. */
async function rowsOf(result: unknown): Promise<Array<Record<string, unknown>>> {
  const r = await result;
  if (Array.isArray(r)) return r as Array<Record<string, unknown>>;
  return [r as Record<string, unknown>];
}

/**
 * Run a (possibly-undefined) resolver and return the thrown error, or undefined
 * on success. Wraps in Promise.resolve so the AsyncIterable arm of the resolver
 * return union doesn't trip `.then` typing.
 */
async function rejectionOf(result: unknown): Promise<unknown> {
  return Promise.resolve(result).then(
    () => undefined,
    (e: unknown) => e
  );
}

const HIT_VECTOR = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8];

// ---------------------------------------------------------------------------
// 1. Hit resolver returns spec-envelope rows
// ---------------------------------------------------------------------------

describe('recall/Hit frame resolver', () => {
  it('returns spec-envelope rows (id, namespace, type, score, salience, blendedScore, kind, vector, row)', async () => {
    const embedder = new FakeEmbedder({ dimension: 8 });
    const { store } = makeStore({
      knnImpl: async () => [{ row: { id: 'm1', topic: 'auth' }, score: 0.92, vector: HIT_VECTOR }]
    });
    const surface = buildRecallFrameSurface(makeDeps(store, { embedder }));
    const hit = surface.types?.Hit;
    expect(hit).toBeDefined();
    const rows = await rowsOf(
      hit?.resolver(makeCtx(), {
        params: {
          to: 'anything',
          namespace: 'claude',
          type: 'Memory',
          k: 5,
          boost: false,
          returnVector: true
        }
      })
    );
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row).toMatchObject({
      id: 'm1',
      namespace: 'claude',
      type: 'Memory',
      score: 0.92,
      kind: 'seed',
      vector: HIT_VECTOR
    });
    expect(typeof row?.salience).toBe('number');
    expect(typeof row?.blendedScore).toBe('number');
    expect(row?.row).toEqual({ id: 'm1', topic: 'auth' });
  });

  // -------------------------------------------------------------------------
  // 2. No embedder → coded frame error
  // -------------------------------------------------------------------------

  it('rejects with embedder_unavailable (a ResolverFrameError) when no embedder is wired', async () => {
    const { store } = makeStore();
    const surface = buildRecallFrameSurface(makeDeps(store)); // no embedder
    const hit = surface.types?.Hit;
    const err = await rejectionOf(hit?.resolver(makeCtx(), { params: { to: 'x' } }));
    expect(err).toBeDefined();
    expect(isResolverFrameError(err)).toBe(true);
    expect((err as { code: string }).code).toBe('embedder_unavailable');
  });

  // -------------------------------------------------------------------------
  // 3. params validation
  // -------------------------------------------------------------------------

  it('rejects bad params with bad_request (missing/empty to, non-number k, non-boolean boost)', async () => {
    const embedder = new FakeEmbedder({ dimension: 8 });
    const { store } = makeStore();
    const surface = buildRecallFrameSurface(makeDeps(store, { embedder }));
    const hit = surface.types?.Hit;

    const reject = async (params: Record<string, unknown>): Promise<unknown> =>
      rejectionOf(hit?.resolver(makeCtx(), { params }));

    for (const params of [
      {}, // missing to
      { to: '' }, // empty to
      { to: 'x', k: 'five' }, // non-number k
      { to: 'x', boost: 'no' } // non-boolean boost
    ]) {
      const err = await reject(params);
      expect(isResolverFrameError(err)).toBe(true);
      expect((err as { code: string }).code).toBe('bad_request');
    }
  });

  // -------------------------------------------------------------------------
  // 6. fields projection
  // -------------------------------------------------------------------------

  it('projects only the requested fields when fields is non-empty', async () => {
    const embedder = new FakeEmbedder({ dimension: 8 });
    const { store } = makeStore({
      knnImpl: async () => [{ row: { id: 'm1' }, score: 0.5 }]
    });
    const surface = buildRecallFrameSurface(makeDeps(store, { embedder }));
    const hit = surface.types?.Hit;
    const rows = await rowsOf(
      hit?.resolver(makeCtx(), {
        params: { to: 'x', namespace: 'claude', type: 'Memory', boost: false },
        fields: { id: true, score: true }
      })
    );
    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0] ?? {}).sort()).toEqual(['id', 'score']);
  });

  // -------------------------------------------------------------------------
  // 7. boost default-on parity
  // -------------------------------------------------------------------------

  it('fires store.boostSalience by default (boost omitted) and skips it on boost:false', async () => {
    const embedder = new FakeEmbedder({ dimension: 8 });

    // Default-on: boost omitted → boostSalience called.
    {
      const { store, boostCalls } = makeStore({
        knnImpl: async () => [{ row: { id: 'm1' }, score: 0.9 }]
      });
      const surface = buildRecallFrameSurface(makeDeps(store, { embedder }));
      await surface.types?.Hit?.resolver(makeCtx(), {
        params: { to: 'x', namespace: 'claude', type: 'Memory' }
      });
      // Fire-and-forget; flush a microtask just in case.
      await Promise.resolve();
      expect(boostCalls).toHaveLength(1);
      expect(boostCalls[0]?.targets[0]).toMatchObject({
        namespace: 'claude',
        type: 'Memory',
        id: 'm1'
      });
    }

    // Opt-out: boost:false → boostSalience NOT called.
    {
      const { store, boostCalls } = makeStore({
        knnImpl: async () => [{ row: { id: 'm1' }, score: 0.9 }]
      });
      const surface = buildRecallFrameSurface(makeDeps(store, { embedder }));
      await surface.types?.Hit?.resolver(makeCtx(), {
        params: { to: 'x', namespace: 'claude', type: 'Memory', boost: false }
      });
      await Promise.resolve();
      expect(boostCalls).toHaveLength(0);
    }
  });
});

// ---------------------------------------------------------------------------
// 4. boost mutation delegates with frame-ctx identity
// ---------------------------------------------------------------------------

describe('recall/boost frame mutation', () => {
  it('delegates to the core with the ctx identity bound into the read-policy check', async () => {
    const { store, boostCalls } = makeStore();
    const identity: Identity = { id: 'agent-1', grants: {} };
    const checkReadPolicy = vi.fn(
      (_ns: string, _type: string, _id: Identity | null): PolicyDecision => ({ allow: true })
    );
    const surface = buildRecallFrameSurface(makeDeps(store, { checkReadPolicy }));
    const boost = surface.mutations?.boost;
    expect(boost).toBeDefined();

    const result = await boost?.resolver(makeCtx(identity), {
      params: { targets: [{ namespace: 'claude', type: 'Memory', id: 'm1' }] }
    });
    expect(result).toEqual({ id: 'ack', ok: true, requested: 1, applied: 1, missing: [] });
    expect(boostCalls).toHaveLength(1);
    expect(checkReadPolicy).toHaveBeenCalledWith(
      'claude',
      'Memory',
      identity,
      expect.objectContaining({ identity })
    );
  });

  it('rejects bad boost params with bad_request', async () => {
    const { store } = makeStore();
    const surface = buildRecallFrameSurface(makeDeps(store));
    const err = await rejectionOf(
      surface.mutations?.boost?.resolver(makeCtx(), { params: { targets: [] } })
    );
    expect(isResolverFrameError(err)).toBe(true);
    expect((err as { code: string }).code).toBe('bad_request');
  });
});

// ---------------------------------------------------------------------------
// 5. fetchEmbeddings mutation
// ---------------------------------------------------------------------------

describe('recall/fetchEmbeddings frame mutation', () => {
  it('returns { id, vectors, model } matching the core output', async () => {
    const embedder: Embedder = new FakeEmbedder({ dimension: 8 });
    // Values chosen to round-trip exactly through Float32Array (the store
    // returns Float32Array; the core widens via Array.from).
    const exactVec = [0, 0.5, 0.25, 1, -1, 0.125, -0.5, 0.75];
    const { store } = makeStore({
      fetchImpl: async () => [
        {
          namespace: 'claude',
          type: 'Memory',
          id: 'm1',
          row: { id: 'm1' },
          vector: new Float32Array(exactVec),
          salience: 0
        }
      ]
    });
    const surface = buildRecallFrameSurface(makeDeps(store, { embedder }));
    const fetch = surface.mutations?.fetchEmbeddings;
    expect(fetch).toBeDefined();
    const result = (await fetch?.resolver(makeCtx(), {
      params: { refs: [{ namespace: 'claude', type: 'Memory', id: 'm1' }] }
    })) as Record<string, unknown>;
    expect(result.id).toBe('embeddings');
    expect(result.model).toBe(embedder.modelId);
    expect(result.vectors).toEqual([
      {
        namespace: 'claude',
        type: 'Memory',
        id: 'm1',
        row: { id: 'm1' },
        vector: exactVec,
        _salience: 0
      }
    ]);
  });

  it('propagates a policy denial as coded policy_denied naming the scope', async () => {
    const embedder: Embedder = new FakeEmbedder({ dimension: 8 });
    const { store } = makeStore();
    const checkReadPolicy = vi.fn((): PolicyDecision => ({ allow: false, reason: 'no read' }));
    const surface = buildRecallFrameSurface(makeDeps(store, { embedder, checkReadPolicy }));
    const err = await rejectionOf(
      surface.mutations?.fetchEmbeddings?.resolver(makeCtx(), {
        params: { refs: [{ namespace: 'claude', type: 'Memory', id: 'm1' }] }
      })
    );
    expect(isResolverFrameError(err)).toBe(true);
    expect((err as { code: string }).code).toBe('policy_denied');
    expect((err as Error).message).toContain('claude/Memory');
  });
});

// ---------------------------------------------------------------------------
// 8. HIT_FIELDS schema / hitRow key-set parity
// ---------------------------------------------------------------------------

describe('HIT_FIELDS schema parity', () => {
  it('HIT_FIELDS keys equal the full union of keys a hitRow can produce (seed + expansion + vector)', async () => {
    // A seed row with returnVector:true carries every key except expandedFrom,
    // which only expansion sets; the full union is pinned by the literal below.
    const embedder = new FakeEmbedder({ dimension: 8 });
    const { store } = makeStore({
      knnImpl: async () => [
        {
          row: { id: 'm1', topic: 'auth' },
          score: 0.9,
          vector: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8]
        }
      ]
    });
    const surface = buildRecallFrameSurface(makeDeps(store, { embedder }));
    const hit = surface.types?.Hit;
    const rows = await rowsOf(
      hit?.resolver(makeCtx(), {
        params: {
          to: 'anything',
          namespace: 'claude',
          type: 'Memory',
          returnVector: true,
          boost: false
        }
      })
    );
    expect(rows).toHaveLength(1);
    const seedRow = rows[0] ?? {};

    // A seed row contains all keys except expandedFrom; HIT_FIELDS must cover all of them.
    const seedKeys = Object.keys(seedRow).sort();
    const schemaKeys = Object.keys(HIT_FIELDS).sort();

    // Every key the resolver emitted must be declared in HIT_FIELDS.
    for (const k of seedKeys) {
      expect(schemaKeys).toContain(k);
    }

    // HIT_FIELDS must declare exactly the full union: the 8 always-present
    // keys plus expandedFrom and vector (both optional in hitRow).
    const expectedFullSet = [
      'blendedScore',
      'expandedFrom',
      'id',
      'kind',
      'namespace',
      'row',
      'salience',
      'score',
      'type',
      'vector'
    ].sort();
    expect(schemaKeys).toEqual(expectedFullSet);
  });
});

describe('the two spellings name each other', () => {
  // Recall's search text is `to` on the FRAME and `query` on the route and the
  // MCP tool. Renaming either breaks callers, so neither is renamed — the
  // REFUSAL names the other spelling, because the error is the one channel a
  // confused caller is guaranteed to read.
  const errorFor = async (params: Record<string, unknown>): Promise<string> => {
    const { store } = makeStore();
    const surface = buildRecallFrameSurface(
      makeDeps(store, { embedder: new FakeEmbedder({ dimension: 8 }) })
    );
    const err = await rejectionOf(surface.types?.Hit?.resolver(makeCtx(), { params }));
    expect(isResolverFrameError(err)).toBe(true);
    return String((err as { message: string }).message);
  };

  it('tells a caller who passed `query` what THIS surface calls it', async () => {
    const message = await errorFor({ query: 'some text' });
    expect(message).toContain('to');
    expect(message).toContain('query');
    expect(message).toMatch(/FRAME/);
  });

  it('names both spellings on a bare omission too', async () => {
    // The discriminating case: without this, the assertion above could pass on
    // a message that only mentions `query` because the caller supplied it.
    const message = await errorFor({});
    expect(message).toContain('to');
    expect(message).toContain('query');
  });
});

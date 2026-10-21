import { FakeEmbedder } from '@mnmal-ai/substrate-embedder/fake';
import type { Identity, SubstrateRequest, SubstrateResponse } from '@mnmal-ai/substrate-types';
import { describe, expect, it } from 'vitest';
import type { EmbeddingsStore, SalienceTarget } from '../src/embeddings-store.js';
import { InMemoryEmbeddingsStore } from '../src/in-memory-embeddings-store.js';
import { handleRecallRequest } from '../src/recall-route.js';
import {
  SALIENCE_BOOST_MAX_TARGETS,
  salienceBoostRouteHandler
} from '../src/salience-boost-route.js';

// Boosting is a WRITE and needs a write policy that permits it; absent, the
// route refuses. Tests that expect a boost to land must authorise one, so a
// test that forgets sees a 403 rather than an unauthorised write.
const ALLOW_WRITES = () => ({ allow: true }) as const;

type BoostCall = {
  targets: ReadonlyArray<SalienceTarget>;
  halfLifeHours: number;
  bump: number | undefined;
};

function makeStore(): { store: EmbeddingsStore; calls: BoostCall[] } {
  const calls: BoostCall[] = [];
  const store: EmbeddingsStore = {
    txScopeId: 'test-store',
    delete: async () => undefined,
    upsert: async () => undefined,
    knnSearch: async () => [],
    boostSalience: async (targets, halfLifeHours, bump) => {
      calls.push({ targets, halfLifeHours, bump });
      return targets;
    },
    fetchEmbeddings: async () => [],
    selectCandidates: async () => []
  };
  return { store, calls };
}

function makeReq(body: unknown, identity?: Identity): SubstrateRequest {
  const req: SubstrateRequest = {
    method: 'POST',
    path: '/substrate/v1/salience/boost',
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

const TARGET = { namespace: 'labs', type: 'Trace', id: 't-1' };

describe('salienceBoostRouteHandler', () => {
  it('boosts the named targets and returns { ok, requested }', async () => {
    const { store, calls } = makeStore();
    const res = await salienceBoostRouteHandler({ store, checkWritePolicy: ALLOW_WRITES })(
      makeReq({ targets: [TARGET] })
    );
    expect(res.status).toBe(200);
    expect(json(res)).toEqual({ ok: true, requested: 1, applied: 1, missing: [] });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.targets).toEqual([TARGET]);
    expect(calls[0]?.halfLifeHours).toBe(24 * 7); // DEFAULT_SALIENCE_CONFIG.halfLifeHours
    expect(calls[0]?.bump).toBeUndefined(); // store applies its default bump=1
  });

  it('passes an explicit bump through', async () => {
    const { store, calls } = makeStore();
    await salienceBoostRouteHandler({ store, checkWritePolicy: ALLOW_WRITES })(
      makeReq({ targets: [TARGET], bump: 0.3 })
    );
    expect(calls[0]?.bump).toBe(0.3);
  });

  it('400 on empty/missing targets', async () => {
    const { store } = makeStore();
    const res = await salienceBoostRouteHandler({ store, checkWritePolicy: ALLOW_WRITES })(
      makeReq({ targets: [] })
    );
    expect(res.status).toBe(400);
  });

  it('400 on a malformed target (non-string id)', async () => {
    const { store } = makeStore();
    const res = await salienceBoostRouteHandler({ store, checkWritePolicy: ALLOW_WRITES })(
      makeReq({ targets: [{ namespace: 'labs', type: 'Trace', id: 5 }] })
    );
    expect(res.status).toBe(400);
  });

  it('400 on a non-positive bump', async () => {
    const { store } = makeStore();
    const res = await salienceBoostRouteHandler({ store, checkWritePolicy: ALLOW_WRITES })(
      makeReq({ targets: [TARGET], bump: 0 })
    );
    expect(res.status).toBe(400);
  });

  it('403 when read policy denies the targets scope', async () => {
    const { store, calls } = makeStore();
    const res = await salienceBoostRouteHandler({
      store,
      checkWritePolicy: ALLOW_WRITES,
      checkReadPolicy: () => ({ allow: false, reason: 'no keys' })
    })(makeReq({ targets: [TARGET] }, { id: 'agent-1', grants: {} }));
    expect(res.status).toBe(403);
    expect(json<{ error: { code: string } }>(res).error.code).toBe('policy_denied');
    expect(calls).toHaveLength(0); // gated before any store work
  });

  it('400 when targets exceed the per-request cap', async () => {
    const { store, calls } = makeStore();
    const many = Array.from({ length: SALIENCE_BOOST_MAX_TARGETS + 1 }, (_, i) => ({
      namespace: 'labs',
      type: 'Trace',
      id: `t-${i}`
    }));
    const res = await salienceBoostRouteHandler({ store, checkWritePolicy: ALLOW_WRITES })(
      makeReq({ targets: many })
    );
    expect(res.status).toBe(400);
    // the cap value is surfaced in the message so callers can detect it
    expect(json<{ message: string }>(res).message).toContain(String(SALIENCE_BOOST_MAX_TARGETS));
    expect(calls).toHaveLength(0);
  });

  it('200 when a valid payload also carries a top-level "error" key', async () => {
    const { store, calls } = makeStore();
    const res = await salienceBoostRouteHandler({ store, checkWritePolicy: ALLOW_WRITES })(
      makeReq({ error: 'boom', targets: [TARGET] })
    );
    expect(res.status).toBe(200);
    expect(json(res)).toEqual({ ok: true, requested: 1, applied: 1, missing: [] });
    expect(calls).toHaveLength(1);
  });

  it('evaluates each distinct (namespace, type) scope once despite repeated scopes', async () => {
    const { store, calls } = makeStore();
    const seenScopes: string[] = [];
    const res = await salienceBoostRouteHandler({
      store,
      checkWritePolicy: ALLOW_WRITES,
      checkReadPolicy: (ns, type) => {
        seenScopes.push(`${ns}/${type}`);
        return { allow: true };
      }
    })(
      makeReq(
        {
          targets: [
            { namespace: 'labs', type: 'Trace', id: 't-1' },
            { namespace: 'labs', type: 'Trace', id: 't-2' }, // same scope as t-1 → deduped
            { namespace: 'labs', type: 'Concept', id: 'c-1' } // distinct scope
          ]
        },
        { id: 'agent-1', grants: {} }
      )
    );
    expect(res.status).toBe(200);
    expect(seenScopes).toEqual(['labs/Trace', 'labs/Concept']); // Trace checked once, not twice
    expect(calls).toHaveLength(1);
    expect(calls[0]?.targets).toHaveLength(3); // all three rows are still boosted
  });
});

describe('salience/boost over a real InMemoryEmbeddingsStore', () => {
  async function seeded() {
    const embedder = new FakeEmbedder({ dimension: 8 });
    const store = new InMemoryEmbeddingsStore();
    const vector = await embedder.embed('the operators favorite color is black');
    await store.upsert({
      rowNamespace: 'labs',
      rowType: 'Trace',
      rowId: 't-1',
      vector,
      model: embedder.modelId
    });
    return { embedder, store, vector };
  }

  async function salienceOf(store: InMemoryEmbeddingsStore, vector: Float32Array): Promise<number> {
    const hits = await store.knnSearch({
      namespace: 'labs',
      type: 'Trace',
      model: new FakeEmbedder({ dimension: 8 }).modelId,
      vector,
      k: 1
    });
    return hits[0]?.salience ?? -1;
  }

  it('raises a row salience from 0 via the route', async () => {
    const { store, vector } = await seeded();
    expect(await salienceOf(store, vector)).toBe(0); // never reinforced yet

    const res = await salienceBoostRouteHandler({ store, checkWritePolicy: ALLOW_WRITES })(
      makeReq({ targets: [{ namespace: 'labs', type: 'Trace', id: 't-1' }] })
    );
    expect(res.status).toBe(200);
    // the route awaits boostSalience before responding, so the store is
    // already mutated by the time the handler promise resolves above.
    expect(await salienceOf(store, vector)).toBeGreaterThan(0); // reinforced
  });

  it('recall with boost:false leaves salience at 0', async () => {
    const { embedder, store, vector } = await seeded();
    await handleRecallRequest(
      { query: 'favorite color', namespace: 'labs', type: 'Trace', boost: false },
      { embedder, store }
    );
    // fire-and-forget is skipped entirely when boost:false — no need to drain
    expect(await salienceOf(store, vector)).toBe(0); // recall did not reinforce
  });
});

import type { Embedder } from '@mnmal-ai/substrate-embedder';
import { describe, expect, it, vi } from 'vitest';
import { handleEmbeddingsFetch, validateFetchInput } from '../src/embeddings-fetch-core.js';
import type { EmbeddingsStore } from '../src/embeddings-store.js';

const ref = { namespace: 'claude', type: 'Memory', id: 'm1' };

function makeFetchStore(fetchEmbeddings: EmbeddingsStore['fetchEmbeddings']): EmbeddingsStore {
  return {
    txScopeId: 'test-store',
    delete: async () => undefined,
    upsert: async () => undefined,
    knnSearch: async () => [],
    boostSalience: async () => [],
    fetchEmbeddings,
    selectCandidates: async () => []
  };
}

function makeEmbedder(modelId: string): Embedder {
  return {
    modelId,
    dimension: 3,
    embed: async () => new Float32Array(3)
  };
}

describe('validateFetchInput', () => {
  it('accepts refs alone', () => {
    expect(validateFetchInput({ refs: [ref] })).toEqual({ refs: [ref] });
  });
  it('accepts refs + explicit model', () => {
    expect(validateFetchInput({ refs: [ref], model: 'older-model' })).toEqual({
      refs: [ref],
      model: 'older-model'
    });
  });
  it('carries an explicit boost flag through, and omits the key when absent', () => {
    expect(validateFetchInput({ refs: [ref], boost: false })).toEqual({
      refs: [ref],
      boost: false
    });
    expect(validateFetchInput({ refs: [ref], boost: true })).toEqual({ refs: [ref], boost: true });
    // Absent must stay absent rather than normalise to `true` — the core reads
    // `!== false`, so a materialised default would be indistinguishable from
    // an explicit opt-in and would mask a caller that never set it.
    expect(validateFetchInput({ refs: [ref] })).toEqual({ refs: [ref] });
  });
  it('rejects a non-boolean boost', () => {
    expect(() => validateFetchInput({ refs: [ref], boost: 'yes' })).toThrowError(
      expect.objectContaining({ code: 'bad_request' })
    );
  });
  it('rejects non-object, empty refs, malformed ref, non-string model, over-cap', () => {
    expect(() => validateFetchInput(null)).toThrowError(
      expect.objectContaining({ code: 'bad_request' })
    );
    expect(() => validateFetchInput({ refs: [] })).toThrowError(
      expect.objectContaining({ code: 'bad_request' })
    );
    expect(() => validateFetchInput({ refs: 'nope' })).toThrowError(
      expect.objectContaining({ code: 'bad_request' })
    );
    expect(() => validateFetchInput({ refs: [{ namespace: 'a', type: 'b' }] })).toThrowError(
      expect.objectContaining({ code: 'bad_request' })
    );
    expect(() => validateFetchInput({ refs: [{ namespace: 'a', type: 'b', id: 7 }] })).toThrowError(
      expect.objectContaining({ code: 'bad_request' })
    );
    expect(() => validateFetchInput({ refs: [ref], model: 7 })).toThrowError(
      expect.objectContaining({ code: 'bad_request' })
    );
    expect(() => validateFetchInput({ refs: Array.from({ length: 501 }, () => ref) })).toThrowError(
      expect.objectContaining({ code: 'bad_request' })
    );
  });
});

describe('handleEmbeddingsFetch', () => {
  const ROW = {
    ...ref,
    row: { id: 'm1', name: 'x' },
    vector: new Float32Array([0.5, -0.25, 1]),
    salience: 0
  };

  it('fetches vectors in one batched store call; Float32Array → number[]; defaults model from embedder', async () => {
    const fetchEmbeddings = vi.fn<EmbeddingsStore['fetchEmbeddings']>().mockResolvedValue([ROW]);
    const out = await handleEmbeddingsFetch(
      { refs: [ref] },
      { store: makeFetchStore(fetchEmbeddings), embedder: makeEmbedder('fake:v1:3') }
    );
    expect(out).toEqual({
      vectors: [
        {
          namespace: 'claude',
          type: 'Memory',
          id: 'm1',
          row: { id: 'm1', name: 'x' },
          vector: [0.5, -0.25, 1],
          _salience: 0
        }
      ],
      model: 'fake:v1:3'
    });
    expect(fetchEmbeddings).toHaveBeenCalledWith([ref], 'fake:v1:3');
  });

  it('explicit model overrides the embedder default; missing refs are silently absent', async () => {
    const fetchEmbeddings = vi.fn<EmbeddingsStore['fetchEmbeddings']>().mockResolvedValue([]);
    const out = await handleEmbeddingsFetch(
      { refs: [ref], model: 'older-model' },
      { store: makeFetchStore(fetchEmbeddings), embedder: makeEmbedder('fake:v1:3') }
    );
    expect(out).toEqual({ vectors: [], model: 'older-model' });
    expect(fetchEmbeddings).toHaveBeenCalledWith([ref], 'older-model');
  });

  it('throws bad_request when neither model nor embedder present; store untouched', async () => {
    const fetchEmbeddings = vi.fn<EmbeddingsStore['fetchEmbeddings']>().mockResolvedValue([]);
    await expect(
      handleEmbeddingsFetch({ refs: [ref] }, { store: makeFetchStore(fetchEmbeddings) })
    ).rejects.toMatchObject({
      code: 'bad_request',
      message: expect.stringContaining('"model" is required')
    });
    expect(fetchEmbeddings).not.toHaveBeenCalled();
  });

  it('throws policy_denied naming the scope; store untouched', async () => {
    const fetchEmbeddings = vi.fn<EmbeddingsStore['fetchEmbeddings']>().mockResolvedValue([]);
    await expect(
      handleEmbeddingsFetch(
        { refs: [ref] },
        {
          store: makeFetchStore(fetchEmbeddings),
          embedder: makeEmbedder('fake:v1:3'),
          checkReadPolicy: () => ({
            allow: false,
            reason: 'reads require an authenticated identity'
          })
        }
      )
    ).rejects.toMatchObject({
      code: 'policy_denied',
      message: expect.stringContaining('claude/Memory')
    });
    expect(fetchEmbeddings).not.toHaveBeenCalled();
  });

  it('dedupes scope checks across refs sharing (namespace, type)', async () => {
    const fetchEmbeddings = vi.fn<EmbeddingsStore['fetchEmbeddings']>().mockResolvedValue([]);
    const checkReadPolicy = vi.fn().mockReturnValue({ allow: true });
    await handleEmbeddingsFetch(
      {
        refs: [ref, { ...ref, id: 'm2' }, { namespace: 'claude', type: 'Decision', id: 'd1' }],
        boost: true
      },
      {
        store: makeFetchStore(fetchEmbeddings),
        embedder: makeEmbedder('fake:v1:3'),
        checkReadPolicy
      }
    );
    expect(checkReadPolicy).toHaveBeenCalledTimes(2); // Memory + Decision, deduped
  });
});

// ---------------------------------------------------------------------------
// Salience: fetch reports each row's salience and, on opt-in, reinforces what
// it returned, so a consumer that reads by known id can move salience.
// ---------------------------------------------------------------------------

function spyBoostStore(rows: Awaited<ReturnType<EmbeddingsStore['fetchEmbeddings']>>) {
  const boostCalls: Array<{
    targets: ReadonlyArray<{ namespace: string; type: string; id: string }>;
    halfLifeHours: number;
  }> = [];
  const store: EmbeddingsStore = {
    txScopeId: 'spy',
    delete: async () => undefined,
    upsert: async () => undefined,
    knnSearch: async () => [],
    boostSalience: async (targets, halfLifeHours) => {
      boostCalls.push({ targets, halfLifeHours });
      return targets;
    },
    fetchEmbeddings: async () => rows,
    selectCandidates: async () => []
  };
  return { store, boostCalls };
}

const OTHER = { namespace: 'claude', type: 'Memory', id: 'm2' };

// Boosting is a WRITE and needs a write policy that permits it. Absent, the
// core declines to reinforce, so every test below that expects a boost has to
// authorise one; a test that forgets sees no boost.
const ALLOW_WRITES = () => ({ allow: true }) as const;

describe('handleEmbeddingsFetch — boost is OPT-IN', () => {
  it('does NOT reinforce by default — a fetch is a read', async () => {
    // Callers fetch to RANK; reinforcing every fetched row would add +1 to
    // everything and erase the signal of what was actually promoted.
    const { store, boostCalls } = spyBoostStore([
      { ...ref, row: { id: 'm1' }, vector: new Float32Array([1]), salience: 4.5 }
    ]);
    const out = await handleEmbeddingsFetch(
      { refs: [ref] },
      { store, embedder: makeEmbedder('fake:v1:3'), checkWritePolicy: ALLOW_WRITES }
    );
    // The read still succeeds and still reports salience — only the WRITE is gone.
    expect(out.vectors).toHaveLength(1);
    expect(out.vectors[0]?._salience).toBe(4.5);
    expect(boostCalls).toHaveLength(0);
  });

  it('boost:false is still honoured, and means the same as omitting it', async () => {
    const { store, boostCalls } = spyBoostStore([
      { ...ref, row: { id: 'm1' }, vector: new Float32Array([1]), salience: 0 }
    ]);
    await handleEmbeddingsFetch(
      { refs: [ref], boost: false },
      { store, embedder: makeEmbedder('fake:v1:3'), checkWritePolicy: ALLOW_WRITES }
    );
    expect(boostCalls).toHaveLength(0);
  });

  it('/substrate/v1/recall is deliberately NOT changed — the routes are not symmetrical', async () => {
    // Do not "fix the inconsistency": recall returns what MATCHED a query, so
    // reinforcing it is the recall-what-you-use signal. fetch returns rows the
    // caller already named, usually to rank. This asserts the fetch side only;
    // recall's own suite pins boost-on by default.
    const { store, boostCalls } = spyBoostStore([
      { ...ref, row: { id: 'm1' }, vector: new Float32Array([1]), salience: 0 }
    ]);
    await handleEmbeddingsFetch(
      { refs: [ref] },
      { store, embedder: makeEmbedder('fake:v1:3'), checkWritePolicy: ALLOW_WRITES }
    );
    expect(boostCalls).toHaveLength(0);
  });
});

describe('handleEmbeddingsFetch — write gate', () => {
  it('serves the read but declines the boost when the write policy denies', async () => {
    // The asymmetry with /substrate/v1/salience/boost, and the reason it is right:
    // the caller asked for VECTORS, and the read gate allowed that. The
    // reinforcement is a side effect they did not ask for, so refusing it must
    // not cost them the answer they did.
    const { store, boostCalls } = spyBoostStore([
      { ...ref, row: { id: 'm1' }, vector: new Float32Array([1]), salience: 4.5 }
    ]);
    const out = await handleEmbeddingsFetch(
      { refs: [ref], boost: true },
      {
        store,
        embedder: makeEmbedder('fake:v1:3'),
        checkWritePolicy: () => ({ allow: false, reason: 'writes require an identity' })
      }
    );
    expect(out.vectors).toHaveLength(1);
    expect(boostCalls).toHaveLength(0);
  });

  it('declines the boost when no write policy is wired at all', async () => {
    // Absence is not permission: an unwired host must not boost.
    const { store, boostCalls } = spyBoostStore([
      { ...ref, row: { id: 'm1' }, vector: new Float32Array([1]), salience: 0 }
    ]);
    // Same reason as above: opt in, so the absence of a boost is attributable
    // to the unwired policy rather than to the caller not asking.
    const out = await handleEmbeddingsFetch(
      { refs: [ref], boost: true },
      { store, embedder: makeEmbedder('fake:v1:3') }
    );
    expect(out.vectors).toHaveLength(1);
    expect(boostCalls).toHaveLength(0);
  });

  it('boosts only the scopes the write policy permits, not all-or-nothing', async () => {
    // A mixed-namespace fetch must not have one denied scope suppress the
    // reinforcement of a permitted one.
    const { store, boostCalls } = spyBoostStore([
      { ...ref, row: { id: 'm1' }, vector: new Float32Array([1]), salience: 0 },
      {
        namespace: 'claude',
        type: 'Decision',
        id: 'd1',
        row: { id: 'd1' },
        vector: new Float32Array([1]),
        salience: 0
      }
    ]);
    await handleEmbeddingsFetch(
      { refs: [ref, { namespace: 'claude', type: 'Decision', id: 'd1' }], boost: true },
      {
        store,
        embedder: makeEmbedder('fake:v1:3'),
        checkWritePolicy: (_ns: string, type: string) => ({ allow: type === 'Memory' })
      }
    );
    expect(boostCalls).toHaveLength(1);
    expect(boostCalls[0]?.targets).toEqual([ref]);
  });
});

describe('handleEmbeddingsFetch — salience', () => {
  it('reinforces when boost:true is passed, and reports the PRE-boost value', async () => {
    const { store, boostCalls } = spyBoostStore([
      { ...ref, row: { id: 'm1' }, vector: new Float32Array([1]), salience: 4.5 }
    ]);
    const out = await handleEmbeddingsFetch(
      { refs: [ref], boost: true },
      { store, embedder: makeEmbedder('fake:v1:3'), checkWritePolicy: ALLOW_WRITES }
    );
    expect(boostCalls).toHaveLength(1);
    expect(boostCalls[0]?.targets).toEqual([ref]);
    // The boost is fire-and-forget, so the response cannot reflect it. Pinning
    // the pre-boost value keeps that explicit — a consumer reading 4.5 here has
    // not been handed a stale number by accident, it is the documented contract
    // and matches what /substrate/v1/recall reports.
    expect(out.vectors[0]?._salience).toBe(4.5);
  });

  it('boosts only rows the store actually returned, not every requested ref', async () => {
    // The distinction matters because boostSalience is a silent no-op on a
    // missing row: passing the requested refs would "work" while quietly
    // widening the write set past what the read-policy gate saw come back.
    const { store, boostCalls } = spyBoostStore([
      { ...ref, row: { id: 'm1' }, vector: new Float32Array([1]), salience: 0 }
    ]);
    await handleEmbeddingsFetch(
      { refs: [ref, OTHER], boost: true },
      { store, embedder: makeEmbedder('fake:v1:3'), checkWritePolicy: ALLOW_WRITES }
    );
    expect(boostCalls[0]?.targets).toEqual([ref]);
  });

  it('skips reinforcement on boost:false, vectors still returned', async () => {
    const { store, boostCalls } = spyBoostStore([
      { ...ref, row: { id: 'm1' }, vector: new Float32Array([1]), salience: 2 }
    ]);
    const out = await handleEmbeddingsFetch(
      { refs: [ref], boost: false },
      { store, embedder: makeEmbedder('fake:v1:3'), checkWritePolicy: ALLOW_WRITES }
    );
    expect(out.vectors).toHaveLength(1);
    expect(out.vectors[0]?._salience).toBe(2);
    expect(boostCalls).toHaveLength(0);
  });

  it('does not call the store when nothing was fetched', async () => {
    const { store, boostCalls } = spyBoostStore([]);
    await handleEmbeddingsFetch(
      { refs: [ref], boost: true },
      { store, embedder: makeEmbedder('fake:v1:3'), checkWritePolicy: ALLOW_WRITES }
    );
    expect(boostCalls).toHaveLength(0);
  });

  it('takes the half-life from the salience config, defaulting to 168h', async () => {
    const rows = [{ ...ref, row: { id: 'm1' }, vector: new Float32Array([1]), salience: 0 }];
    const dflt = spyBoostStore(rows);
    await handleEmbeddingsFetch(
      { refs: [ref], boost: true },
      { store: dflt.store, embedder: makeEmbedder('fake:v1:3'), checkWritePolicy: ALLOW_WRITES }
    );
    expect(dflt.boostCalls[0]?.halfLifeHours).toBe(168);

    const tuned = spyBoostStore(rows);
    await handleEmbeddingsFetch(
      { refs: [ref], boost: true },
      {
        store: tuned.store,
        checkWritePolicy: ALLOW_WRITES,
        embedder: makeEmbedder('fake:v1:3'),
        salience: { weight: 1, halfLifeHours: 24, spreadDamping: 0 }
      }
    );
    expect(tuned.boostCalls[0]?.halfLifeHours).toBe(24);
  });

  it('a failing boost does not fail the fetch', async () => {
    // Fire-and-forget means an unhandled rejection would take the process down
    // rather than the request; the catch is the whole point.
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const store: EmbeddingsStore = {
      ...makeFetchStore(async () => [
        { ...ref, row: { id: 'm1' }, vector: new Float32Array([1]), salience: 0 }
      ]),
      boostSalience: async () => {
        throw new Error('boost boom');
      }
    };
    const out = await handleEmbeddingsFetch(
      { refs: [ref], boost: true },
      { store, embedder: makeEmbedder('fake:v1:3'), checkWritePolicy: ALLOW_WRITES }
    );
    expect(out.vectors).toHaveLength(1);
    await Promise.resolve();
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('boost boom'));
    stderr.mockRestore();
  });

  it('reinforcement happens only after the read-policy gate, never on a denial', async () => {
    const { store, boostCalls } = spyBoostStore([
      { ...ref, row: { id: 'm1' }, vector: new Float32Array([1]), salience: 0 }
    ]);
    await expect(
      handleEmbeddingsFetch(
        { refs: [ref] },
        {
          store,
          embedder: makeEmbedder('fake:v1:3'),
          checkReadPolicy: () => ({ allow: false, reason: 'no read' })
        }
      )
    ).rejects.toThrowError(expect.objectContaining({ code: 'policy_denied' }));
    expect(boostCalls).toHaveLength(0);
  });
});

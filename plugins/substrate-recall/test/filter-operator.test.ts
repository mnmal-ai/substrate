import type { Embedder } from '@mnmal-ai/substrate-embedder';
import { describe, expect, it, vi } from 'vitest';
import { embeddingSimilarOperator } from '../src/filter-operator.js';
import { InMemoryEmbeddingsStore } from '../src/in-memory-embeddings-store.js';

function fakeEmbedder(): Embedder {
  return {
    modelId: 'fake:v1:768',
    dimension: 768,
    embed: vi.fn(async (text: string) => {
      // All-positive query vector so cosine against seeded all-positive row
      // vectors stays > 0 (knnSearch drops score < threshold, default 0).
      const seed = text.length;
      return Float32Array.from({ length: 768 }, (_, i) => 1 + Math.abs(Math.sin(seed + i)));
    })
  };
}

function makeOp(store = new InMemoryEmbeddingsStore(), embedder = fakeEmbedder()) {
  return { op: embeddingSimilarOperator({ embedder, store }), store, embedder };
}

/** A store seeded with N rows under one (namespace, type), each with a unique vector. */
function seededStore(
  ns: string,
  type: string,
  model: string,
  ids: string[]
): InMemoryEmbeddingsStore {
  const store = new InMemoryEmbeddingsStore();
  // All-positive vectors that differ only slightly per row, so every row
  // scores well above 0 against any query (knnSearch drops score < threshold,
  // default 0 — negative-cosine rows would be silently filtered).
  ids.forEach((id, i) => {
    void store.upsert({
      rowNamespace: ns,
      rowType: type,
      rowId: id,
      model,
      vector: Float32Array.from({ length: 768 }, (_, j) => 1 + (i + 1) * 0.01 + j * 0.001)
    });
  });
  return store;
}

describe('embeddingSimilarOperator — validate', () => {
  it('rejects non-object values with a reason mentioning the value', () => {
    const { op } = makeOp();
    expect(op.validate(null)).toEqual({
      ok: false,
      reason: expect.stringContaining('must be an object')
    });
    expect(op.validate('str')).toEqual({
      ok: false,
      reason: expect.stringContaining('must be an object')
    });
  });

  it('rejects missing or empty `to` with a reason mentioning `to`', () => {
    const { op } = makeOp();
    expect(op.validate({})).toEqual({ ok: false, reason: expect.stringContaining('to') });
    expect(op.validate({ to: '' })).toEqual({ ok: false, reason: expect.stringContaining('to') });
  });

  it('accepts the canonical { to } shape', () => {
    const { op } = makeOp();
    expect(op.validate({ to: 'jazz piano' })).toEqual({ ok: true, value: { to: 'jazz piano' } });
  });

  it('accepts { to, threshold }', () => {
    const { op } = makeOp();
    expect(op.validate({ to: 'x', threshold: 0.4 })).toEqual({
      ok: true,
      value: { to: 'x', threshold: 0.4 }
    });
  });

  it('accepts { to, k }', () => {
    const { op } = makeOp();
    expect(op.validate({ to: 'x', k: 5 })).toEqual({ ok: true, value: { to: 'x', k: 5 } });
  });

  it('accepts { to, boost: false } as a no-op', () => {
    const { op } = makeOp();
    expect(op.validate({ to: 'x', boost: false })).toEqual({
      ok: true,
      value: { to: 'x' }
    });
  });

  it('accepts all knobs combined', () => {
    const { op } = makeOp();
    expect(op.validate({ to: 'x', threshold: 0.2, k: 7, boost: false })).toEqual({
      ok: true,
      value: { to: 'x', threshold: 0.2, k: 7 }
    });
  });

  it('normalized value carries exactly the provided keys (no undefined-valued keys)', () => {
    const { op } = makeOp();
    const res = op.validate({ to: 'x' });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(Object.keys(res.value as object)).toEqual(['to']);
    }
  });

  it('rejects non-number threshold with a reason mentioning threshold', () => {
    const { op } = makeOp();
    expect(op.validate({ to: 'x', threshold: 'hot' })).toEqual({
      ok: false,
      reason: expect.stringContaining('threshold')
    });
  });

  it('rejects non-number k with a reason mentioning k', () => {
    const { op } = makeOp();
    expect(op.validate({ to: 'x', k: 'lots' })).toEqual({
      ok: false,
      reason: expect.stringContaining('k')
    });
  });

  it('rejects non-boolean boost with a reason mentioning boost', () => {
    const { op } = makeOp();
    expect(op.validate({ to: 'x', boost: 'yes' })).toEqual({
      ok: false,
      reason: expect.stringContaining('boost')
    });
  });
});

describe('embeddingSimilarOperator — execute', () => {
  it('requires operator context namespace + type', async () => {
    const { op } = makeOp();
    await expect(op.execute({ to: 'x' }, { type: 'Track' })).rejects.toThrow(/namespace \+ type/);
    await expect(op.execute({ to: 'x' }, { namespace: 'music' })).rejects.toThrow(
      /namespace \+ type/
    );
  });

  it('embeds the query string and returns { hits } in knn order', async () => {
    const model = 'fake:v1:768';
    const store = seededStore('music', 'Track', model, ['r1', 'r2', 'r3']);
    const { op, embedder } = makeOp(store);

    const result = (await op.execute(
      { to: 'ambient', boost: false },
      {
        namespace: 'music',
        type: 'Track'
      }
    )) as { hits: Array<{ id: string; score: number; vector?: number[] }> };

    expect(embedder.embed).toHaveBeenCalledWith('ambient');
    expect(Array.isArray(result.hits)).toBe(true);
    expect(result.hits.length).toBe(3);
    // Each hit has a string id + numeric score; descending score order.
    for (const h of result.hits) {
      expect(typeof h.id).toBe('string');
      expect(typeof h.score).toBe('number');
      expect(h.vector).toBeUndefined();
    }
    const scores = result.hits.map((h) => h.score);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
  });

  it('id is String(row.id)', async () => {
    const model = 'fake:v1:768';
    const store = seededStore('music', 'Track', model, ['r1']);
    const { op } = makeOp(store);
    const result = (await op.execute(
      { to: 'x', boost: false },
      {
        namespace: 'music',
        type: 'Track'
      }
    )) as { hits: Array<{ id: string }> };
    expect(result.hits[0]?.id).toBe('r1');
  });

  it('per-hit vector present iff operator context.returnVector === true and store returned one', async () => {
    const model = 'fake:v1:768';
    const store = seededStore('music', 'Track', model, ['r1', 'r2']);
    const { op } = makeOp(store);

    const withVec = (await op.execute(
      { to: 'x', boost: false },
      {
        namespace: 'music',
        type: 'Track',
        returnVector: true
      }
    )) as { hits: Array<{ vector?: number[] }> };
    for (const h of withVec.hits) {
      expect(Array.isArray(h.vector)).toBe(true);
      expect(h.vector?.length).toBe(768);
    }

    const noVec = (await op.execute(
      { to: 'x', boost: false },
      {
        namespace: 'music',
        type: 'Track'
      }
    )) as { hits: Array<{ vector?: number[] }> };
    for (const h of noVec.hits) {
      expect(h.vector).toBeUndefined();
    }
  });

  it('k precedence: value-k beats substrate-k beats default 50', async () => {
    const store = new InMemoryEmbeddingsStore();
    const knnSpy = vi.spyOn(store, 'knnSearch');
    const { op } = makeOp(store);

    await op.execute({ to: 'x', k: 5, boost: false }, { namespace: 'm', type: 'T', k: 10 });
    expect(knnSpy).toHaveBeenLastCalledWith(expect.objectContaining({ k: 5 }));

    await op.execute({ to: 'x', boost: false }, { namespace: 'm', type: 'T', k: 10 });
    expect(knnSpy).toHaveBeenLastCalledWith(expect.objectContaining({ k: 10 }));

    await op.execute({ to: 'x', boost: false }, { namespace: 'm', type: 'T' });
    expect(knnSpy).toHaveBeenLastCalledWith(expect.objectContaining({ k: 50 }));
  });

  it('k clamped to [1,100] and floored', async () => {
    const store = new InMemoryEmbeddingsStore();
    const knnSpy = vi.spyOn(store, 'knnSearch');
    const { op } = makeOp(store);

    await op.execute({ to: 'x', k: 0, boost: false }, { namespace: 'm', type: 'T' });
    expect(knnSpy).toHaveBeenLastCalledWith(expect.objectContaining({ k: 1 }));

    await op.execute({ to: 'x', k: 999, boost: false }, { namespace: 'm', type: 'T' });
    expect(knnSpy).toHaveBeenLastCalledWith(expect.objectContaining({ k: 100 }));

    await op.execute({ to: 'x', k: 7.9, boost: false }, { namespace: 'm', type: 'T' });
    expect(knnSpy).toHaveBeenLastCalledWith(expect.objectContaining({ k: 7 }));
  });

  it('threshold > 0 threads into knnSearch; absent/0 omitted', async () => {
    const store = new InMemoryEmbeddingsStore();
    const knnSpy = vi.spyOn(store, 'knnSearch');
    const { op } = makeOp(store);

    await op.execute({ to: 'x', threshold: 0.4, boost: false }, { namespace: 'm', type: 'T' });
    expect(knnSpy).toHaveBeenLastCalledWith(expect.objectContaining({ threshold: 0.4 }));

    await op.execute({ to: 'x', boost: false }, { namespace: 'm', type: 'T' });
    let arg = knnSpy.mock.calls.at(-1)?.[0];
    expect(arg).not.toHaveProperty('threshold');

    await op.execute({ to: 'x', threshold: 0, boost: false }, { namespace: 'm', type: 'T' });
    arg = knnSpy.mock.calls.at(-1)?.[0];
    expect(arg).not.toHaveProperty('threshold');
  });

  it('returnVector threads into knnSearch only when operator context asks', async () => {
    const store = new InMemoryEmbeddingsStore();
    const knnSpy = vi.spyOn(store, 'knnSearch');
    const { op } = makeOp(store);

    await op.execute({ to: 'x', boost: false }, { namespace: 'm', type: 'T', returnVector: true });
    expect(knnSpy).toHaveBeenLastCalledWith(expect.objectContaining({ returnVector: true }));

    await op.execute({ to: 'x', boost: false }, { namespace: 'm', type: 'T' });
    const arg = knnSpy.mock.calls.at(-1)?.[0];
    expect(arg).not.toHaveProperty('returnVector');
  });
});

describe('embeddingSimilarOperator — never boosts salience', () => {
  it('a query does not boost its hits', async () => {
    const store = seededStore('music', 'Track', 'fake:v1:768', ['r1', 'r2']);
    const boostSpy = vi.spyOn(store, 'boostSalience');
    const { op } = makeOp(store);

    const result = (await op.execute({ to: 'x' }, { namespace: 'music', type: 'Track' })) as {
      hits: unknown[];
    };
    await Promise.resolve();
    await Promise.resolve();

    expect(result.hits).toHaveLength(2);
    expect(boostSpy).not.toHaveBeenCalled();
  });

  it('refuses an over-long `to`', () => {
    const { op } = makeOp();
    expect(op.validate({ to: 'x'.repeat(8193) })).toMatchObject({ ok: false });
  });

  it('refuses boost: true, naming the gated routes', () => {
    const { op } = makeOp();
    expect(op.validate({ to: 'x', boost: true })).toEqual({
      ok: false,
      reason: expect.stringContaining('/substrate/v1/salience/boost')
    });
  });

  it('rows with missing/empty ids are excluded from hits', async () => {
    const store = new InMemoryEmbeddingsStore();
    vi.spyOn(store, 'knnSearch').mockResolvedValue([
      { row: { id: '' }, score: 0.9, salience: 0 },
      { row: {}, score: 0.8, salience: 0 },
      { row: { id: 'valid' }, score: 0.7, salience: 0 }
    ]);
    const { op } = makeOp(store);

    const result = (await op.execute({ to: 'x' }, { namespace: 'music', type: 'Track' })) as {
      hits: Array<{ id: string }>;
    };
    expect(result.hits.map((h) => h.id)).toEqual(['valid']);
  });
});

describe('embeddingSimilarOperator — computedFields', () => {
  it('declares ["_score", "_vector"]', () => {
    const { op } = makeOp();
    expect(op.computedFields).toEqual(['_score', '_vector']);
  });
});

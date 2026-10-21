import type { Dataset } from '@mnmal-ai/substrate-types';
import { describe, expect, it } from 'vitest';
import { InMemoryEmbeddingsStore } from '../src/in-memory-embeddings-store.js';

function vec(seed: number, dim = 8): Float32Array {
  return Float32Array.from({ length: dim }, (_, i) => Math.sin(seed + i));
}

describe('InMemoryEmbeddingsStore.knnSearch', () => {
  it('seeds row.id from the entry when no datasetFor is wired', async () => {
    const store = new InMemoryEmbeddingsStore();
    await store.upsert({
      rowNamespace: 'demo',
      rowType: 'Doc',
      rowId: 'doc-1',
      vector: vec(1),
      model: 'fake:v1'
    });

    const results = await store.knnSearch({
      namespace: 'demo',
      type: 'Doc',
      model: 'fake:v1',
      vector: vec(1),
      k: 5
    });

    expect(results).toHaveLength(1);
    expect(results[0]?.row).toEqual({ id: 'doc-1' });
  });

  it('replaces the seed with the full row body when datasetFor resolves', async () => {
    const dataset = {
      read: async (_type: string, _params: { id: string }) => ({
        rows: [{ id: 'doc-2', title: 'hello', body: 'world' }]
      })
    } as unknown as Dataset;

    const store = new InMemoryEmbeddingsStore({
      datasetFor: () => dataset
    });
    await store.upsert({
      rowNamespace: 'demo',
      rowType: 'Doc',
      rowId: 'doc-2',
      vector: vec(2),
      model: 'fake:v1'
    });

    const results = await store.knnSearch({
      namespace: 'demo',
      type: 'Doc',
      model: 'fake:v1',
      vector: vec(2),
      k: 5
    });

    expect(results[0]?.row).toEqual({ id: 'doc-2', title: 'hello', body: 'world' });
  });
});

function makeStubDataset(rows: Record<string, Array<Record<string, unknown>>>): Dataset {
  return {
    read: async (_type: string, _params: { id: string }) => {
      const typeRows = rows[_type] ?? [];
      return {
        rows: typeRows.filter((r) => r.id === _params.id)
      };
    }
  } as unknown as Dataset;
}

describe('InMemoryEmbeddingsStore.fetchEmbeddings', () => {
  it('returns embedded rows joined to dataset bodies', async () => {
    const dataset = makeStubDataset({
      Decision: [
        { id: 'dec-1', topic: 'A' },
        { id: 'dec-2', topic: 'B' }
      ]
    });
    const store = new InMemoryEmbeddingsStore({
      datasetFor: (_ns, t) => (t === 'Decision' ? dataset : undefined)
    });
    await store.upsert({
      rowNamespace: 'claude',
      rowType: 'Decision',
      rowId: 'dec-1',
      vector: new Float32Array([1, 0, 0]),
      model: 'm:3'
    });
    await store.upsert({
      rowNamespace: 'claude',
      rowType: 'Decision',
      rowId: 'dec-2',
      vector: new Float32Array([0, 1, 0]),
      model: 'm:3'
    });

    const out = await store.fetchEmbeddings(
      [
        { namespace: 'claude', type: 'Decision', id: 'dec-1' },
        { namespace: 'claude', type: 'Decision', id: 'dec-2' }
      ],
      'm:3'
    );

    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({
      namespace: 'claude',
      type: 'Decision',
      id: 'dec-1',
      row: { id: 'dec-1', topic: 'A' }
    });
    expect(Array.from(out[0]!.vector)).toEqual([1, 0, 0]);
  });

  it('silently drops IDs without an embedding row', async () => {
    const store = new InMemoryEmbeddingsStore();
    await store.upsert({
      rowNamespace: 'claude',
      rowType: 'Decision',
      rowId: 'dec-1',
      vector: new Float32Array([1, 0, 0]),
      model: 'm:3'
    });
    const out = await store.fetchEmbeddings(
      [
        { namespace: 'claude', type: 'Decision', id: 'dec-1' },
        { namespace: 'claude', type: 'Decision', id: 'missing' }
      ],
      'm:3'
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.id).toBe('dec-1');
  });

  it('filters by model — vectors stored under other models are absent', async () => {
    const store = new InMemoryEmbeddingsStore();
    await store.upsert({
      rowNamespace: 'claude',
      rowType: 'Decision',
      rowId: 'dec-1',
      vector: new Float32Array([1, 0, 0]),
      model: 'm:3'
    });
    const out = await store.fetchEmbeddings(
      [{ namespace: 'claude', type: 'Decision', id: 'dec-1' }],
      'other-model'
    );
    expect(out).toHaveLength(0);
  });

  it('returns empty array for empty input (no thrash on no-op call)', async () => {
    const store = new InMemoryEmbeddingsStore();
    const out = await store.fetchEmbeddings([], 'm:3');
    expect(out).toEqual([]);
  });
});

describe('InMemoryEmbeddingsStore.knnSearch returnVector', () => {
  it('returns a defensive copy of the stored vector iff requested', async () => {
    const store = new InMemoryEmbeddingsStore();
    await store.upsert({
      rowNamespace: 'demo',
      rowType: 'Doc',
      rowId: 'doc-1',
      vector: vec(1),
      model: 'fake:v1'
    });

    const base = { namespace: 'demo', type: 'Doc', model: 'fake:v1', vector: vec(1), k: 5 };
    const without = await store.knnSearch(base);
    expect(without[0]).not.toHaveProperty('vector');

    const withVector = await store.knnSearch({ ...base, returnVector: true });
    expect(withVector[0]?.vector).toEqual(Array.from(vec(1)));

    // Mutating the returned array must not corrupt the stored vector.
    withVector[0]!.vector![0] = 999;
    const again = await store.knnSearch({ ...base, returnVector: true });
    expect(again[0]?.vector?.[0]).toBeCloseTo(vec(1)[0]!);
  });
});

describe('InMemoryEmbeddingsStore.delete', () => {
  it('removes the entry so it drops out of knnSearch', async () => {
    const store = new InMemoryEmbeddingsStore();
    const base = { rowNamespace: 'demo', rowType: 'Doc', vector: vec(1), model: 'fake:v1' };
    await store.upsert({ ...base, rowId: 'doc-1' });
    await store.upsert({ ...base, rowId: 'doc-2' });

    await store.delete({ rowNamespace: 'demo', rowType: 'Doc', rowId: 'doc-1' });

    const results = await store.knnSearch({
      namespace: 'demo',
      type: 'Doc',
      model: 'fake:v1',
      vector: vec(1),
      k: 5
    });
    expect(results.map((r) => r.row.id)).toEqual(['doc-2']);
  });

  it('is a no-op for an absent entry', async () => {
    const store = new InMemoryEmbeddingsStore();
    await expect(
      store.delete({ rowNamespace: 'demo', rowType: 'Doc', rowId: 'never-indexed' })
    ).resolves.toBeUndefined();
  });
});

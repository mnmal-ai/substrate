import type { Embedder } from '@mnmal-ai/substrate-embedder';
import { describe, expect, it, vi } from 'vitest';
import type { EmbeddingsStore, EmbeddingsStoreKnnInput } from '../src/embeddings-store.js';
import { makeExpansionResolver } from '../src/expansion-resolver.js';
import { InMemoryEmbeddingsStore } from '../src/in-memory-embeddings-store.js';
import { recallMcpTool } from '../src/mcp-tool.js';
import { SpreadEdgeRegistry } from '../src/spread-resolver.js';

function fakeEmbedder(vec?: Float32Array): Embedder {
  const vector = vec ?? new Float32Array(768);
  return {
    modelId: 'fake/test',
    dimension: vector.length,
    embed: vi.fn(async () => vector)
  };
}

describe('recallMcpTool', () => {
  it('exposes the canonical name + description + handler + inputSchema', () => {
    const tool = recallMcpTool({
      embedder: fakeEmbedder(),
      store: new InMemoryEmbeddingsStore()
    });
    expect(tool.name).toBe('recall');
    expect(typeof tool.description).toBe('string');
    expect(tool.description.length).toBeGreaterThan(20);
    expect(typeof tool.handler).toBe('function');
    expect(tool.inputSchema).toMatchObject({
      type: 'object',
      required: expect.arrayContaining(['query'])
    });
  });

  it('handler returns a recall result for a query', async () => {
    const tool = recallMcpTool({
      embedder: fakeEmbedder(),
      store: new InMemoryEmbeddingsStore()
    });
    const result = await tool.handler({ query: 'hello', namespace: 'test', type: 'Mem' });
    // handleRecallRequest returns { rows: [...], model }
    expect(result).toHaveProperty('rows');
    expect((result as { rows: unknown[] }).rows).toBeInstanceOf(Array);
    expect(result).toHaveProperty('model', 'fake/test');
  });

  /**
   * The availability gate lives in the core every surface reaches, so this
   * surface reports the same `embedder_unavailable` code as the route.
   */
  it('handler returns embedder_unavailable when no arm is wired', async () => {
    const tool = recallMcpTool({ store: new InMemoryEmbeddingsStore() });
    const result = await tool.handler({ query: 'x', namespace: 'test', type: 'Note' });
    expect(result).toMatchObject({ error: { code: 'embedder_unavailable' } });
  });

  it('accepts expand:true and forwards it into the recall path', async () => {
    const tool = recallMcpTool({
      embedder: fakeEmbedder(),
      store: new InMemoryEmbeddingsStore()
    });
    // Should not throw on input schema validation
    const result = await tool.handler({
      query: 'hello',
      namespace: 'test',
      type: 'Note',
      expand: true
    });
    expect(result).toHaveProperty('rows');
  });

  it('includes expand in the input schema declaration', async () => {
    const tool = recallMcpTool({
      embedder: fakeEmbedder(),
      store: new InMemoryEmbeddingsStore()
    });
    // The schema should declare expand as a boolean property
    expect(tool.inputSchema).toMatchObject({
      type: 'object',
      properties: expect.objectContaining({
        expand: expect.any(Object)
      })
    });
  });
});

// ---------------------------------------------------------------------------
// MCP integration test: expansion resolver wired end-to-end
// ---------------------------------------------------------------------------

/**
 * Build a store that returns canned knn rows and can serve canned neighbour
 * embeddings via fetchEmbeddings. Mirrors the makeStoreWithFetch helper in
 * recall-route.test.ts.
 */
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
    knnSearch: async (_input: EmbeddingsStoreKnnInput) =>
      knnRows.map((r) => ({ ...r, salience: 0 })),
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

describe('recallMcpTool — expansion integration (Fix C1)', () => {
  it('expand:true with wired expansionResolver surfaces _expandedFrom on a neighbour row', async () => {
    const queryVec = new Float32Array([1, 0, 0]);
    const neighbourVec = new Float32Array([0.9, 0.1, 0]); // high cosine vs queryVec

    const store = makeStoreWithFetch(
      // knn seed: a Decision that supersedes another Decision via an opt-in crossRef.
      // Same-type edge so the expansion scope filter passes the neighbour.
      [{ row: { id: 'dec-1', topic: 'Salience', supersedes: 'dec-prev' }, score: 0.6 }],
      [
        {
          ns: 'claude',
          type: 'Decision',
          id: 'dec-prev',
          row: { id: 'dec-prev', topic: 'Salience (earlier)' },
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

    const expansionResolver = makeExpansionResolver(registry, null, {
      maxNeighboursPerSeed: 8,
      maxTotalNeighbours: 50
    });

    const tool = recallMcpTool({
      embedder: fakeEmbedder(queryVec),
      store,
      expansionResolver,
      expansionEnabled: true
    });

    const result = (await tool.handler({
      query: 'salience',
      namespace: 'claude',
      type: 'Decision',
      k: 5,
      expand: true
    })) as { rows: Array<{ row: Record<string, unknown>; _expandedFrom?: unknown }> };

    expect(result).toHaveProperty('rows');
    const expandedRows = result.rows.filter((r) => r._expandedFrom !== undefined);
    expect(expandedRows).toHaveLength(1);
    expect(expandedRows[0]!.row.id).toBe('dec-prev');
    expect(expandedRows[0]!._expandedFrom).toEqual({
      namespace: 'claude',
      type: 'Decision',
      id: 'dec-1'
    });
  });

  it('expand:true with expansionEnabled:false silently skips expansion (no _expandedFrom)', async () => {
    const queryVec = new Float32Array([1, 0, 0]);
    const conceptVec = new Float32Array([0.9, 0.1, 0]);

    const store = makeStoreWithFetch(
      [{ row: { id: 'dec-1', establishesConcept: 'concept-1' }, score: 0.6 }],
      [
        {
          ns: 'claude',
          type: 'Concept',
          id: 'concept-1',
          row: { id: 'concept-1' },
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

    const expansionResolver = makeExpansionResolver(registry, null, {
      maxNeighboursPerSeed: 8,
      maxTotalNeighbours: 50
    });

    const tool = recallMcpTool({
      embedder: fakeEmbedder(queryVec),
      store,
      expansionResolver,
      expansionEnabled: false // kill-switch OFF
    });

    const result = (await tool.handler({
      query: 'q',
      namespace: 'claude',
      type: 'Decision',
      k: 5,
      expand: true
    })) as { rows: Array<{ _expandedFrom?: unknown }> };

    expect(result.rows.every((r) => r._expandedFrom === undefined)).toBe(true);
  });

  it('expand:true without expansionResolver wired → no _expandedFrom (previous broken behaviour now fixed)', async () => {
    // No expansionResolver in the tool config: expansion is silently skipped.
    const queryVec = new Float32Array([1, 0, 0]);
    const conceptVec = new Float32Array([0.9, 0.1, 0]);

    const store = makeStoreWithFetch(
      [{ row: { id: 'dec-1', establishesConcept: 'concept-1' }, score: 0.6 }],
      [
        {
          ns: 'claude',
          type: 'Concept',
          id: 'concept-1',
          row: { id: 'concept-1' },
          vector: conceptVec
        }
      ]
    );

    // Intentionally no expansionResolver wired
    const tool = recallMcpTool({
      embedder: fakeEmbedder(queryVec),
      store
    });

    const result = (await tool.handler({
      query: 'q',
      namespace: 'claude',
      type: 'Decision',
      k: 5,
      expand: true
    })) as { rows: Array<{ _expandedFrom?: unknown }> };

    // Without a resolver, expansion is silently skipped
    expect(result.rows.every((r) => r._expandedFrom === undefined)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Salience-config parity with the HTTP recall route
// ---------------------------------------------------------------------------

describe('recallMcpTool — salience parity', () => {
  // Row B has the lower cosine but high salience; only a weight>0 blend
  // reorders it ahead of A. A store with distinct per-row salience lets us
  // observe whether the MCP path applied the blend.
  function makeSalienceStore(): EmbeddingsStore {
    const rows = [
      { row: { id: 'A' }, score: 0.5, salience: 0 },
      { row: { id: 'B' }, score: 0.4, salience: 100 }
    ];
    return {
      txScopeId: 'salience-store',
      delete: async () => undefined,
      upsert: async () => undefined,
      knnSearch: async () => rows,
      boostSalience: async () => [],
      fetchEmbeddings: async () => [],
      selectCandidates: async () => []
    };
  }

  type Out = { rows: Array<{ row: { id: string }; score: number; _blendedScore: number }> };

  it('default config (no salience) leaves cosine ranking intact', async () => {
    const tool = recallMcpTool({ embedder: fakeEmbedder(), store: makeSalienceStore() });
    const out = (await tool.handler({ query: 'q', namespace: 'test', type: 'Note' })) as Out;
    expect(out.rows.map((r) => r.row.id)).toEqual(['A', 'B']);
    // weight=0 ⇒ blended == cosine for every row.
    for (const r of out.rows) expect(r._blendedScore).toBeCloseTo(r.score, 6);
  });

  it('threads a weight>0 salience config so the high-salience row re-ranks (HTTP parity)', async () => {
    const tool = recallMcpTool({
      embedder: fakeEmbedder(),
      store: makeSalienceStore(),
      salience: { weight: 1, halfLifeHours: 168, spreadDamping: 0 }
    });
    const out = (await tool.handler({ query: 'q', namespace: 'test', type: 'Note' })) as Out;
    // B (high salience) outranks A despite the lower cosine: the MCP path
    // applies the same blend as the HTTP route.
    expect(out.rows.map((r) => r.row.id)).toEqual(['B', 'A']);
  });

  it('read-policy gate: binds a null identity and maps denial to the error shape', async () => {
    const seen: unknown[] = [];
    const tool = recallMcpTool({
      embedder: fakeEmbedder(),
      store: new InMemoryEmbeddingsStore(),
      checkReadPolicy: (_ns, _type, identity) => {
        seen.push(identity);
        return { allow: false, reason: 'reads require an authenticated identity' };
      }
    });
    const out = (await tool.handler({ query: 'q', namespace: 'claude', type: 'Memory' })) as {
      error: { code: string; message: string };
    };
    expect(out.error.code).toBe('policy_denied');
    expect(out.error.message).toContain('authenticated identity');
    // The substrate MCP surface has no identity channel — it must bind null
    // (fail-closed under a gated posture), never a fabricated identity.
    expect(seen).toEqual([null]);
  });
});

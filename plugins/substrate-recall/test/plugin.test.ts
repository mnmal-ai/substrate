import type { Embedder } from '@mnmal-ai/substrate-embedder';
import semver from 'semver';
import { describe, expect, it, vi } from 'vitest';
import pkg from '../package.json' with { type: 'json' };
import { InMemoryClusterStore } from '../src/in-memory-cluster-store.js';
import { InMemoryEmbeddingsStore } from '../src/in-memory-embeddings-store.js';
import { createRecallPlugin } from '../src/plugin.js';

function fakeEmbedder(): Embedder {
  return {
    modelId: 'fake/test',
    dimension: 768,
    embed: vi.fn(async () => new Float32Array(768))
  };
}

describe('createRecallPlugin', () => {
  it('returns a KernelPlugin with all four populated slots', () => {
    const plugin = createRecallPlugin({
      embedder: fakeEmbedder(),
      store: new InMemoryEmbeddingsStore()
    });
    expect(plugin.name).toBe('substrate-recall');
    // Asserts the range ADMITS this package's version, not that it has a
    // particular textual shape, which would pin a stale major.
    expect(semver.validRange(plugin.contractVersion)).not.toBeNull();
    expect(semver.satisfies(pkg.version, plugin.contractVersion)).toBe(true);
    // Every migration, including 0002 (recall_clusters), is applied even with
    // no ClusterStore wired — the same off-mode posture as the embedder ones.
    expect(plugin.migrations?.map((m) => m.id)).toEqual([
      '0001_embeddings',
      '0002_recall_clusters',
      '0003_lexical'
    ]);
    expect(Object.keys(plugin.filterOperators ?? {})).toContain('embeddingSimilar');
    expect(plugin.kernelRoutes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'recall', method: 'POST' }),
        expect.objectContaining({ path: 'embed-stats', method: 'GET' }),
        expect.objectContaining({ path: 'embeddings/fetch', method: 'POST' }),
        expect.objectContaining({ path: 'salience/boost', method: 'POST' }),
        expect.objectContaining({ path: 'crystallise', method: 'POST' }),
        expect.objectContaining({ path: 'embed/reindex', method: 'POST' }),
        expect.objectContaining({ path: 'lexical/reindex', method: 'POST' })
      ])
    );
    expect(plugin.mcpTools).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'recall' })])
    );
  });

  it('still produces a valid plugin without an embedder (recall returns 503 at runtime)', () => {
    const plugin = createRecallPlugin({ store: new InMemoryEmbeddingsStore() });
    expect(plugin.name).toBe('substrate-recall');
    // Without an embedder the embeddingSimilar operator is absent — filter map is empty
    expect(Object.keys(plugin.filterOperators ?? {})).not.toContain('embeddingSimilar');
    // kernelRoutes and mcpTools are still present (recall returns 503, embeddings/fetch
    // requires an explicit model, crystallise returns 503 — all three degrade at
    // runtime, not at compose)
    expect(plugin.kernelRoutes).toHaveLength(7);
    expect(plugin.mcpTools).toHaveLength(1);
  });

  it('claims POST /substrate/v1/crystallise', () => {
    const plugin = createRecallPlugin({
      store: new InMemoryEmbeddingsStore(),
      clusters: new InMemoryClusterStore()
    });
    const paths = (plugin.kernelRoutes ?? []).map((r) => `${r.method} ${r.path}`);
    expect(paths).toContain('POST crystallise');
  });

  it('registers migration 0002 (recall_clusters)', () => {
    const plugin = createRecallPlugin({ store: new InMemoryEmbeddingsStore() });
    expect((plugin.migrations ?? []).map((m) => m.id)).toContain('0002_recall_clusters');
  });

  it('publishes recall/Cluster only when a ClusterStore is wired', () => {
    const off = createRecallPlugin({ store: new InMemoryEmbeddingsStore() });
    expect(Object.keys(off.kernelNamespace?.types ?? {})).toEqual(['Hit']);

    const on = createRecallPlugin({
      store: new InMemoryEmbeddingsStore(),
      clusters: new InMemoryClusterStore()
    });
    expect(Object.keys(on.kernelNamespace?.types ?? {}).sort()).toEqual([
      'Cluster',
      'ClusterMember',
      'Hit'
    ]);
    expect(Object.keys(on.kernelNamespace?.mutations ?? {}).sort()).toEqual([
      'boost',
      'crystallise',
      'fetchEmbeddings',
      'labelCluster'
    ]);
  });

  // `RecallPluginConfig.runClusterer` must reach BOTH transports, so a
  // composed-plugin test can substitute a fake for the worker-backed one.
  it('threads a custom runClusterer through to both the crystallise route and the frame surface', async () => {
    const seedCandidates = (store: InMemoryEmbeddingsStore): Promise<void> =>
      Promise.all(
        ['d1', 'd2'].map((id) =>
          store.upsert({
            rowNamespace: 'cortext',
            rowType: 'Decision',
            rowId: id,
            vector: new Float32Array(8).fill(1),
            model: 'fake/test'
          })
        )
      ).then(() => undefined);

    const params = {
      mode: 'form',
      select: { scopes: [{ namespace: 'cortext', type: 'Decision' }] }
    };

    let calls = 0;
    const runClusterer = async (vectors: readonly Float32Array[]): Promise<number[]> => {
      calls++;
      return vectors.map(() => 0);
    };

    // Route transport.
    const routeStore = new InMemoryEmbeddingsStore();
    await seedCandidates(routeStore);
    const routePlugin = createRecallPlugin({
      embedder: fakeEmbedder(),
      store: routeStore,
      clusters: new InMemoryClusterStore(),
      runClusterer
    });
    const routeHandler = (routePlugin.kernelRoutes ?? []).find(
      (r) => r.path === 'crystallise'
    )?.handler;
    if (routeHandler === undefined) throw new Error('crystallise route handler not found');
    const res = await routeHandler({
      body: Buffer.from(JSON.stringify(params)),
      identity: null
    } as never);
    expect(res.status).toBe(200);
    expect(calls).toBe(1);

    // Frame transport — its own store/clusters so this pass sees the
    // candidates as unclaimed rather than reusing the route pass's store.
    const frameStore = new InMemoryEmbeddingsStore();
    await seedCandidates(frameStore);
    const framePlugin = createRecallPlugin({
      embedder: fakeEmbedder(),
      store: frameStore,
      clusters: new InMemoryClusterStore(),
      runClusterer
    });
    const crystalliseMutation = framePlugin.kernelNamespace?.mutations?.crystallise;
    if (crystalliseMutation === undefined) throw new Error('crystallise mutation not found');
    const row = await crystalliseMutation.resolver({ identity: null } as never, { params });
    expect((row as unknown as { clustersFormed: number }).clustersFormed).toBe(1);
    expect(calls).toBe(2);
  });
});

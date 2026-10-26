import { FakeEmbedder } from '@mnmal-ai/substrate-embedder/fake';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { alignVectorDimensions } from '../src/align-dimension.js';
import { InMemoryEmbeddingsStore } from '../src/in-memory-embeddings-store.js';
import { recallClustersMigration } from '../src/migrations/0002_recall_clusters.js';
import { createRecallPlugin } from '../src/plugin.js';

const POSTGRES_URL = process.env.POSTGRES_URL;

/**
 * Migrations are recorded by id and applied once, so a store whose
 * first boot had no embedder kept vector(768) for both the embeddings column
 * and the cluster centroids, and configuring a 1024 embedder later never
 * re-checked either. These tests start from exactly that state.
 */
describe.skipIf(POSTGRES_URL === undefined)('alignVectorDimensions', () => {
  let sql: ReturnType<typeof postgres>;
  const typeOf = async (table: string, column: string): Promise<string> => {
    const rows = await sql.unsafe(
      `SELECT format_type(atttypid, atttypmod) AS ft FROM pg_attribute
       WHERE attrelid = '${table}'::regclass AND attname = '${column}'`
    );
    return (rows[0] as unknown as { ft: string }).ft;
  };

  beforeAll(() => {
    sql = postgres(POSTGRES_URL as string, { onnotice: () => {} });
  });
  afterAll(async () => {
    await sql`DROP TABLE IF EXISTS recall_cluster_members, recall_clusters, embeddings CASCADE`;
    await sql.end();
  });
  beforeEach(async () => {
    await sql`DROP TABLE IF EXISTS recall_cluster_members, recall_clusters, embeddings CASCADE`;
    await sql`CREATE EXTENSION IF NOT EXISTS vector`;
    // The state a store is left in by a first boot with no embedder.
    await sql.unsafe(`
      CREATE TABLE embeddings (
        row_namespace text NOT NULL, row_type text NOT NULL, row_id text NOT NULL,
        embedding vector(768) NOT NULL, model text NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (row_namespace, row_type, row_id)
      )`);
    await recallClustersMigration({ dimension: 768 }).apply({
      sql,
      metric: () => {},
      layout: null
    });
  });

  it('realigns BOTH empty columns, and rebuilds the HNSW index', async () => {
    const report = await alignVectorDimensions(sql, { dimension: 1024 });
    expect(report).toMatchObject({ embeddings: 'aligned', centroids: 'aligned' });
    expect(await typeOf('embeddings', 'embedding')).toBe('vector(1024)');
    expect(await typeOf('recall_clusters', 'centroid')).toBe('vector(1024)');
    const idx = await sql`SELECT indexname FROM pg_indexes
      WHERE schemaname = current_schema() AND tablename = 'embeddings'`;
    expect(idx.map((r) => r.indexname)).toContain('embeddings_hnsw');
  });

  it('replicas booting together align once, without racing on the DDL', async () => {
    // One client each: a shared pool would queue them on one connection.
    const replicas = [0, 1, 2, 3].map(() =>
      postgres(POSTGRES_URL as string, { max: 1, onnotice: () => {} })
    );
    await Promise.all(replicas.map((r) => r`SELECT 1`));
    const reports = await Promise.all(
      replicas.map((r) => alignVectorDimensions(r, { dimension: 1024 }))
    ).finally(() => Promise.all(replicas.map((r) => r.end())));
    expect(reports.map((r) => r.embeddings).sort()).toEqual(['aligned', 'match', 'match', 'match']);
    expect(await typeOf('embeddings', 'embedding')).toBe('vector(1024)');
  });

  it('is a no-op when the dimensions already match', async () => {
    expect(await alignVectorDimensions(sql, { dimension: 768 })).toMatchObject({
      embeddings: 'match',
      centroids: 'match'
    });
  });

  it('leaves a POPULATED column alone and says so', async () => {
    const v = `[${Array.from({ length: 768 }, () => 0.1).join(',')}]`;
    await sql.unsafe(
      `INSERT INTO embeddings (row_namespace, row_type, row_id, embedding, model)
       VALUES ('ns', 'T', 'a', '${v}', 'm')`
    );
    const report = await alignVectorDimensions(sql, { dimension: 1024 });
    expect(report).toMatchObject({
      embeddings: 'populated',
      centroids: 'aligned',
      found: { embeddings: 768 }
    });
    expect(await typeOf('embeddings', 'embedding')).toBe('vector(768)');
  });

  it('runs on every boot through the plugin hook, with an embedder', async () => {
    const plugin = createRecallPlugin({
      embedder: new FakeEmbedder({ dimension: 1024 }),
      store: new InMemoryEmbeddingsStore()
    });
    await plugin.onKernelReady?.({
      lifecycle: 'kernel',
      sql,
      coordinatorNamespaces: [],
      metric: () => {}
    });
    expect(await typeOf('embeddings', 'embedding')).toBe('vector(1024)');
    expect(await typeOf('recall_clusters', 'centroid')).toBe('vector(1024)');
  });

  it('does nothing without an embedder, so a boot with it off cannot shrink a column', async () => {
    await alignVectorDimensions(sql, { dimension: 1024 });
    const plugin = createRecallPlugin({ store: new InMemoryEmbeddingsStore() });
    await plugin.onKernelReady?.({
      lifecycle: 'kernel',
      sql,
      coordinatorNamespaces: [],
      metric: () => {}
    });
    expect(await typeOf('embeddings', 'embedding')).toBe('vector(1024)');
  });

  it('reports a populated mismatch as a metric, not silently', async () => {
    const v = `[${Array.from({ length: 768 }, () => 0.1).join(',')}]`;
    await sql.unsafe(
      `INSERT INTO embeddings (row_namespace, row_type, row_id, embedding, model)
       VALUES ('ns', 'T', 'a', '${v}', 'm')`
    );
    const metrics: Array<[string, unknown]> = [];
    const plugin = createRecallPlugin({
      embedder: new FakeEmbedder({ dimension: 1024 }),
      store: new InMemoryEmbeddingsStore()
    });
    await plugin.onKernelReady?.({
      lifecycle: 'kernel',
      sql,
      coordinatorNamespaces: [],
      metric: (name, payload) => metrics.push([name, payload])
    });
    expect(metrics).toEqual([
      [
        'recall_dimension_mismatch',
        expect.objectContaining({
          column: 'embeddings.embedding',
          stored: 768,
          embedder: 1024
        })
      ]
    ]);
  });
});

import type { Dataset, Row } from '@mnmal-ai/substrate-types';
import postgres from 'postgres';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { EmbedOutcome } from '../src/embed-and-store.js';
import { runEmbedBackfill } from '../src/embed-backfill.js';
import { EmbedSourceRegistry } from '../src/embed-source-registry.js';
import type { EmbeddingsStore } from '../src/embeddings-store.js';
import { embeddingsMigration } from '../src/migrations/0001_embeddings.js';
import { PgEmbeddingsStore } from '../src/pg-embeddings-store.js';

/** A dataset whose rows carry a `v` marking which version of the row a read saw. */
function fakeDataset(rows: Record<string, Row>): Dataset {
  return {
    read: async (_type: string, params: { ids?: string[] }) => ({
      rows: (params.ids ?? []).flatMap((id) => (rows[id] ? [rows[id]] : [])),
      hasMore: false
    })
  } as unknown as Dataset;
}

function setup(opts: {
  stale: string[];
  outcome?: (row: Row) => EmbedOutcome;
  staleRowIds?: boolean;
}) {
  const seen: Row[] = [];
  const registry = new EmbedSourceRegistry();
  registry.add({
    namespace: 'notes',
    type: 'Note',
    hook: async () => {},
    reembed: async (row) => {
      seen.push(row);
      return opts.outcome?.(row) ?? { status: 'embedded' };
    }
  } as Parameters<EmbedSourceRegistry['add']>[0]);
  const asked: string[] = [];
  const store = {
    ...(opts.staleRowIds === false
      ? {}
      : {
          staleRowIds: async ({ afterId, limit }: { afterId: string; limit: number }) => {
            asked.push(afterId);
            return opts.stale.filter((id) => id > afterId).slice(0, limit);
          }
        })
  } as unknown as EmbeddingsStore;
  const dataset = fakeDataset(
    Object.fromEntries(opts.stale.map((id) => [id, { id, v: 'current' } as Row]))
  );
  return { registry, store, dataset, seen, asked };
}

describe('runEmbedBackfill', () => {
  it('re-embeds the current row for each stale id', async () => {
    const s = setup({ stale: ['a', 'b'] });
    const r = await runEmbedBackfill({
      registry: s.registry,
      store: s.store,
      resolveDataset: () => s.dataset,
      cursors: new Map(),
      perTypeLimit: 10
    });
    expect(r).toEqual({ embedded: 2, unindexable: 0, failed: 0 });
    expect(s.seen).toEqual([
      { id: 'a', v: 'current' },
      { id: 'b', v: 'current' }
    ]);
  });

  it('pages by id across passes and starts over after a short page', async () => {
    const s = setup({ stale: ['a', 'b', 'c'], outcome: () => ({ status: 'unindexable' }) });
    const cursors = new Map<string, string>();
    const pass = () =>
      runEmbedBackfill({
        registry: s.registry,
        store: s.store,
        resolveDataset: () => s.dataset,
        cursors,
        perTypeLimit: 2
      });
    await pass();
    await pass();
    await pass();
    expect(s.asked).toEqual(['', 'b', '']);
  });

  it('stops the pass when the embedder is unavailable', async () => {
    const s = setup({
      stale: ['a', 'b'],
      outcome: () => ({ status: 'failed', error: 'down', code: 'unavailable' })
    });
    const r = await runEmbedBackfill({
      registry: s.registry,
      store: s.store,
      resolveDataset: () => s.dataset,
      cursors: new Map(),
      perTypeLimit: 10
    });
    expect(r).toEqual({ embedded: 0, unindexable: 0, failed: 1, stopped: 'down' });
    expect(s.seen).toHaveLength(1);
  });

  it('does nothing against a store that cannot see the rows', async () => {
    const s = setup({ stale: ['a'], staleRowIds: false });
    const r = await runEmbedBackfill({
      registry: s.registry,
      store: s.store,
      resolveDataset: () => s.dataset,
      cursors: new Map(),
      perTypeLimit: 10
    });
    expect(r).toEqual({ embedded: 0, unindexable: 0, failed: 0 });
    expect(s.seen).toEqual([]);
  });
});

const POSTGRES_URL = process.env.POSTGRES_URL;

describe.skipIf(POSTGRES_URL === undefined)('PgEmbeddingsStore.staleRowIds', () => {
  let sql: ReturnType<typeof postgres>;
  const vec = Float32Array.from({ length: 768 }, (_, i) => Math.sin(i));

  beforeAll(async () => {
    const setupSql = postgres(POSTGRES_URL as string);
    try {
      await embeddingsMigration().apply({ sql: setupSql, metric: () => {} });
    } finally {
      await setupSql.end();
    }
  });

  beforeEach(async () => {
    sql = postgres(POSTGRES_URL as string);
    await sql`TRUNCATE TABLE embeddings CASCADE`;
    await sql`TRUNCATE TABLE rows CASCADE`;
  });

  afterEach(async () => {
    await sql.end();
  });

  it('finds rows with no vector or a vector older than the row, live rows only', async () => {
    const t0 = new Date('2026-10-01T00:00:00Z');
    const t1 = new Date('2026-10-02T00:00:00Z');
    await sql`
      INSERT INTO rows (namespace, type, id, body, updated_at, deleted_at) VALUES
        ('notes', 'Note', 'fresh',   ${sql.json({})}, ${t0}, NULL),
        ('notes', 'Note', 'missing', ${sql.json({})}, ${t0}, NULL),
        ('notes', 'Note', 'stale',   ${sql.json({})}, ${t1}, NULL),
        ('notes', 'Note', 'gone',    ${sql.json({})}, ${t0}, now()),
        ('notes', 'Note', 'legacy',  ${sql.json({})}, NULL,  NULL),
        ('notes', 'Other', 'x',      ${sql.json({})}, ${t0}, NULL)
    `;
    const store = new PgEmbeddingsStore({ sql });
    for (const id of ['fresh', 'stale', 'legacy']) {
      await store.upsert({
        rowNamespace: 'notes',
        rowType: 'Note',
        rowId: id,
        vector: vec,
        model: 'm',
        now: t0
      });
    }
    const all = await store.staleRowIds({
      namespace: 'notes',
      type: 'Note',
      afterId: '',
      limit: 10
    });
    expect(all).toEqual(['missing', 'stale']);
    const after = await store.staleRowIds({
      namespace: 'notes',
      type: 'Note',
      afterId: 'missing',
      limit: 10
    });
    expect(after).toEqual(['stale']);
  });
});

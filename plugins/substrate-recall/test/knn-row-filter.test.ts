/**
 * embeddingSimilar / knnSearch scope by row fields INSIDE the search.
 *
 * The failure it fixes: a store shared by several projects, where one
 * project's rows sit closer to the query than another's. A post-filter (top-k,
 * then `id IN`) returns none of the second project's rows at all.
 */

import { MemoryDataset } from '@mnmal-ai/substrate-dataset-memory';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { matchesRowFilter, rowFilterProblem } from '../src/embeddings-store.js';
import { InMemoryEmbeddingsStore } from '../src/in-memory-embeddings-store.js';
import { embeddingsMigration } from '../src/migrations/0001_embeddings.js';
import { PgEmbeddingsStore } from '../src/pg-embeddings-store.js';

const POSTGRES_URL = process.env.POSTGRES_URL;
// The suites in this package share one embeddings, created at the default 768.
const DIM = 768;
const MODEL = 'm:768';
const query = Float32Array.from({ length: DIM }, (_, i) => (i === 0 ? 1 : 0));
/** Close to the query for small `t`, further away as it grows. */
const near = (t: number) =>
  Float32Array.from({ length: DIM }, (_, i) => (i === 0 ? 1 : i === 1 ? t : 0));

/** 120 project-A rows nearer the query than 3 project-B rows. */
const ROWS = [
  ...Array.from({ length: 120 }, (_, i) => ({
    id: `a${i}`,
    project: 'alpha',
    area: 'x',
    t: 0.01 + i * 0.001
  })),
  ...Array.from({ length: 3 }, (_, i) => ({ id: `b${i}`, project: 'beta', area: 'y', t: 2 + i }))
];

describe('row filter semantics', () => {
  it('validates shape and field names', () => {
    expect(rowFilterProblem({ project: { eq: 'beta' } })).toBeNull();
    expect(rowFilterProblem({ project: { in: ['a', null] } })).toBeNull();
    expect(rowFilterProblem({ 'body; drop': { eq: 1 } })).toMatch(/plain identifier/);
    expect(rowFilterProblem({ project: { eq: 'a', in: ['b'] } })).toMatch(/exactly one/);
    expect(rowFilterProblem({ project: { in: [] } })).toMatch(/non-empty/);
  });

  it('matches as text, with eq null meaning missing or null', () => {
    expect(matchesRowFilter({ n: 5, b: true }, { n: { eq: '5' }, b: { eq: true } })).toBe(true);
    expect(matchesRowFilter({}, { project: { eq: null } })).toBe(true);
    expect(matchesRowFilter({ project: 'x' }, { project: { in: ['y', null] } })).toBe(false);
  });

  it('reads only the row’s own fields, never its prototype', () => {
    expect(matchesRowFilter({ id: 'a' }, { constructor: { eq: null } })).toBe(true);
    expect(matchesRowFilter({ id: 'a' }, { toString: { eq: null } })).toBe(true);
  });
});

describe('in-memory store with no row resolver', () => {
  it('matches no row against a filter, as the lexical store does; unfiltered still returns stubs', async () => {
    const store = new InMemoryEmbeddingsStore();
    await store.upsert({
      rowNamespace: 'ns',
      rowType: 'Doc',
      rowId: 'd1',
      vector: near(0.1),
      model: MODEL
    });
    const base = { namespace: 'ns', type: 'Doc', model: MODEL, vector: query, k: 5 };
    expect((await store.knnSearch(base)).map((h) => h.row)).toEqual([{ id: 'd1' }]);
    expect(await store.knnSearch({ ...base, rowFilter: { project: { eq: null } } })).toEqual([]);
  });
});

describe('in-memory store: the filter fills k from the matching rows', () => {
  it('returns project beta although 120 alpha rows are nearer', async () => {
    const ds = new MemoryDataset({ namespace: 'ns' });
    await ds.write(
      'Doc',
      ROWS.map(({ id, project, area }) => ({ id, project, area }))
    );
    const store = new InMemoryEmbeddingsStore({ datasetFor: () => ds });
    for (const r of ROWS)
      await store.upsert({
        rowNamespace: 'ns',
        rowType: 'Doc',
        rowId: r.id,
        vector: near(r.t),
        model: MODEL
      });
    const base = { namespace: 'ns', type: 'Doc', model: MODEL, vector: query, k: 5 };
    expect((await store.knnSearch(base)).every((h) => h.row.project === 'alpha')).toBe(true);
    const scoped = await store.knnSearch({ ...base, rowFilter: { project: { eq: 'beta' } } });
    expect(scoped.map((h) => h.row.id)).toEqual(['b0', 'b1', 'b2']);
  });
});

describe.skipIf(POSTGRES_URL === undefined)(
  'pg store: the filter runs inside the vector search',
  () => {
    let sql: ReturnType<typeof postgres>;
    let store: PgEmbeddingsStore;

    beforeAll(async () => {
      sql = postgres(POSTGRES_URL as string, { onnotice: () => {} });
      await sql`CREATE EXTENSION IF NOT EXISTS vector`;
      await embeddingsMigration().apply({ sql, metric: () => {} });
      await sql`DELETE FROM embeddings WHERE row_namespace = 'knn1558'`;
      await sql`DELETE FROM rows WHERE namespace = 'knn1558'`;
      store = new PgEmbeddingsStore({ sql });
      for (const r of ROWS) {
        await sql`INSERT INTO rows (namespace, type, id, body)
        VALUES ('knn1558', 'Doc', ${r.id}, ${sql.json({ id: r.id, project: r.project, area: r.area })})`;
        await store.upsert({
          rowNamespace: 'knn1558',
          rowType: 'Doc',
          rowId: r.id,
          vector: near(r.t),
          model: MODEL
        });
      }
    });
    afterAll(async () => {
      await sql`DELETE FROM embeddings WHERE row_namespace = 'knn1558'`;
      await sql`DELETE FROM rows WHERE namespace = 'knn1558'`;
      await sql.end();
    });

    const base = () => ({ namespace: 'knn1558', type: 'Doc', model: MODEL, vector: query, k: 5 });

    it('without a filter, the nearer project crowds the other out', async () => {
      const hits = await store.knnSearch(base());
      expect(hits.every((h) => h.row.project === 'alpha')).toBe(true);
    });

    it('a body filter (project) returns the crowded-out rows', async () => {
      const hits = await store.knnSearch({ ...base(), rowFilter: { project: { eq: 'beta' } } });
      expect(hits.map((h) => h.row.id)).toEqual(['b0', 'b1', 'b2']);
    });

    it('a body-field filter (area) does the same', async () => {
      const hits = await store.knnSearch({ ...base(), rowFilter: { area: { in: ['y'] } } });
      expect(hits.map((h) => h.row.id)).toEqual(['b0', 'b1', 'b2']);
    });

    it('refuses a field name that is not a plain identifier', async () => {
      await expect(
        store.knnSearch({ ...base(), rowFilter: { "x'); drop table rows; --": { eq: 1 } } })
      ).rejects.toThrow(/plain identifier/);
    });
  }
);

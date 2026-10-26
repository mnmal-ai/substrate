/**
 * `where` on a recall request scopes every candidate source — the dense kNN,
 * the lexical search and crossRef expansion — so k fills with in-scope rows
 * in a store shared by several projects.
 */

import { MemoryDataset } from '@mnmal-ai/substrate-dataset-memory';
import type { Embedder } from '@mnmal-ai/substrate-embedder';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { EmbeddingsStore } from '../src/embeddings-store.js';
import { InMemoryEmbeddingsStore } from '../src/in-memory-embeddings-store.js';
import { InMemoryLexicalStore } from '../src/in-memory-lexical-store.js';
import type { LexicalStore } from '../src/lexical-store.js';
import { embeddingsMigration } from '../src/migrations/0001_embeddings.js';
import { lexicalMigration } from '../src/migrations/0003_lexical.js';
import { PgEmbeddingsStore } from '../src/pg-embeddings-store.js';
import { PgLexicalStore } from '../src/pg-lexical-store.js';
import type { RecallDeps, RecallInput } from '../src/recall/types.js';
import { handleRecallRequest } from '../src/recall-route.js';

const POSTGRES_URL = process.env.POSTGRES_URL;
const NS = 'recallwhere';
const DIM = 768;
const MODEL = 'm:768';
const queryVec = Float32Array.from({ length: DIM }, (_, i) => (i === 0 ? 1 : 0));
/** Close to the query for small `t`, further away as it grows. */
const near = (t: number) =>
  Float32Array.from({ length: DIM }, (_, i) => (i === 0 ? 1 : i === 1 ? t : 0));

const embedder = {
  modelId: MODEL,
  dimension: DIM,
  embed: async () => queryVec
} as unknown as Embedder;

interface Seed {
  type: 'Doc' | 'Note';
  id: string;
  project: string | null;
  t: number;
  text: string;
}

/**
 * 40 alpha Docs rank above 3 beta Docs in both arms; one Doc has no project.
 * The two Notes are expansion neighbours, nearer than any beta Doc.
 */
const SEEDS: Seed[] = [
  ...Array.from({ length: 40 }, (_, i) => ({
    type: 'Doc' as const,
    id: `a${String(i).padStart(2, '0')}`,
    project: 'alpha',
    t: 0.01 + i * 0.001,
    text: 'sweden sweden sweden'
  })),
  ...Array.from({ length: 3 }, (_, i) => ({
    type: 'Doc' as const,
    id: `b${i}`,
    project: 'beta',
    t: 2 + i,
    text: 'sweden'
  })),
  { type: 'Doc', id: 'n0', project: null, t: 6, text: 'sweden' },
  { type: 'Note', id: 'xa', project: 'alpha', t: 0.5, text: 'unrelated' },
  { type: 'Note', id: 'xb', project: 'beta', t: 0.5, text: 'unrelated' }
];

interface World {
  store: EmbeddingsStore;
  lexicalStore: LexicalStore;
}

const ids = (rows: ReadonlyArray<{ row: Record<string, unknown> }>) =>
  rows.map((r) => String(r.row.id));

function suite(name: string, make: () => Promise<World>) {
  describe(name, () => {
    let world: World;
    beforeAll(async () => {
      world = await make();
    });

    const recall = (input: Partial<RecallInput>, deps: Partial<RecallDeps> = {}) =>
      handleRecallRequest(
        { query: 'sweden', namespace: NS, type: 'Doc', boost: false, rowFields: true, ...input },
        deps
      );
    const dense = () => ({ embedder, store: world.store });

    it('dense: without where, the nearer project crowds the other out', async () => {
      const out = await recall({ k: 3 }, dense());
      expect(out.rows.every((r) => r.row.project === 'alpha')).toBe(true);
    });

    it('dense: where fills k with the in-scope rows, carrying their project', async () => {
      const out = await recall({ k: 3, where: { project: { eq: 'beta' } } }, dense());
      expect(ids(out.rows)).toEqual(['b0', 'b1', 'b2']);
      expect(out.rows.every((r) => r.row.project === 'beta')).toBe(true);
    });

    it('dense: `in` with null admits project-less rows and not the other project', async () => {
      const out = await recall({ k: 10, where: { project: { in: ['beta', null] } } }, dense());
      expect(ids(out.rows).sort()).toEqual(['b0', 'b1', 'b2', 'n0']);
    });

    it('lexical-only: where fills k with the in-scope rows', async () => {
      const out = await recall(
        { k: 3, where: { project: { eq: 'beta' } } },
        { lexicalStore: world.lexicalStore }
      );
      expect(out.arms?.lexical).toBe(true);
      expect(ids(out.rows)).toEqual(['b0', 'b1', 'b2']);
    });

    it('fused: both arms are scoped, so the fused top k is all in scope', async () => {
      const out = await recall(
        { k: 3, where: { project: { eq: 'beta' } } },
        { ...dense(), lexicalStore: world.lexicalStore }
      );
      expect(out.arms?.dense && out.arms.lexical).toBe(true);
      expect(ids(out.rows).sort()).toEqual(['b0', 'b1', 'b2']);
    });

    // xa and xb differ only in project, so xb arriving shows expansion ran and
    // xa's absence is the filter.
    it('expansion: an out-of-scope neighbour is dropped and an in-scope one is added', async () => {
      const out = await recall(
        { k: 4, expand: true, lexical: false, where: { project: { eq: 'beta' } } },
        {
          ...dense(),
          expansionEnabled: true,
          expansionResolver: async () =>
            ['xa', 'xb'].map((id) => ({
              namespace: NS,
              type: 'Note',
              id,
              seedId: 'b0',
              allowsCrossType: true
            }))
        }
      );
      expect(ids(out.rows).sort()).toEqual(['b0', 'b1', 'b2', 'xb']);
      expect(out.rows.find((r) => r.row.id === 'xb')?._expandedFrom?.id).toBe('b0');
    });
  });
}

describe('where validation', () => {
  for (const where of [{ project: 'beta' }, { 'bad-field': { eq: 1 } }, []]) {
    it(`refuses ${JSON.stringify(where)} with bad_request`, async () => {
      const lexicalStore = new InMemoryLexicalStore();
      await expect(
        handleRecallRequest({ query: 'q', namespace: NS, where: where as never }, { lexicalStore })
      ).rejects.toMatchObject({ code: 'bad_request', message: expect.stringMatching(/^"where" /) });
    });
  }
});

suite('in-memory stores', async () => {
  const ds = new MemoryDataset({ namespace: NS });
  for (const type of ['Doc', 'Note'] as const) {
    await ds.write(
      type,
      SEEDS.filter((s) => s.type === type).map(({ id, project }) =>
        project === null ? { id } : { id, project }
      )
    );
  }
  const store = new InMemoryEmbeddingsStore({ datasetFor: () => ds });
  const lexicalStore = new InMemoryLexicalStore({ datasetFor: () => ds });
  for (const s of SEEDS) {
    await store.upsert({
      rowNamespace: NS,
      rowType: s.type,
      rowId: s.id,
      vector: near(s.t),
      model: MODEL
    });
    await lexicalStore.upsert({ rowNamespace: NS, rowType: s.type, rowId: s.id, text: s.text });
  }
  return { store, lexicalStore };
});

describe.skipIf(POSTGRES_URL === undefined)('pg', () => {
  let sql: ReturnType<typeof postgres>;
  const clean = async () => {
    await sql`DELETE FROM embeddings WHERE row_namespace = ${NS}`;
    await sql`DELETE FROM lexical WHERE row_namespace = ${NS}`;
    await sql`DELETE FROM rows WHERE namespace = ${NS}`;
  };
  afterAll(async () => {
    await clean();
    await sql.end();
  });

  suite('pg stores', async () => {
    sql = postgres(POSTGRES_URL as string, { onnotice: () => {} });
    await sql`CREATE EXTENSION IF NOT EXISTS vector`;
    await embeddingsMigration().apply({ sql, metric: () => {}, layout: null });
    const lex = lexicalMigration();
    await lex.apply({ sql } as unknown as Parameters<typeof lex.apply>[0]);
    await clean();
    const store = new PgEmbeddingsStore({ sql });
    const lexicalStore = new PgLexicalStore(sql);
    for (const s of SEEDS) {
      const body = s.project === null ? { id: s.id } : { id: s.id, project: s.project };
      await sql`INSERT INTO rows (namespace, type, id, body)
        VALUES (${NS}, ${s.type}, ${s.id}, ${sql.json(body)})`;
      await store.upsert({
        rowNamespace: NS,
        rowType: s.type,
        rowId: s.id,
        vector: near(s.t),
        model: MODEL
      });
      await lexicalStore.upsert({ rowNamespace: NS, rowType: s.type, rowId: s.id, text: s.text });
    }
    return { store, lexicalStore };
  });
});

/**
 * Recall's lexical and kNN searches read through the type table's descriptor
 * under the same catalog-version guard as `dataset.read`: a process whose
 * catalog notification is late (B, deaf) and that cached a field `pending`
 * still returns the field, and still matches a row filter on it, after
 * another process promoted it out of `extra`. A retried `embeddingSimilar`
 * read embeds its query once.
 */

import { randomBytes } from 'node:crypto';
import { clearExtensionOperators, registerExtensionOperator } from '@mnmal-ai/substrate-core';
import { PgDataset, typeTableRef } from '@mnmal-ai/substrate-dataset-pg';
import type { Embedder } from '@mnmal-ai/substrate-embedder';
import type { FieldDef, Row } from '@mnmal-ai/substrate-types';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { embeddingSimilarOperator } from '../src/filter-operator.js';
import { embeddingsMigration } from '../src/migrations/0001_embeddings.js';
import { lexicalMigration } from '../src/migrations/0003_lexical.js';
import { PgEmbeddingsStore } from '../src/pg-embeddings-store.js';
import { PgLexicalStore } from '../src/pg-lexical-store.js';

const POSTGRES_URL = process.env.POSTGRES_URL;
// The suites in this package share one embeddings, created at the default 768.
const DIM = 768;
const MODEL = 'm:768';
const unit = Float32Array.from({ length: DIM }, (_, i) => (i === 0 ? 1 : 0));

describe.skipIf(!POSTGRES_URL)('recall through a stale table descriptor (pg)', () => {
  let sqlA: Sql;
  let sqlB: Sql;
  let ns: string;
  let defs: Record<string, { fields: Record<string, FieldDef> }>;
  const namespaces: string[] = [];
  const lookup = {
    typeDefLookup: (type: string) => defs[type],
    fieldDefLookup: (type: string, f: string) => defs[type]?.fields[f]
  };

  beforeAll(async () => {
    sqlA = postgres(POSTGRES_URL as string, { onnotice: () => {} });
    await sqlA`CREATE EXTENSION IF NOT EXISTS vector`;
    await embeddingsMigration().apply({ sql: sqlA, metric: () => {}, layout: null });
    const lex = lexicalMigration();
    await lex.apply({ sql: sqlA } as unknown as Parameters<typeof lex.apply>[0]);
    sqlB = postgres(POSTGRES_URL as string, { onnotice: () => {} });
    // Deaf: B caches descriptors as if listening, but no notification reaches it.
    vi.spyOn(sqlB, 'listen').mockResolvedValue({
      state: {} as never,
      unlisten: async () => {}
    } as never);
  });

  afterAll(async () => {
    clearExtensionOperators();
    for (const n of namespaces) {
      await sqlA`DELETE FROM embeddings WHERE row_namespace = ${n}`;
      await sqlA`DELETE FROM lexical WHERE row_namespace = ${n}`;
    }
    await sqlA.end({ timeout: 5 });
    await sqlB.end({ timeout: 5 });
  });

  beforeEach(async () => {
    ns = `sd_${randomBytes(4).toString('hex')}`;
    namespaces.push(ns);
    defs = { Doc: { fields: { title: { kind: 'scalar', type: 'string' } } } };
    const a = new PgDataset({ namespace: ns, sql: sqlA, ...lookup });
    await a.write('Doc', [{ id: 'd1', title: 'jazz piano' }]);
    defs.Doc = {
      fields: {
        title: { kind: 'scalar', type: 'string' },
        rank: { kind: 'scalar', type: 'number' }
      }
    };
    await a.ensureTypeStorage('Doc', { newFields: 'pending' });
    await a.write('Doc', [{ id: 'd1', rank: 1 }]);
    await new PgLexicalStore(sqlA).upsert({
      rowNamespace: ns,
      rowType: 'Doc',
      rowId: 'd1',
      text: 'jazz piano'
    });
    await new PgEmbeddingsStore({ sql: sqlA }).upsert({
      rowNamespace: ns,
      rowType: 'Doc',
      rowId: 'd1',
      vector: unit,
      model: MODEL
    });
    // B caches `rank` pending, read from `extra`; A then moves it to its column.
    expect((await typeTableRef(sqlB, ns, 'Doc'))?.text('r', 'rank')).toContain('extra');
    const events = await a.promotePendingFields({
      lockTimeoutMs: 2000,
      batchRows: 100,
      namespace: ns
    });
    expect(events.map((e) => e.kind)).toEqual(['promoted']);
  });

  it('a lexical search returns the promoted field, and matches a filter on it', async () => {
    const store = new PgLexicalStore(sqlB);
    const hits = await store.search({
      namespace: ns,
      type: 'Doc',
      query: 'jazz',
      k: 5,
      rowFilter: { rank: { eq: 1 } }
    });
    expect(hits.map((h) => [h.rowId, h.row.rank])).toEqual([['d1', 1]]);
  });

  it('a kNN search returns the hit its row filter matches on the promoted field', async () => {
    const store = new PgEmbeddingsStore({ sql: sqlB });
    const hits = await store.knnSearch({
      namespace: ns,
      type: 'Doc',
      model: MODEL,
      vector: unit,
      k: 5,
      rowFilter: { rank: { eq: 1 } }
    });
    expect(hits.map((h) => [h.row.id, h.row.rank])).toEqual([['d1', 1]]);
  });

  it('a retried embeddingSimilar read embeds its query once', async () => {
    let calls = 0;
    const embedder: Embedder = {
      modelId: MODEL,
      dimension: DIM,
      embed: async () => {
        calls++;
        return unit;
      }
    };
    registerExtensionOperator(
      'embeddingSimilar',
      embeddingSimilarOperator({ embedder, store: new PgEmbeddingsStore({ sql: sqlB }) })
    );
    const b = new PgDataset({ namespace: ns, sql: sqlB, ...lookup });
    const res = await b.read('Doc', {
      where: { embeddingSimilar: { to: 'jazz', where: { rank: { eq: 1 } } } }
    });
    expect(res.rows.map((r: Row) => [r.id, r.rank])).toEqual([['d1', 1]]);
    expect(calls).toBe(1);
  });
});

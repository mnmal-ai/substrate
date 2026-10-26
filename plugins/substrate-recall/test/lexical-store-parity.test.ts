/**
 * LexicalStore parity — memory vs pg, against a live postgres.
 *
 * Applies migration 0003 itself rather than assuming the target database is
 * at any particular migration level, matching `embeddings-store-parity`.
 *
 * The parity blocks assert only what BOTH backends can do. pg stems and the
 * in-memory matcher does not, so pg matches through inflections this store
 * misses; the stemming block below is pg-only and says so, rather than being
 * quietly dropped from parity and leaving the difference undocumented.
 */

import type { Dataset } from '@mnmal-ai/substrate-types';
import postgres from 'postgres';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { InMemoryLexicalStore } from '../src/in-memory-lexical-store.js';
import type { LexicalStore } from '../src/lexical-store.js';
import { lexicalMigration } from '../src/migrations/0003_lexical.js';
import { PgLexicalStore } from '../src/pg-lexical-store.js';

const POSTGRES_URL = process.env.POSTGRES_URL;
const isPgGated = POSTGRES_URL !== undefined;

const NS = 'cortext';
const TYPE = 'Memory';

const CORPUS: Array<{ id: string; text: string }> = [
  { id: 'holiday', text: 'In July of 2026 we went to Sweden, Denmark and Norway on vacation' },
  { id: 'warship', text: 'The Vasa was a 17th-century Swedish warship that sank in Stockholm' },
  { id: 'vikings', text: 'The Vikings were seafaring people from Scandinavia' }
];

async function ensureSchema(url: string): Promise<void> {
  const sql = postgres(url);
  try {
    const migration = lexicalMigration();
    // KernelMigrationContext carries more than this migration reads; `sql`
    // is the only member it touches.
    await migration.apply({ sql } as unknown as Parameters<typeof migration.apply>[0]);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/** Seed rows so the store's INNER JOIN can resolve a body. */
async function seedRows(sql: ReturnType<typeof postgres>): Promise<void> {
  for (const { id } of CORPUS) {
    await sql`
      INSERT INTO rows (namespace, type, id, body, deleted_at)
      VALUES (${NS}, ${TYPE}, ${id}, ${sql.json({ id })}, NULL)
      ON CONFLICT (namespace, type, id) DO UPDATE SET deleted_at = NULL
    `;
  }
}

async function seedIndex(store: LexicalStore): Promise<void> {
  for (const { id, text } of CORPUS) {
    await store.upsert({ rowNamespace: NS, rowType: TYPE, rowId: id, text });
  }
}

describe.skipIf(!isPgGated)('LexicalStore parity (memory vs pg)', () => {
  let sql: ReturnType<typeof postgres>;
  let pg: PgLexicalStore;
  let mem: InMemoryLexicalStore;

  beforeAll(async () => {
    await ensureSchema(POSTGRES_URL as string);
  });

  beforeEach(async () => {
    sql = postgres(POSTGRES_URL as string);
    await sql`DELETE FROM lexical WHERE row_namespace = ${NS}`;
    await seedRows(sql);
    pg = new PgLexicalStore(sql);
    mem = new InMemoryLexicalStore();
    await seedIndex(pg);
    await seedIndex(mem);
  });

  afterEach(async () => {
    await sql.end({ timeout: 5 });
  });

  /**
   * The case the arm exists for: the row whose CONTENT names Sweden must come back, and the Swedish warship must
   * not. "Swedish" does not stem to "sweden" in either backend, which is what
   * makes this a clean discriminator rather than a lucky ranking.
   */
  it('finds the row whose content names Sweden, in both backends', async () => {
    const search = { namespace: NS, type: TYPE, query: 'Sweden', k: 5 } as const;
    const pgHits = await pg.search(search);
    const memHits = await mem.search(search);

    expect(pgHits.map((h) => h.rowId)).toEqual(['holiday']);
    expect(memHits.map((h) => h.rowId)).toEqual(['holiday']);
  });

  it('returns the row body from the join in pg', async () => {
    const hits = await pg.search({ namespace: NS, type: TYPE, query: 'Sweden', k: 5 });
    // The body as stored, as the dataset read path returns it.
    expect(hits[0]?.row).toEqual({ id: 'holiday' });
  });

  it('excludes a soft-deleted row in both backends', async () => {
    await sql`
      UPDATE rows SET deleted_at = now()
      WHERE namespace = ${NS} AND type = ${TYPE} AND id = 'holiday'
    `;
    const memWithRows = new InMemoryLexicalStore({
      datasetFor: () =>
        ({
          read: async (_type: string, params: { id: string }) => ({
            rows: params.id === 'holiday' ? [] : [{ id: params.id }]
          })
        }) as unknown as Dataset
    });
    await seedIndex(memWithRows);

    const search = { namespace: NS, type: TYPE, query: 'Sweden', k: 5 } as const;
    expect((await pg.search(search)).map((h) => h.rowId)).toEqual([]);
    expect((await memWithRows.search(search)).map((h) => h.rowId)).toEqual([]);
  });

  it('keeps the newer text when an older write lands after it, in both backends', async () => {
    const row = { rowNamespace: NS, rowType: TYPE, rowId: 'holiday' };
    for (const store of [pg, mem] as LexicalStore[]) {
      await store.upsert({ ...row, text: 'Finland', now: new Date('2030-01-02') });
      await store.upsert({ ...row, text: 'Sweden', now: new Date('2030-01-01') });
    }

    const search = { namespace: NS, type: TYPE, query: 'Sweden', k: 5 } as const;
    expect((await pg.search(search)).map((h) => h.rowId)).toEqual([]);
    expect((await mem.search(search)).map((h) => h.rowId)).toEqual([]);
  });

  it('stops returning a row after delete, in both backends', async () => {
    await pg.delete({ rowNamespace: NS, rowType: TYPE, rowId: 'holiday' });
    await mem.delete({ rowNamespace: NS, rowType: TYPE, rowId: 'holiday' });

    const search = { namespace: NS, type: TYPE, query: 'Sweden', k: 5 } as const;
    expect((await pg.search(search)).map((h) => h.rowId)).toEqual([]);
    expect((await mem.search(search)).map((h) => h.rowId)).toEqual([]);
  });

  it('purgeOrphans removes the text of tombstoned and dropped rows, keeps live ones', async () => {
    await sql`
      UPDATE rows SET deleted_at = now()
      WHERE namespace = ${NS} AND type = ${TYPE} AND id = 'holiday'
    `;
    // A drop or a tombstone purge hard-deletes the row.
    await sql`DELETE FROM rows WHERE namespace = ${NS} AND type = ${TYPE} AND id = 'warship'`;

    expect(await pg.purgeOrphans()).toBeGreaterThanOrEqual(2);
    const left = await sql<{ row_id: string }[]>`
      SELECT row_id FROM lexical WHERE row_namespace = ${NS} ORDER BY row_id
    `;
    expect(left.map((r) => r.row_id)).toEqual(['vikings']);
  });

  it('countIndexed agrees on a live corpus', async () => {
    expect(await pg.countIndexed(NS, TYPE)).toBe(CORPUS.length);
    expect(await mem.countIndexed(NS, TYPE)).toBe(CORPUS.length);
    expect(await pg.countIndexed(NS, 'Nope')).toBe(0);
    expect(await mem.countIndexed(NS, 'Nope')).toBe(0);
  });

  it('countIndexed excludes a soft-deleted row in pg, matching search', async () => {
    await sql`
      UPDATE rows SET deleted_at = now()
      WHERE namespace = ${NS} AND type = ${TYPE} AND id = 'holiday'
    `;
    // Same liveness predicate as search: the count names rows recall could
    // return, not orphaned index entries.
    expect(await pg.countIndexed(NS, TYPE)).toBe(CORPUS.length - 1);
  });

  it('scopes to (namespace, type) in both backends', async () => {
    await sql`
      INSERT INTO rows (namespace, type, id, body, deleted_at)
      VALUES ('labs', 'Trace', 'other', ${sql.json({ id: 'other' })}, NULL)
      ON CONFLICT (namespace, type, id) DO NOTHING
    `;
    await pg.upsert({
      rowNamespace: 'labs',
      rowType: 'Trace',
      rowId: 'other',
      text: 'Sweden'
    });
    await mem.upsert({
      rowNamespace: 'labs',
      rowType: 'Trace',
      rowId: 'other',
      text: 'Sweden'
    });

    const search = { namespace: NS, type: TYPE, query: 'Sweden', k: 5 } as const;
    expect((await pg.search(search)).map((h) => h.rowId)).toEqual(['holiday']);
    expect((await mem.search(search)).map((h) => h.rowId)).toEqual(['holiday']);
  });
});

describe.skipIf(!isPgGated)('PgLexicalStore: behaviour the memory store cannot match', () => {
  let sql: ReturnType<typeof postgres>;
  let pg: PgLexicalStore;

  beforeAll(async () => {
    await ensureSchema(POSTGRES_URL as string);
  });

  beforeEach(async () => {
    sql = postgres(POSTGRES_URL as string);
    await sql`DELETE FROM lexical WHERE row_namespace = ${NS}`;
    await seedRows(sql);
    pg = new PgLexicalStore(sql);
    await seedIndex(pg);
  });

  afterEach(async () => {
    await sql.end({ timeout: 5 });
  });

  /**
   * Proves the GENERATED tsv column is real and stemming is live. The write
   * path never computes a tsvector, so if the generated expression were wrong
   * or absent, every query here would return nothing — which is exactly the
   * silent failure the generated column exists to make impossible.
   */
  it('matches a stemmed form the in-memory store would miss', async () => {
    const hits = await pg.search({ namespace: NS, type: TYPE, query: 'seafaring people', k: 5 });
    expect(hits.map((h) => h.rowId)).toEqual(['vikings']);

    const mem = new InMemoryLexicalStore();
    await seedIndex(mem);
    // Same corpus, same query: the memory store also matches here (whole
    // tokens), so the discriminating case is a genuine inflection.
    const stemmed = await pg.search({ namespace: NS, type: TYPE, query: 'sank', k: 5 });
    expect(stemmed.map((h) => h.rowId)).toEqual(['warship']);
    const memStemmed = await mem.search({ namespace: NS, type: TYPE, query: 'sank', k: 5 });
    expect(memStemmed.map((h) => h.rowId)).toEqual(['warship']);
  });

  /**
   * THE AND CEILING. `websearch_to_tsquery` ANDs every
   * non-stopword term, so ONE absent term zeroes the whole arm — and the
   * queries that hit it are the natural ones. "Sweden" reaches the row;
   * "what happened in Sweden" does not, because "happened" is not in it.
   *
   * The fallback is AND-FIRST, OR-ONLY-IF-EMPTY, so it is strictly additive:
   * it fires only where the arm contributes nothing, and can never displace a
   * row the strict pass found. `threshold` reaches the dense arm only, so an
   * always-OR arm would admit noise into a channel with no floor on it.
   */
  it('falls back to OR when the strict AND pass matches nothing', async () => {
    const strict = await pg.search({
      namespace: NS,
      type: TYPE,
      query: 'Sweden zzzabsentqqq',
      k: 5
    });
    expect(strict.map((h) => h.rowId)).toEqual(['holiday']);
  });

  it('answers a natural-language question the AND pass zeroes', async () => {
    const hits = await pg.search({
      namespace: NS,
      type: TYPE,
      query: 'what happened in Sweden',
      k: 5
    });
    expect(hits.map((h) => h.rowId)).toEqual(['holiday']);
  });

  /**
   * The fallback must not WIDEN a query the strict pass already answered.
   * Needs a row carrying ONE of the terms, or the assertion passes for the
   * wrong reason — the base corpus shares no content word between rows, so
   * an always-OR arm would return the same set and the test would be green
   * against both implementations.
   *
   * With `brochure` present, `Sweden vacation` is an AND hit on `holiday`
   * alone; always-OR would return `brochure` too. That row is the whole
   * discriminator.
   */
  it('does not widen a query the strict pass already answered', async () => {
    await sql`
      INSERT INTO rows (namespace, type, id, body, deleted_at)
      VALUES (${NS}, ${TYPE}, 'brochure', ${sql.json({ id: 'brochure' })}, NULL)
      ON CONFLICT (namespace, type, id) DO UPDATE SET deleted_at = NULL
    `;
    await pg.upsert({
      rowNamespace: NS,
      rowType: TYPE,
      rowId: 'brochure',
      text: 'A brochure about Sweden'
    });

    const hits = await pg.search({ namespace: NS, type: TYPE, query: 'Sweden vacation', k: 5 });
    expect(hits.map((h) => h.rowId)).toEqual(['holiday']);

    // And the same two terms with NO row carrying both do fall back, which is
    // what makes the assertion above about the strict pass rather than about
    // the corpus.
    const widened = await pg.search({
      namespace: NS,
      type: TYPE,
      query: 'Sweden warship',
      k: 5
    });
    expect(widened.map((h) => h.rowId).sort()).toEqual(['brochure', 'holiday', 'warship']);
  });

  /**
   * A NEGATED term must not be flipped into an OR arm. `websearch_to_tsquery`
   * renders `Stockholm -Vasa` as `'stockholm' & !'vasa'`, and a blind
   * `' & '` -> `' | '` rewrite yields `'stockholm' | !'vasa'` — which matches
   * every row NOT mentioning Vasa, i.e. the opposite of what was asked, and
   * far more rows than the query that returned none.
   */
  it('does not fall back on a query carrying an exclusion', async () => {
    const hits = await pg.search({
      namespace: NS,
      type: TYPE,
      query: 'Stockholm -Vasa',
      k: 5
    });
    expect(hits.map((h) => h.rowId)).toEqual([]);
  });

  /**
   * `websearch_to_tsquery` must not raise on punctuation a person types.
   * `to_tsquery` would throw a syntax error and turn a search box into a 500.
   */
  it('does not raise on free-text punctuation', async () => {
    await expect(
      pg.search({ namespace: NS, type: TYPE, query: 'Sweden & (Denmark', k: 5 })
    ).resolves.toBeDefined();
  });

  it('honours a negated term', async () => {
    const hits = await pg.search({
      namespace: NS,
      type: TYPE,
      query: 'Stockholm -Vasa',
      k: 5
    });
    expect(hits.map((h) => h.rowId)).toEqual([]);
  });
});

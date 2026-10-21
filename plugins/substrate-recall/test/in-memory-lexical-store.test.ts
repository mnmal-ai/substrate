import { describe, expect, it } from 'vitest';
import { InMemoryLexicalStore } from '../src/in-memory-lexical-store.js';

describe('InMemoryLexicalStore', () => {
  /**
   * The case the whole arm exists for. `m1` is the row whose CONTENT names
   * Sweden; its embedded handle would be the question ("did we go to Sweden?")
   * and a dense search for that question ranks a Swedish warship above the
   * holiday. A lexical arm has to return the holiday and only the holiday.
   */
  it('finds a row by a term that appears only in its lexical text', async () => {
    const store = new InMemoryLexicalStore();
    await store.upsert({
      rowNamespace: 'cortext',
      rowType: 'Memory',
      rowId: 'm1',
      text: 'In July of 2026 we went to Sweden, Denmark and Norway on vacation'
    });
    await store.upsert({
      rowNamespace: 'cortext',
      rowType: 'Memory',
      rowId: 'm2',
      text: 'The Vasa was a 17th-century Swedish warship'
    });

    const hits = await store.search({
      namespace: 'cortext',
      type: 'Memory',
      query: 'Sweden',
      k: 5
    });

    expect(hits.map((h) => h.rowId)).toEqual(['m1']);
  });

  it('does not leak rows from another namespace or type', async () => {
    const store = new InMemoryLexicalStore();
    await store.upsert({
      rowNamespace: 'cortext',
      rowType: 'Memory',
      rowId: 'm1',
      text: 'Sweden'
    });
    await store.upsert({
      rowNamespace: 'labs',
      rowType: 'Trace',
      rowId: 't1',
      text: 'Sweden'
    });

    const hits = await store.search({
      namespace: 'cortext',
      type: 'Memory',
      query: 'Sweden',
      k: 5
    });

    expect(hits.map((h) => h.rowId)).toEqual(['m1']);
  });

  it('stops finding a row once its lexical text is deleted', async () => {
    const store = new InMemoryLexicalStore();
    await store.upsert({
      rowNamespace: 'cortext',
      rowType: 'Memory',
      rowId: 'm1',
      text: 'Sweden'
    });
    await store.delete({ rowNamespace: 'cortext', rowType: 'Memory', rowId: 'm1' });

    const hits = await store.search({
      namespace: 'cortext',
      type: 'Memory',
      query: 'Sweden',
      k: 5
    });

    expect(hits).toEqual([]);
  });

  /**
   * Ranking has to discriminate, or the arm contributes a flat rank to the
   * fusion and cannot move anything. More matched query terms ranks higher.
   */
  async function seeded(): Promise<InMemoryLexicalStore> {
    const store = new InMemoryLexicalStore();
    await store.upsert({
      rowNamespace: 'cortext',
      rowType: 'Memory',
      rowId: 'both',
      text: 'We went to Sweden and Denmark'
    });
    await store.upsert({
      rowNamespace: 'cortext',
      rowType: 'Memory',
      rowId: 'one',
      text: 'We went to Denmark'
    });
    return store;
  }

  /**
   * AND first, matching pg, whose `websearch_to_tsquery` ANDs. An always-OR
   * matcher would make the in-memory store more permissive than pg.
   */
  it('returns only full matches when a row matches every term', async () => {
    const hits = await (await seeded()).search({
      namespace: 'cortext',
      type: 'Memory',
      query: 'Sweden Denmark',
      k: 5
    });
    expect(hits.map((h) => h.rowId)).toEqual(['both']);
  });

  /**
   * The fallback: when no row carries every term, partial matches come back
   * ordered by how many they carry.
   */
  it('falls back to partial matches ranked by term count when nothing matches all', async () => {
    const hits = await (await seeded()).search({
      namespace: 'cortext',
      type: 'Memory',
      query: 'Sweden Denmark Norway',
      k: 5
    });
    expect(hits.map((h) => h.rowId)).toEqual(['both', 'one']);
  });
});

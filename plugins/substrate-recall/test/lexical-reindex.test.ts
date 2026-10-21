/**
 * Lexical backfill.
 *
 * A backfill must produce what the write path would for the same row. The pg
 * `tsv` is GENERATED, but the TEXT still comes from a source function, so
 * these tests pin that the backfill runs the registered source rather than a
 * copy of its own.
 *
 * The rest guard the ways a green run could lie: swallowed failures, and an
 * unwired dependency reported as an empty corpus.
 */

import type { Dataset, Row } from '@mnmal-ai/substrate-types';
import { describe, expect, it } from 'vitest';
import { handleEmbedStatsRequest } from '../src/embed-stats-route.js';
import { InMemoryLexicalStore } from '../src/in-memory-lexical-store.js';
import { makeLexicalReindex } from '../src/lexical-index.js';
import { handleLexicalReindex } from '../src/lexical-reindex-core.js';
import { LexicalSourceRegistry } from '../src/lexical-source-registry.js';

const noopHook = (async () => {}) as never;

/** Cursor paging over a fixed row list — the cursor is the offset. */
function pagedDataset(rows: Row[]): Dataset {
  return {
    read: async (_type: string, params: { limit?: number; cursor?: string }) => {
      const start = params.cursor === undefined ? 0 : Number(params.cursor);
      const limit = params.limit ?? rows.length;
      const slice = rows.slice(start, start + limit);
      const end = start + slice.length;
      return {
        rows: slice,
        hasMore: end < rows.length,
        ...(end < rows.length ? { nextCursor: String(end) } : {})
      };
    }
  } as unknown as Dataset;
}

function registryWith(
  store: InMemoryLexicalStore,
  source: (r: Row) => string | null
): {
  registry: LexicalSourceRegistry;
} {
  const registry = new LexicalSourceRegistry();
  registry.add({
    namespace: 'cortext',
    type: 'Memory',
    hook: noopHook,
    reindex: makeLexicalReindex({ namespace: 'cortext', type: 'Memory', source, store })
  });
  return { registry };
}

describe('handleLexicalReindex', () => {
  /**
   * The reason the backfill exists: rows written before the arm shipped are
   * invisible to it. Nothing about them is wrong — they were simply never
   * passed through a lexical hook — so a backfill that reaches them is the
   * difference between an arm that works and one that only works on new rows.
   */
  it('indexes rows the write path never saw, using the registered source', async () => {
    const store = new InMemoryLexicalStore();
    const { registry } = registryWith(store, (r) => String(r.body ?? ''));
    const rows: Row[] = [
      { id: 'm1', body: 'In July of 2026 we went to Sweden on vacation' },
      { id: 'm2', body: 'The Vasa was a Swedish warship' }
    ];

    const result = await handleLexicalReindex(
      { namespace: 'cortext', type: 'Memory' },
      { registry, resolveDataset: () => pagedDataset(rows) }
    );

    expect(result.indexed).toBe(2);
    expect(result.failed).toBe(0);
    const hits = await store.search({
      namespace: 'cortext',
      type: 'Memory',
      query: 'Sweden',
      k: 5
    });
    expect(hits.map((h) => h.rowId)).toEqual(['m1']);
  });

  /**
   * Same sentinel as the write path. A row that is un-indexable must have any
   * previously indexed text REMOVED by the backfill, or a corpus that flipped
   * to un-indexable stays findable until someone rewrites each row.
   */
  it('removes indexed text for rows whose source returns the sentinel', async () => {
    const store = new InMemoryLexicalStore();
    await store.upsert({
      rowNamespace: 'cortext',
      rowType: 'Memory',
      rowId: 'm1',
      text: 'Sweden'
    });
    const { registry } = registryWith(store, () => null);

    const result = await handleLexicalReindex(
      { namespace: 'cortext', type: 'Memory' },
      { registry, resolveDataset: () => pagedDataset([{ id: 'm1' } as Row]) }
    );

    expect(result.unindexable).toBe(1);
    expect(
      await store.search({ namespace: 'cortext', type: 'Memory', query: 'Sweden', k: 5 })
    ).toEqual([]);
  });

  /**
   * A backfill whose per-row errors vanish is worse than one that refuses,
   * because the operator stops looking. Same posture as the embed reindex.
   */
  it('reports per-row failures rather than swallowing them', async () => {
    const store = new InMemoryLexicalStore();
    const { registry } = registryWith(store, (r) => {
      if (r.id === 'bad') throw new Error('source exploded');
      return String(r.body ?? '');
    });

    const result = await handleLexicalReindex(
      { namespace: 'cortext', type: 'Memory' },
      {
        registry,
        resolveDataset: () =>
          pagedDataset([{ id: 'ok', body: 'fine' } as Row, { id: 'bad' } as Row])
      }
    );

    expect(result.indexed).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.failures).toEqual([{ id: 'bad', error: 'source exploded' }]);
  });

  /**
   * An unwired dataset must not read as a clean run over an empty corpus — a
   * backfill reporting "0 rows, 0 failures" is indistinguishable from success
   * and would let an operator conclude the arm is populated.
   */
  it('refuses when no dataset resolver is wired', async () => {
    const store = new InMemoryLexicalStore();
    const { registry } = registryWith(store, () => '');

    await expect(
      handleLexicalReindex({ namespace: 'cortext', type: 'Memory' }, { registry })
    ).rejects.toMatchObject({ code: 'unavailable' });
  });

  /**
   * Names what IS lexically indexed. The registry is configuration-derived, so
   * this answer is complete even for a type that has indexed no rows yet —
   * the blind spot a row-derived answer has.
   */
  it('names the lexically-indexed types when asked for one that is not', async () => {
    const store = new InMemoryLexicalStore();
    const { registry } = registryWith(store, () => '');

    await expect(
      handleLexicalReindex(
        { namespace: 'cortext', type: 'Nope' },
        { registry, resolveDataset: () => pagedDataset([]) }
      )
    ).rejects.toMatchObject({ code: 'unknown_type' });
  });

  it('pages with a cursor and reports hasMore', async () => {
    const store = new InMemoryLexicalStore();
    const { registry } = registryWith(store, (r) => String(r.body ?? ''));
    const rows: Row[] = Array.from({ length: 5 }, (_, i) => ({
      id: `m${i}`,
      body: `row ${i}`
    })) as Row[];

    const first = await handleLexicalReindex(
      { namespace: 'cortext', type: 'Memory', limit: 2 },
      { registry, resolveDataset: () => pagedDataset(rows) }
    );

    expect(first.indexed).toBe(2);
    expect(first.hasMore).toBe(true);
    expect(first.nextCursor).toBe('2');
  });
});

describe('embed-stats reports what is LEXICALLY indexed', () => {
  /**
   * Discovery has to come from the server's own configuration, not from the
   * rows that happen to exist. A type declaring `lexical.source` that has
   * indexed nothing yet is exactly the case a row-derived answer cannot see,
   * and it is indistinguishable there from "not indexed at all".
   */
  it('names lexically-indexed types alongside embedded ones', () => {
    const lexical = new LexicalSourceRegistry();
    lexical.add({ namespace: 'cortext', type: 'Memory', hook: noopHook });

    const body = handleEmbedStatsRequest(undefined, undefined, lexical);

    expect(body.lexicalTypes).toEqual([{ namespace: 'cortext', type: 'Memory' }]);
  });

  /**
   * The two empty answers must stay distinguishable, for the same reason the
   * embeddedTypes docblock gives: `undefined` means this server does not know,
   * `[]` means it knows and nothing is indexed. A caller collapsing them with
   * `?? []` would report full coverage against a server that never answered.
   */
  it('answers [] when it knows nothing is lexically indexed, not undefined', () => {
    const body = handleEmbedStatsRequest(undefined, undefined, new LexicalSourceRegistry());
    expect(body.lexicalTypes).toEqual([]);
  });

  it('answers undefined when no lexical registry was wired at all', () => {
    const body = handleEmbedStatsRequest(undefined, undefined);
    expect(body.lexicalTypes).toBeUndefined();
  });
});

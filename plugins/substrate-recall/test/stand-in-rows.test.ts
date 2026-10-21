/**
 * A store with no row resolver hands back stand-in bodies; a row filter must
 * not judge them as though they were the row.
 */

import type { PolicyDecision, RequestContext } from '@mnmal-ai/substrate-types';
import { describe, expect, it } from 'vitest';
import { InMemoryEmbeddingsStore } from '../src/in-memory-embeddings-store.js';
import { InMemoryLexicalStore } from '../src/in-memory-lexical-store.js';
import { anonymousCaller, visibleRefs, visibleRows } from '../src/row-visibility.js';

// Admits any row not owned by bob, so an empty stand-in would pass it.
const notBobs = (): PolicyDecision => ({
  allow: true,
  obligations: [
    {
      kind: 'row-filter',
      predicate: (_ctx: RequestContext, r: { owner?: unknown }) => r.owner !== 'bob'
    }
  ]
});

describe('stand-in rows under a row filter', () => {
  it('drops a ref whose row the store could not resolve', async () => {
    const store = new InMemoryEmbeddingsStore();
    await store.upsert({
      rowNamespace: 'ns',
      rowType: 'Note',
      rowId: 'b-1',
      vector: new Float32Array([1, 0, 0]),
      model: 'm'
    });
    const ref = { namespace: 'ns', type: 'Note', id: 'b-1' };
    expect(await visibleRefs([ref], notBobs, anonymousCaller(), store, 'm')).toEqual([]);
    expect(
      await visibleRefs([ref], () => ({ allow: true }), anonymousCaller(), store, 'm')
    ).toEqual([ref]);
  });

  it('drops a lexical hit whose row the store could not resolve', async () => {
    const store = new InMemoryLexicalStore();
    await store.upsert({
      rowNamespace: 'ns',
      rowType: 'Note',
      rowId: 'b-1',
      text: 'quarterly plan'
    });
    const hits = await store.search({ namespace: 'ns', type: 'Note', query: 'plan', k: 5 });
    const items = hits.map((h) => ({ namespace: 'ns', type: 'Note', row: h.row }));
    expect(items).toHaveLength(1);
    expect(visibleRows(items, notBobs, anonymousCaller())).toEqual([]);
  });
});

/**
 * Dry-run lexical coverage.
 *
 * The claim under test: { scanned, indexed, unindexable } per type lets a
 * consumer tell a deliberately narrow `lexical.source` from a broken
 * backfill — the distinction rows-indexed alone cannot draw. Both render as
 * a small `indexed`; only the companion fields separate them:
 *
 *   narrow source    scanned == indexed + unindexable + failed (gap ~ 0)
 *   backfill missing scanned >> indexed + unindexable (gap = unvisited rows)
 *
 * The rest guard the ways a coverage read could lie: a scan that writes
 * (it must not — the store is untouched), an unwired dependency reported as
 * clean zeros, and an unclassifiable entry collapsing unknown into zero.
 */

import type { Dataset, Row } from '@mnmal-ai/substrate-types';
import { describe, expect, it } from 'vitest';
import { embedStatsRouteHandler } from '../src/embed-stats-route.js';
import { InMemoryLexicalStore } from '../src/in-memory-lexical-store.js';
import {
  handleLexicalCoverage,
  validateLexicalCoverageInput
} from '../src/lexical-coverage-core.js';
import { makeLexicalClassify } from '../src/lexical-index.js';
import { LexicalSourceRegistry } from '../src/lexical-source-registry.js';
import type { LexicalStore } from '../src/lexical-store.js';

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

function registryWithClassify(
  source: (r: Row) => string | null | undefined
): LexicalSourceRegistry {
  const registry = new LexicalSourceRegistry();
  const store = new InMemoryLexicalStore();
  registry.add({
    namespace: 'cortext',
    type: 'Memory',
    hook: noopHook,
    classify: makeLexicalClassify({ namespace: 'cortext', type: 'Memory', source, store })
  });
  return registry;
}

const countingStore = (): LexicalStore & {
  countIndexed: (ns: string, t: string) => Promise<number>;
} => new InMemoryLexicalStore();

describe('handleLexicalCoverage', () => {
  it('a narrow source reads as refused-by-design, not as a broken backfill', async () => {
    // Narrow source: 5 scanned, 1 indexed, 4 refused.
    const rows: Row[] = [
      { id: 'm1', body: 'indexed already' },
      { id: 'm2', body: 'refused' },
      { id: 'm3', body: 'refused' },
      { id: 'm4', body: 'refused' },
      { id: 'm5', body: 'refused' }
    ];
    const store = new InMemoryLexicalStore();
    await store.upsert({
      rowNamespace: 'cortext',
      rowType: 'Memory',
      rowId: 'm1',
      text: 'indexed already'
    });
    const registry = new LexicalSourceRegistry();
    registry.add({
      namespace: 'cortext',
      type: 'Memory',
      hook: noopHook,
      classify: makeLexicalClassify({
        namespace: 'cortext',
        type: 'Memory',
        source: (r) => (r.id === 'm1' ? String(r.body) : null),
        store
      })
    });
    const out = await handleLexicalCoverage(
      {},
      { registry, resolveDataset: () => pagedDataset(rows), lexicalStore: store }
    );
    expect(out.types).toEqual([
      { namespace: 'cortext', type: 'Memory', scanned: 5, indexed: 1, unindexable: 4, failed: 0 }
    ]);
    // The arithmetic closes: every scanned row is accounted for.
    const t = out.types[0]!;
    expect(t.scanned - t.indexed - (t.unindexable ?? 0) - t.failed).toBe(0);
  });

  it('rows the scan never visited read as a gap, not as refusals', async () => {
    // Backfill never ran: source would index everything, store holds nothing.
    const rows: Row[] = [
      { id: 'm1', body: 'one' },
      { id: 'm2', body: 'two' },
      { id: 'm3', body: 'three' }
    ];
    const store = new InMemoryLexicalStore();
    const out = await handleLexicalCoverage(
      {},
      {
        registry: registryWithClassify((r) => String(r.body ?? '')),
        resolveDataset: () => pagedDataset(rows),
        lexicalStore: store
      }
    );
    const t = out.types[0]!;
    expect(t).toMatchObject({ scanned: 3, indexed: 0, unindexable: 0, failed: 0 });
    // The gap IS the finding: 3 rows unvisited, zero refused.
    expect(t.scanned - t.indexed - (t.unindexable ?? 0) - t.failed).toBe(3);
  });

  it('never writes: the store is byte-identical after a coverage run', async () => {
    const rows: Row[] = [
      { id: 'm1', body: 'one' },
      { id: 'm2', body: null }
    ];
    const store = new InMemoryLexicalStore();
    await handleLexicalCoverage(
      {},
      {
        registry: registryWithClassify((r) => (typeof r.body === 'string' ? r.body : null)),
        resolveDataset: () => pagedDataset(rows),
        lexicalStore: store
      }
    );
    expect(await store.countIndexed('cortext', 'Memory')).toBe(0);
  });

  it('pages to completion past the first page', async () => {
    const rows: Row[] = Array.from({ length: 1200 }, (_, i) => ({ id: `m${i}`, body: `row ${i}` }));
    const store = countingStore();
    const out = await handleLexicalCoverage(
      {},
      {
        registry: registryWithClassify((r) => String(r.body ?? '')),
        resolveDataset: () => pagedDataset(rows),
        lexicalStore: store
      }
    );
    expect(out.types[0]).toMatchObject({ scanned: 1200, indexed: 0, unindexable: 0, failed: 0 });
  });

  it('counts a throwing source as failed, not as refused', async () => {
    const rows: Row[] = [{ id: 'm1', body: 'boom' }];
    const store = countingStore();
    const registry = new LexicalSourceRegistry();
    registry.add({
      namespace: 'cortext',
      type: 'Memory',
      hook: noopHook,
      classify: makeLexicalClassify({
        namespace: 'cortext',
        type: 'Memory',
        source: () => {
          throw new Error('source blew up');
        },
        store
      })
    });
    const out = await handleLexicalCoverage(
      {},
      { registry, resolveDataset: () => pagedDataset(rows), lexicalStore: store }
    );
    expect(out.types[0]).toMatchObject({ scanned: 1, indexed: 0, unindexable: 0, failed: 1 });
  });

  it('an entry with no classifier reports unknown, not zero', async () => {
    const store = new InMemoryLexicalStore();
    await store.upsert({ rowNamespace: 'cortext', rowType: 'Memory', rowId: 'm1', text: 'held' });
    const registry = new LexicalSourceRegistry();
    registry.add({ namespace: 'cortext', type: 'Memory', hook: noopHook });
    const out = await handleLexicalCoverage(
      {},
      { registry, resolveDataset: () => pagedDataset([{ id: 'm1' }]), lexicalStore: store }
    );
    // indexed still counted; unindexable null (unknown) with nothing scanned.
    expect(out.types[0]).toEqual({
      namespace: 'cortext',
      type: 'Memory',
      scanned: 0,
      indexed: 1,
      unindexable: null,
      failed: 0
    });
  });

  it('refuses rather than reporting clean zeros when no dataset resolver is wired', async () => {
    await expect(
      handleLexicalCoverage(
        {},
        { registry: registryWithClassify(() => ''), lexicalStore: countingStore() }
      )
    ).rejects.toMatchObject({ code: 'unavailable' });
  });

  it('rejects a single-type filter for an undeclared type by name', async () => {
    await expect(
      handleLexicalCoverage(
        { namespace: 'cortext', type: 'Nope' },
        {
          registry: registryWithClassify(() => ''),
          resolveDataset: () => pagedDataset([]),
          lexicalStore: countingStore()
        }
      )
    ).rejects.toMatchObject({ code: 'unknown_type' });
  });

  it('validateLexicalCoverageInput requires namespace + type together', () => {
    expect(validateLexicalCoverageInput(undefined)).toEqual({});
    expect(validateLexicalCoverageInput({ namespace: 'c', type: 'M' })).toEqual({
      namespace: 'c',
      type: 'M'
    });
    expect(() => validateLexicalCoverageInput({ namespace: 'c' })).toThrowError(
      expect.objectContaining({ code: 'bad_request' })
    );
  });
});

describe('embed-stats ?coverage=true', () => {
  const baseReq = {
    method: 'GET' as const,
    path: '/substrate/v1/embed-stats',
    headers: {},
    query: {} as Record<string, string>,
    params: {},
    body: null
  };

  function wired() {
    const store = new InMemoryLexicalStore();
    const registry = new LexicalSourceRegistry();
    registry.add({
      namespace: 'cortext',
      type: 'Memory',
      hook: noopHook,
      classify: makeLexicalClassify({
        namespace: 'cortext',
        type: 'Memory',
        source: (r) => String(r.body ?? ''),
        store
      })
    });
    const composition = {
      lexicalEnabled: true,
      lexicalStore: store as LexicalStore,
      resolveDataset: () => pagedDataset([{ id: 'm1', body: 'one' }])
    };
    return { store, registry, composition };
  }

  it('omits lexicalCoverage unless asked — the scan is never computed unasked', async () => {
    const { registry, composition } = wired();
    const res = await embedStatsRouteHandler(undefined, undefined, registry, composition)(baseReq);
    expect(res.status).toBe(200);
    expect('lexicalCoverage' in JSON.parse(String(res.body))).toBe(false);
  });

  it('reports per-type coverage when asked', async () => {
    const { registry, composition } = wired();
    const res = await embedStatsRouteHandler(
      undefined,
      undefined,
      registry,
      composition
    )({
      ...baseReq,
      query: { coverage: 'true' }
    });
    expect(res.status).toBe(200);
    const body = JSON.parse(String(res.body)) as { lexicalCoverage: unknown };
    expect(body.lexicalCoverage).toEqual([
      { namespace: 'cortext', type: 'Memory', scanned: 1, indexed: 0, unindexable: 0, failed: 0 }
    ]);
  });

  it('503s when asked but the store or resolver is not wired', async () => {
    const registry = new LexicalSourceRegistry();
    const res = await embedStatsRouteHandler(undefined, undefined, registry, {
      lexicalEnabled: false
    })({
      ...baseReq,
      query: { coverage: 'true' }
    });
    expect(res.status).toBe(503);
    expect(JSON.parse(String(res.body)).error.code).toBe('unavailable');
  });
});

describe('LexicalStore.countIndexed', () => {
  it('counts per (namespace, type) on the in-memory store', async () => {
    const store = new InMemoryLexicalStore();
    await store.upsert({ rowNamespace: 'c', rowType: 'M', rowId: 'a', text: 'alpha' });
    await store.upsert({ rowNamespace: 'c', rowType: 'M', rowId: 'b', text: 'beta' });
    await store.upsert({ rowNamespace: 'c', rowType: 'D', rowId: 'a', text: 'gamma' });
    expect(await store.countIndexed('c', 'M')).toBe(2);
    expect(await store.countIndexed('c', 'D')).toBe(1);
    expect(await store.countIndexed('c', 'Missing')).toBe(0);
    await store.delete({ rowNamespace: 'c', rowType: 'M', rowId: 'a' });
    expect(await store.countIndexed('c', 'M')).toBe(1);
  });
});

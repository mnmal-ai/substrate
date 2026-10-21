import type { Embedder } from '@mnmal-ai/substrate-embedder';
import type { EmbedSourceContext, RequestContext, Row } from '@mnmal-ai/substrate-types';
import { describe, expect, it, vi } from 'vitest';
import { makeEmbedPostWrite } from '../src/embed-and-store.js';
import type { EmbeddingsStore } from '../src/embeddings-store.js';

describe('makeEmbedPostWrite', () => {
  it('wraps embedAndStore into a PostWriteHook shape', async () => {
    const fakeEmbedder = {
      embed: vi.fn(async () => new Float32Array([0.1, 0.2, 0.3])),
      modelId: 'fake',
      dimension: 3
    };
    const fakeStore = {
      txScopeId: 'test',
      upsert: vi.fn(async () => {}),
      knnSearch: vi.fn(async () => [])
    };
    const hook = makeEmbedPostWrite({
      namespace: 'demo',
      type: 'Memory',
      source: (row) => (row.body as string) ?? '',
      embedder: fakeEmbedder as unknown as Embedder,
      store: fakeStore as unknown as EmbeddingsStore
    });
    const row: Row = { id: 'abc', body: 'hello' };
    await hook(row, {} as RequestContext);
    expect(fakeEmbedder.embed).toHaveBeenCalledWith('hello');
    expect(fakeStore.upsert).toHaveBeenCalled();
  });

  it('returns a PostWriteHook with the correct signature', () => {
    const hook = makeEmbedPostWrite({
      namespace: 'demo',
      type: 'Memory',
      source: () => '',
      embedder: {
        embed: async () => new Float32Array(),
        modelId: 'fake',
        dimension: 0
      } as unknown as Embedder,
      store: {
        txScopeId: 'test',
        upsert: async () => {},
        knnSearch: async () => []
      } as unknown as EmbeddingsStore
    });
    // PostWriteHook = (row, ctx) => Promise<void>
    expect(typeof hook).toBe('function');
  });

  it('awaits async source functions (embed.source widening)', async () => {
    const fakeEmbedder = {
      embed: vi.fn(async () => new Float32Array([0.5])),
      modelId: 'fake',
      dimension: 1
    };
    const fakeStore = {
      txScopeId: 'test',
      upsert: vi.fn(async () => {}),
      knnSearch: vi.fn(async () => [])
    };
    const hook = makeEmbedPostWrite({
      namespace: 'demo',
      type: 'Doc',
      // Async source — simulates a crossRef read that resolves to extra context.
      source: async (row) => `${row.title as string} — enriched`,
      embedder: fakeEmbedder as unknown as Embedder,
      store: fakeStore as unknown as EmbeddingsStore
    });
    await hook({ id: 'doc-1', title: 'hello' } as Row, {} as RequestContext);
    expect(fakeEmbedder.embed).toHaveBeenCalledWith('hello — enriched');
  });

  it('passes EmbedSourceContext to source when embedSourceContext is supplied', async () => {
    const fakeEmbedder = {
      embed: vi.fn(async () => new Float32Array([0.5])),
      modelId: 'fake',
      dimension: 1
    };
    const fakeStore = {
      txScopeId: 'test',
      upsert: vi.fn(async () => {}),
      knnSearch: vi.fn(async () => [])
    };
    const fakeCtx: EmbedSourceContext = {
      read: vi.fn(async () => ({ id: 'concept-1', name: 'Salience' }) as Row)
    };
    const sourceFn = vi.fn(async (row: Row, ctx?: EmbedSourceContext) => {
      const linked = await ctx?.read('demo', 'Concept', { id: 'concept-1' });
      return `${row.title as string} → ${(linked as { name?: string } | null)?.name ?? ''}`;
    });
    const hook = makeEmbedPostWrite({
      namespace: 'demo',
      type: 'Trace',
      source: sourceFn,
      embedder: fakeEmbedder as unknown as Embedder,
      store: fakeStore as unknown as EmbeddingsStore,
      embedSourceContext: fakeCtx
    });
    await hook({ id: 'trace-1', title: 'hello' } as Row, {} as RequestContext);
    expect(sourceFn).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'trace-1', title: 'hello' }),
      fakeCtx
    );
    expect(fakeCtx.read).toHaveBeenCalledWith('demo', 'Concept', { id: 'concept-1' });
    expect(fakeEmbedder.embed).toHaveBeenCalledWith('hello → Salience');
  });

  it('un-indexes the row when source returns the null sentinel', async () => {
    const fakeEmbedder = {
      embed: vi.fn(async () => new Float32Array([0.1])),
      modelId: 'fake',
      dimension: 1
    };
    const fakeStore = {
      txScopeId: 'test',
      upsert: vi.fn(async () => {}),
      delete: vi.fn(async () => {}),
      knnSearch: vi.fn(async () => [])
    };
    const hook = makeEmbedPostWrite({
      namespace: 'labs',
      type: 'Trace',
      source: (row) => (row.recallVisible === false ? null : (row.synopsis as string)),
      embedder: fakeEmbedder as unknown as Embedder,
      store: fakeStore as unknown as EmbeddingsStore
    });
    await hook(
      { id: 't-1', recallVisible: false, synopsis: 'mirror' } as Row,
      {} as RequestContext
    );
    expect(fakeEmbedder.embed).not.toHaveBeenCalled();
    expect(fakeStore.upsert).not.toHaveBeenCalled();
    expect(fakeStore.delete).toHaveBeenCalledWith({
      rowNamespace: 'labs',
      rowType: 'Trace',
      rowId: 't-1'
    });
  });

  it('passes undefined ctx to source when no embedSourceContext is supplied (back-compat)', async () => {
    const sourceFn = vi.fn((row: Row, ctx?: EmbedSourceContext) => {
      expect(ctx).toBeUndefined();
      return row.body as string;
    });
    const hook = makeEmbedPostWrite({
      namespace: 'demo',
      type: 'Memory',
      source: sourceFn,
      embedder: {
        embed: async () => new Float32Array([0.1]),
        modelId: 'fake',
        dimension: 1
      } as unknown as Embedder,
      store: {
        txScopeId: 't',
        upsert: async () => {},
        knnSearch: async () => []
      } as unknown as EmbeddingsStore
    });
    await hook({ id: 'm-1', body: 'note' } as Row, {} as RequestContext);
    expect(sourceFn).toHaveBeenCalled();
  });
});

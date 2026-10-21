import { FakeEmbedder } from '@mnmal-ai/substrate-embedder/fake';
import type { NamespaceDefinition, RequestContext, Row } from '@mnmal-ai/substrate-types';
import { describe, expect, it, vi } from 'vitest';
import { InMemoryEmbeddingsStore } from '../src/in-memory-embeddings-store.js';
import type { LexicalStore } from '../src/lexical-store.js';
import { createRecallPlugin } from '../src/plugin.js';

function makeNs(
  namespace: string,
  types: NonNullable<NamespaceDefinition['types']>
): NamespaceDefinition {
  return { namespace, types, install: () => {} };
}

function fakeLexicalStore(): LexicalStore & { upsert: ReturnType<typeof vi.fn> } {
  return {
    upsert: vi.fn(async () => {}),
    delete: vi.fn(async () => {}),
    search: vi.fn(async () => [])
  } as unknown as LexicalStore & { upsert: ReturnType<typeof vi.fn> };
}

describe('lexical post-write', () => {
  /**
   * The load-bearing property, and the reason lexical is not just another
   * embed knob: a lexical index needs no embedder. A deployment with no
   * ollama — no vectors at all — still gets keyword recall, and `embed`'s
   * off-mode early return must not swallow it.
   */
  it('indexes a row lexically when no embedder is configured', async () => {
    const lexical = fakeLexicalStore();
    const ns = makeNs('cortext', {
      Memory: {
        fields: { body: { kind: 'scalar', type: 'string' } },
        lexical: { source: (row: Row) => (row.body as string) ?? '' }
      }
    });
    const plugin = createRecallPlugin({
      store: new InMemoryEmbeddingsStore(),
      lexicalStore: lexical
    });

    const contribs = plugin.contributePostWrites!(ns);
    await contribs.Memory!(
      { id: 'm1', body: 'We went to Sweden in July' } as Row,
      {
        // biome-ignore lint/suspicious/noExplicitAny: hooks ignore ctx here
      } as any as RequestContext
    );

    expect(lexical.upsert).toHaveBeenCalledWith({
      rowNamespace: 'cortext',
      rowType: 'Memory',
      rowId: 'm1',
      text: 'We went to Sweden in July',
      now: expect.any(Date)
    });
  });

  /**
   * Both-arms is the EXPECTED shape for any store whose handle is shorter than
   * its content, not an edge case — `embed` takes the synopsis, `lexical` takes
   * the body. `contributePostWrites` returns one hook per type, so the two must
   * compose rather than one winning.
   */
  it('runs both arms for a type declaring embed.source and lexical.source', async () => {
    const lexical = fakeLexicalStore();
    const embeddings = new InMemoryEmbeddingsStore();
    const ns = makeNs('cortext', {
      Memory: {
        fields: {
          synopsis: { kind: 'scalar', type: 'string' },
          body: { kind: 'scalar', type: 'string' }
        },
        embed: { source: (row: Row) => (row.synopsis as string) ?? '' },
        lexical: { source: (row: Row) => (row.body as string) ?? '' }
      }
    });
    const plugin = createRecallPlugin({
      embedder: new FakeEmbedder({ dimension: 8 }),
      store: embeddings,
      lexicalStore: lexical
    });

    const contribs = plugin.contributePostWrites!(ns);
    await contribs.Memory!(
      { id: 'm1', synopsis: 'Where did we go?', body: 'We went to Sweden in July' } as Row,
      // biome-ignore lint/suspicious/noExplicitAny: hooks ignore ctx here
      {} as any as RequestContext
    );

    expect(lexical.upsert).toHaveBeenCalledWith({
      rowNamespace: 'cortext',
      rowType: 'Memory',
      rowId: 'm1',
      text: 'We went to Sweden in July',
      now: expect.any(Date)
    });
    expect(
      await embeddings.knnSearch({
        namespace: 'cortext',
        type: 'Memory',
        model: new FakeEmbedder({ dimension: 8 }).modelId,
        vector: new Float32Array(8).fill(0),
        k: 10
      })
    ).toHaveLength(1);
  });

  /**
   * Same un-indexable sentinel as `embed.source`, and it must DELETE rather
   * than merely decline. Rows commonly flip to un-indexable after being
   * written, so skipping the write leaves the old text findable forever —
   * only rows written after the flip would benefit.
   */
  it('deletes the lexical row when source returns the un-indexable sentinel', async () => {
    const lexical = fakeLexicalStore();
    const ns = makeNs('cortext', {
      Memory: {
        fields: { body: { kind: 'scalar', type: 'string' } },
        lexical: { source: () => null }
      }
    });
    const plugin = createRecallPlugin({
      store: new InMemoryEmbeddingsStore(),
      lexicalStore: lexical
    });

    const contribs = plugin.contributePostWrites!(ns);
    await contribs.Memory!(
      { id: 'm1', body: 'secret' } as Row,
      {
        // biome-ignore lint/suspicious/noExplicitAny: hooks ignore ctx here
      } as any as RequestContext
    );

    expect(lexical.delete).toHaveBeenCalledWith({
      rowNamespace: 'cortext',
      rowType: 'Memory',
      rowId: 'm1'
    });
    expect(lexical.upsert).not.toHaveBeenCalled();
  });

  /**
   * `''` is NOT the sentinel, matching `embed.source`. An empty string indexes
   * normally — a row whose lexical text is legitimately empty must not be
   * confused with one whose retrieval policy says never index me.
   */
  it('indexes an empty string rather than treating it as the sentinel', async () => {
    const lexical = fakeLexicalStore();
    const ns = makeNs('cortext', {
      Memory: {
        fields: { body: { kind: 'scalar', type: 'string' } },
        lexical: { source: () => '' }
      }
    });
    const plugin = createRecallPlugin({
      store: new InMemoryEmbeddingsStore(),
      lexicalStore: lexical
    });

    const contribs = plugin.contributePostWrites!(ns);
    await contribs.Memory!(
      { id: 'm1', body: '' } as Row,
      {
        // biome-ignore lint/suspicious/noExplicitAny: hooks ignore ctx here
      } as any as RequestContext
    );

    expect(lexical.upsert).toHaveBeenCalledWith({
      rowNamespace: 'cortext',
      rowType: 'Memory',
      rowId: 'm1',
      text: '',
      now: expect.any(Date)
    });
    expect(lexical.delete).not.toHaveBeenCalled();
  });
});

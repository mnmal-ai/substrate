import { FakeEmbedder } from '@mnmal-ai/substrate-embedder/fake';
import type { NamespaceDefinition } from '@mnmal-ai/substrate-types';
import { describe, expect, it } from 'vitest';
import { InMemoryEmbeddingsStore } from '../src/in-memory-embeddings-store.js';
import { createRecallPlugin } from '../src/plugin.js';

/**
 * Hand-crafted NamespaceDefinition shapes — avoids pulling in substrate-sdk as a
 * dev dep. NamespaceTypeDef has an index signature so extra slots pass through.
 */
function makeNs(
  namespace: string,
  types: NonNullable<NamespaceDefinition['types']>
): NamespaceDefinition {
  return {
    namespace,
    types,
    install: () => {}
  };
}

describe('createRecallPlugin: contributePostWrites', () => {
  it('contributes one hook per type with embed.source', () => {
    const ns = makeNs('claude', {
      Memory: {
        fields: { body: { kind: 'scalar', type: 'string' } },
        embed: { source: (row) => (row.body as string) ?? '' }
      },
      Todo: {
        fields: { title: { kind: 'scalar', type: 'string' } }
        // no embed
      }
    });
    const plugin = createRecallPlugin({
      embedder: new FakeEmbedder({ dimension: 8 }),
      store: new InMemoryEmbeddingsStore()
    });
    const contribs = plugin.contributePostWrites!(ns);
    expect(Object.keys(contribs)).toEqual(['Memory']);
    expect(typeof contribs.Memory).toBe('function');
  });

  it('returns empty when embedder is undefined (off mode)', () => {
    const ns = makeNs('claude', {
      Memory: {
        fields: { body: { kind: 'scalar', type: 'string' } },
        embed: { source: (row) => (row.body as string) ?? '' }
      }
    });
    const plugin = createRecallPlugin({ store: new InMemoryEmbeddingsStore() });
    const contribs = plugin.contributePostWrites!(ns);
    expect(contribs).toEqual({});
  });

  it('returns empty when no types declare embed.source', () => {
    const ns = makeNs('claude', {
      Todo: { fields: { title: { kind: 'scalar', type: 'string' } } }
    });
    const plugin = createRecallPlugin({
      embedder: new FakeEmbedder({ dimension: 8 }),
      store: new InMemoryEmbeddingsStore()
    });
    const contribs = plugin.contributePostWrites!(ns);
    expect(contribs).toEqual({});
  });

  it('returns empty when namespace has no types (hand-crafted / SDK bypass)', () => {
    const ns: NamespaceDefinition = { namespace: 'empty', install: () => {} };
    const plugin = createRecallPlugin({
      embedder: new FakeEmbedder({ dimension: 8 }),
      store: new InMemoryEmbeddingsStore()
    });
    const contribs = plugin.contributePostWrites!(ns);
    expect(contribs).toEqual({});
  });
});

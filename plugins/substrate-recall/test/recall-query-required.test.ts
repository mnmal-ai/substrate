/**
 * The HTTP route and the frame reject a missing or empty query before the
 * shared handler runs; the MCP tool does not. So the handler checks it for
 * every surface: a missing query used to throw a raw TypeError, and an empty
 * one reached the embedder, which (Ollama) answers "" with no vector at all.
 */

import { FakeEmbedder } from '@mnmal-ai/substrate-embedder/fake';
import { describe, expect, it, vi } from 'vitest';
import { InMemoryEmbeddingsStore } from '../src/in-memory-embeddings-store.js';
import { handleRecallRequest } from '../src/recall-route.js';

describe('handleRecallRequest requires a query', () => {
  for (const [label, query] of [
    ['missing', undefined],
    ['empty', ''],
    ['blank', '   ']
  ] as const) {
    it(`refuses a ${label} query with bad_request, before embedding`, async () => {
      const embedder = new FakeEmbedder({ dimension: 8 });
      const spy = vi.spyOn(embedder, 'embed');
      await expect(
        handleRecallRequest({ query, namespace: 'cortext', type: 'Memory' } as never, {
          embedder,
          store: new InMemoryEmbeddingsStore()
        })
      ).rejects.toMatchObject({ code: 'bad_request' });
      expect(spy).not.toHaveBeenCalled();
    });
  }
});

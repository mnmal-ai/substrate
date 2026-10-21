import { FakeEmbedder } from '@mnmal-ai/substrate-embedder/fake';
import { describe, expect, it, vi } from 'vitest';
import { embedAndStore } from '../src/embed-and-store.js';
import { createEmbedStats } from '../src/embed-stats.js';
import type {
  EmbeddingsStore,
  EmbeddingsStoreDeleteInput,
  EmbeddingsStoreUpsertInput
} from '../src/embeddings-store.js';
import { InMemoryEmbeddingsStore } from '../src/in-memory-embeddings-store.js';

/**
 * Spy `EmbeddingsStore` — captures every `upsert` and `delete` call.
 */
function makeStore(
  opts: { upsertImpl?: () => Promise<void>; deleteImpl?: () => Promise<void> } = {}
): {
  store: EmbeddingsStore;
  upserts: EmbeddingsStoreUpsertInput[];
  deletes: EmbeddingsStoreDeleteInput[];
} {
  const upserts: EmbeddingsStoreUpsertInput[] = [];
  const deletes: EmbeddingsStoreDeleteInput[] = [];
  const upsertImpl = opts.upsertImpl ?? (async () => undefined);
  const deleteImpl = opts.deleteImpl ?? (async () => undefined);
  const store: EmbeddingsStore = {
    txScopeId: 'test-store',
    delete: async (input) => {
      deletes.push(input);
      await deleteImpl();
    },
    upsert: async (input) => {
      upserts.push(input);
      await upsertImpl();
    },
    knnSearch: async () => [],
    boostSalience: async () => [],
    fetchEmbeddings: async () => [],
    selectCandidates: async () => []
  };
  return { store, upserts, deletes };
}

describe('embedAndStore', () => {
  describe('serializeRow option', () => {
    it('uses serializeRow to build source text', async () => {
      const embedder = new FakeEmbedder({ dimension: 4 });
      const spy = vi.spyOn(embedder, 'embed');
      const { store } = makeStore();
      await embedAndStore(
        { id: 'r1', topic: 'auth', choice: 'rotate', rationale: 'leak' },
        {
          namespace: 'claude',
          type: 'Decision',
          serializeRow: (r) =>
            `${typeof r.topic === 'string' ? r.topic : ''}\n\n${typeof r.choice === 'string' ? r.choice : ''}\n\n${typeof r.rationale === 'string' ? r.rationale : ''}`,
          embedder,
          store
        }
      );
      expect(spy).toHaveBeenCalledWith('auth\n\nrotate\n\nleak');
    });

    it('serializeRow can implement synopsis-preference fallback', async () => {
      const embedder = new FakeEmbedder({ dimension: 4 });
      const spy = vi.spyOn(embedder, 'embed');
      const { store } = makeStore();
      // Replicates Memory's synopsis-preference logic
      const serializeRow = (r: Record<string, unknown>): string => {
        const str = (v: unknown) => (typeof v === 'string' ? v : '');
        return str(r.synopsis) || `${str(r.description)}\n\n${str(r.body)}`;
      };
      // With synopsis present — should use synopsis
      await embedAndStore(
        { id: 'm1', description: 'one-line hook', body: 'full content', synopsis: 'tight hook' },
        { namespace: 'claude', type: 'Memory', serializeRow, embedder, store }
      );
      expect(spy).toHaveBeenCalledWith('tight hook');
      // With synopsis absent — should fall back to description+body
      spy.mockClear();
      await embedAndStore(
        { id: 'm2', description: 'one-line hook', body: 'full content', synopsis: '' },
        { namespace: 'claude', type: 'Memory', serializeRow, embedder, store }
      );
      expect(spy).toHaveBeenCalledWith('one-line hook\n\nfull content');
    });

    it('passes empty string through when serializeRow returns empty (no skip)', async () => {
      const embedder = new FakeEmbedder({ dimension: 4 });
      const spy = vi.spyOn(embedder, 'embed');
      const { store } = makeStore();
      await embedAndStore(
        { id: 'a1' },
        {
          namespace: 'claude',
          type: 'AnchorIntent',
          serializeRow: (r) => (typeof r.text === 'string' ? r.text : ''),
          embedder,
          store
        }
      );
      // embed is called even on empty text
      expect(spy).toHaveBeenCalledWith('');
    });
  });

  describe('un-indexable rows (null sentinel)', () => {
    const skipRow = { id: 'r1', recallVisible: false, synopsis: 'mirror text' };
    const skipSource = (r: Record<string, unknown>): string | null =>
      r.recallVisible === false ? null : (r.synopsis as string);

    it('does not embed or upsert when serializeRow returns null', async () => {
      const embedder = new FakeEmbedder({ dimension: 4 });
      const spy = vi.spyOn(embedder, 'embed');
      const { store, upserts } = makeStore();
      await embedAndStore(skipRow, {
        namespace: 'labs',
        type: 'Trace',
        serializeRow: skipSource,
        embedder,
        store
      });
      expect(spy).not.toHaveBeenCalled();
      expect(upserts).toHaveLength(0);
    });

    it('deletes any existing embedding so a row that flips stops being recallable', async () => {
      const embedder = new FakeEmbedder({ dimension: 4 });
      const { store, deletes } = makeStore();
      await embedAndStore(skipRow, {
        namespace: 'labs',
        type: 'Trace',
        serializeRow: skipSource,
        embedder,
        store
      });
      expect(deletes).toEqual([{ rowNamespace: 'labs', rowType: 'Trace', rowId: 'r1' }]);
    });

    it('treats undefined the same as null', async () => {
      const embedder = new FakeEmbedder({ dimension: 4 });
      const spy = vi.spyOn(embedder, 'embed');
      const { store, upserts, deletes } = makeStore();
      await embedAndStore(skipRow, {
        namespace: 'labs',
        type: 'Trace',
        serializeRow: () => undefined,
        embedder,
        store
      });
      expect(spy).not.toHaveBeenCalled();
      expect(upserts).toHaveLength(0);
      expect(deletes).toHaveLength(1);
    });

    it('awaits an async serializeRow that resolves to the sentinel', async () => {
      const embedder = new FakeEmbedder({ dimension: 4 });
      const spy = vi.spyOn(embedder, 'embed');
      const { store, deletes } = makeStore();
      await embedAndStore(skipRow, {
        namespace: 'labs',
        type: 'Trace',
        serializeRow: async () => null,
        embedder,
        store
      });
      expect(spy).not.toHaveBeenCalled();
      expect(deletes).toHaveLength(1);
    });

    it('records a skip — not a success or a failure', async () => {
      const embedder = new FakeEmbedder({ dimension: 4 });
      const { store } = makeStore();
      const stats = createEmbedStats();
      await embedAndStore(skipRow, {
        namespace: 'labs',
        type: 'Trace',
        serializeRow: skipSource,
        embedder,
        store,
        stats
      });
      expect(stats.snapshot().skips).toBe(1);
      expect(stats.snapshot().successes).toBe(0);
      expect(stats.snapshot().failures).toBe(0);
      expect(stats.snapshot().writes).toBe(1);
    });

    it('swallows store.delete errors + records failure to stats', async () => {
      const embedder = new FakeEmbedder({ dimension: 4 });
      const { store } = makeStore({
        deleteImpl: async () => {
          throw new Error('pg down');
        }
      });
      const stats = createEmbedStats();
      await expect(
        embedAndStore(skipRow, {
          namespace: 'labs',
          type: 'Trace',
          serializeRow: skipSource,
          embedder,
          store,
          stats
        })
      ).resolves.toBeUndefined();
      expect(stats.snapshot().failures).toBe(1);
      expect(stats.snapshot().skips).toBe(0);
    });

    it('embeds normally when the same source returns text', async () => {
      const embedder = new FakeEmbedder({ dimension: 4 });
      const spy = vi.spyOn(embedder, 'embed');
      const { store, upserts, deletes } = makeStore();
      await embedAndStore(
        { id: 'r2', recallVisible: true, synopsis: 'real content' },
        { namespace: 'labs', type: 'Trace', serializeRow: skipSource, embedder, store }
      );
      expect(spy).toHaveBeenCalledWith('real content');
      expect(upserts).toHaveLength(1);
      expect(deletes).toHaveLength(0);
    });

    it("does NOT treat '' as the sentinel — empty source still embeds and upserts", async () => {
      const embedder = new FakeEmbedder({ dimension: 4 });
      const spy = vi.spyOn(embedder, 'embed');
      const { store, upserts, deletes } = makeStore();
      await embedAndStore(
        { id: 'a1' },
        { namespace: 'claude', type: 'AnchorIntent', serializeRow: () => '', embedder, store }
      );
      expect(spy).toHaveBeenCalledWith('');
      expect(upserts).toHaveLength(1);
      expect(deletes).toHaveLength(0);
    });
  });

  describe('fields option', () => {
    it('joins non-empty string field values with newline', async () => {
      const embedder = new FakeEmbedder({ dimension: 4 });
      const spy = vi.spyOn(embedder, 'embed');
      const { store } = makeStore();
      await embedAndStore(
        { id: 'r1', a: 'foo', b: 'bar', c: 'baz' },
        { namespace: 'ns', type: 'T', fields: ['a', 'b', 'c'], embedder, store }
      );
      expect(spy).toHaveBeenCalledWith('foo\nbar\nbaz');
    });

    it('filters out non-string and empty field values', async () => {
      const embedder = new FakeEmbedder({ dimension: 4 });
      const spy = vi.spyOn(embedder, 'embed');
      const { store } = makeStore();
      await embedAndStore(
        { id: 'r1', a: 'foo', b: 42, c: '', d: 'bar' },
        { namespace: 'ns', type: 'T', fields: ['a', 'b', 'c', 'd'], embedder, store }
      );
      expect(spy).toHaveBeenCalledWith('foo\nbar');
    });

    it('produces empty string when all fields missing', async () => {
      const embedder = new FakeEmbedder({ dimension: 4 });
      const spy = vi.spyOn(embedder, 'embed');
      const { store } = makeStore();
      await embedAndStore(
        { id: 'r1' },
        { namespace: 'ns', type: 'T', fields: ['a', 'b'], embedder, store }
      );
      // empty string — embed is still called (no empty-skip in the generic primitive)
      expect(spy).toHaveBeenCalledWith('');
    });
  });

  describe('store.upsert call shape', () => {
    it('upserts with correct rowNamespace, rowType, rowId, model', async () => {
      const embedder = new FakeEmbedder({ dimension: 4 });
      const { store, upserts } = makeStore();
      await embedAndStore(
        { id: 'a1', text: 'intent text' },
        {
          namespace: 'claude',
          type: 'AnchorIntent',
          serializeRow: (r) => (typeof r.text === 'string' ? r.text : ''),
          embedder,
          store
        }
      );
      expect(upserts).toHaveLength(1);
      expect(upserts[0]?.rowType).toBe('AnchorIntent');
      expect(upserts[0]?.rowId).toBe('a1');
      expect(upserts[0]?.rowNamespace).toBe('claude');
      expect(upserts[0]?.model).toBe(embedder.modelId);
    });
  });

  describe('shared behaviour', () => {
    it('swallows embedder errors (no throw) + records failure to stats', async () => {
      const embedder = {
        modelId: 'fake:v1:4',
        dimension: 4,
        embed: vi.fn().mockRejectedValue(new Error('ollama down'))
      };
      const { store, upserts } = makeStore();
      const stats = createEmbedStats();
      await expect(
        embedAndStore(
          { id: 'r1', topic: 't', choice: 'c', rationale: 'r' },
          {
            namespace: 'claude',
            type: 'Decision',
            serializeRow: (r) => `${typeof r.topic === 'string' ? r.topic : ''}`,
            embedder,
            store,
            stats
          }
        )
      ).resolves.toBeUndefined();
      expect(upserts).toHaveLength(0);
      expect(stats.snapshot().failures).toBe(1);
      expect(stats.snapshot().lastFailure?.error).toBe('ollama down');
    });

    it('swallows store.upsert errors (no throw) + records failure to stats', async () => {
      const embedder = new FakeEmbedder({ dimension: 4 });
      const { store } = makeStore({
        upsertImpl: async () => {
          throw new Error('pg down');
        }
      });
      const stats = createEmbedStats();
      await expect(
        embedAndStore(
          { id: 'r1', topic: 't' },
          {
            namespace: 'claude',
            type: 'Decision',
            serializeRow: (r) => (typeof r.topic === 'string' ? r.topic : ''),
            embedder,
            store,
            stats
          }
        )
      ).resolves.toBeUndefined();
      expect(stats.snapshot().failures).toBe(1);
    });

    it('records success to stats on happy path', async () => {
      const embedder = new FakeEmbedder({ dimension: 4 });
      const { store } = makeStore();
      const stats = createEmbedStats();
      await embedAndStore(
        { id: 'r1', topic: 't' },
        {
          namespace: 'claude',
          type: 'Decision',
          serializeRow: (r) => (typeof r.topic === 'string' ? r.topic : ''),
          embedder,
          store,
          stats
        }
      );
      expect(stats.snapshot().successes).toBe(1);
      expect(stats.snapshot().failures).toBe(0);
    });

    it('skips when row is missing id', async () => {
      const embedder = new FakeEmbedder({ dimension: 4 });
      const spy = vi.spyOn(embedder, 'embed');
      const { store, upserts } = makeStore();
      await embedAndStore(
        { topic: 't', choice: 'c' },
        {
          namespace: 'claude',
          type: 'Decision',
          serializeRow: (r) => (typeof r.topic === 'string' ? r.topic : ''),
          embedder,
          store
        }
      );
      expect(spy).not.toHaveBeenCalled();
      expect(upserts).toHaveLength(0);
    });
  });
});

describe('embedAndStore — ids and write ordering', () => {
  it('embeds a row with a numeric id under its string form', async () => {
    const { store, upserts } = makeStore();
    await embedAndStore(
      { id: 42, title: 'x' },
      {
        namespace: 'app',
        type: 'Doc',
        fields: ['title'],
        embedder: new FakeEmbedder({ dimension: 4 }),
        store
      }
    );
    expect(upserts.map((u) => u.rowId)).toEqual(['42']);
  });

  it('keeps the later write when an earlier embed finishes last', async () => {
    const store = new InMemoryEmbeddingsStore();
    const release: Array<() => void> = [];
    const embedder = {
      modelId: 'slow:2',
      dimension: 2,
      embed: (text: string) =>
        new Promise<Float32Array>((resolve) => {
          release.push(() => resolve(new Float32Array(text === 'old' ? [1, 0] : [0, 1])));
        })
    };
    const opts = { namespace: 'app', type: 'Doc', fields: ['title'], embedder, store };
    const first = embedAndStore({ id: 'd1', title: 'old' }, opts);
    await new Promise((r) => setTimeout(r, 5));
    const second = embedAndStore({ id: 'd1', title: 'new' }, opts);
    await new Promise((r) => setTimeout(r, 0));
    release[1]?.();
    await second;
    release[0]?.();
    await first;
    const [hit] = await store.fetchEmbeddings(
      [{ namespace: 'app', type: 'Doc', id: 'd1' }],
      'slow:2'
    );
    expect(Array.from(hit?.vector ?? [])).toEqual([0, 1]);
  });
});

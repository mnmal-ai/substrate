/**
 * Admin re-embed route + core.
 *
 * THE CLAIM UNDER TEST: a backfill must produce the SAME vector the write path
 * would for the same row. A hand-copied `embed.source` that drifted would write
 * a different geometry into the same index and degrade recall without anything
 * failing. `re-embeds to the byte-identical vector the write path produces` is
 * that claim stated as a test.
 *
 * The rest guard the ways a green run could be a lie: a page that swallows its
 * failures, an unwired dependency reported as an empty corpus, and a route
 * whose gate is declared but not the one that is enforced.
 */

import { EmbedError } from '@mnmal-ai/substrate-embedder';
import { FakeEmbedder } from '@mnmal-ai/substrate-embedder/fake';
import type { Dataset, NamespaceDefinition, Row } from '@mnmal-ai/substrate-types';
import { describe, expect, it } from 'vitest';
import { makeEmbedPostWrite, makeReembed } from '../src/embed-and-store.js';
import { EmbedSourceRegistry } from '../src/embed-source-registry.js';
import { InMemoryEmbeddingsStore } from '../src/in-memory-embeddings-store.js';
import { createRecallPlugin } from '../src/plugin.js';
import { handleReindex, REINDEX_MAX_LIMIT, validateReindexInput } from '../src/reindex-core.js';
import { reindexRouteHandler } from '../src/reindex-route.js';

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

const binding = (store: InMemoryEmbeddingsStore, embedder: FakeEmbedder) => ({
  namespace: 'cortext',
  type: 'Memory',
  source: (r: Row) => String(r.synopsis ?? ''),
  embedder,
  store
});

function registryWith(entry: Partial<Parameters<EmbedSourceRegistry['add']>[0]> = {}) {
  const reg = new EmbedSourceRegistry();
  reg.add({ namespace: 'cortext', type: 'Memory', hook: noopHook, ...entry });
  return reg;
}

describe('re-embed agrees with the write path', () => {
  it('re-embeds to the byte-identical vector the write path produces', async () => {
    // Both paths are driven for the same row, into two separate stores, and
    // the stored vectors compared element-by-element. If a future change gives
    // the backfill its own serialisation, this is what breaks.
    const embedder = new FakeEmbedder({ dimension: 16 });
    const writeStore = new InMemoryEmbeddingsStore();
    const reindexStore = new InMemoryEmbeddingsStore();
    const row = { id: 'm1', synopsis: 'the shape of the claim' } as Row;

    await makeEmbedPostWrite(binding(writeStore, embedder))(row, {} as never);

    const reg = registryWith({ reembed: makeReembed(binding(reindexStore, embedder)) });
    const res = await handleReindex(
      { namespace: 'cortext', type: 'Memory' },
      { registry: reg, resolveDataset: () => pagedDataset([row]) }
    );
    expect(res.embedded).toBe(1);

    const model = embedder.modelId;
    const ref = [{ namespace: 'cortext', type: 'Memory', id: 'm1' }];
    const [fromWrite] = await writeStore.fetchEmbeddings(ref, model);
    const [fromReindex] = await reindexStore.fetchEmbeddings(ref, model);
    expect(fromWrite).toBeDefined();
    expect(Array.from(fromReindex!.vector)).toEqual(Array.from(fromWrite!.vector));
  });

  it('removes the vector of a row whose source has become un-indexable', async () => {
    // The null sentinel is policy, not an error: a row that flipped to
    // un-indexable after being written must lose the vector it already has,
    // or it stays recallable forever.
    const embedder = new FakeEmbedder({ dimension: 16 });
    const store = new InMemoryEmbeddingsStore();
    await store.upsert({
      rowNamespace: 'cortext',
      rowType: 'Memory',
      rowId: 'm1',
      vector: await embedder.embed('stale'),
      model: embedder.modelId
    });

    const reg = registryWith({
      reembed: makeReembed({ ...binding(store, embedder), source: () => null })
    });
    const res = await handleReindex(
      { namespace: 'cortext', type: 'Memory' },
      { registry: reg, resolveDataset: () => pagedDataset([{ id: 'm1' } as Row]) }
    );

    expect(res).toMatchObject({ scanned: 1, embedded: 0, unindexable: 1, failed: 0 });
    expect(
      await store.fetchEmbeddings(
        [{ namespace: 'cortext', type: 'Memory', id: 'm1' }],
        embedder.modelId
      )
    ).toEqual([]);
  });
});

describe('failures are reported, not swallowed', () => {
  it('names the failing row instead of counting it as embedded', async () => {
    // The write-path hook swallows by design — its mutation has already
    // committed. A backfill that inherited that posture would report a clean
    // run over rows it never embedded, which is worse than refusing outright
    // because the operator stops looking.
    const store = new InMemoryEmbeddingsStore();
    const exploding = {
      modelId: 'boom:v1',
      dimension: 16,
      embed: async (text: string) => {
        if (text === 'bad') throw new Error('embedder exploded');
        return new Float32Array(16);
      }
    };
    const reg = registryWith({
      reembed: makeReembed({
        ...binding(store, exploding as never),
        source: (r: Row) => String(r.synopsis ?? '')
      })
    });

    const res = await handleReindex(
      { namespace: 'cortext', type: 'Memory' },
      {
        registry: reg,
        resolveDataset: () =>
          pagedDataset([
            { id: 'ok-1', synopsis: 'fine' } as Row,
            { id: 'bad-1', synopsis: 'bad' } as Row
          ])
      }
    );

    expect(res).toMatchObject({ scanned: 2, embedded: 1, failed: 1 });
    expect(res.failures).toEqual([{ id: 'bad-1', error: 'embedder exploded' }]);
  });

  it('accounts for every row it scanned', async () => {
    // scanned === embedded + unindexable + failed. A page that drops an
    // outcome silently reports arithmetic that does not close, and nobody
    // checks subtraction on a green run.
    const embedder = new FakeEmbedder({ dimension: 16 });
    const store = new InMemoryEmbeddingsStore();
    const reg = registryWith({
      reembed: makeReembed({
        ...binding(store, embedder),
        source: (r: Row) => (r.id === 'm2' ? null : 'text')
      })
    });
    const rows = [{ id: 'm1' }, { id: 'm2' }, { id: 3 }, {}] as unknown as Row[];

    const res = await handleReindex(
      { namespace: 'cortext', type: 'Memory' },
      { registry: reg, resolveDataset: () => pagedDataset(rows) }
    );

    expect(res.scanned).toBe(4);
    expect(res.embedded).toBe(2);
    expect(res.embedded + res.unindexable + res.failed).toBe(res.scanned);
    // The id-less row is a failure, not an invisible skip.
    expect(res.failures).toEqual([{ id: '<no-id>', error: 'row has no string or number id' }]);
  });
});

describe('an unavailable dependency is not an empty corpus', () => {
  it('refuses when no dataset resolver is wired', async () => {
    // Reporting `scanned: 0` here would render absence of a dependency as
    // absence of work. The caller must be able to tell "nothing to do" from
    // "could not look".
    const reg = registryWith({ reembed: async () => ({ status: 'embedded' as const }) });
    await expect(
      handleReindex({ namespace: 'cortext', type: 'Memory' }, { registry: reg })
    ).rejects.toMatchObject({ code: 'unavailable' });
  });

  it('refuses an entry registered without a re-embed binding', async () => {
    const reg = registryWith(); // hook only — no reembed
    await expect(
      handleReindex(
        { namespace: 'cortext', type: 'Memory' },
        { registry: reg, resolveDataset: () => pagedDataset([]) }
      )
    ).rejects.toMatchObject({ code: 'unavailable' });
  });

  it('names the embedded types when asked for one that is not embedded', async () => {
    const reg = registryWith({ reembed: async () => ({ status: 'embedded' as const }) });
    await expect(
      handleReindex(
        { namespace: 'cortext', type: 'Todo' },
        { registry: reg, resolveDataset: () => pagedDataset([]) }
      )
    ).rejects.toMatchObject({ code: 'unknown_type', message: /cortext\/Memory/ });
  });
});

describe('paging', () => {
  it('walks the corpus across pages via the cursor', async () => {
    const embedder = new FakeEmbedder({ dimension: 16 });
    const store = new InMemoryEmbeddingsStore();
    const reg = registryWith({ reembed: makeReembed(binding(store, embedder)) });
    const rows = Array.from({ length: 5 }, (_, i) => ({ id: `m${i}`, synopsis: `s${i}` }) as Row);
    const deps = { registry: reg, resolveDataset: () => pagedDataset(rows) };

    const first = await handleReindex({ namespace: 'cortext', type: 'Memory', limit: 2 }, deps);
    expect(first).toMatchObject({ scanned: 2, embedded: 2, hasMore: true });
    expect(first.nextCursor).toBeDefined();

    let cursor = first.nextCursor;
    let total = first.embedded;
    let guard = 0;
    while (cursor !== undefined && guard++ < 10) {
      const page = await handleReindex(
        { namespace: 'cortext', type: 'Memory', limit: 2, cursor },
        deps
      );
      total += page.embedded;
      cursor = page.nextCursor;
    }
    expect(total).toBe(5);
  });
});

describe('input validation', () => {
  it('defaults the limit and caps it at the documented maximum', () => {
    expect(validateReindexInput({ namespace: 'a', type: 'B' }).limit).toBe(100);
    expect(() =>
      validateReindexInput({ namespace: 'a', type: 'B', limit: REINDEX_MAX_LIMIT + 1 })
    ).toThrow(/maximum/);
  });

  it('rejects a missing namespace or type', () => {
    expect(() => validateReindexInput({ type: 'B' })).toThrow(/namespace/);
    expect(() => validateReindexInput({ namespace: 'a' })).toThrow(/type/);
  });
});

describe('route', () => {
  const call = (body: unknown, deps: Parameters<typeof reindexRouteHandler>[0]) =>
    reindexRouteHandler(deps)({ body: Buffer.from(JSON.stringify(body)) } as never);

  it('maps an unknown type to 400 and an unwired dep to 503', async () => {
    const reg = registryWith({ reembed: async () => ({ status: 'embedded' as const }) });
    const withData = { registry: reg, resolveDataset: () => pagedDataset([]) };

    expect((await call({ namespace: 'cortext', type: 'Nope' }, withData)).status).toBe(400);
    expect((await call({ namespace: 'cortext', type: 'Memory' }, { registry: reg })).status).toBe(
      503
    );
    expect((await call({ namespace: 'cortext' }, withData)).status).toBe(400);
  });
});

/**
 * Composition. Everything above would pass unchanged if `createRecallPlugin`
 * never claimed the route or never populated `reembed`, so these assert
 * against the composed plugin rather than an invented shape.
 */
describe('createRecallPlugin wires it for real', () => {
  const embedded = (name: string) => ({
    fields: { synopsis: { kind: 'scalar' as const, type: 'string' as const } },
    embed: { source: (row: Record<string, unknown>) => `${name}:${String(row.synopsis ?? '')}` }
  });
  const makeNs = (namespace: string, types: NonNullable<NamespaceDefinition['types']>) => ({
    namespace,
    types,
    install: () => {}
  });

  const plugin = () =>
    createRecallPlugin({
      embedder: new FakeEmbedder({ dimension: 8 }),
      store: new InMemoryEmbeddingsStore(),
      resolveDataset: () => pagedDataset([{ id: 'm1', synopsis: 'hello' } as Row])
    });

  it('claims the route under the admin capability', () => {
    // `admin` is the ONLY capability compose enforces under mode:'attribute';
    // a `mutate` claim here would be waived and the route left open.
    const route = plugin().kernelRoutes?.find((r) => r.path === 'embed/reindex');
    expect(route).toBeDefined();
    expect(route?.capability).toBe('admin');
    expect(route?.method).toBe('POST');
  });

  it('re-embeds through the plugin using the namespace’s own embed.source', async () => {
    const p = plugin();
    p.contributePostWrites!(makeNs('cortext', { Memory: embedded('Memory') }));
    const route = p.kernelRoutes?.find((r) => r.path === 'embed/reindex');
    const res = (await route!.handler({
      body: Buffer.from(JSON.stringify({ namespace: 'cortext', type: 'Memory' }))
    } as never)) as { status: number; body: unknown };

    expect(res.status).toBe(200);
    expect(JSON.parse(String(res.body))).toMatchObject({ scanned: 1, embedded: 1, failed: 0 });
  });

  it('refuses a type the composed namespace does not embed', async () => {
    const p = plugin();
    p.contributePostWrites!(
      makeNs('cortext', {
        Memory: embedded('Memory'),
        Todo: { fields: { title: { kind: 'scalar', type: 'string' } } }
      })
    );
    const route = p.kernelRoutes?.find((r) => r.path === 'embed/reindex');
    const res = (await route!.handler({
      body: Buffer.from(JSON.stringify({ namespace: 'cortext', type: 'Todo' }))
    } as never)) as { status: number };
    expect(res.status).toBe(400);
  });
});

describe('an unavailable embedder stops the page', () => {
  function reindexWith(embed: (text: string) => Promise<Float32Array>) {
    const attempted: string[] = [];
    const embedder = {
      modelId: 'probe:v1:16',
      dimension: 16,
      embed: async (text: string) => {
        attempted.push(text);
        return embed(text);
      }
    };
    const reg = registryWith({
      reembed: makeReembed({
        ...binding(new InMemoryEmbeddingsStore(), embedder as never),
        source: (r: Row) => String(r.id)
      })
    });
    const run = handleReindex(
      { namespace: 'cortext', type: 'Memory' },
      {
        registry: reg,
        resolveDataset: () => pagedDataset([{ id: 'a' }, { id: 'b' }, { id: 'c' }] as Row[])
      }
    );
    return { run, attempted };
  }

  it('throws code unavailable on the first transport failure, without trying the rest', async () => {
    const { run, attempted } = reindexWith(async () => {
      throw new EmbedError('unavailable', 'OllamaEmbedder: timed out after 120000ms');
    });
    await expect(run).rejects.toMatchObject({ code: 'unavailable' });
    expect(attempted).toEqual(['a']);
  });

  it('keeps going past a per-row invalid_response', async () => {
    const { run, attempted } = reindexWith(async (text) => {
      if (text === 'a') throw new EmbedError('invalid_response', 'bad vector');
      return new Float32Array(16);
    });
    await expect(run).resolves.toMatchObject({ scanned: 3, embedded: 2, failed: 1 });
    expect(attempted).toEqual(['a', 'b', 'c']);
  });
});

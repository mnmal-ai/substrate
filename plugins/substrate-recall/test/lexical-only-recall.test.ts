/**
 * Recall with no embedder.
 *
 * The lexical arm needs no model: `lexical`'s `tsv` is GENERATED ALWAYS
 * and the write hook is wired outside the embedder gate, so a lexical-only
 * deployment indexes and must also be readable.
 *
 * The arm gate lives in the core, the one place all three surfaces pass
 * through; the surfaces only map its code to their transport.
 */

import { FakeEmbedder } from '@mnmal-ai/substrate-embedder/fake';
import type { Dataset } from '@mnmal-ai/substrate-types';
import { describe, expect, it } from 'vitest';
import type { EmbeddingsStore } from '../src/embeddings-store.js';
import { InMemoryLexicalStore } from '../src/in-memory-lexical-store.js';
import { createRecallPlugin } from '../src/plugin.js';
import { handleRecallRequest } from '../src/recall-route.js';

const NS = 'cortext';
const TYPE = 'Memory';

function denseStore(ids: string[]): EmbeddingsStore {
  return {
    txScopeId: 'test',
    upsert: async () => {},
    delete: async () => {},
    knnSearch: async () => ids.map((id, i) => ({ row: { id }, score: 1 - i * 0.1, salience: 0 })),
    boostSalience: async () => {}
  } as unknown as EmbeddingsStore;
}

async function seeded(text: Record<string, string>): Promise<InMemoryLexicalStore> {
  const store = new InMemoryLexicalStore({
    datasetFor: () =>
      ({
        read: async (_type: string, params: { id: string }) => ({ rows: [{ id: params.id }] })
      }) as unknown as Dataset
  });
  for (const [id, t] of Object.entries(text)) {
    await store.upsert({ rowNamespace: NS, rowType: TYPE, rowId: id, text: t });
  }
  return store;
}

const query = { query: 'Sweden', namespace: NS, type: TYPE, k: 5 };

describe('handleRecallRequest with no dense arm', () => {
  it('answers from the lexical arm alone', async () => {
    const res = await handleRecallRequest(query, {
      lexicalStore: await seeded({ holiday: 'we went to Sweden in July' })
    });
    expect(res.rows.map((r) => r.row.id)).toEqual(['holiday']);
    expect(res.arms).toEqual({
      dense: false,
      denseWhy: 'no-embedder',
      lexical: true,
      lexicalWhy: 'ran'
    });
  });

  /**
   * `model` NAMES THE DENSE ARM'S MODEL, and stays a required string reporting
   * the empty one when no dense arm ran.
   *
   * Not optional: `undefined` would read as "server predates the field", and
   * widening `string` to `string | undefined` would break every reader. Empty
   * says the server ran no model.
   */
  it('reports an empty model rather than dropping the field', async () => {
    const res = await handleRecallRequest(query, {
      lexicalStore: await seeded({ holiday: 'Sweden' })
    });
    expect(res.model).toBe('');
  });

  /** No embed and no knn happened; the timings say zero rather than inventing one. */
  it('reports zero embed and knn time', async () => {
    const res = await handleRecallRequest(query, {
      lexicalStore: await seeded({ holiday: 'Sweden' })
    });
    expect(res.timings.embed_ms).toBe(0);
    expect(res.timings.knn_ms).toBe(0);
  });

  /**
   * A deployment with neither arm and a caller who switched the only arm off
   * are DIFFERENT FAULTS WITH DIFFERENT FIXES — wire an arm, versus drop a
   * request flag. Same discipline as `lexicalWhy` itself: two ways of getting
   * nothing must not share a rendering.
   */
  it('refuses with embedder_unavailable when nothing is wired', async () => {
    await expect(handleRecallRequest(query, {})).rejects.toMatchObject({
      code: 'embedder_unavailable'
    });
  });

  it('refuses with no_retrieval_arm when the caller disabled the only arm', async () => {
    await expect(
      handleRecallRequest(
        { ...query, lexical: false },
        { lexicalStore: await seeded({ holiday: 'Sweden' }) }
      )
    ).rejects.toMatchObject({ code: 'no_retrieval_arm' });
  });

  /**
   * The refusal is GENERATED from the same two facts the `arms` envelope
   * reports, so the message and the envelope cannot disagree about why an arm
   * did not run.
   */
  it('names both arms and why each is off', async () => {
    const err = await handleRecallRequest(
      { ...query, lexical: false },
      { lexicalStore: await seeded({ holiday: 'Sweden' }) }
    ).then(
      () => null,
      (e: unknown) => e as Error
    );
    expect(err?.message).toContain('dense');
    expect(err?.message).toContain('lexical');
    expect(err?.message).toContain('disabled-by-request');
  });

  /** A half-wired dense arm is no dense arm: knn needs both halves. */
  it('treats an embedder with no store as no dense arm', async () => {
    const res = await handleRecallRequest(query, {
      embedder: new FakeEmbedder({ dimension: 8 }),
      lexicalStore: await seeded({ holiday: 'Sweden' })
    });
    expect(res.arms?.dense).toBe(false);
    expect(res.rows.map((r) => r.row.id)).toEqual(['holiday']);
  });

  /** Boosting is a write against the embeddings store; with none there is nothing to boost. */
  it('does not attempt a salience boost with no store', async () => {
    const res = await handleRecallRequest(
      { ...query, boost: true },
      { lexicalStore: await seeded({ holiday: 'Sweden' }) }
    );
    expect(res.rows).toHaveLength(1);
  });

  /**
   * The order is load-bearing: the arm check runs before namespace
   * resolution, so a server with nothing to search with says so rather than
   * sending the caller to fix a parameter that would change nothing. `SUBSTRATE_NAMESPACE`
   * is cleared because a set one would hide a wrong order.
   */
  it('refuses on the missing arm before the missing namespace', async () => {
    const saved = process.env.SUBSTRATE_NAMESPACE;
    delete process.env.SUBSTRATE_NAMESPACE;
    try {
      await expect(handleRecallRequest({ query: 'Sweden' }, {})).rejects.toMatchObject({
        code: 'embedder_unavailable'
      });
    } finally {
      if (saved !== undefined) process.env.SUBSTRATE_NAMESPACE = saved;
    }
  });

  it('still runs both arms when the dense arm is wired', async () => {
    const res = await handleRecallRequest(query, {
      embedder: new FakeEmbedder({ dimension: 8 }),
      store: denseStore(['warship']),
      lexicalStore: await seeded({ holiday: 'Sweden' })
    });
    expect(res.arms).toEqual({ dense: true, denseWhy: 'ran', lexical: true, lexicalWhy: 'ran' });
    expect(res.model).not.toBe('');
  });
});

/**
 * Every surface, since each reaches recall independently and a consumer may
 * use any one of them.
 */
describe('every recall surface serves a lexical-only deployment', () => {
  const req = (body: unknown) => ({
    method: 'POST' as const,
    path: '/substrate/v1/recall',
    headers: {},
    query: {},
    params: {},
    body: Buffer.from(JSON.stringify(body))
  });

  async function lexicalOnlyPlugin() {
    return createRecallPlugin({
      store: denseStore([]),
      lexicalStore: await seeded({ holiday: 'we went to Sweden in July' })
    });
  }

  it('serves it over the HTTP route', async () => {
    const plugin = await lexicalOnlyPlugin();
    const route = plugin.kernelRoutes?.find((r) => r.path === 'recall');
    const res = await Promise.resolve(route!.handler(req(query)));
    expect(res.status).toBe(200);
    const body = JSON.parse(String(res.body)) as {
      arms?: { dense?: boolean; lexical?: boolean };
      rows: Array<{ row: { id?: string } }>;
    };
    expect(body.arms).toEqual({
      dense: false,
      denseWhy: 'no-embedder',
      lexical: true,
      lexicalWhy: 'ran'
    });
    expect(body.rows.map((r) => r.row.id)).toEqual(['holiday']);
  });

  it('serves it through the recall/Hit frame', async () => {
    const plugin = await lexicalOnlyPlugin();
    const resolver = plugin.kernelNamespace?.types?.Hit?.resolver;
    const rows = (await resolver!(
      { identity: null } as never,
      {
        params: { to: 'Sweden', namespace: NS, type: TYPE, k: 5 },
        fields: undefined
      } as never
    )) as Array<{ id?: string }>;
    expect(rows.map((r) => r.id)).toEqual(['holiday']);
  });

  it('serves it through the MCP tool', async () => {
    const plugin = await lexicalOnlyPlugin();
    const tool = plugin.mcpTools?.find((t) => t.name === 'recall');
    const out = (await tool!.handler(query)) as {
      arms?: { dense?: boolean };
      rows?: Array<{ row: { id?: string } }>;
    };
    expect(out.arms?.dense).toBe(false);
    expect(out.rows?.map((r) => r.row.id)).toEqual(['holiday']);
  });

  /**
   * With NOTHING wired the surfaces must still refuse — and each maps the
   * core's code to its own transport's shape.
   */
  it('still refuses over HTTP when no arm is wired', async () => {
    const plugin = createRecallPlugin({ store: denseStore([]) });
    const route = plugin.kernelRoutes?.find((r) => r.path === 'recall');
    const res = await Promise.resolve(route!.handler(req(query)));
    expect(res.status).toBe(503);
    expect(String(res.body)).toContain('embedder_unavailable');
  });

  it('still refuses over MCP when no arm is wired', async () => {
    const plugin = createRecallPlugin({ store: denseStore([]) });
    const tool = plugin.mcpTools?.find((t) => t.name === 'recall');
    const out = (await tool!.handler(query)) as { error?: { code?: string } };
    expect(out.error?.code).toBe('embedder_unavailable');
  });
});

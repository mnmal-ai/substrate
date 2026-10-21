/**
 * The dense arm on a type that declares no `embed.source` must not run and
 * must report itself off, so "this type is never embedded" is distinguishable
 * from "nothing matched". Mirrors `lexical-fusion.test.ts`'s `no-source`
 * cases. The sharp assertion is that the arm STOPS: `denseStore` below
 * returns rows unconditionally, so a dense arm that still runs produces rows.
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

/** Dense arm that returns rows unconditionally — so a skipped arm is visible. */
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

/** A registry that knows about something, but not the queried type. */
const declaresOtherTypes = { get: () => undefined, size: () => 1 };

const query = { query: 'Sweden', namespace: NS, type: TYPE, k: 5 };

describe('handleRecallRequest on a type with no embed.source', () => {
  it('reports no-source and does not run a knn that cannot match', async () => {
    const res = await handleRecallRequest(query, {
      embedder: new FakeEmbedder({ dimension: 8 }),
      store: denseStore(['warship', 'vikings']),
      embedSources: declaresOtherTypes
    });

    expect(res.arms).toEqual({
      dense: false,
      denseWhy: 'no-source',
      lexical: false,
      lexicalWhy: 'no-store'
    });
    // The store would have returned two rows. The arm did not ask it.
    expect(res.rows).toEqual([]);
  });

  /**
   * `model` names the DENSE arm's model and is empty when no dense arm ran;
   * naming one would read as though that model searched and found nothing.
   */
  it('reports an empty model and zero dense timings', async () => {
    const res = await handleRecallRequest(query, {
      embedder: new FakeEmbedder({ dimension: 8 }),
      store: denseStore(['warship']),
      embedSources: declaresOtherTypes
    });

    expect(res.model).toBe('');
    expect(res.timings.embed_ms).toBe(0);
    expect(res.timings.knn_ms).toBe(0);
  });

  /**
   * An absent or EMPTY registry is not authoritative: `createRecallPlugin`
   * fills it at `contributePostWrites` time, so it is empty until namespaces
   * register. Treating either as "nothing embedded" would disable the dense
   * arm everywhere.
   */
  it('runs the arm when no registry is wired', async () => {
    const res = await handleRecallRequest(query, {
      embedder: new FakeEmbedder({ dimension: 8 }),
      store: denseStore(['warship'])
    });

    expect(res.arms?.denseWhy).toBe('ran');
    expect(res.rows.map((r) => r.row.id)).toEqual(['warship']);
  });

  it('runs the arm when the registry is wired but not yet populated', async () => {
    const res = await handleRecallRequest(query, {
      embedder: new FakeEmbedder({ dimension: 8 }),
      store: denseStore(['warship']),
      embedSources: { get: () => undefined, size: () => 0 }
    });

    expect(res.arms?.denseWhy).toBe('ran');
    expect(res.rows.map((r) => r.row.id)).toEqual(['warship']);
  });

  it('runs the arm for a type the registry does declare', async () => {
    const res = await handleRecallRequest(query, {
      embedder: new FakeEmbedder({ dimension: 8 }),
      store: denseStore(['warship']),
      embedSources: { get: () => ({ namespace: NS, type: TYPE }), size: () => 1 }
    });

    expect(res.arms).toEqual({
      dense: true,
      denseWhy: 'ran',
      lexical: false,
      lexicalWhy: 'no-store'
    });
  });

  /**
   * A DEPLOYMENT fault outranks a type's declaration. An operator with no
   * embedder wired needs to hear that first: `no-source` would send them to
   * edit a namespace definition that would change nothing until a model
   * exists.
   */
  it('names the deployment fault ahead of the declaration', async () => {
    const res = await handleRecallRequest(query, {
      lexicalStore: await seeded({ holiday: 'we went to Sweden in July' }),
      embedSources: declaresOtherTypes
    });

    expect(res.arms?.denseWhy).toBe('no-embedder');
  });

  /**
   * DEGRADATION, NOT BLACKOUT. A type carrying a `lexical.source` and no
   * `embed.source` is a normal shape — the lexical arm indexes without a
   * model — so stopping the dense arm must not stop the answer.
   */
  it('still answers from the lexical arm', async () => {
    const res = await handleRecallRequest(query, {
      embedder: new FakeEmbedder({ dimension: 8 }),
      store: denseStore(['warship']),
      lexicalStore: await seeded({ holiday: 'we went to Sweden in July' }),
      embedSources: declaresOtherTypes
    });

    expect(res.arms).toEqual({
      dense: false,
      denseWhy: 'no-source',
      lexical: true,
      lexicalWhy: 'ran'
    });
    expect(res.rows.map((r) => r.row.id)).toEqual(['holiday']);
    // `warship` is what the dense store would have contributed.
    expect(res.rows.map((r) => r.row.id)).not.toContain('warship');
  });
});

/**
 * Each recall surface hand-copies a subset of `recallCoreDeps` into the core,
 * so a dep can reach none of them. A dropped registry yields `dense: true`;
 * these assert the no-source case that a dropped dep gets wrong.
 */
describe('the no-source verdict reaches every recall surface', () => {
  const fakeReq = (body: unknown) => ({
    method: 'POST' as const,
    path: '/substrate/v1/recall',
    headers: {},
    query: {},
    params: {},
    body: Buffer.from(JSON.stringify(body))
  });

  /** Populate the registry the way the host does, then ask for another type. */
  async function pluginWithEmbeddedType() {
    const plugin = await createRecallPlugin({
      embedder: new FakeEmbedder({ dimension: 8 }),
      store: denseStore(['warship'])
    });
    plugin.contributePostWrites?.({
      namespace: NS,
      types: {
        [TYPE]: { embed: { source: (row: Record<string, unknown>) => String(row.body ?? '') } }
      }
    } as never);
    return plugin;
  }

  it('reports no-source through the HTTP route', async () => {
    const plugin = await pluginWithEmbeddedType();
    const route = plugin.kernelRoutes?.find((r) => r.path === 'recall');

    const res = await Promise.resolve(
      route!.handler(fakeReq({ query: 'Sweden', namespace: NS, type: 'Undeclared', k: 5 }))
    );
    const body = JSON.parse(String(res.body)) as {
      rows?: unknown[];
      arms?: { dense?: boolean; denseWhy?: string };
    };

    expect(body.arms?.denseWhy).toBe('no-source');
    expect(body.arms?.dense).toBe(false);
    expect(body.rows).toEqual([]);
  });

  it('reports no-source through the MCP tool', async () => {
    const plugin = await pluginWithEmbeddedType();
    const tool = plugin.mcpTools?.find((t) => t.name === 'recall');

    const out = (await tool!.handler({
      query: 'Sweden',
      namespace: NS,
      type: 'Undeclared',
      k: 5
    })) as { rows?: unknown[]; arms?: { denseWhy?: string } };

    expect(out.arms?.denseWhy).toBe('no-source');
    expect(out.rows).toEqual([]);
  });

  /**
   * The frame asserts on ROWS because it returns no `arms` envelope:
   * `hitResolver` maps `out.rows` and drops everything around it.
   */
  it('stops the arm through the frame surface', async () => {
    const plugin = await pluginWithEmbeddedType();
    const resolver = plugin.kernelNamespace?.types?.Hit?.resolver;

    const rows = (await resolver!(
      { identity: null } as never,
      {
        params: { to: 'Sweden', namespace: NS, type: 'Undeclared', k: 5 },
        fields: undefined
      } as never
    )) as Array<{ id?: unknown }>;

    expect(rows).toEqual([]);
  });

  it('runs the dense arm through the route for the declared type', async () => {
    const plugin = await pluginWithEmbeddedType();
    const route = plugin.kernelRoutes?.find((r) => r.path === 'recall');

    const res = await Promise.resolve(
      route!.handler(fakeReq({ query: 'Sweden', namespace: NS, type: TYPE, k: 5 }))
    );
    const body = JSON.parse(String(res.body)) as { arms?: { denseWhy?: string } };

    expect(body.arms?.denseWhy).toBe('ran');
  });
});

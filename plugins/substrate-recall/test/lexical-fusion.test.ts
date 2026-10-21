/**
 * The lexical arm inside `/substrate/v1/recall`.
 *
 * These go through `handleRecallRequest` rather than `fuseByRank` directly.
 * The fusion maths is pinned in rrf.test.ts; what is pinned here is that the
 * arm is REACHED.
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

/** Dense arm that returns exactly the rows it is told to, in order. */
function denseStore(ids: string[]): EmbeddingsStore {
  return {
    txScopeId: 'test',
    upsert: async () => {},
    delete: async () => {},
    knnSearch: async () => ids.map((id, i) => ({ row: { id }, score: 1 - i * 0.1, salience: 0 })),
    boostSalience: async () => {}
  } as unknown as EmbeddingsStore;
}

/**
 * Seeded lexical store WITH a row resolver, mirroring how the host wires one
 * (`apps/substrate/src/main.ts` passes `datasetFor` from the dataset registry).
 *
 * Without it the in-memory store returns `row: {}` by design (the
 * no-resolver mode), so hits would carry no id.
 */
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

describe('recall with the lexical arm', () => {
  /**
   * THE CASE THE ARM EXISTS FOR. `holiday` is invisible to the dense arm —
   * its handle never mentioned Sweden — and must still reach the result set.
   * An intersection would make the arm a re-ranker and this row would stay
   * lost.
   */
  it('surfaces a row the dense arm never returned', async () => {
    const res = await handleRecallRequest(
      { query: 'Sweden', namespace: NS, type: TYPE, k: 5 },
      {
        embedder: new FakeEmbedder({ dimension: 8 }),
        store: denseStore(['warship', 'vikings']),
        lexicalStore: await seeded({ holiday: 'we went to Sweden in July' })
      }
    );
    expect(res.rows.map((r) => r.row.id)).toContain('holiday');
    expect(res.arms).toEqual({ dense: true, denseWhy: 'ran', lexical: true, lexicalWhy: 'ran' });
  });

  /**
   * Negative control. Off by request must be distinguishable from contributing nothing — which is the whole reason the
   * envelope reports the EFFECTIVE mode rather than echoing the request.
   */
  it('honours lexical:false and says so in the envelope', async () => {
    const deps = {
      embedder: new FakeEmbedder({ dimension: 8 }),
      store: denseStore(['warship']),
      lexicalStore: await seeded({ holiday: 'we went to Sweden in July' })
    };
    const off = await handleRecallRequest(
      { query: 'Sweden', namespace: NS, type: TYPE, k: 5, lexical: false },
      deps
    );
    expect(off.rows.map((r) => r.row.id)).toEqual(['warship']);
    expect(off.arms).toEqual({
      dense: true,
      denseWhy: 'ran',
      lexical: false,
      lexicalWhy: 'disabled-by-request'
    });
  });

  /**
   * A deployment with no store must be distinguishable from one where the
   * caller switched the arm off. Same two-empty-answers discipline as
   * `lexicalEnabled`: these need different fixes, so they cannot share a
   * rendering.
   */
  it('reports no-store rather than pretending the arm was declined', async () => {
    const res = await handleRecallRequest(
      { query: 'Sweden', namespace: NS, type: TYPE, k: 5 },
      { embedder: new FakeEmbedder({ dimension: 8 }), store: denseStore(['warship']) }
    );
    expect(res.arms).toEqual({
      dense: true,
      denseWhy: 'ran',
      lexical: false,
      lexicalWhy: 'no-store'
    });
    expect(res.rows.map((r) => r.row.id)).toEqual(['warship']);
  });

  /**
   * A fused score cannot say WHICH arm put a row where it is. `explain`
   * returns the working: per-arm ranks, `null` for an arm that did not return
   * the row, plus the pre-fusion dense score.
   */
  it('returns per-arm ranks under explain, with null for a silent arm', async () => {
    const res = await handleRecallRequest(
      { query: 'Sweden', namespace: NS, type: TYPE, k: 5, explain: true },
      {
        embedder: new FakeEmbedder({ dimension: 8 }),
        store: denseStore(['warship']),
        lexicalStore: await seeded({ holiday: 'we went to Sweden in July' })
      }
    );
    const holiday = res.rows.find((r) => r.row.id === 'holiday');
    const warship = res.rows.find((r) => r.row.id === 'warship');
    expect(holiday?._arms).toEqual({ dense: null, lexical: 1 });
    expect(warship?._arms).toEqual({ dense: 1, lexical: null });
  });

  it('omits the diagnostics when explain is not asked for', async () => {
    const res = await handleRecallRequest(
      { query: 'Sweden', namespace: NS, type: TYPE, k: 5 },
      {
        embedder: new FakeEmbedder({ dimension: 8 }),
        store: denseStore(['warship']),
        lexicalStore: await seeded({ holiday: 'we went to Sweden in July' })
      }
    );
    expect(res.rows[0]).not.toHaveProperty('_arms');
  });

  /**
   * Agreement across arms beats confidence within one — the property that
   * makes fusion worth doing rather than concatenating.
   */
  it('ranks a row both arms found above one only the dense arm found', async () => {
    const res = await handleRecallRequest(
      { query: 'Sweden', namespace: NS, type: TYPE, k: 5 },
      {
        embedder: new FakeEmbedder({ dimension: 8 }),
        store: denseStore(['both', 'denseOnly']),
        lexicalStore: await seeded({ both: 'Sweden trip', lexOnly: 'Sweden again' })
      }
    );
    expect(res.rows[0]?.row.id).toBe('both');
  });
});

describe('the arm reaches every recall surface, not just the route', () => {
  const fakeReq = (body: unknown) => ({
    method: 'POST' as const,
    path: '/substrate/v1/recall',
    headers: {},
    query: {},
    params: {},
    body: Buffer.from(JSON.stringify(body))
  });

  async function pluginWithArm() {
    const plugin = await createRecallPlugin({
      embedder: new FakeEmbedder({ dimension: 8 }),
      store: denseStore(['warship']),
      lexicalStore: await seeded({ holiday: 'we went to Sweden in July' })
    });
    // Populate the registry the way the host does, via `contributePostWrites`.
    // An empty registry reads as "not yet populated", not "no type declares a
    // source", so without this the test cannot tell a threaded registry from a
    // dropped one.
    plugin.contributePostWrites?.({
      namespace: NS,
      types: {
        [TYPE]: { lexical: { source: (row: Record<string, unknown>) => String(row.body ?? '') } }
      }
    } as never);
    return plugin;
  }

  /**
   * Each surface (route, MCP tool, frame) hand-copies a subset of the shared
   * `recallCoreDeps` bag into `handleRecallRequest`, so a dep added to the bag
   * can reach none of them.
   *
   * Regression: `lexicalSources` must reach the core. `arms.lexical: true`
   * cannot tell (a dropped registry also yields it), so assert the case a
   * dropped dep gets wrong: a type with no `lexical.source` says `no-source`.
   */
  it('reports no-source through the HTTP route for a type with no source', async () => {
    const plugin = await pluginWithArm();
    const route = plugin.kernelRoutes?.find((r) => r.path === 'recall');
    const res = await Promise.resolve(
      route!.handler(fakeReq({ query: 'Sweden', namespace: NS, type: 'Undeclared', k: 5 }))
    );
    const body = JSON.parse(String(res.body)) as { arms?: { lexicalWhy?: string } };
    expect(body.arms?.lexicalWhy).toBe('no-source');
  });

  /**
   * The frame asserts on ROWS, not on `arms`, because the frame does not
   * return the envelope — `hitResolver` maps `out.rows` and drops the rest.
   * `no-source` does not merely
   * relabel an echo: it STOPS the arm, so a lexical-only row indexed under an
   * undeclared type must not come back. With the dep dropped the arm runs and
   * `stowaway` appears.
   */
  it('does not run the arm through the frame for a type with no source', async () => {
    const lexicalStore = await seeded({});
    await lexicalStore.upsert({
      rowNamespace: NS,
      rowType: 'Undeclared',
      rowId: 'stowaway',
      text: 'we went to Sweden in July'
    });
    const plugin = await createRecallPlugin({
      embedder: new FakeEmbedder({ dimension: 8 }),
      store: denseStore(['warship']),
      lexicalStore
    });
    plugin.contributePostWrites?.({
      namespace: NS,
      types: {
        [TYPE]: { lexical: { source: (row: Record<string, unknown>) => String(row.body ?? '') } }
      }
    } as never);
    const resolver = plugin.kernelNamespace?.types?.Hit?.resolver;
    const rows = (await resolver!(
      { identity: null } as never,
      {
        params: { to: 'Sweden', namespace: NS, type: 'Undeclared', k: 5 },
        fields: undefined
      } as never
    )) as Array<{ id?: unknown }>;
    expect(rows.map((r) => r.id)).not.toContain('stowaway');
  });

  it('reports no-source through the MCP tool for a type with no source', async () => {
    const plugin = await pluginWithArm();
    const tool = plugin.mcpTools?.find((t) => t.name === 'recall');
    const out = (await tool!.handler({
      query: 'Sweden',
      namespace: NS,
      type: 'Undeclared',
      k: 5
    })) as { arms?: { lexicalWhy?: string } };
    expect(out.arms?.lexicalWhy).toBe('no-source');
  });

  it('runs the lexical arm through the HTTP route', async () => {
    const plugin = await pluginWithArm();
    const route = plugin.kernelRoutes?.find((r) => r.path === 'recall');
    const res = await Promise.resolve(
      route!.handler(fakeReq({ query: 'Sweden', namespace: NS, type: TYPE, k: 5 }))
    );
    const body = JSON.parse(String(res.body)) as { arms?: { lexical?: boolean } };
    expect(body.arms?.lexical).toBe(true);
  });

  it('runs the lexical arm through the MCP tool', async () => {
    const plugin = await pluginWithArm();
    const tool = plugin.mcpTools?.find((t) => t.name === 'recall');
    const out = (await tool!.handler({
      query: 'Sweden',
      namespace: NS,
      type: TYPE,
      k: 5
    })) as { arms?: { lexical?: boolean } };
    expect(out.arms?.lexical).toBe(true);
  });

  it('advertises the toggle in the MCP tool schema, so a client can find it', async () => {
    const plugin = await pluginWithArm();
    const tool = plugin.mcpTools?.find((t) => t.name === 'recall');
    const props = (tool?.inputSchema as { properties?: Record<string, unknown> })?.properties ?? {};
    expect(Object.keys(props)).toContain('lexical');
    expect(Object.keys(props)).toContain('explain');
  });
});

/**
 * What the envelope and the scores say when the arm runs and CONTRIBUTES
 * NOTHING. Fusion must be entered on "did the lexical arm return anything",
 * not on "is a lexical store wired", or every dense-only row pays RRF.
 */
describe('the arm reports what it actually contributed', () => {
  /**
   * `score` must stay in the cosine domain when nothing was fused, because a
   * consumer's floors are calibrated there.
   *
   * The arm still reports `ran`. It did run — it matched nothing, which is a
   * different fact from being off, and collapsing them would re-create the
   * ambiguity `lexicalWhy` exists to remove.
   */
  it('leaves scores in the cosine domain when the lexical arm matched nothing', async () => {
    const res = await handleRecallRequest(
      { query: 'Sweden', namespace: NS, type: TYPE, k: 5, explain: true },
      {
        embedder: new FakeEmbedder({ dimension: 8 }),
        store: denseStore(['warship', 'vikings']),
        lexicalStore: await seeded({ unrelated: 'a note about postgres backups' })
      }
    );
    expect(res.arms).toEqual({ dense: true, denseWhy: 'ran', lexical: true, lexicalWhy: 'ran' });
    for (const row of res.rows) expect(row.score).toBe(row._denseScore);
  });

  /**
   * `0` is a cosine a row could genuinely have. `null` is the only value that
   * says "this row was never on the cosine axis, do not judge it there" — and
   * the difference decides whether a floor silently admits it.
   */
  it('reports _denseScore null for a lexical-only row rather than 0', async () => {
    const res = await handleRecallRequest(
      { query: 'Sweden', namespace: NS, type: TYPE, k: 5, explain: true },
      {
        embedder: new FakeEmbedder({ dimension: 8 }),
        store: denseStore(['warship']),
        lexicalStore: await seeded({ holiday: 'we went to Sweden in July' })
      }
    );
    const holiday = res.rows.find((r) => r.row.id === 'holiday');
    const warship = res.rows.find((r) => r.row.id === 'warship');
    expect(holiday?._arms).toEqual({ dense: null, lexical: 1 });
    expect(holiday?._denseScore).toBeNull();
    expect(typeof warship?._denseScore).toBe('number');
  });

  /**
   * `arms.lexical` is false when no lexicalStore is wired, when the type
   * declares no `lexical.source`, or when the caller passed `lexical: false`.
   * This pins the middle case.
   */
  it('says no-source for a type that declares no lexical.source', async () => {
    const res = await handleRecallRequest(
      { query: 'Sweden', namespace: NS, type: TYPE, k: 5, explain: true },
      {
        embedder: new FakeEmbedder({ dimension: 8 }),
        store: denseStore(['warship', 'vikings']),
        lexicalStore: await seeded({ holiday: 'we went to Sweden in July' }),
        lexicalSources: { get: () => undefined, size: () => 1 }
      }
    );
    expect(res.arms).toEqual({
      dense: true,
      denseWhy: 'ran',
      lexical: false,
      lexicalWhy: 'no-source'
    });
    expect(res.rows.map((r) => r.row.id)).toEqual(['warship', 'vikings']);
    // Cosines, not `1/(60+rank)`. Asserted on the values rather than against
    // `_denseScore`, which is absent here: no fusion ran, so there is no
    // pre-fusion component to report and the score IS the dense score.
    expect(res.rows.map((r) => r.score)).toEqual([1, 0.9]);
  });

  it('runs the arm for a type the registry does declare', async () => {
    const res = await handleRecallRequest(
      { query: 'Sweden', namespace: NS, type: TYPE, k: 5 },
      {
        embedder: new FakeEmbedder({ dimension: 8 }),
        store: denseStore(['warship']),
        lexicalStore: await seeded({ holiday: 'we went to Sweden in July' }),
        lexicalSources: { get: () => ({ namespace: NS, type: TYPE }), size: () => 1 }
      }
    );
    expect(res.arms).toEqual({ dense: true, denseWhy: 'ran', lexical: true, lexicalWhy: 'ran' });
    expect(res.rows.map((r) => r.row.id)).toContain('holiday');
  });

  /**
   * ABSENT IS NOT EMPTY. A caller that wires no registry has told the core
   * nothing about which types are indexed — it must not conclude `no-source`
   * from that and refuse an arm the deployment has. The registry is threaded
   * by `createRecallPlugin`; a direct core caller (every test above, and
   * anything embedding the core) legitimately has none.
   */
  it('runs the arm when no registry is wired, rather than inferring no-source', async () => {
    const res = await handleRecallRequest(
      { query: 'Sweden', namespace: NS, type: TYPE, k: 5 },
      {
        embedder: new FakeEmbedder({ dimension: 8 }),
        store: denseStore(['warship']),
        lexicalStore: await seeded({ holiday: 'we went to Sweden in July' })
      }
    );
    expect(res.arms?.lexicalWhy).toBe('ran');
  });
});

/**
 * `threshold` is a cosine floor on every row that has a cosine, not only on
 * rows the dense arm ranked. Applied to the dense arm alone, raising the floor
 * freed slots for unfiltered lexical hits, so the result set grew MORE lexical
 * as the floor rose.
 */
describe('threshold applies to lexical-only rows', () => {
  const embedder = new FakeEmbedder({ dimension: 8 });

  /** Dense arm ranking `ids`, plus stored vectors for `vectors` by id. */
  function storeWithVectors(
    ids: string[],
    vectors: Record<string, Float32Array>,
    calls: { fetch: number } = { fetch: 0 }
  ): EmbeddingsStore {
    return {
      ...denseStore(ids),
      fetchEmbeddings: async (
        refs: ReadonlyArray<{ namespace: string; type: string; id: string }>
      ) => {
        calls.fetch++;
        return refs.flatMap((r) => {
          const vector = vectors[r.id];
          return vector === undefined ? [] : [{ ...r, row: { id: r.id }, vector, salience: 0 }];
        });
      }
    } as unknown as EmbeddingsStore;
  }

  const negate = (v: Float32Array): Float32Array => v.map((x) => -x);

  it('drops a lexical-only row whose cosine is below the floor', async () => {
    const q = await embedder.embed('Sweden');
    const res = await handleRecallRequest(
      { query: 'Sweden', namespace: NS, type: TYPE, k: 5, threshold: 0.5 },
      {
        embedder,
        store: storeWithVectors(['warship'], { near: q, far: negate(q) }),
        lexicalStore: await seeded({ near: 'Sweden in July', far: 'Sweden in winter' })
      }
    );
    const ids = res.rows.map((r) => r.row.id);
    expect(ids).toContain('near');
    expect(ids).not.toContain('far');
  });

  /** No stored vector means no cosine, and a row without one cannot meet a floor. */
  it('drops a lexical-only row with no stored embedding when a floor is set', async () => {
    const res = await handleRecallRequest(
      { query: 'Sweden', namespace: NS, type: TYPE, k: 5, threshold: 0.5 },
      {
        embedder,
        store: storeWithVectors(['warship'], {}),
        lexicalStore: await seeded({ holiday: 'we went to Sweden in July' })
      }
    );
    expect(res.rows.map((r) => r.row.id)).toEqual(['warship']);
  });

  it('fetches no vectors when no floor is set', async () => {
    const calls = { fetch: 0 };
    const res = await handleRecallRequest(
      { query: 'Sweden', namespace: NS, type: TYPE, k: 5 },
      {
        embedder,
        store: storeWithVectors(['warship'], {}, calls),
        lexicalStore: await seeded({ holiday: 'we went to Sweden in July' })
      }
    );
    expect(calls.fetch).toBe(0);
    expect(res.rows.map((r) => r.row.id)).toContain('holiday');
  });

  /** Rows both arms found were already floored by knn; only lexical-only ids are fetched. */
  it('fetches vectors only for rows the dense arm did not rank', async () => {
    const q = await embedder.embed('Sweden');
    const fetched: string[] = [];
    const store = storeWithVectors(['warship'], { holiday: q });
    const inner = store.fetchEmbeddings.bind(store);
    store.fetchEmbeddings = async (refs, model) => {
      fetched.push(...refs.map((r) => r.id));
      return inner(refs, model);
    };
    await handleRecallRequest(
      { query: 'Sweden warship', namespace: NS, type: TYPE, k: 5, threshold: 0.5 },
      {
        embedder,
        store,
        lexicalStore: await seeded({
          warship: 'a Sweden warship',
          holiday: 'a Sweden warship on holiday'
        })
      }
    );
    expect(fetched).toEqual(['holiday']);
  });
});

/**
 * `lexicalThreshold` floors lexical-only hits separately from `threshold`.
 * Omitted, it takes `threshold`'s value; 0 leaves those hits unfloored, so a
 * caller whose lexical arm exists to surface rows the vector index does not
 * hold can keep them while still flooring the dense arm.
 */
describe('lexicalThreshold', () => {
  const embedder = new FakeEmbedder({ dimension: 8 });

  /** Dense arm ranking `ids`; stored vectors for `vectors` by id, none for the rest. */
  function storeWithVectors(ids: string[], vectors: Record<string, Float32Array>): EmbeddingsStore {
    return {
      ...denseStore(ids),
      fetchEmbeddings: async (
        refs: ReadonlyArray<{ namespace: string; type: string; id: string }>
      ) =>
        refs.flatMap((r) => {
          const vector = vectors[r.id];
          return vector === undefined ? [] : [{ ...r, row: { id: r.id }, vector, salience: 0 }];
        })
    } as unknown as EmbeddingsStore;
  }

  it('keeps a lexical-only hit with no stored vector when lexicalThreshold is 0', async () => {
    const res = await handleRecallRequest(
      { query: 'Sweden', namespace: NS, type: TYPE, k: 5, threshold: 0.5, lexicalThreshold: 0 },
      {
        embedder,
        store: storeWithVectors(['warship'], {}),
        lexicalStore: await seeded({ holiday: 'we went to Sweden in July' })
      }
    );
    expect(res.rows.map((r) => r.row.id)).toContain('holiday');
  });

  it('floors lexical-only hits at lexicalThreshold even when threshold is unset', async () => {
    const q = await embedder.embed('Sweden');
    const res = await handleRecallRequest(
      { query: 'Sweden', namespace: NS, type: TYPE, k: 5, lexicalThreshold: 0.5 },
      {
        embedder,
        store: storeWithVectors(['warship'], { near: q, far: q.map((x) => -x) }),
        lexicalStore: await seeded({ near: 'Sweden in July', far: 'Sweden in winter' })
      }
    );
    const ids = res.rows.map((r) => r.row.id);
    expect(ids).toContain('near');
    expect(ids).not.toContain('far');
    expect(ids).toContain('warship');
  });

  describe('reaches every surface', () => {
    async function plugin() {
      const p = await createRecallPlugin({
        embedder,
        store: storeWithVectors(['warship'], {}),
        lexicalStore: await seeded({ holiday: 'we went to Sweden in July' })
      });
      p.contributePostWrites?.({
        namespace: NS,
        types: {
          [TYPE]: { lexical: { source: (row: Record<string, unknown>) => String(row.body ?? '') } }
        }
      } as never);
      return p;
    }
    const params = { namespace: NS, type: TYPE, k: 5, threshold: 0.5, lexicalThreshold: 0 };
    const fakeReq = (body: unknown) => ({
      method: 'POST' as const,
      path: '/substrate/v1/recall',
      headers: {},
      query: {},
      params: {},
      body: Buffer.from(JSON.stringify(body))
    });

    it('HTTP route', async () => {
      const route = (await plugin()).kernelRoutes?.find((r) => r.path === 'recall');
      const res = await Promise.resolve(route!.handler(fakeReq({ query: 'Sweden', ...params })));
      const body = JSON.parse(String(res.body)) as { rows: Array<{ row: { id: string } }> };
      expect(body.rows.map((r) => r.row.id)).toContain('holiday');
    });

    it('HTTP route rejects a non-number', async () => {
      const route = (await plugin()).kernelRoutes?.find((r) => r.path === 'recall');
      const res = await Promise.resolve(
        route!.handler(fakeReq({ query: 'Sweden', ...params, lexicalThreshold: 'low' }))
      );
      expect(res.status).toBe(400);
      expect(JSON.parse(String(res.body)).message).toBe('"lexicalThreshold" must be a number');
    });

    it('MCP tool, and its schema advertises the param', async () => {
      const tool = (await plugin()).mcpTools?.find((t) => t.name === 'recall');
      const out = (await tool!.handler({ query: 'Sweden', ...params })) as {
        rows: Array<{ row: { id: string } }>;
      };
      expect(out.rows.map((r) => r.row.id)).toContain('holiday');
      const props =
        (tool?.inputSchema as { properties?: Record<string, unknown> })?.properties ?? {};
      expect(Object.keys(props)).toContain('lexicalThreshold');
    });

    it('recall/Hit frame', async () => {
      const resolver = (await plugin()).kernelNamespace?.types?.Hit?.resolver;
      const rows = (await resolver!(
        { identity: null } as never,
        { params: { to: 'Sweden', ...params }, fields: undefined } as never
      )) as Array<{ id?: unknown }>;
      expect(rows.map((r) => r.id)).toContain('holiday');
    });
  });
});

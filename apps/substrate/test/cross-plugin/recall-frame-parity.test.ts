/**
 * The same logical recall through POST /substrate/v1/recall and through a
 * `recall/Hit` frame must produce identical hit sets, scores, ordering, and
 * side-effects — modulo the documented envelope reshaping (route
 * `{ row, _salience, _blendedScore, _expandedFrom }` vs frame
 * `{ id, salience, blendedScore, kind, expandedFrom }`) and the mutation-ack
 * sentinel ids ('ack' / 'embeddings').
 *
 * ONE `createRecallPlugin` instance per test backs BOTH paths. The frame path
 * runs through a composed `MemorySubstrateServer`; the route path invokes the
 * kernel-route handlers pulled directly off the same plugin's `kernelRoutes`,
 * which close over the same store/embedder/resolvers. A divergence can
 * therefore only come from the adapters, never from differing wiring. Kernel
 * routes are mounted by the binary's substrate lifecycle, not by compose(),
 * hence pulling the handler off the plugin.
 */

import { type ComposeResult, compose } from '@mnmal-ai/substrate-compose';
import { MemoryEdgesStore } from '@mnmal-ai/substrate-core';
import { MemoryDataset } from '@mnmal-ai/substrate-dataset-memory';
import { FakeEmbedder } from '@mnmal-ai/substrate-embedder/fake';
import {
  createRecallPlugin,
  InMemoryEmbeddingsStore,
  type RecallPluginConfig
} from '@mnmal-ai/substrate-recall';
import { MemorySubstrateServer } from '@mnmal-ai/substrate-server-memory';
import type {
  HttpHandler,
  Identity,
  KernelPlugin,
  PackEnvelope,
  PolicyDecision,
  SubstrateRequest,
  SubstrateResponse,
  WsResponseFrame
} from '@mnmal-ai/substrate-types';
import { WS_CODE_SUBSCRIPTION_UNSUPPORTED_FRAME } from '@mnmal-ai/substrate-types';
import { afterEach, describe, expect, it } from 'vitest';
import { embeddableCoordinator } from '../_fixtures/embeddable-coordinator.js';

// ---------------------------------------------------------------------------
// Wire helpers
// ---------------------------------------------------------------------------

function bodyToString(res: SubstrateResponse): string {
  const b = res.body;
  if (b === undefined || b === null) return '';
  if (typeof b === 'string') return b;
  if (Buffer.isBuffer(b)) return b.toString('utf8');
  if (b instanceof Uint8Array) return Buffer.from(b).toString('utf8');
  return '';
}

function parseEnvelope(res: SubstrateResponse): PackEnvelope {
  return JSON.parse(bodyToString(res)) as PackEnvelope;
}

function parseJson<T>(res: SubstrateResponse): T {
  return JSON.parse(bodyToString(res)) as T;
}

/** Pull a kernel-route handler off a substrate plugin by path. */
function routeHandler(plugin: KernelPlugin, path: string): HttpHandler {
  const claim = (plugin.kernelRoutes ?? []).find((r) => r.path === path);
  if (claim === undefined) throw new Error(`no kernel route for path '${path}'`);
  return claim.handler;
}

/** Build a POST SubstrateRequest with a JSON body and optional identity. */
function postReq(path: string, body: unknown, identity?: Identity): SubstrateRequest {
  const req: SubstrateRequest = {
    method: 'POST',
    path,
    headers: { 'content-type': 'application/json' },
    query: {},
    params: {},
    body: Buffer.from(JSON.stringify(body), 'utf8')
  };
  if (identity !== undefined) req.identity = identity;
  return req;
}

// ---------------------------------------------------------------------------
// Harness: one plugin instance backing both paths over a shared store.
// ---------------------------------------------------------------------------

interface Harness {
  composed: ComposeResult;
  server: MemorySubstrateServer;
  plugin: KernelPlugin;
  store: InMemoryEmbeddingsStore;
  embedder: FakeEmbedder | undefined;
  /** Real ids of seeded rows, in seed order. */
  seededIds: string[];
  /** Drive a `recall/Hit` frame end-to-end through POST /substrate/v1/query. */
  frameRecall: (params: Record<string, unknown>) => Promise<SubstrateResponse>;
  /** Drive a `recall/<mutation>` frame end-to-end through POST /substrate/v1/mutate. */
  frameMutate: (key: string, params: Record<string, unknown>) => Promise<SubstrateResponse>;
  /** Invoke a kernel route off the SAME plugin instance. */
  route: (path: string, body: unknown, identity?: Identity) => Promise<SubstrateResponse>;
}

const DIM = 8;

async function bootHarness(
  opts: {
    embedder?: FakeEmbedder | undefined;
    withEmbedder?: boolean;
    checkReadPolicy?: RecallPluginConfig['checkReadPolicy'];
    /** Seed N `sample/Memo` rows with distinct embed texts (ids assigned by engine). */
    seed?: Array<{ text: string }>;
  } = {}
): Promise<Harness> {
  const withEmbedder = opts.withEmbedder ?? true;
  const embedder = withEmbedder
    ? (opts.embedder ?? new FakeEmbedder({ dimension: DIM }))
    : undefined;

  // Late-bound dataset ref so knnSearch can join row bodies (main.ts idiom).
  const datasetRegistryRef: { current: { get: (ns: string) => unknown } | null } = {
    current: null
  };
  const store = new InMemoryEmbeddingsStore({
    datasetFor: (ns) =>
      datasetRegistryRef.current?.get(ns) as import('@mnmal-ai/substrate-types').Dataset | undefined
  });

  const server = new MemorySubstrateServer();
  const dataset = new MemoryDataset({ namespace: 'default' });
  const edges = new MemoryEdgesStore({ now: () => new Date() });

  const recallCfg: RecallPluginConfig = {
    store,
    edges,
    ...(embedder !== undefined ? { embedder } : {}),
    ...(opts.checkReadPolicy !== undefined ? { checkReadPolicy: opts.checkReadPolicy } : {}),
    // The harness plays the host, and the host is what wires the write gate.
    checkWritePolicy: () => ({ allow: true })
  };
  const plugin = createRecallPlugin(recallCfg);

  const composed = await compose({
    // Auth is off, so the deployment must declare who it writes as.
    systemActor: 'test',
    server,
    dataset,
    edges,
    coordinators: [embeddableCoordinator],
    kernelPlugins: [plugin]
  });
  datasetRegistryRef.current = composed.datasets;

  await server.start();

  // Seed real sample/Memo rows through the engine so the store's datasetFor
  // join finds bodies (knnSearch drops entries whose row was deleted / missing
  // from the dataset). Each row's embedding is upserted under its real id using
  // the deterministic FakeEmbedder over the seed text, so cosine vs the query
  // differs row-to-row and ordering is observable. Both paths read the SAME
  // store, so a single seed feeds both transports.
  const seededIds: string[] = [];
  if (opts.seed !== undefined && embedder !== undefined) {
    for (const s of opts.seed) {
      const writeRes = await server.inject(
        postReq('/substrate/v1/mutate', {
          'sample/createMemo': {
            params: {
              name: `seed-${s.text}`,
              description: s.text,
              type: 'reference',
              body: s.text,
              archived: false,
              project: null
            },
            fields: { id: true }
          }
        })
      );
      const id = (parseEnvelope(writeRes).data['sample/createMemo'] as { id: string }).id;
      seededIds.push(id);
      const vector = await embedder.embed(s.text);
      await store.upsert({
        rowNamespace: 'sample',
        rowType: 'Memo',
        rowId: id,
        vector,
        model: embedder.modelId
      });
    }
  }

  return {
    composed,
    server,
    plugin,
    store,
    embedder,
    seededIds,
    // Omit `fields` so the full row/ack passes through unprojected — a
    // non-undefined `fields` (even `{}`) drives strict envelope projection
    // (helpers.ts projectEnvelope), which would strip every key.
    frameRecall: (params) =>
      server.inject(postReq('/substrate/v1/query', { 'recall/Hit': { params } })),
    frameMutate: (key, params) =>
      server.inject(postReq('/substrate/v1/mutate', { [key]: { params } })),
    route: (path, body, identity) =>
      Promise.resolve(routeHandler(plugin, path)(postReq(path, body, identity)))
  };
}

/** Flush fire-and-forget microtasks the recall route schedules for boost. */
async function flushMicrotasks(): Promise<void> {
  // 5 turns drains the recall boost's current fire-and-forget chain; bump if
  // that chain ever deepens (an under-flush here reads as flaky-green).
  for (let i = 0; i < 5; i++) await Promise.resolve();
  await new Promise<void>((r) => setImmediate(r));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

/** Equal salience lists, to within the decay between two reads milliseconds apart. */
function expectSameSalience(a: number[], b: number[]): void {
  expect(a).toHaveLength(b.length);
  for (const [i, v] of a.entries()) expect(v).toBeCloseTo(b[i] ?? Number.NaN, 6);
}

describe('recall route-vs-frame parity', () => {
  const harnesses: Harness[] = [];

  afterEach(async () => {
    while (harnesses.length > 0) {
      const h = harnesses.pop();
      if (h !== undefined) await h.composed.stop();
    }
  });

  function track(h: Harness): Harness {
    harnesses.push(h);
    return h;
  }

  // The three seed rows embed distinct texts whose cosine vs the query text
  // ('target text') is distinct AND positive — ordering is then observable, and
  // every row clears the recall path's implicit threshold=0 floor (the route
  // core forwards a threshold only when >0, so a negative threshold can't be
  // used to keep negative-cosine rows; the seeds are chosen positive instead).
  // Cosines vs 'target text' under FakeEmbedder(dim 8): ~0.53, ~0.40, ~0.25.
  const QUERY = 'target text';
  const SEED = [{ text: 'seed-row-4' }, { text: 'seed-row-6' }, { text: 'seed-row-1' }];

  // -------------------------------------------------------------------------
  // 1. same hits, same scores, same order
  // -------------------------------------------------------------------------

  it('same hits, same scores, same order', async () => {
    const h = track(await bootHarness({ seed: SEED }));
    const input = { namespace: 'sample', type: 'Memo', k: 3, boost: false };

    const routeRes = await h.route('recall', { query: QUERY, ...input });
    expect(routeRes.status).toBe(200);
    const routeRows = parseJson<{ rows: Array<Record<string, unknown>> }>(routeRes).rows;

    const frameRes = await h.frameRecall({ to: QUERY, ...input });
    expect(frameRes.status).toBe(200);
    const frameRows = parseEnvelope(frameRes).data['recall/Hit'] as Array<Record<string, unknown>>;

    // At least two rows so ordering is actually exercised.
    expect(routeRows.length).toBeGreaterThanOrEqual(2);
    expect(frameRows.length).toBe(routeRows.length);

    expect(frameRows.map((r) => [r.id, r.score, r.kind])).toEqual(
      routeRows.map((r) => [
        (r.row as { id: string }).id,
        r.score,
        '_expandedFrom' in r ? 'expansion' : 'seed'
      ])
    );
  });

  // -------------------------------------------------------------------------
  // 2. returnVector parity
  // -------------------------------------------------------------------------

  it('returnVector parity: frame vectors equal route vectors', async () => {
    const h = track(await bootHarness({ seed: SEED }));
    const input = { namespace: 'sample', type: 'Memo', k: 3, boost: false, returnVector: true };

    const routeRows = parseJson<{ rows: Array<Record<string, unknown>> }>(
      await h.route('recall', { query: QUERY, ...input })
    ).rows;
    const frameRows = parseEnvelope(await h.frameRecall({ to: QUERY, ...input })).data[
      'recall/Hit'
    ] as Array<Record<string, unknown>>;

    expect(routeRows.length).toBeGreaterThanOrEqual(2);
    // Each vector is a dim-8 number array, identical element-for-element + in
    // the same row order.
    const routeVecs = routeRows.map((r) => r.vector);
    const frameVecs = frameRows.map((r) => r.vector);
    expect(routeVecs[0]).toHaveLength(DIM);
    expect(frameVecs).toEqual(routeVecs);
  });

  // -------------------------------------------------------------------------
  // 3. boost-on-recall side-effect parity
  // -------------------------------------------------------------------------

  it('boost side-effect parity: boost:true bumps salience identically', async () => {
    const input = { namespace: 'sample', type: 'Memo', k: 3 };

    // Frame half: fresh store, recall with boost defaulting to true, then read
    // salience back via a boost:false recall (no further side-effect).
    const hFrame = track(await bootHarness({ seed: SEED }));
    await hFrame.frameRecall({ to: QUERY, ...input }); // boost defaults true
    await flushMicrotasks();
    const frameAfter = parseEnvelope(
      await hFrame.frameRecall({ to: QUERY, ...input, boost: false })
    ).data['recall/Hit'] as Array<Record<string, unknown>>;
    // Each half boots an independent store with its own engine-assigned ids, so
    // compare the salience VALUES in sorted order (the ids necessarily differ).
    const frameSalience = frameAfter.map((r) => r.salience as number).sort((a, b) => a - b);

    // Route half: fresh store, identical recall via the route, same read-back.
    const hRoute = track(await bootHarness({ seed: SEED }));
    await hRoute.route('recall', { query: QUERY, ...input }); // boost defaults true
    await flushMicrotasks();
    const routeAfter = parseJson<{ rows: Array<Record<string, unknown>> }>(
      await hRoute.route('recall', { query: QUERY, ...input, boost: false })
    ).rows;
    const routeSalience = routeAfter.map((r) => r._salience as number).sort((a, b) => a - b);

    // Every returned row was reinforced once → salience strictly > 0, and the
    // per-row salience deltas match across transports.
    expect(frameSalience.length).toBeGreaterThanOrEqual(2);
    expect(frameSalience.every((s) => s > 0)).toBe(true);
    expectSameSalience(frameSalience, routeSalience);
  });

  // -------------------------------------------------------------------------
  // 4. boost mutation parity
  // -------------------------------------------------------------------------

  it('boost mutation parity: recall/boost === POST /substrate/v1/salience/boost', async () => {
    // Each half boots a fresh store with its own engine-assigned ids; targets
    // are that half's own first two seeded rows. Response semantics + store
    // effect are compared structurally (salience values in seed order), since
    // the row ids differ between independent stores.
    const targetsFor = (h: Harness) =>
      h.seededIds.slice(0, 2).map((id) => ({ namespace: 'sample', type: 'Memo', id }));

    // Frame half.
    const hFrame = track(await bootHarness({ seed: SEED }));
    const frameRes = await hFrame.frameMutate('recall/boost', { targets: targetsFor(hFrame) });
    expect(frameRes.status).toBe(200);
    const frameAck = parseEnvelope(frameRes).data['recall/boost'] as Record<string, unknown>;

    // Route half: same logical input via POST /substrate/v1/salience/boost.
    const hRoute = track(await bootHarness({ seed: SEED }));
    const routeRes = await hRoute.route('salience/boost', { targets: targetsFor(hRoute) });
    expect(routeRes.status).toBe(200);
    const routeAck = parseJson<Record<string, unknown>>(routeRes);

    // Response semantics: route returns { ok, requested, applied, missing }
    // exactly; the frame returns the same payload plus the documented 'ack'
    // sentinel id (mutations must return a Row, id required).
    //
    // `applied: 2` with an empty `missing` is the load-bearing half: both
    // targets are seeded rows, so a response that reinforced nothing fails.
    expect(routeAck).toEqual({ ok: true, requested: 2, applied: 2, missing: [] });
    const { id, ...frameAckNoId } = frameAck;
    expect(id).toBe('ack'); // documented divergence asserted explicitly
    expect(frameAckNoId).toEqual(routeAck);

    // Store-side effect parity: read salience back via a boost:false recall on
    // each store and compare the salience values in seed order (ids differ).
    const frameSal = (
      parseEnvelope(
        await hFrame.frameRecall({
          to: QUERY,
          namespace: 'sample',
          type: 'Memo',
          k: 3,
          boost: false
        })
      ).data['recall/Hit'] as Array<Record<string, unknown>>
    )
      .map((r) => r.salience as number)
      .sort((a, b) => a - b);
    const routeSal = parseJson<{ rows: Array<Record<string, unknown>> }>(
      await hRoute.route('recall', {
        query: QUERY,
        namespace: 'sample',
        type: 'Memo',
        k: 3,
        boost: false
      })
    )
      .rows.map((r) => r._salience as number)
      .sort((a, b) => a - b);
    // Two rows reinforced once → two strictly-positive salience values.
    expect(frameSal.filter((s) => s > 0)).toHaveLength(2);
    expectSameSalience(frameSal, routeSal);
  });

  // -------------------------------------------------------------------------
  // 5. fetchEmbeddings parity
  // -------------------------------------------------------------------------

  it('fetchEmbeddings parity: recall/fetchEmbeddings === POST /substrate/v1/embeddings/fetch', async () => {
    const h = track(await bootHarness({ seed: SEED }));
    const refs = h.seededIds.slice(0, 2).map((id) => ({ namespace: 'sample', type: 'Memo', id }));

    // `boost: false` on BOTH halves: fetch can reinforce what it returns, so
    // with one shared store the first call would move the salience the second
    // reports — a difference in call ORDER, not in transport. Boost parity is
    // asserted separately below, one store per transport.
    const routeOut = parseJson<{ vectors: unknown[]; model: string }>(
      await h.route('embeddings/fetch', { refs, boost: false })
    );
    const frameAck = parseEnvelope(
      await h.frameMutate('recall/fetchEmbeddings', { refs, boost: false })
    ).data['recall/fetchEmbeddings'] as Record<string, unknown>;

    // Frame adds the 'embeddings' sentinel id; strip it and the rest must match
    // the route output byte-for-byte (identical vectors + model + _salience).
    expect(frameAck.id).toBe('embeddings');
    const { id, ...frameNoId } = frameAck;
    expect(id).toBe('embeddings');
    expect(frameNoId).toEqual(routeOut);
    expect((routeOut.vectors as unknown[]).length).toBe(2);
    expect(routeOut.model).toBe(h.embedder?.modelId);
    // Read-only really is read-only on both paths.
    for (const v of routeOut.vectors as Array<Record<string, unknown>>) {
      expect(v._salience).toBe(0);
    }
  });

  it('fetchEmbeddings boost parity: both transports reinforce what they return', async () => {
    // One store per transport, because the effect under test is a write;
    // salience is compared in seed order since independent stores assign
    // their own ids.
    //
    // `boost: true` must be explicit: fetch boost is opt-in, and without it
    // both transports would agree on doing nothing, which proves nothing.
    const refsFor = (h: Harness) =>
      h.seededIds.slice(0, 2).map((id) => ({ namespace: 'sample', type: 'Memo', id }));
    const salienceOf = async (h: Harness) =>
      (
        parseEnvelope(
          await h.frameRecall({ to: QUERY, namespace: 'sample', type: 'Memo', k: 3, boost: false })
        ).data['recall/Hit'] as Array<Record<string, unknown>>
      )
        .map((r) => r.salience as number)
        .sort((a, b) => a - b);

    const hFrame = track(await bootHarness({ seed: SEED }));
    const frameOut = parseEnvelope(
      await hFrame.frameMutate('recall/fetchEmbeddings', { refs: refsFor(hFrame), boost: true })
    ).data['recall/fetchEmbeddings'] as { vectors: Array<Record<string, unknown>> };

    const hRoute = track(await bootHarness({ seed: SEED }));
    const routeOut = parseJson<{ vectors: Array<Record<string, unknown>> }>(
      await hRoute.route('embeddings/fetch', { refs: refsFor(hRoute), boost: true })
    );

    // The response reports the PRE-boost value on both paths — the boost is
    // fire-and-forget and cannot have landed by the time the envelope is built.
    for (const v of [...frameOut.vectors, ...routeOut.vectors]) expect(v._salience).toBe(0);

    // The store, read back afterwards, disagrees with that envelope on both
    // paths and by the same amount. Two rows fetched → exactly two reinforced.
    const frameSal = await salienceOf(hFrame);
    const routeSal = await salienceOf(hRoute);
    expect(frameSal.filter((s) => s > 0)).toHaveLength(2);
    expectSameSalience(frameSal, routeSal);
  });

  // -------------------------------------------------------------------------
  // 6. policy parity
  // -------------------------------------------------------------------------

  it('policy parity: denied scope yields 403 policy_denied on route and policy_denied frame error with matching text', async () => {
    const reason = 'reads require an authenticated identity';
    const checkReadPolicy = (ns: string, type: string): PolicyDecision =>
      ns === 'sample' && type === 'Memo' ? { allow: false, reason } : { allow: true };
    const h = track(await bootHarness({ seed: SEED, checkReadPolicy }));
    const input = { namespace: 'sample', type: 'Memo', k: 3, boost: false };

    // Route: 403 with policy_denied; the recall route's message is the bare
    // policy reason (it does not prefix the scope).
    const routeRes = await h.route('recall', { query: QUERY, ...input });
    expect(routeRes.status).toBe(403);
    const routeErr = parseJson<{ error: { code: string; message: string } }>(routeRes).error;
    expect(routeErr.code).toBe('policy_denied');
    expect(routeErr.message).toBe(reason);

    // Frame: per-key envelope error, same code + same message text.
    const frameRes = await h.frameRecall({ to: QUERY, ...input });
    expect(frameRes.status).toBe(200); // envelope errors are per-key, not transport-level
    const frameErrs = parseEnvelope(frameRes).errors ?? [];
    expect(frameErrs).toHaveLength(1);
    expect(frameErrs[0]?.code).toBe('policy_denied');
    expect(frameErrs[0]?.message).toBe(routeErr.message);
  });

  // -------------------------------------------------------------------------
  // 7. off-mode parity (no embedder)
  // -------------------------------------------------------------------------

  it('off-mode parity: no embedder → 503 embedder_unavailable on route, embedder_unavailable frame error', async () => {
    const h = track(await bootHarness({ withEmbedder: false }));
    const input = { namespace: 'sample', type: 'Memo', k: 3, boost: false };

    const routeRes = await h.route('recall', { query: QUERY, ...input });
    expect(routeRes.status).toBe(503);
    const routeErr = parseJson<{ error: { code: string } }>(routeRes).error;
    expect(routeErr.code).toBe('embedder_unavailable');

    const frameRes = await h.frameRecall({ to: QUERY, ...input });
    const frameErrs = parseEnvelope(frameRes).errors ?? [];
    expect(frameErrs).toHaveLength(1);
    expect(frameErrs[0]?.code).toBe('embedder_unavailable');
  });

  // -------------------------------------------------------------------------
  // 8. expansion parity
  // -------------------------------------------------------------------------

  it('expansion parity: expanded neighbours match (ids/scores/expandedFrom) both sides', async () => {
    // sample/Memo.relatedTo is a self-ref crossRef with spread:true, so the
    // recall plugin's spread registry picks it up via contributePostWrites when
    // the `sample` namespace registers — expansion walks dec-1 → dec-2 through
    // BOTH the route handler and the frame surface (same resolver instance).
    const h = track(await bootHarness());
    const embedder = h.embedder;
    if (embedder === undefined) throw new Error('expansion test needs an embedder');

    // Create two sample/Memo rows: dec-2 first, then dec-1 with
    // `relatedTo: dec-2`. Bodies are joined by the store's datasetFor, so the
    // expansion source's `row.relatedTo` is present.
    const createDecision = async (params: Record<string, unknown>): Promise<string> => {
      const res = await h.server.inject(
        postReq('/substrate/v1/mutate', {
          'sample/createMemo': { params, fields: { id: true } }
        })
      );
      const env = parseEnvelope(res);
      if (env.errors !== undefined && env.errors.length > 0) {
        throw new Error(`createDecision failed: ${JSON.stringify(env.errors)}`);
      }
      return (env.data['sample/createMemo'] as { id: string }).id;
    };

    const dec2Id = await createDecision({
      name: 'salience original',
      description: 'first attempt',
      body: 'r2',
      archived: false,
      project: null
    });
    const dec1Id = await createDecision({
      name: 'salience design v2',
      description: 'blended score with decay',
      body: 'r3',
      archived: false,
      project: null,
      relatedTo: dec2Id
    });
    const dec2Res = { id: dec2Id };
    const dec1Res = { id: dec1Id };

    // Force deterministic vectors so dec-2 surfaces ONLY via expansion:
    //  - dec-1 stored vector == queryVec → cosine 1.0, a strong knn seed.
    //  - dec-2 stored vector == -queryVec → cosine -1.0, BELOW the recall
    //    path's implicit threshold=0 floor, so knn drops it. Expansion has no
    //    threshold filter: it walks dec-1.relatedTo → dec-2, re-scores it
    //    (still -1.0), and merges it into the pool as an `_expandedFrom` row.
    //    This makes dec-2 unambiguously an expansion-only hit on BOTH paths.
    const queryVec = await embedder.embed('salience query');
    const negVec = new Float32Array(DIM);
    for (let i = 0; i < DIM; i++) negVec[i] = -queryVec[i]!;
    await h.store.upsert({
      rowNamespace: 'sample',
      rowType: 'Memo',
      rowId: dec1Res.id,
      vector: queryVec,
      model: embedder.modelId
    });
    await h.store.upsert({
      rowNamespace: 'sample',
      rowType: 'Memo',
      rowId: dec2Res.id,
      vector: negVec,
      model: embedder.modelId
    });

    const input = {
      namespace: 'sample',
      type: 'Memo',
      k: 5,
      expand: true,
      boost: false
    };

    const routeRows = parseJson<{ rows: Array<Record<string, unknown>> }>(
      await h.route('recall', { query: 'salience query', ...input })
    ).rows;
    const frameRows = parseEnvelope(await h.frameRecall({ to: 'salience query', ...input })).data[
      'recall/Hit'
    ] as Array<Record<string, unknown>>;

    const routeExpanded = routeRows.filter((r) => '_expandedFrom' in r);
    const frameExpanded = frameRows.filter((r) => r.kind === 'expansion');

    // Expansion actually fired on both sides — dec-2 reached via dec-1.relatedTo.
    expect(routeExpanded.length).toBeGreaterThanOrEqual(1);
    expect(frameExpanded.length).toBe(routeExpanded.length);
    expect(routeExpanded.some((r) => (r.row as { id: string }).id === dec2Res.id)).toBe(true);

    // Same expanded ids + scores, same order, and expandedFrom matches the
    // route's _expandedFrom verbatim.
    expect(frameExpanded.map((r) => [r.id, r.score, r.expandedFrom])).toEqual(
      routeExpanded.map((r) => [(r.row as { id: string }).id, r.score, r._expandedFrom])
    );
    // And the seed dec-1 is the expandedFrom anchor.
    expect((routeExpanded[0]!._expandedFrom as { id: string }).id).toBe(dec1Res.id);

    // Full hit-set parity (seeds + expansions), same order.
    expect(frameRows.map((r) => [r.id, r.score, r.kind])).toEqual(
      routeRows.map((r) => [
        (r.row as { id: string }).id,
        r.score,
        '_expandedFrom' in r ? 'expansion' : 'seed'
      ])
    );
  });

  // -------------------------------------------------------------------------
  // 9. WS subscribe refusal over a real composed engine
  // -------------------------------------------------------------------------

  it('subscribing to recall/Hit yields subscription_unsupported_frame (engine.subscribe over composed engine)', async () => {
    // The recall namespace is virtual (dataset-less): it has no write stream to
    // subscribe to. The composed engine must refuse a recall/Hit subscription
    // at registration with subscription_unsupported_frame, never register it.
    // Driven via engine.subscribe against the composed engine — apps/substrate's
    // subscription harnesses live at the engine level (the dedicated WS-refusal
    // suite is packages/substrate-core/test/subscribe-unsupported-frames.test.ts);
    // engine.subscribe over the real composition is the faithful exercise here.
    const h = track(await bootHarness({ seed: SEED }));
    const frames: WsResponseFrame[] = [];
    await h.composed.engine.subscribe({
      id: 'sub-recall-hit',
      frame: { 'recall/Hit': { params: { to: 'x' }, fields: { id: true } } },
      ctx: {},
      onFrame: (f) => void frames.push(f)
    });

    const first = frames[0];
    expect(first?.kind).toBe('error');
    expect(first?.errors?.[0]?.code).toBe(WS_CODE_SUBSCRIPTION_UNSUPPORTED_FRAME);
    expect(h.composed.engine.activeSubscriptionCount()).toBe(0);
  });
});

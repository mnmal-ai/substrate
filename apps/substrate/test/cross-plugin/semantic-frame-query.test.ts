/**
 * End-to-end single-type semantic frame query. Drives POST /substrate/v1/query with
 * `{ 'sample/Memo': { params: { where: { embeddingSimilar: {...} } }, fields } }`
 * frames through a composed `MemorySubstrateServer` carrying the sample coordinator.
 *
 * Exercises the FRAME surface alone (route-vs-frame equivalence is
 * recall-frame-parity.test.ts): relevance order, structural AND intersection,
 * threshold cut, explicit-orderBy override, `_vector` round-trip, the
 * computed_field_unavailable gate over real HTTP, and boost:false.
 *
 * The operator is registered explicitly (registerExtensionOperator, cleared in
 * afterEach) because the binary's composeKernelPlugins path wires it into
 * the shared substrate-filter registry, not compose() in-process.
 */

import { type ComposeResult, compose } from '@mnmal-ai/substrate-compose';
import { MemoryEdgesStore } from '@mnmal-ai/substrate-core';
import { MemoryDataset } from '@mnmal-ai/substrate-dataset-memory';
import { FakeEmbedder } from '@mnmal-ai/substrate-embedder/fake';
import { clearExtensionOperators, registerExtensionOperator } from '@mnmal-ai/substrate-filter';
import { embeddingSimilarOperator, InMemoryEmbeddingsStore } from '@mnmal-ai/substrate-recall';
import { MemorySubstrateServer } from '@mnmal-ai/substrate-server-memory';
import type { PackEnvelope, SubstrateRequest, SubstrateResponse } from '@mnmal-ai/substrate-types';
import { afterEach, describe, expect, it } from 'vitest';
import { embeddableCoordinator } from '../_fixtures/embeddable-coordinator.js';

// ---------------------------------------------------------------------------
// Wire helpers (same shape as recall-frame-parity.test.ts)
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

function postReq(path: string, body: unknown): SubstrateRequest {
  return {
    method: 'POST',
    path,
    headers: { 'content-type': 'application/json' },
    query: {},
    params: {},
    body: Buffer.from(JSON.stringify(body), 'utf8')
  };
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const DIM = 8;

// Seeds whose cosine vs QUERY under FakeEmbedder(dim 8) is distinct, positive,
// and descending in this order: seed-row-4 ≈ 0.533, seed-row-6 ≈ 0.403,
// seed-row-1 ≈ 0.248 (same fixtures as the parity suite). Names are
// `seed-<text>`, so name-asc order is seed-seed-row-1 < seed-row-4 < seed-row-6.
const QUERY = 'target text';
const SEED = [{ text: 'seed-row-4' }, { text: 'seed-row-6' }, { text: 'seed-row-1' }];

interface SeededRow {
  id: string;
  text: string;
  name: string;
  archived: boolean;
  vector: number[];
}

interface Harness {
  composed: ComposeResult;
  server: MemorySubstrateServer;
  store: InMemoryEmbeddingsStore;
  embedder: FakeEmbedder;
  rows: SeededRow[];
  /** Drive a single-type semantic frame end-to-end through POST /substrate/v1/query. */
  query: (frame: Record<string, unknown>) => Promise<SubstrateResponse>;
}

async function bootHarness(
  opts: { seed?: Array<{ text: string; archived?: boolean }> } = {}
): Promise<Harness> {
  const embedder = new FakeEmbedder({ dimension: DIM });

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

  const composed = await compose({
    // Auth is off, so the deployment must declare who it writes as.
    systemActor: 'test',
    server,
    dataset,
    edges,
    coordinators: [embeddableCoordinator]
  });
  datasetRegistryRef.current = composed.datasets;

  await server.start();

  // Register embeddingSimilar against the SAME store/embedder the seeds use —
  // the binary's filterRegistry.register idiom (main.ts), cleared in afterEach.
  registerExtensionOperator('embeddingSimilar', embeddingSimilarOperator({ embedder, store }));

  // Seed real sample/Memo rows through the engine, then upsert each row's
  // embedding under its real id so knnSearch's datasetFor join finds bodies.
  const rows: SeededRow[] = [];
  for (const s of opts.seed ?? []) {
    const archived = s.archived ?? false;
    const name = `seed-${s.text}`;
    const writeRes = await server.inject(
      postReq('/substrate/v1/mutate', {
        'sample/createMemo': {
          params: {
            name,
            description: s.text,
            type: 'reference',
            body: s.text,
            archived,
            project: null
          },
          fields: { id: true }
        }
      })
    );
    const env = parseEnvelope(writeRes);
    if (env.errors !== undefined && env.errors.length > 0) {
      throw new Error(`createMemory failed: ${JSON.stringify(env.errors)}`);
    }
    const id = (env.data['sample/createMemo'] as { id: string }).id;
    const vector = await embedder.embed(s.text);
    await store.upsert({
      rowNamespace: 'sample',
      rowType: 'Memo',
      rowId: id,
      vector,
      model: embedder.modelId
    });
    rows.push({ id, text: s.text, name, archived, vector: Array.from(vector) });
  }

  return {
    composed,
    server,
    store,
    embedder,
    rows,
    query: (frame) => server.inject(postReq('/substrate/v1/query', frame))
  };
}

/** Flush the operator's fire-and-forget boost microtask chain. */
async function flushMicrotasks(): Promise<void> {
  // 5 turns drains the current boost chain; bump if it deepens. An
  // under-flush here is a FALSE GREEN on the boost:false test (a scheduled
  // boost that hasn't landed looks identical to no boost).
  for (let i = 0; i < 5; i++) await Promise.resolve();
  await new Promise<void>((r) => setImmediate(r));
}

function hits(res: SubstrateResponse): Array<Record<string, unknown>> {
  return parseEnvelope(res).data['sample/Memo'] as Array<Record<string, unknown>>;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('semantic frame query end-to-end', () => {
  const harnesses: Harness[] = [];

  afterEach(async () => {
    clearExtensionOperators();
    while (harnesses.length > 0) {
      const h = harnesses.pop();
      if (h !== undefined) await h.composed.stop();
    }
  });

  function track(h: Harness): Harness {
    harnesses.push(h);
    return h;
  }

  // 1. Relevance ordering + numeric descending _score.
  it('rows come back in relevance order, each carrying a numeric descending _score', async () => {
    const h = track(await bootHarness({ seed: SEED }));
    const res = await h.query({
      'sample/Memo': {
        params: { where: { embeddingSimilar: { to: QUERY, boost: false } } },
        fields: { id: true, name: true, _score: true }
      }
    });
    expect(res.status).toBe(200);
    const rows = hits(res);

    // Relevance order: seed-row-4 (0.53) → seed-row-6 (0.40) → seed-row-1 (0.25).
    expect(rows.map((r) => r.name)).toEqual([
      'seed-seed-row-4',
      'seed-seed-row-6',
      'seed-seed-row-1'
    ]);
    // Every row carries a numeric _score, strictly descending.
    const scores = rows.map((r) => r._score as number);
    expect(scores.every((s) => typeof s === 'number')).toBe(true);
    expect(scores[0]).toBeGreaterThan(scores[1]!);
    expect(scores[1]).toBeGreaterThan(scores[2]!);
  });

  // 2. Structural AND intersection — the k-semantics documentation case.
  it('top-k semantic hits THEN filtered — k is not a result-count guarantee', async () => {
    // The strongest row (seed-row-4) is archived. It is a top-k semantic hit,
    // but the structural archived:false clause intersects it OUT — so the page
    // is the survivors (seed-row-6, seed-row-1) in relevance order, NOT k rows.
    const h = track(
      await bootHarness({
        seed: [
          { text: 'seed-row-4', archived: true },
          { text: 'seed-row-6' },
          { text: 'seed-row-1' }
        ]
      })
    );
    const res = await h.query({
      'sample/Memo': {
        params: {
          where: { embeddingSimilar: { to: QUERY, boost: false }, archived: { eq: false } }
        },
        fields: { id: true, name: true, _score: true }
      }
    });
    expect(res.status).toBe(200);
    const rows = hits(res);

    // The highest-scoring row is gone despite its score; survivors keep order.
    expect(rows.map((r) => r.name)).toEqual(['seed-seed-row-6', 'seed-seed-row-1']);
    const scores = rows.map((r) => r._score as number);
    expect(scores[0]).toBeGreaterThan(scores[1]!);
  });

  // 3. Threshold cut.
  it('threshold cuts the weakest row, leaving only stronger hits', async () => {
    const h = track(await bootHarness({ seed: SEED }));
    // 0.3 sits between seed-row-1 (0.25) and seed-row-6 (0.40): cuts the weakest.
    const res = await h.query({
      'sample/Memo': {
        params: { where: { embeddingSimilar: { to: QUERY, threshold: 0.3, boost: false } } },
        fields: { id: true, name: true, _score: true }
      }
    });
    expect(res.status).toBe(200);
    const rows = hits(res);

    expect(rows.map((r) => r.name)).toEqual(['seed-seed-row-4', 'seed-seed-row-6']);
    expect(rows.map((r) => r._score as number).every((s) => s >= 0.3)).toBe(true);
  });

  // 4. Explicit orderBy wins over relevance order.
  it('explicit orderBy overrides relevance order', async () => {
    const h = track(await bootHarness({ seed: SEED }));
    const res = await h.query({
      'sample/Memo': {
        params: {
          where: { embeddingSimilar: { to: QUERY, boost: false } },
          orderBy: [{ name: 'asc' }]
        },
        fields: { id: true, name: true, _score: true }
      }
    });
    expect(res.status).toBe(200);
    const rows = hits(res);

    // Name-asc, NOT relevance: seed-seed-row-1 < seed-seed-row-4 < seed-seed-row-6.
    expect(rows.map((r) => r.name)).toEqual([
      'seed-seed-row-1',
      'seed-seed-row-4',
      'seed-seed-row-6'
    ]);
  });

  // 5. _vector round-trip.
  it('projecting _vector returns the seeded embedding vector per row', async () => {
    const h = track(await bootHarness({ seed: SEED }));
    const res = await h.query({
      'sample/Memo': {
        params: { where: { embeddingSimilar: { to: QUERY, boost: false } } },
        fields: { id: true, name: true, _vector: true }
      }
    });
    expect(res.status).toBe(200);
    const rows = hits(res);

    const byName = new Map(h.rows.map((r) => [r.name, r.vector]));
    for (const row of rows) {
      const expected = byName.get(row.name as string);
      expect(expected).toBeDefined();
      const vec = row._vector as number[];
      expect(vec).toHaveLength(DIM);
      expect(vec).toEqual(expected);
    }
  });

  // 6. computed_field_unavailable end-to-end over real HTTP.
  it('projecting _score with a structural-only where errors computed_field_unavailable over HTTP', async () => {
    const h = track(await bootHarness({ seed: SEED }));
    const res = await h.query({
      'sample/Memo': {
        params: { where: { archived: { eq: false } } },
        fields: { id: true, _score: true }
      }
    });
    expect(res.status).toBe(200); // envelope errors are per-key, not transport-level
    const errs = parseEnvelope(res).errors ?? [];
    expect(errs).toHaveLength(1);
    expect(errs[0]?.code).toBe('computed_field_unavailable');
    expect(errs[0]?.path).toEqual(['sample/Memo', '_score']);
    expect(errs[0]?.message).toContain('_score');
  });

  // 7. boost:false honored end-to-end — store salience unchanged after the query.
  it('boost:false leaves store salience untouched after the query', async () => {
    const h = track(await bootHarness({ seed: SEED }));
    const res = await h.query({
      'sample/Memo': {
        params: { where: { embeddingSimilar: { to: QUERY, boost: false } } },
        fields: { id: true, _score: true }
      }
    });
    expect(res.status).toBe(200);
    await flushMicrotasks(); // give any (wrongly) scheduled boost a chance to land

    // Read salience back: a vanilla knnSearch carries each row's salience. With
    // boost:false the operator must NOT have reinforced anything → all zero.
    const queryVec = await h.embedder.embed(QUERY);
    const knn = await h.store.knnSearch({
      namespace: 'sample',
      type: 'Memo',
      model: h.embedder.modelId,
      vector: queryVec,
      k: 10
    });
    expect(knn.length).toBe(SEED.length);
    expect(knn.every((r) => r.salience === 0)).toBe(true);
  });
});

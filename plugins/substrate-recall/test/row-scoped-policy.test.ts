/**
 * A row-scoped read policy (`row()` in substrate-policy) allows at the type
 * level and hides rows through a `row-filter` obligation. Every recall
 * surface evaluates it per row with the caller's request context.
 */

import type { Embedder } from '@mnmal-ai/substrate-embedder';
import type {
  Identity,
  PolicyDecision,
  RequestContext,
  SubstrateRequest
} from '@mnmal-ai/substrate-types';
import { describe, expect, it } from 'vitest';
import type { EmbeddingsStore, SalienceTarget } from '../src/embeddings-store.js';
import { createRecallPlugin } from '../src/plugin.js';
import { handleRecallRequest } from '../src/recall-route.js';

const ALICE: Identity = { id: 'alice', grants: { '*': ['read', 'mutate'] } };
const BOB: Identity = { id: 'bob', grants: { '*': ['read', 'mutate'] } };
const VEC = new Float32Array([1, 0, 0]);

const note = (id: string, owner: string) => ({ id, owner, body: `${owner} secret ${id}` });
// Ranked best-first: alice's two notes outrank bob's three.
const NOTES = [
  note('a-1', 'alice'),
  note('a-2', 'alice'),
  note('b-1', 'bob'),
  note('b-2', 'bob'),
  note('b-3', 'bob')
];

// What `row((ctx, r) => r.owner === ctx.identity?.id)` evaluates to on Note.
function ownerOnlyNotes(_ns: string, type: string): PolicyDecision {
  if (type !== 'Note') return { allow: true };
  return {
    allow: true,
    obligations: [
      {
        kind: 'row-filter',
        predicate: (ctx: RequestContext, r: { owner?: unknown }) => r.owner === ctx.identity?.id
      }
    ]
  };
}

function makeStore(): { store: EmbeddingsStore; boosted: SalienceTarget[] } {
  const boosted: SalienceTarget[] = [];
  const store: EmbeddingsStore = {
    txScopeId: 'test-store',
    delete: async () => undefined,
    upsert: async () => undefined,
    knnSearch: async (input) =>
      NOTES.slice(0, input.k).map((row, i) => ({ row, score: 0.9 - i / 100, salience: 0 })),
    boostSalience: async (targets) => {
      boosted.push(...targets);
      return [...targets];
    },
    fetchEmbeddings: async (ids) =>
      NOTES.filter((n) => ids.some((i) => i.type === 'Note' && i.id === n.id)).map((row) => ({
        namespace: 'ns',
        type: 'Note',
        id: row.id,
        row,
        vector: VEC,
        salience: 0
      })),
    selectCandidates: async () => []
  };
  return { store, boosted };
}

const embedder: Embedder = { modelId: 'fake/test', dimension: 3, embed: async () => VEC };

function req(path: string, body: unknown, identity: Identity): SubstrateRequest {
  return {
    method: 'POST',
    path,
    headers: { 'content-type': 'application/json' },
    query: {},
    params: {},
    body: Buffer.from(JSON.stringify(body), 'utf8'),
    identity
  };
}

function setup() {
  const { store, boosted } = makeStore();
  const plugin = createRecallPlugin({
    store,
    embedder,
    checkReadPolicy: ownerOnlyNotes,
    checkWritePolicy: () => ({ allow: true })
  });
  const call = async (path: string, body: unknown, who: Identity) => {
    const handler = plugin.kernelRoutes?.find((r) => r.path === path)?.handler;
    const res = await handler!(req(`/substrate/v1/${path}`, body, who));
    return { status: res.status, body: JSON.parse(String(res.body)) };
  };
  return { call, boosted };
}

const ids = (rows: Array<{ row?: { id?: unknown }; id?: unknown }>) =>
  rows.map((r) => r.row?.id ?? r.id);

describe('row-scoped read policy on recall surfaces', () => {
  it("hides alice's notes from bob's recall and fills k from visible rows", async () => {
    const { call } = setup();
    const query = { query: 'secret', namespace: 'ns', type: 'Note', k: 3, boost: false };
    const bob = await call('recall', query, BOB);
    expect(bob.status).toBe(200);
    expect(ids(bob.body.rows)).toEqual(['b-1', 'b-2', 'b-3']);
    const alice = await call('recall', { ...query, k: 2 }, ALICE);
    expect(ids(alice.body.rows)).toEqual(['a-1', 'a-2']);
  });

  it("drops alice's note when bob's expansion reaches it", async () => {
    const { store } = makeStore();
    const run = (who: Identity) =>
      handleRecallRequest(
        { query: 'secret', namespace: 'ns', type: 'Memory', expand: true, boost: false },
        {
          embedder,
          store: {
            ...store,
            knnSearch: async () => [{ row: { id: 'm-1' }, score: 0.5, salience: 0 }]
          },
          expansionResolver: async () => [
            { namespace: 'ns', type: 'Note', id: 'a-1', seedId: 'm-1', allowsCrossType: true }
          ],
          checkReadPolicy: ownerOnlyNotes,
          caller: { identity: who, now: new Date(), headers: {}, meta: {} }
        }
      );
    expect(ids((await run(BOB)).rows)).toEqual(['m-1']);
    expect(ids((await run(ALICE)).rows)).toContain('a-1');
  });

  it("serves alice's note to alice and not to bob on embeddings/fetch", async () => {
    const { call } = setup();
    const body = { refs: [{ namespace: 'ns', type: 'Note', id: 'a-1' }] };
    expect((await call('embeddings/fetch', body, BOB)).body.vectors).toEqual([]);
    expect(ids((await call('embeddings/fetch', body, ALICE)).body.vectors)).toEqual(['a-1']);
  });

  it("does not let bob boost alice's note", async () => {
    const { call, boosted } = setup();
    const body = { targets: [{ namespace: 'ns', type: 'Note', id: 'a-1' }] };
    const bob = await call('salience/boost', body, BOB);
    expect(bob.body.applied).toBe(0);
    expect(boosted).toEqual([]);
    const alice = await call('salience/boost', body, ALICE);
    expect(alice.body.applied).toBe(1);
  });
});

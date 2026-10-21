/**
 * crossRef edge sync on update.
 *
 * The create path (`createResolverWithEdges`) writes a first-class EdgesStore
 * edge per crossRef value. Repointing a crossRef via update must move the
 * edge too, or the sweep's applyPolicy walks a stale edge for onDelete.
 *
 * `reconcileCrossRefEdgesOnUpdate` is unit-tested directly against a bare
 * EdgesStore; the second describe block drives the same behaviour through
 * the real `updateResolver` to prove the wiring, not just the helper.
 */

import { MemoryEdgesStore } from '@mnmal-ai/substrate-core';
import { MemoryDataset } from '@mnmal-ai/substrate-dataset-memory';
import type { Edge, EdgeRef, RequestContext } from '@mnmal-ai/substrate-types';
import { beforeEach, describe, expect, it } from 'vitest';
import { reconcileCrossRefEdgesOnUpdate } from '../../src/autocrud/crossref-edge-sync.js';
import type { CrossRefFieldInfo } from '../../src/autocrud/crossref-existence.js';
import { createResolverWithEdges, updateResolver } from '../../src/autocrud/index.js';
import { field } from '../../src/field.js';

function makeEdgesStore(): MemoryEdgesStore {
  return new MemoryEdgesStore({ now: () => new Date('2026-07-12T00:00:00Z') });
}

/**
 * Re-read an edge from the store by id, including tombstoned ones.
 *
 * The store copies on the way out, so an object captured from `write` would
 * not reflect a later tombstone and `toBeUndefined()` checks on it would pass
 * vacuously.
 */
async function reread(store: MemoryEdgesStore, id: string): Promise<Edge | undefined> {
  const { edges } = await store.readNextBatch(null, 1000);
  return edges.find((e) => e.id === id);
}

const TRACE_CROSSREF: CrossRefFieldInfo = {
  fieldName: 'trace',
  def: field.crossRef('main', 'Trace', { nullable: true })
};

describe('reconcileCrossRefEdgesOnUpdate (unit)', () => {
  const owner: EdgeRef = { ns: 'main', type: 'Constituent', id: 'c1' };
  let edges: MemoryEdgesStore;

  beforeEach(() => {
    edges = makeEdgesStore();
  });

  it('repoints A -> B: tombstones the old edge, exactly one live edge remains at B', async () => {
    const oldEdge = await edges.write({
      from: owner,
      to: { ns: 'main', type: 'Trace', id: 'a' },
      fieldName: 'trace',
      policy: 'set_null'
    });

    await reconcileCrossRefEdgesOnUpdate(edges, owner, [TRACE_CROSSREF], { trace: 'b' });

    expect((await reread(edges, oldEdge.id))?.deletedAt).toBeInstanceOf(Date);
    const live = await edges.findEdgesFrom(owner);
    expect(live).toHaveLength(1);
    expect(live[0]?.to).toEqual({ ns: 'main', type: 'Trace', id: 'b' });
  });

  it('sets the crossRef to null: the edge is removed, zero live edges remain', async () => {
    const oldEdge = await edges.write({
      from: owner,
      to: { ns: 'main', type: 'Trace', id: 'a' },
      fieldName: 'trace',
      policy: 'set_null'
    });

    await reconcileCrossRefEdgesOnUpdate(edges, owner, [TRACE_CROSSREF], { trace: null });

    expect((await reread(edges, oldEdge.id))?.deletedAt).toBeInstanceOf(Date);
    expect(await edges.findEdgesFrom(owner)).toHaveLength(0);
  });

  it('same value: no churn — edge id and createdAt are unchanged', async () => {
    const oldEdge = await edges.write({
      from: owner,
      to: { ns: 'main', type: 'Trace', id: 'a' },
      fieldName: 'trace',
      policy: 'set_null'
    });

    await reconcileCrossRefEdgesOnUpdate(edges, owner, [TRACE_CROSSREF], { trace: 'a' });

    expect((await reread(edges, oldEdge.id))?.deletedAt).toBeUndefined();
    const live = await edges.findEdgesFrom(owner);
    expect(live).toHaveLength(1);
    expect(live[0]?.id).toBe(oldEdge.id);
    expect(live[0]?.createdAt).toEqual(oldEdge.createdAt);
  });

  it('field absent from the patch: the existing edge is left untouched', async () => {
    const oldEdge = await edges.write({
      from: owner,
      to: { ns: 'main', type: 'Trace', id: 'a' },
      fieldName: 'trace',
      policy: 'set_null'
    });

    await reconcileCrossRefEdgesOnUpdate(edges, owner, [TRACE_CROSSREF], { unrelated: 'x' });

    expect((await reread(edges, oldEdge.id))?.deletedAt).toBeUndefined();
    const live = await edges.findEdgesFrom(owner);
    expect(live).toHaveLength(1);
    expect(live[0]?.id).toBe(oldEdge.id);
  });

  it('field newly set with no prior edge: a new edge is created', async () => {
    expect(await edges.findEdgesFrom(owner)).toHaveLength(0);

    await reconcileCrossRefEdgesOnUpdate(edges, owner, [TRACE_CROSSREF], { trace: 'z' });

    const live = await edges.findEdgesFrom(owner);
    expect(live).toHaveLength(1);
    expect(live[0]?.to).toEqual({ ns: 'main', type: 'Trace', id: 'z' });
  });

  it('numeric id: same value coerced to string — no churn', async () => {
    const oldEdge = await edges.write({
      from: owner,
      to: { ns: 'main', type: 'Trace', id: 1 },
      fieldName: 'trace',
      policy: 'set_null'
    });

    await reconcileCrossRefEdgesOnUpdate(edges, owner, [TRACE_CROSSREF], { trace: 1 });

    expect((await reread(edges, oldEdge.id))?.deletedAt).toBeUndefined();
    const live = await edges.findEdgesFrom(owner);
    expect(live).toHaveLength(1);
    expect(live[0]?.id).toBe(oldEdge.id);
    expect(live[0]?.createdAt).toEqual(oldEdge.createdAt);
  });

  it('numeric id: different numeric value — repoint and tombstone', async () => {
    const oldEdge = await edges.write({
      from: owner,
      to: { ns: 'main', type: 'Trace', id: 1 },
      fieldName: 'trace',
      policy: 'set_null'
    });

    await reconcileCrossRefEdgesOnUpdate(edges, owner, [TRACE_CROSSREF], { trace: 2 });

    expect((await reread(edges, oldEdge.id))?.deletedAt).toBeInstanceOf(Date);
    const live = await edges.findEdgesFrom(owner);
    expect(live).toHaveLength(1);
    expect(live[0]?.to).toEqual({ ns: 'main', type: 'Trace', id: 2 });
  });

  it('multiple live edges for the same (from, fieldName) self-heal: all are tombstoned and exactly one live edge remains at the new target', async () => {
    const edgeA = await edges.write({
      from: owner,
      to: { ns: 'main', type: 'Trace', id: 'a' },
      fieldName: 'trace',
      policy: 'set_null'
    });
    const edgeB = await edges.write({
      from: owner,
      to: { ns: 'main', type: 'Trace', id: 'b' },
      fieldName: 'trace',
      policy: 'set_null'
    });

    await reconcileCrossRefEdgesOnUpdate(edges, owner, [TRACE_CROSSREF], { trace: 'c' });

    expect((await reread(edges, edgeA.id))?.deletedAt).toBeInstanceOf(Date);
    expect((await reread(edges, edgeB.id))?.deletedAt).toBeInstanceOf(Date);
    const live = await edges.findEdgesFrom(owner);
    expect(live).toHaveLength(1);
    expect(live[0]?.to).toEqual({ ns: 'main', type: 'Trace', id: 'c' });
  });

  it('multiple live edges self-heal even when the new value matches the first duplicate', async () => {
    // Two live edges for one (from, fieldName) — a broken invariant. Repointing
    // to the value the FIRST duplicate already holds must still tombstone BOTH
    // and leave exactly one live edge, not skip via the "unchanged" fast-path.
    const edgeA = await edges.write({
      from: owner,
      to: { ns: 'main', type: 'Trace', id: 'a' },
      fieldName: 'trace',
      policy: 'set_null'
    });
    const edgeB = await edges.write({
      from: owner,
      to: { ns: 'main', type: 'Trace', id: 'b' },
      fieldName: 'trace',
      policy: 'set_null'
    });

    const firstTarget = (await edges.findEdgesFrom(owner))[0]?.to.id;
    await reconcileCrossRefEdgesOnUpdate(edges, owner, [TRACE_CROSSREF], { trace: firstTarget });

    expect((await reread(edges, edgeA.id))?.deletedAt).toBeInstanceOf(Date);
    expect((await reread(edges, edgeB.id))?.deletedAt).toBeInstanceOf(Date);
    const live = await edges.findEdgesFrom(owner);
    expect(live).toHaveLength(1);
    expect(live[0]?.to).toEqual({ ns: 'main', type: 'Trace', id: firstTarget });
  });

  it('multi-field patch: two crossRef fields each independently repoint their own edge', async () => {
    const REF_A: CrossRefFieldInfo = {
      fieldName: 'refA',
      def: field.crossRef('main', 'Trace', { nullable: true })
    };
    const REF_B: CrossRefFieldInfo = {
      fieldName: 'refB',
      def: field.crossRef('main', 'Widget', { nullable: true })
    };

    const oldA = await edges.write({
      from: owner,
      to: { ns: 'main', type: 'Trace', id: 'a-old' },
      fieldName: 'refA',
      policy: 'set_null'
    });
    const oldB = await edges.write({
      from: owner,
      to: { ns: 'main', type: 'Widget', id: 'b-old' },
      fieldName: 'refB',
      policy: 'set_null'
    });

    await reconcileCrossRefEdgesOnUpdate(edges, owner, [REF_A, REF_B], {
      refA: 'a-new',
      refB: 'b-new'
    });

    expect((await reread(edges, oldA.id))?.deletedAt).toBeInstanceOf(Date);
    expect((await reread(edges, oldB.id))?.deletedAt).toBeInstanceOf(Date);

    const live = await edges.findEdgesFrom(owner);
    const liveA = live.filter((e) => e.fieldName === 'refA');
    const liveB = live.filter((e) => e.fieldName === 'refB');
    expect(liveA).toHaveLength(1);
    expect(liveA[0]?.to).toEqual({ ns: 'main', type: 'Trace', id: 'a-new' });
    expect(liveB).toHaveLength(1);
    expect(liveB[0]?.to).toEqual({ ns: 'main', type: 'Widget', id: 'b-new' });
  });
});

describe('updateResolver reconciles crossRef edges on repoint (integration)', () => {
  const fields = {
    id: field.string(),
    trace: field.crossRef('main', 'Trace', { nullable: true })
  };

  function ctxAt(at: string): RequestContext {
    return {
      identity: { kind: 'system', id: 'test', grants: { '*': ['read', 'mutate'] } },
      namespace: 'main',
      operation: 'mutate',
      now: new Date(at),
      headers: {},
      meta: {}
    };
  }

  it('repointing a crossRef via update tombstones the stale edge and leaves exactly one live edge at the new target', async () => {
    const ds = new MemoryDataset({ namespace: 'main' });
    const edges = makeEdgesStore();
    await ds.write('Trace', [{ id: 'old' }, { id: 'new' }]);

    const create = createResolverWithEdges('Constituent', ds, edges, { fields });
    const created = await create(ctxAt('2026-07-12T00:00:00Z'), {
      dataset: ds,
      edges,
      params: { id: 'c1', trace: 'old' }
    });

    const owner: EdgeRef = { ns: 'main', type: 'Constituent', id: created.id };
    const before = await edges.findEdgesFrom(owner);
    expect(before).toHaveLength(1);
    const staleEdge = before[0];
    // Narrow rather than optional-chain: every assertion below needs the id, and
    // a `?.` here would let a missing edge sail past as `undefined === undefined`.
    if (staleEdge === undefined) throw new Error('expected a stale edge to exist');
    expect(staleEdge.to).toEqual({ ns: 'main', type: 'Trace', id: 'old' });

    const update = updateResolver('Constituent', ds, edges, { fields });
    await update(ctxAt('2026-07-12T01:00:00Z'), {
      dataset: ds,
      edges,
      params: { id: 'c1', trace: 'new' }
    });

    // Re-read rather than inspecting the captured object: the store copies on
    // the way out, so a reference taken before the update describes the edge as
    // it was, not as it is.
    expect((await reread(edges, staleEdge.id))?.deletedAt).toBeInstanceOf(Date);

    const after = await edges.findEdgesFrom(owner);
    expect(after).toHaveLength(1);
    expect(after[0]?.to).toEqual({ ns: 'main', type: 'Trace', id: 'new' });
  });
});

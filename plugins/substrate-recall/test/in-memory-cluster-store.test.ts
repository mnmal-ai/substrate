import { beforeEach, describe, expect, it } from 'vitest';
import type { ClusterProvenance, ClusterStore } from '../src/cluster-store.js';
import { memberKey } from '../src/cluster-store.js';
import { InMemoryClusterStore } from '../src/in-memory-cluster-store.js';

const PROVENANCE: ClusterProvenance = {
  backend: 'wasm',
  backendVersion: '0.1.0',
  regime: 'normalised',
  seed: 42,
  params: { nComponents: 10, nNeighbors: 15, minClusterSize: 5 },
  model: 'nomic-embed-text:768'
};

const centroid = (...xs: number[]): Float32Array => new Float32Array(xs);

describe('InMemoryClusterStore', () => {
  let store: ClusterStore;

  beforeEach(() => {
    store = new InMemoryClusterStore({ txScopeId: 'test' });
  });

  const formCluster = async (id: string): Promise<void> => {
    await store.createCluster({
      id,
      centroid: centroid(1, 0),
      cohesion: 0.9,
      label: 'provisional',
      labelledBy: 'medoid',
      provenance: PROVENANCE
    });
  };

  it('createCluster returns a record with a monotonic shortId and zero members', async () => {
    const a = await store.createCluster({
      id: 'c1',
      centroid: centroid(1, 0),
      cohesion: 0.9,
      label: 'a',
      labelledBy: 'medoid',
      provenance: PROVENANCE
    });
    const b = await store.createCluster({
      id: 'c2',
      centroid: centroid(0, 1),
      cohesion: 0.8,
      label: 'b',
      labelledBy: 'medoid',
      provenance: PROVENANCE
    });
    expect(a.memberCount).toBe(0);
    expect(a.retiredAt).toBeNull();
    expect(a.lastAccretedAt).toBeNull();
    expect(b.shortId).toBeGreaterThan(a.shortId);
  });

  it('attachMembers bumps memberCount and stamps lastAccretedAt', async () => {
    await formCluster('c1');
    await store.attachMembers([
      {
        id: 'm1',
        clusterId: 'c1',
        ref: { namespace: 'cortext', type: 'Decision', id: 'd1' },
        origin: 'formation',
        similarity: 0.8
      },
      {
        id: 'm2',
        clusterId: 'c1',
        ref: { namespace: 'cortext', type: 'Memory', id: 'x1' },
        origin: 'accretion',
        similarity: 0.7
      }
    ]);
    const c = await store.getCluster('c1');
    expect(c?.memberCount).toBe(2);
    expect(c?.lastAccretedAt).toBeInstanceOf(Date);
  });

  it('attached members get distinct, increasing shortId values', async () => {
    await formCluster('c1');
    await store.attachMembers([
      {
        id: 'm1',
        clusterId: 'c1',
        ref: { namespace: 'cortext', type: 'Decision', id: 'd1' },
        origin: 'formation',
        similarity: 0.8
      },
      {
        id: 'm2',
        clusterId: 'c1',
        ref: { namespace: 'cortext', type: 'Memory', id: 'x1' },
        origin: 'accretion',
        similarity: 0.7
      }
    ]);
    const members = await store.listMembers('c1');
    const m1 = members.find((m) => m.id === 'm1');
    const m2 = members.find((m) => m.id === 'm2');
    expect(m1?.shortId).toEqual(expect.any(Number));
    expect(m2?.shortId).toEqual(expect.any(Number));
    expect(m2?.shortId).toBeGreaterThan(m1?.shortId as number);
  });

  it('re-attaching the same (cluster, member) pair is a no-op', async () => {
    await formCluster('c1');
    const member = {
      id: 'm1',
      clusterId: 'c1',
      ref: { namespace: 'cortext', type: 'Decision', id: 'd1' },
      origin: 'formation' as const,
      similarity: 0.8
    };
    await store.attachMembers([member]);
    await store.attachMembers([{ ...member, id: 'm1-again', similarity: 0.99 }]);
    const members = await store.listMembers('c1');
    expect(members.length).toBe(1);
    expect(members[0]?.similarity).toBe(0.8);
  });

  it('findClustersForMember walks back from a source row', async () => {
    await formCluster('c1');
    await store.attachMembers([
      {
        id: 'm1',
        clusterId: 'c1',
        ref: { namespace: 'cortext', type: 'Decision', id: 'd1' },
        origin: 'formation',
        similarity: 0.8
      }
    ]);
    const found = await store.findClustersForMember({
      namespace: 'cortext',
      type: 'Decision',
      id: 'd1'
    });
    expect(found.map((m) => m.clusterId)).toEqual(['c1']);
  });

  it('claimedMembers reports only live claims', async () => {
    await formCluster('c1');
    const claimed = { namespace: 'cortext', type: 'Decision', id: 'd1' };
    const free = { namespace: 'cortext', type: 'Decision', id: 'd2' };
    await store.attachMembers([
      { id: 'm1', clusterId: 'c1', ref: claimed, origin: 'formation', similarity: 0.8 }
    ]);

    expect(await store.claimedMembers([claimed, free])).toEqual(new Set([memberKey(claimed)]));

    await store.markDeparted([claimed]);
    expect(await store.claimedMembers([claimed, free])).toEqual(new Set());
  });

  it('markDeparted moves the row from memberCount to departedCount and is idempotent', async () => {
    await formCluster('c1');
    const ref = { namespace: 'cortext', type: 'Decision', id: 'd1' };
    await store.attachMembers([
      { id: 'm1', clusterId: 'c1', ref, origin: 'formation', similarity: 0.8 }
    ]);

    expect(await store.markDeparted([ref])).toBe(1);
    const after = await store.getCluster('c1');
    expect(after?.memberCount).toBe(0);
    expect(after?.departedCount).toBe(1);

    expect(await store.markDeparted([ref])).toBe(0);
  });

  it('a departed member is retained, not removed', async () => {
    await formCluster('c1');
    const ref = { namespace: 'cortext', type: 'Decision', id: 'd1' };
    await store.attachMembers([
      { id: 'm1', clusterId: 'c1', ref, origin: 'formation', similarity: 0.8 }
    ]);
    await store.markDeparted([ref]);

    expect(await store.listMembers('c1')).toEqual([]);
    const all = await store.listMembers('c1', { includeDeparted: true });
    expect(all.length).toBe(1);
    expect(all[0]?.departedAt).toBeInstanceOf(Date);
  });

  it('retire hides the cluster from the default listing but never deletes it', async () => {
    await formCluster('c1');
    await store.retire('c1');

    expect(await store.listClusters()).toEqual([]);
    const withRetired = await store.listClusters({ includeRetired: true });
    expect(withRetired.length).toBe(1);
    expect(withRetired[0]?.retiredAt).toBeInstanceOf(Date);
  });

  it('relabel replaces the label and flips labelledBy to agent', async () => {
    await formCluster('c1');
    const updated = await store.relabel('c1', 'Plugin loader architecture');
    expect(updated?.label).toBe('Plugin loader architecture');
    expect(updated?.labelledBy).toBe('agent');
    expect(await store.relabel('nope', 'x')).toBeNull();
  });

  it('listClusters returns oldest first', async () => {
    await store.createCluster({
      id: 'c1',
      centroid: centroid(1, 0),
      cohesion: 0.9,
      label: 'a',
      labelledBy: 'medoid',
      provenance: PROVENANCE,
      now: new Date('2026-01-01T00:00:00Z')
    });
    await store.createCluster({
      id: 'c2',
      centroid: centroid(0, 1),
      cohesion: 0.9,
      label: 'b',
      labelledBy: 'medoid',
      provenance: PROVENANCE,
      now: new Date('2026-01-02T00:00:00Z')
    });
    expect((await store.listClusters()).map((c) => c.id)).toEqual(['c1', 'c2']);
  });
});

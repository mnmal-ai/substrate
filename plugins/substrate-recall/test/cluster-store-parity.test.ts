import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ClusterProvenance, ClusterStore } from '../src/cluster-store.js';
import { memberKey } from '../src/cluster-store.js';
import { InMemoryClusterStore } from '../src/in-memory-cluster-store.js';
import { recallClustersMigration } from '../src/migrations/0002_recall_clusters.js';
import { PgClusterStore } from '../src/pg-cluster-store.js';

const POSTGRES_URL = process.env.POSTGRES_URL;
const isPgGated = POSTGRES_URL !== undefined;
const DIM = 8;

const PROVENANCE: ClusterProvenance = {
  backend: 'wasm',
  backendVersion: '0.1.0',
  regime: 'normalised',
  seed: 42,
  params: { nComponents: 10, nNeighbors: 15, minClusterSize: 5 },
  model: 'nomic-embed-text:768'
};

const centroid = (first: number): Float32Array => {
  const v = new Float32Array(DIM);
  v[0] = first;
  v[1] = 1 - first;
  return v;
};

let sql: ReturnType<typeof postgres> | undefined;

beforeAll(async () => {
  if (!isPgGated) return;
  sql = postgres(POSTGRES_URL as string, { onnotice: () => {} });
  await sql`DROP TABLE IF EXISTS recall_cluster_members CASCADE`;
  await sql`DROP TABLE IF EXISTS recall_clusters CASCADE`;
  await recallClustersMigration({ dimension: DIM }).apply({ sql, metric: () => {} });
});

afterAll(async () => {
  if (sql === undefined) return;
  await sql`DROP TABLE IF EXISTS recall_cluster_members CASCADE`;
  await sql`DROP TABLE IF EXISTS recall_clusters CASCADE`;
  await sql.end();
});

interface Impl {
  name: string;
  skip: boolean;
  make: () => Promise<ClusterStore>;
}

const IMPLS: Impl[] = [
  {
    name: 'InMemoryClusterStore',
    skip: false,
    make: async (): Promise<ClusterStore> => new InMemoryClusterStore({ txScopeId: 'mem' })
  },
  {
    name: 'PgClusterStore',
    skip: !isPgGated,
    make: async (): Promise<ClusterStore> => {
      const handle = sql as ReturnType<typeof postgres>;
      await handle`TRUNCATE recall_cluster_members, recall_clusters`;
      return new PgClusterStore({ sql: handle });
    }
  }
];

for (const impl of IMPLS) {
  describe.skipIf(impl.skip)(`ClusterStore parity — ${impl.name}`, () => {
    let store: ClusterStore;

    beforeEach(async () => {
      store = await impl.make();
    });

    const form = async (id: string, first = 1): Promise<void> => {
      await store.createCluster({
        id,
        centroid: centroid(first),
        cohesion: 0.9,
        label: 'provisional',
        labelledBy: 'medoid',
        provenance: PROVENANCE
      });
    };

    it('round-trips a cluster including centroid, provenance and regime', async () => {
      await form('c1', 0.25);
      const got = await store.getCluster('c1');
      expect(got?.label).toBe('provisional');
      expect(got?.labelledBy).toBe('medoid');
      expect(got?.cohesion).toBeCloseTo(0.9, 6);
      expect(got?.provenance).toEqual(PROVENANCE);
      expect(got?.provenance.regime).toBe('normalised');
      expect(got?.provenance.backend).toBe('wasm');
      expect(Array.from(got?.centroid ?? [])).toEqual(Array.from(centroid(0.25)));
      expect(got?.memberCount).toBe(0);
      expect(got?.retiredAt).toBeNull();
    });

    it('attachMembers updates counts and lastAccretedAt', async () => {
      await form('c1');
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
      expect(c?.departedCount).toBe(0);
      expect(c?.lastAccretedAt).toBeInstanceOf(Date);

      const members = await store.listMembers('c1');
      expect(members.map((m) => m.origin).sort()).toEqual(['accretion', 'formation']);
    });

    it('re-attaching the same pair is a no-op', async () => {
      await form('c1');
      const firstNow = new Date('2026-01-01T00:00:00Z');
      const secondNow = new Date('2026-01-02T00:00:00Z');
      const member = {
        id: 'm1',
        clusterId: 'c1',
        ref: { namespace: 'cortext', type: 'Decision', id: 'd1' },
        origin: 'formation' as const,
        similarity: 0.8
      };
      await store.attachMembers([{ ...member, now: firstNow }]);
      const afterFirst = await store.getCluster('c1');

      // Duplicate-only batch, stamped with a DIFFERENT `now` — a true no-op
      // must leave both the counters and `lastAccretedAt` exactly as the
      // first attach left them. If the store recounted/restamped on this
      // batch anyway, `lastAccretedAt` would move to `secondNow` here.
      await store.attachMembers([{ ...member, id: 'm-again', similarity: 0.99, now: secondNow }]);
      const members = await store.listMembers('c1');
      expect(members.length).toBe(1);
      expect(members[0]?.similarity).toBeCloseTo(0.8, 6);

      const afterSecond = await store.getCluster('c1');
      expect(afterSecond?.memberCount).toBe(afterFirst?.memberCount);
      expect(afterSecond?.lastAccretedAt?.getTime()).toBe(afterFirst?.lastAccretedAt?.getTime());
      expect(afterSecond?.lastAccretedAt?.getTime()).toBe(firstNow.getTime());
    });

    it('claimedMembers reports live claims only', async () => {
      await form('c1');
      const claimed = { namespace: 'cortext', type: 'Decision', id: 'd1' };
      const free = { namespace: 'cortext', type: 'Decision', id: 'd2' };
      await store.attachMembers([
        { id: 'm1', clusterId: 'c1', ref: claimed, origin: 'formation', similarity: 0.8 }
      ]);
      expect(await store.claimedMembers([claimed, free])).toEqual(new Set([memberKey(claimed)]));
      await store.markDeparted([claimed]);
      expect(await store.claimedMembers([claimed, free])).toEqual(new Set());
    });

    it('markDeparted retains the row, moves the counters, and is idempotent', async () => {
      await form('c1');
      const ref = { namespace: 'cortext', type: 'Decision', id: 'd1' };
      await store.attachMembers([
        { id: 'm1', clusterId: 'c1', ref, origin: 'formation', similarity: 0.8 }
      ]);
      expect(await store.markDeparted([ref])).toBe(1);
      expect(await store.markDeparted([ref])).toBe(0);

      const c = await store.getCluster('c1');
      expect(c?.memberCount).toBe(0);
      expect(c?.departedCount).toBe(1);
      expect(await store.listMembers('c1')).toEqual([]);
      const all = await store.listMembers('c1', { includeDeparted: true });
      expect(all.length).toBe(1);
      expect(all[0]?.departedAt).toBeInstanceOf(Date);
    });

    it('listAllMembers spans every cluster — retired ones included — and omits departed rows', async () => {
      await form('c1');
      await form('c2');
      const refs = {
        live: { namespace: 'cortext', type: 'Decision', id: 'd1' },
        gone: { namespace: 'cortext', type: 'Decision', id: 'd2' },
        stranded: { namespace: 'cortext', type: 'Memory', id: 'x1' }
      };
      await store.attachMembers([
        { id: 'm1', clusterId: 'c1', ref: refs.live, origin: 'formation', similarity: 0.8 },
        { id: 'm2', clusterId: 'c1', ref: refs.gone, origin: 'formation', similarity: 0.8 },
        { id: 'm3', clusterId: 'c2', ref: refs.stranded, origin: 'accretion', similarity: 0.7 }
      ]);
      await store.markDeparted([refs.gone]);
      // c2 is retired with its member still attached — the exact state the
      // decay sweep self-heals, and the reason this listing cannot be
      // live-clusters-only: those survivors are invisible to `listClusters()`.
      await store.retire('c2');

      const all = await store.listAllMembers();
      expect(
        all
          .map((m) => memberKey({ namespace: m.memberNs, type: m.memberType, id: m.memberId }))
          .sort()
      ).toEqual(['cortext/Decision/d1', 'cortext/Memory/x1']);
      expect(all.map((m) => m.clusterId).sort()).toEqual(['c1', 'c2']);
      expect(all.every((m) => m.departedAt === null)).toBe(true);
    });

    it('findClustersForMember walks back from a source row', async () => {
      await form('c1');
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

    it('retire hides but never deletes', async () => {
      await form('c1');
      await store.retire('c1');
      expect(await store.listClusters()).toEqual([]);
      const withRetired = await store.listClusters({ includeRetired: true });
      expect(withRetired.length).toBe(1);
      expect(withRetired[0]?.retiredAt).toBeInstanceOf(Date);
    });

    it('relabel flips labelledBy to agent; unknown id returns null', async () => {
      await form('c1');
      const updated = await store.relabel('c1', 'Plugin loader architecture');
      expect(updated?.label).toBe('Plugin loader architecture');
      expect(updated?.labelledBy).toBe('agent');
      expect(await store.relabel('nope', 'x')).toBeNull();
    });

    it('listClusters is oldest-first', async () => {
      await store.createCluster({
        id: 'c1',
        centroid: centroid(1),
        cohesion: 0.9,
        label: 'a',
        labelledBy: 'medoid',
        provenance: PROVENANCE,
        now: new Date('2026-01-01T00:00:00Z')
      });
      await store.createCluster({
        id: 'c2',
        centroid: centroid(0),
        cohesion: 0.9,
        label: 'b',
        labelledBy: 'medoid',
        provenance: PROVENANCE,
        now: new Date('2026-01-02T00:00:00Z')
      });
      expect((await store.listClusters()).map((c) => c.id)).toEqual(['c1', 'c2']);
    });

    it('attachMembers spanning two clusters stamps each cluster with its own now', async () => {
      await form('c1');
      await form('c2', 0.5);
      const earlier = new Date('2026-01-01T00:00:00Z');
      const later = new Date('2026-01-02T00:00:00Z');
      await store.attachMembers([
        {
          id: 'm1',
          clusterId: 'c1',
          ref: { namespace: 'cortext', type: 'Decision', id: 'd1' },
          origin: 'formation',
          similarity: 0.8,
          now: earlier
        },
        {
          id: 'm2',
          clusterId: 'c2',
          ref: { namespace: 'cortext', type: 'Decision', id: 'd2' },
          origin: 'formation',
          similarity: 0.8,
          now: later
        }
      ]);
      const c1 = await store.getCluster('c1');
      const c2 = await store.getCluster('c2');
      expect(c1?.lastAccretedAt?.getTime()).toBe(earlier.getTime());
      expect(c2?.lastAccretedAt?.getTime()).toBe(later.getTime());
    });
  });
}

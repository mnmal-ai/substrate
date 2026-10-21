import { beforeEach, describe, expect, it } from 'vitest';
import type { Candidate, CandidateSelector } from '../src/candidate-selection.js';
import type { ClusterProvenance, ClusterStore, MemberRef } from '../src/cluster-store.js';
import { memberKey } from '../src/cluster-store.js';
import type { CrystalliseCoreDeps } from '../src/crystallise-core.js';
import { DEFAULT_CRYSTALLISE_CONFIG, handleCrystallise } from '../src/crystallise-core.js';
import type { EmbeddingsStore } from '../src/embeddings-store.js';
import { InMemoryClusterStore } from '../src/in-memory-cluster-store.js';

const MODEL = 'fake:3';
const SELECT: CandidateSelector = {
  scopes: [{ namespace: 'cortext', type: 'Decision' }],
  excludeTextPrefixes: [],
  limit: 100
};
const PROVENANCE: ClusterProvenance = {
  backend: 'wasm',
  backendVersion: '0.1.0',
  regime: 'normalised',
  seed: 42,
  params: { nComponents: 10, nNeighbors: 15, minClusterSize: 3 },
  model: MODEL
};

const candidate = (id: string, vector: number[]): Candidate => ({
  namespace: 'cortext',
  type: 'Decision',
  id,
  vector: new Float32Array(vector),
  row: { id, title: id }
});

function fakeEmbeddings(rows: Candidate[]): EmbeddingsStore {
  return {
    txScopeId: 'fake',
    upsert: async (): Promise<void> => {},
    knnSearch: async (): Promise<never[]> => [],
    boostSalience: async (): Promise<[]> => [],
    fetchEmbeddings: async (): Promise<never[]> => [],
    selectCandidates: async (): Promise<Candidate[]> => rows.map((r) => ({ ...r }))
  } as unknown as EmbeddingsStore;
}

describe('handleCrystallise — staleness', () => {
  let clusters: ClusterStore;
  let deps: CrystalliseCoreDeps;
  let alive: Set<string>;
  let idSeq: number;
  let probeCalls: MemberRef[][];

  beforeEach(async () => {
    clusters = new InMemoryClusterStore({ txScopeId: 'mem' });
    idSeq = 0;
    alive = new Set(['d1', 'd2', 'd3', 'd4']);
    probeCalls = [];
    deps = {
      embeddings: fakeEmbeddings([]),
      clusters,
      model: MODEL,
      config: { ...DEFAULT_CRYSTALLISE_CONFIG, minClusterSize: 3 },
      newId: (): string => `id-${++idSeq}`,
      now: (): Date => new Date('2026-08-06T12:00:00Z'),
      runClusterer: async (): Promise<number[]> => {
        throw new Error('staleness must not run the clusterer');
      },
      rowsMissing: async (refs: readonly MemberRef[]): Promise<Set<string>> => {
        probeCalls.push([...refs]);
        return new Set(refs.filter((r) => !alive.has(r.id)).map(memberKey));
      }
    };

    await clusters.createCluster({
      id: 'cA',
      centroid: new Float32Array([1, 0, 0]),
      cohesion: 0.95,
      label: 'seed',
      labelledBy: 'medoid',
      provenance: PROVENANCE
    });
    await clusters.attachMembers(
      ['d1', 'd2', 'd3', 'd4'].map((id, i) => ({
        id: `m${i}`,
        clusterId: 'cA',
        ref: { namespace: 'cortext', type: 'Decision', id },
        origin: 'formation' as const,
        similarity: 0.9
      }))
    );
  });

  it('marks a member whose source row is gone as departed, not removed', async () => {
    alive.delete('d4');
    const out = await handleCrystallise({ mode: 'accrete', select: SELECT }, deps);

    expect(out.departed).toBe(1);
    const cluster = await clusters.getCluster('cA');
    expect(cluster?.memberCount).toBe(3);
    expect(cluster?.departedCount).toBe(1);

    // Exactly at the floor (3 live against minClusterSize: 3) must NOT
    // retire — "falls below" is strict-less-than, not "at or below".
    expect(out.retired).toBe(0);
    expect(cluster?.retiredAt).toBeNull();
    expect(await clusters.listClusters()).toHaveLength(1);

    const all = await clusters.listMembers('cA', { includeDeparted: true });
    expect(all.length).toBe(4);
    expect(all.find((m) => m.memberId === 'd4')?.departedAt).toBeInstanceOf(Date);
  });

  it('retires a cluster once live membership falls below minClusterSize, and releases its survivors', async () => {
    alive.delete('d3');
    alive.delete('d4');
    const out = await handleCrystallise({ mode: 'accrete', select: SELECT }, deps);

    // Two members departed because their source rows are gone (d3, d4) — the
    // two survivors (d1, d2) are NOT counted here: they are released because
    // their cluster retired, not because their own row vanished.
    expect(out.departed).toBe(2);
    expect(out.retired).toBe(1);
    expect(await clusters.listClusters()).toEqual([]);

    const [retired] = await clusters.listClusters({ includeRetired: true });
    expect(retired?.retiredAt).toBeInstanceOf(Date);
    // Regression: retirement must release surviving members, since
    // claimedMembers checks only `departedAt` and there is no un-retire. All 4
    // are departed — 2 rows vanished, 2 released by the retirement.
    expect(retired?.memberCount).toBe(0);
    expect(retired?.departedCount).toBe(4);

    const all = await clusters.listMembers('cA', { includeDeparted: true });
    expect(all.find((m) => m.memberId === 'd1')?.departedAt).toBeInstanceOf(Date);
    expect(all.find((m) => m.memberId === 'd2')?.departedAt).toBeInstanceOf(Date);
  });

  it('retires against the floor recorded in its OWN provenance, not the ambient config', async () => {
    // cB was formed under a per-request minClusterSize:2 override — looser
    // than the ambient config's minClusterSize:3 wired into `deps` above.
    // Provenance is where that override is durably recorded (crystallise-core
    // stamps `params.minClusterSize` from the request, falling back to
    // config only when no override was given).
    alive.add('e1').add('e2').add('e3');
    await clusters.createCluster({
      id: 'cB',
      centroid: new Float32Array([0, 1, 0]),
      cohesion: 0.9,
      label: 'seed-b',
      labelledBy: 'medoid',
      provenance: { ...PROVENANCE, params: { ...PROVENANCE.params, minClusterSize: 2 } }
    });
    await clusters.attachMembers(
      ['e1', 'e2', 'e3'].map((id, i) => ({
        id: `mb${i}`,
        clusterId: 'cB',
        ref: { namespace: 'cortext', type: 'Decision', id },
        origin: 'formation' as const,
        similarity: 0.9
      }))
    );

    // Drop cB to 2 live members. Against its OWN floor (2) that must NOT
    // retire; against the ambient config floor (3) it would.
    alive.delete('e3');
    const out = await handleCrystallise({ mode: 'accrete', select: SELECT }, deps);

    expect(out.retired).toBe(0);
    const cB = await clusters.getCluster('cB');
    expect(cB?.retiredAt).toBeNull();
    expect(cB?.memberCount).toBe(2);
  });

  it('a retired cluster stops accreting, and its released survivors are claimable by a later pass', async () => {
    alive.delete('d3');
    alive.delete('d4');
    await handleCrystallise({ mode: 'accrete', select: SELECT }, deps);

    // Still won't attach to the now-retired cluster — accretion never
    // considers a retired cluster's centroid.
    deps.embeddings = fakeEmbeddings([candidate('new', [1, 0, 0])]);
    const out = await handleCrystallise({ mode: 'accrete', select: SELECT }, deps);
    expect(out.membersAttached).toBe(0);
    expect(await clusters.listMembers('cA')).toHaveLength(0);

    // The released survivors (d1, d2) are unclaimed rows again — a fresh
    // formation pass sees them as ordinary candidates and can form a brand
    // new cluster from them. This is the assertion that retirement actually
    // released the claim, not just that the count reads zero.
    deps.embeddings = fakeEmbeddings([candidate('d1', [1, 0, 0]), candidate('d2', [1, 0, 0])]);
    deps.runClusterer = async (v: readonly Float32Array[]): Promise<number[]> => v.map(() => 0);
    const formed = await handleCrystallise({ mode: 'form', select: SELECT }, deps);
    expect(formed.considered).toBe(2);
    expect(formed.clustersFormed).toBe(1);
    expect(formed.membersAttached).toBe(2);
  });

  it('leaves a healthy cluster alone', async () => {
    const out = await handleCrystallise({ mode: 'accrete', select: SELECT }, deps);
    expect(out.departed).toBe(0);
    expect(out.retired).toBe(0);
    expect((await clusters.listClusters()).length).toBe(1);
  });

  it('is idempotent — a second pass re-departs nothing', async () => {
    alive.delete('d4');
    await handleCrystallise({ mode: 'accrete', select: SELECT }, deps);
    const second = await handleCrystallise({ mode: 'accrete', select: SELECT }, deps);
    expect(second.departed).toBe(0);
    expect(second.retired).toBe(0);
  });

  it('self-heals a cluster left retired with undeparted survivors by an earlier, interrupted pass', async () => {
    // Simulate the exact broken state a crash between `retire()` committing
    // and `markDeparted()` running would leave: retire cA directly through
    // the store, bypassing the sweep entirely, so its 4 members stay live
    // (`departedAt: null`) under a retired cluster — the state
    // `sweepStaleMembership` must repair, not just avoid creating.
    await clusters.retire('cA', new Date('2026-08-05T00:00:00Z'));
    const brokenBefore = await clusters.getCluster('cA');
    expect(brokenBefore?.retiredAt).toBeInstanceOf(Date);
    expect(brokenBefore?.memberCount).toBe(4);

    const out = await handleCrystallise({ mode: 'accrete', select: SELECT }, deps);

    // Repairing an already-retired cluster is not a NEW retirement this
    // pass — the count must not be inflated by the repair.
    expect(out.retired).toBe(0);

    const healed = await clusters.getCluster('cA');
    expect(healed?.memberCount).toBe(0);
    expect(healed?.departedCount).toBe(4);
    const all = await clusters.listMembers('cA', { includeDeparted: true });
    for (const id of ['d1', 'd2', 'd3', 'd4']) {
      expect(all.find((m) => m.memberId === id)?.departedAt).toBeInstanceOf(Date);
    }

    // The released survivors are claimable again — a later formation pass
    // sees them as ordinary unclaimed candidates.
    deps.embeddings = fakeEmbeddings([candidate('d1', [1, 0, 0]), candidate('d2', [1, 0, 0])]);
    deps.runClusterer = async (v: readonly Float32Array[]): Promise<number[]> => v.map(() => 0);
    const formed = await handleCrystallise({ mode: 'form', select: SELECT }, deps);
    expect(formed.considered).toBe(2);
    expect(formed.clustersFormed).toBe(1);
    expect(formed.membersAttached).toBe(2);
  });

  it('skips the decay sweep entirely when no rowsMissing probe is wired', async () => {
    delete deps.rowsMissing;
    alive.clear();
    const out = await handleCrystallise({ mode: 'accrete', select: SELECT }, deps);
    expect(out.departed).toBe(0);
    expect((await clusters.getCluster('cA'))?.memberCount).toBe(4);
  });

  it('probes every member of every live cluster in ONE call, not one call per member', async () => {
    // A second cluster in a different namespace/type: the batch must span
    // clusters AND scopes, since the host groups by (namespace, type) to
    // turn this into one read per group rather than one per member.
    await clusters.createCluster({
      id: 'cB',
      centroid: new Float32Array([0, 1, 0]),
      cohesion: 0.9,
      label: 'seed-b',
      labelledBy: 'medoid',
      provenance: PROVENANCE
    });
    await clusters.attachMembers(
      ['s1', 's2', 's3'].map((id, i) => ({
        id: `ms${i}`,
        clusterId: 'cB',
        ref: { namespace: 'cortext', type: 'SessionLog', id },
        origin: 'formation' as const,
        similarity: 0.9
      }))
    );
    alive.add('s1').add('s2').add('s3');

    await handleCrystallise({ mode: 'accrete', select: SELECT }, deps);

    expect(probeCalls).toHaveLength(1);
    expect(probeCalls[0]?.map(memberKey).sort()).toEqual([
      'cortext/Decision/d1',
      'cortext/Decision/d2',
      'cortext/Decision/d3',
      'cortext/Decision/d4',
      'cortext/SessionLog/s1',
      'cortext/SessionLog/s2',
      'cortext/SessionLog/s3'
    ]);
  });

  it('does not call the probe at all when no live cluster holds members', async () => {
    // Nothing to ask about — an empty batch must not become a round trip
    // (the host would issue a read per (namespace, type) group of zero).
    await clusters.markDeparted(
      ['d1', 'd2', 'd3', 'd4'].map((id) => ({ namespace: 'cortext', type: 'Decision', id })),
      new Date('2026-08-05T00:00:00Z')
    );

    const out = await handleCrystallise({ mode: 'accrete', select: SELECT }, deps);

    expect(probeCalls).toHaveLength(0);
    expect(out.departed).toBe(0);
  });

  it('reads membership once for the whole sweep, whatever the cluster count', async () => {
    // Regression: store reads must not scale with cluster count (no
    // per-cluster `listMembers` or `getCluster`).
    const reads: string[] = [];
    const counted = new Proxy(clusters, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (typeof value !== 'function') return value;
        return (...args: unknown[]): unknown => {
          if (prop === 'listAllMembers' || prop === 'listMembers' || prop === 'getCluster') {
            reads.push(String(prop));
          }
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      }
    });

    for (let i = 0; i < 5; i++) {
      const id = `cx${i}`;
      await clusters.createCluster({
        id,
        centroid: new Float32Array([0, 0, 1]),
        cohesion: 0.9,
        label: id,
        labelledBy: 'medoid',
        provenance: PROVENANCE
      });
      // Three members each — at the floor, so nothing retires and the sweep
      // walks every cluster to the end.
      await clusters.attachMembers(
        [0, 1, 2].map((n) => ({
          id: `${id}-m${n}`,
          clusterId: id,
          ref: { namespace: 'cortext', type: 'Decision', id: `${id}-d${n}` },
          origin: 'formation' as const,
          similarity: 0.9
        }))
      );
      for (const n of [0, 1, 2]) alive.add(`${id}-d${n}`);
    }

    deps.clusters = counted;
    const out = await handleCrystallise({ mode: 'accrete', select: SELECT }, deps);

    expect(out.departed).toBe(0);
    expect(out.retired).toBe(0);
    expect(reads).toEqual(['listAllMembers']);
  });

  it('departs nothing when the probe reports no missing rows, however it got there', async () => {
    // The polarity that makes this contract fail safe: the probe returns the
    // rows it can POSITIVELY say are gone. A host that resolves no dataset —
    // or drops a group by mistake — yields an empty set, and an empty set
    // must mean "depart nobody", never "depart everybody". There is no
    // un-depart, so absence of evidence must not be evidence of absence.
    alive.clear();
    deps.rowsMissing = async (): Promise<Set<string>> => new Set();

    const out = await handleCrystallise({ mode: 'accrete', select: SELECT }, deps);

    expect(out.departed).toBe(0);
    expect(out.retired).toBe(0);
    expect((await clusters.getCluster('cA'))?.memberCount).toBe(4);
  });
});

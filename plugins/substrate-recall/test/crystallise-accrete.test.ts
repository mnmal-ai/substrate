import { beforeEach, describe, expect, it } from 'vitest';
import type { Candidate, CandidateSelector } from '../src/candidate-selection.js';
import type { ClusterProvenance, ClusterStore } from '../src/cluster-store.js';
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
  params: { nComponents: 10, nNeighbors: 15, minClusterSize: 5 },
  model: MODEL
};

const candidate = (id: string, vector: number[], title = id): Candidate => ({
  namespace: 'cortext',
  type: 'Decision',
  id,
  vector: new Float32Array(vector),
  row: { id, title }
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

describe('handleCrystallise — accrete', () => {
  let clusters: ClusterStore;
  let deps: CrystalliseCoreDeps;
  let idSeq: number;

  const seedCluster = async (id: string, centroid: number[]): Promise<void> => {
    await clusters.createCluster({
      id,
      centroid: new Float32Array(centroid),
      cohesion: 0.95,
      label: `seed-${id}`,
      labelledBy: 'medoid',
      provenance: PROVENANCE
    });
  };

  beforeEach(async () => {
    clusters = new InMemoryClusterStore({ txScopeId: 'mem' });
    idSeq = 0;
    deps = {
      embeddings: fakeEmbeddings([]),
      clusters,
      model: MODEL,
      config: DEFAULT_CRYSTALLISE_CONFIG,
      newId: (): string => `id-${++idSeq}`,
      now: (): Date => new Date('2026-08-06T12:00:00Z'),
      runClusterer: async (): Promise<number[]> => {
        throw new Error('accretion must never run the clusterer');
      }
    };
    await seedCluster('cA', [1, 0, 0]);
    await seedCluster('cB', [0, 1, 0]);
  });

  it('attaches an unclaimed row to the nearest centroid above the threshold', async () => {
    deps.embeddings = fakeEmbeddings([candidate('x', [0.95, 0.05, 0])]);
    const out = await handleCrystallise({ mode: 'accrete', select: SELECT }, deps);

    expect(out.membersAttached).toBe(1);
    expect(out.clustersAccretedInto).toBe(1);
    expect(out.clustersFormed).toBe(0);

    const members = await clusters.listMembers('cA');
    expect(members.map((m) => m.memberId)).toEqual(['x']);
    expect(members[0]?.origin).toBe('accretion');
    expect(members[0]?.similarity).toBeGreaterThan(deps.config.accretionThreshold);
  });

  it('leaves a row unclaimed when nothing is close enough', async () => {
    deps.embeddings = fakeEmbeddings([candidate('far', [0, 0, 1])]);
    const out = await handleCrystallise({ mode: 'accrete', select: SELECT }, deps);

    expect(out.membersAttached).toBe(0);
    expect(await clusters.listMembers('cA')).toEqual([]);
    expect(await clusters.listMembers('cB')).toEqual([]);
    expect(
      (await clusters.claimedMembers([{ namespace: 'cortext', type: 'Decision', id: 'far' }])).size
    ).toBe(0);
  });

  it('picks the nearest cluster, not the first one that clears the threshold', async () => {
    // Closer to cB, but cA is listed first.
    deps.embeddings = fakeEmbeddings([candidate('x', [0.4, 0.92, 0])]);
    await handleCrystallise({ mode: 'accrete', select: SELECT }, deps);

    expect((await clusters.listMembers('cA')).length).toBe(0);
    expect((await clusters.listMembers('cB')).map((m) => m.memberId)).toEqual(['x']);
  });

  it('ignores retired clusters', async () => {
    await clusters.retire('cA');
    deps.embeddings = fakeEmbeddings([candidate('x', [1, 0, 0])]);
    const out = await handleCrystallise({ mode: 'accrete', select: SELECT }, deps);

    expect(await clusters.listMembers('cA')).toEqual([]);
    expect(out.membersAttached).toBe(0);
  });

  it('bumps lastAccretedAt on the cluster it attached to', async () => {
    deps.embeddings = fakeEmbeddings([candidate('x', [1, 0, 0])]);
    await handleCrystallise({ mode: 'accrete', select: SELECT }, deps);
    const cluster = await clusters.getCluster('cA');
    expect(cluster?.lastAccretedAt).toBeInstanceOf(Date);
    expect(cluster?.memberCount).toBe(1);
  });

  it('does nothing when there are no live clusters to accrete into', async () => {
    await clusters.retire('cA');
    await clusters.retire('cB');
    deps.embeddings = fakeEmbeddings([candidate('x', [1, 0, 0])]);
    const out = await handleCrystallise({ mode: 'accrete', select: SELECT }, deps);
    expect(out.membersAttached).toBe(0);
    expect(out.clustersAccretedInto).toBe(0);
  });

  /**
   * The property the entire design rests on. An already-claimed row is
   * invisible to accretion, no matter how much closer another centroid is.
   */
  it('never reassigns an existing member, even to a much nearer cluster', async () => {
    const row = candidate('x', [0, 1, 0]); // squarely cB's territory
    await clusters.attachMembers([
      {
        id: 'm-existing',
        clusterId: 'cA',
        ref: { namespace: 'cortext', type: 'Decision', id: 'x' },
        origin: 'formation',
        similarity: 0.1
      }
    ]);

    deps.embeddings = fakeEmbeddings([row]);
    const out = await handleCrystallise({ mode: 'accrete', select: SELECT }, deps);

    expect(out.considered).toBe(0);
    expect(out.membersAttached).toBe(0);
    expect((await clusters.listMembers('cA')).map((m) => m.memberId)).toEqual(['x']);
    expect(await clusters.listMembers('cB')).toEqual([]);
  });

  /**
   * Property test over the invariant: whatever the geometry, repeated
   * accretion passes never change any member's cluster.
   */
  it('is stable across repeated passes for arbitrary geometries', async () => {
    const rows: Candidate[] = [];
    // Deterministic pseudo-random spread — no Math.random, so a failure is
    // reproducible from the test alone.
    let state = 12345;
    const next = (): number => {
      state = (state * 1103515245 + 12345) % 2147483648;
      return state / 2147483648;
    };
    for (let i = 0; i < 40; i++) {
      rows.push(candidate(`r${String(i).padStart(2, '0')}`, [next(), next(), next()]));
    }
    deps.embeddings = fakeEmbeddings(rows);

    await handleCrystallise({ mode: 'accrete', select: SELECT }, deps);
    const snapshot = new Map<string, string>();
    for (const clusterId of ['cA', 'cB']) {
      for (const m of await clusters.listMembers(clusterId)) snapshot.set(m.memberId, clusterId);
    }

    for (let pass = 0; pass < 3; pass++) {
      await handleCrystallise({ mode: 'accrete', select: SELECT }, deps);
    }

    const after = new Map<string, string>();
    for (const clusterId of ['cA', 'cB']) {
      for (const m of await clusters.listMembers(clusterId)) after.set(m.memberId, clusterId);
    }
    expect(after).toEqual(snapshot);
  });
});

import { describe, expect, it, vi } from 'vitest';
import type { Candidate } from '../src/candidate-selection.js';
import { buildClusterSurface } from '../src/cluster-frame-surface.js';
import type { ClusterProvenance } from '../src/cluster-store.js';
import { DEFAULT_CRYSTALLISE_CONFIG } from '../src/crystallise-core.js';
import type { EmbeddingsStore } from '../src/embeddings-store.js';
import { InMemoryClusterStore } from '../src/in-memory-cluster-store.js';

const PROVENANCE: ClusterProvenance = {
  backend: 'wasm',
  backendVersion: '0.1.0',
  regime: 'normalised',
  seed: 42,
  params: { nComponents: 10, nNeighbors: 15, minClusterSize: 5 },
  model: 'fake:3'
};

const ctx = { identity: null } as never;

const noEmbeddings = {} as EmbeddingsStore;

async function seeded(): Promise<ReturnType<typeof buildClusterSurface>> {
  const clusters = new InMemoryClusterStore({ txScopeId: 'mem' });
  await clusters.createCluster({
    id: 'cA',
    centroid: new Float32Array([1, 0]),
    cohesion: 0.9,
    label: 'plugin loader',
    labelledBy: 'medoid',
    provenance: PROVENANCE
  });
  await clusters.attachMembers([
    {
      id: 'm1',
      clusterId: 'cA',
      ref: { namespace: 'cortext', type: 'Decision', id: 'd1' },
      origin: 'formation',
      similarity: 0.9
    }
  ]);
  await clusters.createCluster({
    id: 'cB',
    centroid: new Float32Array([0, 1]),
    cohesion: 0.8,
    label: 'retired one',
    labelledBy: 'medoid',
    provenance: PROVENANCE
  });
  await clusters.retire('cB');

  return buildClusterSurface({
    embeddings: noEmbeddings,
    clusters,
    model: 'fake:3',
    config: DEFAULT_CRYSTALLISE_CONFIG
  });
}

const CRYSTALLISE_CANDIDATES: Candidate[] = [
  {
    namespace: 'cortext',
    type: 'Decision',
    id: 'd1',
    vector: new Float32Array([1, 0, 0]),
    row: { title: 'plugin loader' }
  },
  {
    namespace: 'cortext',
    type: 'Decision',
    id: 'd2',
    vector: new Float32Array([0.98, 0.1, 0]),
    row: { title: 'plugin tier' }
  }
];

function fakeCrystalliseEmbeddings(): EmbeddingsStore {
  return {
    txScopeId: 'fake',
    upsert: async (): Promise<void> => {},
    knnSearch: async (): Promise<never[]> => [],
    boostSalience: async (): Promise<[]> => [],
    fetchEmbeddings: async (): Promise<never[]> => [],
    selectCandidates: async (): Promise<Candidate[]> =>
      CRYSTALLISE_CANDIDATES.map((c) => ({ ...c }))
  } as unknown as EmbeddingsStore;
}

/** A crystallise-capable surface — `seeded()`'s `noEmbeddings` has no `selectCandidates`. */
function crystalliseSurface(
  overrides: Record<string, unknown> = {}
): ReturnType<typeof buildClusterSurface> {
  return buildClusterSurface({
    embeddings: fakeCrystalliseEmbeddings(),
    clusters: new InMemoryClusterStore({ txScopeId: 'mem-crystallise' }),
    model: 'fake:3',
    config: DEFAULT_CRYSTALLISE_CONFIG,
    runClusterer: async (v: readonly Float32Array[]): Promise<number[]> => v.map(() => 0),
    ...overrides
  } as Parameters<typeof buildClusterSurface>[0]);
}

const CRYSTALLISE_PARAMS = {
  mode: 'form',
  select: { scopes: [{ namespace: 'cortext', type: 'Decision' }] }
};

// `fields` is omitted (never `fields: undefined`) throughout: under
// `exactOptionalPropertyTypes` an explicit `undefined` on the optional
// ResolverArgs.fields is a type error. Runtime behaviour is identical.
describe('recall/Cluster frame surface', () => {
  it('lists live clusters by default', async () => {
    const surface = await seeded();
    const rows = await surface.types.Cluster.resolver(ctx, { params: {} });
    expect(rows.map((r) => r.id)).toEqual(['cA']);
    expect(rows[0]?.label).toBe('plugin loader');
    expect(rows[0]?.memberCount).toBe(1);
    expect(rows[0]?.provenance).toMatchObject({ backend: 'wasm', regime: 'normalised' });
  });

  it('includes retired clusters on request', async () => {
    const surface = await seeded();
    const rows = await surface.types.Cluster.resolver(ctx, {
      params: { includeRetired: true }
    });
    expect(rows.map((r) => r.id).sort()).toEqual(['cA', 'cB']);
  });

  it('projects only the requested fields', async () => {
    const surface = await seeded();
    const rows = await surface.types.Cluster.resolver(ctx, {
      params: {},
      fields: { id: true, label: true }
    });
    expect(Object.keys(rows[0] ?? {}).sort()).toEqual(['id', 'label']);
  });

  it('does not publish the centroid — 768 floats per row is not a listing field', async () => {
    const surface = await seeded();
    const rows = await surface.types.Cluster.resolver(ctx, { params: {} });
    expect('centroid' in (rows[0] ?? {})).toBe(false);
  });

  it('lists members of a cluster', async () => {
    const surface = await seeded();
    const rows = await surface.types.ClusterMember.resolver(ctx, {
      params: { cluster: 'cA' }
    });
    expect(rows.map((r) => r.memberId)).toEqual(['d1']);
    expect(rows[0]?.origin).toBe('formation');
  });

  it('walks back from a source row to the clusters claiming it', async () => {
    const surface = await seeded();
    const rows = await surface.types.ClusterMember.resolver(ctx, {
      params: { memberNs: 'cortext', memberType: 'Decision', memberId: 'd1' }
    });
    expect(rows.map((r) => r.cluster)).toEqual(['cA']);
  });

  it('rejects a ClusterMember query with neither a cluster nor a member triple', async () => {
    const surface = await seeded();
    await expect(surface.types.ClusterMember.resolver(ctx, { params: {} })).rejects.toMatchObject({
      code: 'bad_request'
    });
  });

  it('labelCluster replaces the label and marks it agent-authored', async () => {
    const surface = await seeded();
    const row = await surface.mutations.labelCluster.resolver(ctx, {
      params: { id: 'cA', label: 'Plugin loader architecture' }
    });
    expect(row.label).toBe('Plugin loader architecture');
    expect(row.labelledBy).toBe('agent');
  });

  it('labelCluster on an unknown id is a bad_request, not a silent no-op', async () => {
    const surface = await seeded();
    await expect(
      surface.mutations.labelCluster.resolver(ctx, {
        params: { id: 'nope', label: 'x' }
      })
    ).rejects.toMatchObject({ code: 'bad_request' });
  });
});

// The cluster read surface is policy-gated: `recall/ClusterMember` enumerates
// row ids in gated namespaces, and `Cluster.label` carries handle-field text
// from those same rows.
describe('recall/Cluster + recall/ClusterMember — read-policy gate', () => {
  /** Like `seeded()`, but threads a `checkReadPolicy` and adds a second,
   *  differently-scoped member so a per-scope denial has something to
   *  discriminate against. */
  async function seededWithPolicy(
    checkReadPolicy: (ns: string, type: string, identity: unknown) => { allow: boolean }
  ): Promise<ReturnType<typeof buildClusterSurface>> {
    const clusters = new InMemoryClusterStore({ txScopeId: 'mem-policy' });
    await clusters.createCluster({
      id: 'cA',
      centroid: new Float32Array([1, 0]),
      cohesion: 0.9,
      label: 'plugin loader',
      labelledBy: 'medoid',
      provenance: PROVENANCE
    });
    await clusters.attachMembers([
      {
        id: 'm1',
        clusterId: 'cA',
        ref: { namespace: 'cortext', type: 'Decision', id: 'd1' },
        origin: 'formation',
        similarity: 0.9
      },
      {
        id: 'm2',
        clusterId: 'cA',
        ref: { namespace: 'cortext', type: 'Memory', id: 'mem1' },
        origin: 'formation',
        similarity: 0.8
      }
    ]);
    // A second cluster whose ONLY member is in the denied scope — nothing
    // readable anywhere in it, so it must vanish from the listing entirely.
    await clusters.createCluster({
      id: 'cC',
      centroid: new Float32Array([0, 1]),
      cohesion: 0.7,
      label: 'private only',
      labelledBy: 'medoid',
      provenance: PROVENANCE
    });
    await clusters.attachMembers([
      {
        id: 'm3',
        clusterId: 'cC',
        ref: { namespace: 'cortext', type: 'Decision', id: 'd2' },
        origin: 'formation',
        similarity: 0.9
      }
    ]);

    return buildClusterSurface({
      embeddings: noEmbeddings,
      clusters,
      model: 'fake:3',
      config: DEFAULT_CRYSTALLISE_CONFIG,
      checkReadPolicy
    } as Parameters<typeof buildClusterSurface>[0]);
  }

  it('recall/ClusterMember silently drops rows the caller cannot read, keeping readable ones', async () => {
    const surface = await seededWithPolicy((ns, type) => ({
      allow: !(ns === 'cortext' && type === 'Decision')
    }));
    const rows = await surface.types.ClusterMember.resolver(ctx, { params: { cluster: 'cA' } });
    expect(rows.map((r) => r.memberId)).toEqual(['mem1']);
  });

  it('recall/Cluster drops a cluster with no readable member scope, keeps one with at least one', async () => {
    const surface = await seededWithPolicy((ns, type) => ({
      allow: !(ns === 'cortext' && type === 'Decision')
    }));
    const rows = await surface.types.Cluster.resolver(ctx, { params: {} });
    // cA has a readable Memory member (survives); cC's only member is the
    // denied Decision scope (vanishes) — this is the "at least one readable
    // scope" predicate, not "every scope must be readable".
    expect(rows.map((r) => r.id)).toEqual(['cA']);
  });

  it('recall/Cluster reads the members of every listed cluster in one call', async () => {
    const surface = await seededWithPolicy((ns, type) => ({
      allow: !(ns === 'cortext' && type === 'Decision')
    }));
    const spy = vi.spyOn(InMemoryClusterStore.prototype, 'listMembers');
    try {
      const rows = await surface.types.Cluster.resolver(ctx, { params: {} });
      expect(rows.map((r) => r.id)).toEqual(['cA']);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  it('recall/Cluster.getCluster (by id) returns nothing for a cluster with no readable member scope', async () => {
    const surface = await seededWithPolicy((ns, type) => ({
      allow: !(ns === 'cortext' && type === 'Decision')
    }));
    const rows = await surface.types.Cluster.resolver(ctx, { params: { id: 'cC' } });
    expect(rows).toEqual([]);
  });

  it('withholds the label unless the caller can read every member scope', async () => {
    const partial = await seededWithPolicy((ns, type) => ({
      allow: !(ns === 'cortext' && type === 'Decision')
    }));
    const [row] = await partial.types.Cluster.resolver(ctx, { params: { id: 'cA' } });
    expect(row?.label).toBeNull();

    const open = await seededWithPolicy(() => ({ allow: true }));
    const [full] = await open.types.Cluster.resolver(ctx, { params: { id: 'cA' } });
    expect(full?.label).toBe('plugin loader');
  });

  it('a fully-open policy (every scope allowed) changes nothing', async () => {
    const surface = await seededWithPolicy(() => ({ allow: true }));
    const rows = await surface.types.Cluster.resolver(ctx, { params: {} });
    expect(rows.map((r) => r.id).sort()).toEqual(['cA', 'cC']);
  });

  // The published memberCount must agree with what recall/ClusterMember hands
  // back: memberCount 2 beside one ClusterMember row would disclose that an
  // unreadable member exists.
  it('memberCount and departedCount are filtered to what the caller can read, matching ClusterMember', async () => {
    const surface = await seededWithPolicy((ns, type) => ({
      allow: !(ns === 'cortext' && type === 'Decision')
    }));
    const [row] = await surface.types.Cluster.resolver(ctx, { params: { id: 'cA' } });
    // cA has 2 live members (d1: Decision — denied; mem1: Memory — allowed).
    // The unfiltered record would report memberCount: 2; the caller may
    // only read 1.
    expect(row?.memberCount).toBe(1);
    expect(row?.departedCount).toBe(0);

    const memberRows = await surface.types.ClusterMember.resolver(ctx, {
      params: { cluster: 'cA' }
    });
    expect(memberRows).toHaveLength(row?.memberCount as number);
  });

  it('departedCount is also filtered — a departed member in a denied scope does not inflate the visible count', async () => {
    const clusters = new InMemoryClusterStore({ txScopeId: 'mem-departed-policy' });
    await clusters.createCluster({
      id: 'cD',
      centroid: new Float32Array([1, 0]),
      cohesion: 0.9,
      label: 'mixed departures',
      labelledBy: 'medoid',
      provenance: PROVENANCE
    });
    await clusters.attachMembers([
      {
        id: 'm1',
        clusterId: 'cD',
        ref: { namespace: 'cortext', type: 'Decision', id: 'd1' },
        origin: 'formation',
        similarity: 0.9
      },
      {
        id: 'm2',
        clusterId: 'cD',
        ref: { namespace: 'cortext', type: 'Memory', id: 'mem1' },
        origin: 'formation',
        similarity: 0.8
      },
      {
        id: 'm3',
        clusterId: 'cD',
        ref: { namespace: 'cortext', type: 'Memory', id: 'mem2' },
        origin: 'formation',
        similarity: 0.7
      }
    ]);
    await clusters.markDeparted([
      { namespace: 'cortext', type: 'Decision', id: 'd1' },
      { namespace: 'cortext', type: 'Memory', id: 'mem2' }
    ]);

    const surface = buildClusterSurface({
      embeddings: noEmbeddings,
      clusters,
      model: 'fake:3',
      config: DEFAULT_CRYSTALLISE_CONFIG,
      checkReadPolicy: (ns, type) => ({ allow: !(ns === 'cortext' && type === 'Decision') })
    } as Parameters<typeof buildClusterSurface>[0]);

    const [row] = await surface.types.Cluster.resolver(ctx, { params: { id: 'cD' } });
    // Raw record: memberCount 1 (mem1 live), departedCount 2 (d1, mem2).
    // Filtered: d1 (departed, denied scope) drops out of departedCount.
    expect(row?.memberCount).toBe(1);
    expect(row?.departedCount).toBe(1);
  });

  it('a cluster with zero live members stays visible even under a denying policy (nothing left to leak)', async () => {
    const clusters = new InMemoryClusterStore({ txScopeId: 'mem-retired-policy' });
    await clusters.createCluster({
      id: 'cE',
      centroid: new Float32Array([1, 0]),
      cohesion: 0.9,
      label: 'fully departed',
      labelledBy: 'medoid',
      provenance: PROVENANCE
    });
    await clusters.attachMembers([
      {
        id: 'm1',
        clusterId: 'cE',
        ref: { namespace: 'cortext', type: 'Decision', id: 'd1' },
        origin: 'formation',
        similarity: 0.9
      }
    ]);
    await clusters.markDeparted([{ namespace: 'cortext', type: 'Decision', id: 'd1' }]);

    const surface = buildClusterSurface({
      embeddings: noEmbeddings,
      clusters,
      model: 'fake:3',
      config: DEFAULT_CRYSTALLISE_CONFIG,
      // Denies everything — if the zero-live-members case were computed
      // wrong (e.g. treated as "no readable live member" rather than "no
      // live member at all"), this cluster would wrongly vanish.
      checkReadPolicy: () => ({ allow: false })
    } as Parameters<typeof buildClusterSurface>[0]);

    const rows = await surface.types.Cluster.resolver(ctx, { params: { id: 'cE' } });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.memberCount).toBe(0);
    expect(rows[0]?.departedCount).toBe(0);
  });

  it('labelCluster is LOUDLY denied (not silently filtered) when the caller cannot see the cluster', async () => {
    const surface = await seededWithPolicy((ns, type) => ({
      allow: !(ns === 'cortext' && type === 'Decision')
    }));
    await expect(
      surface.mutations.labelCluster.resolver(ctx, { params: { id: 'cC', label: 'renamed' } })
    ).rejects.toMatchObject({ code: 'policy_denied' });
  });

  it('labelCluster succeeds when the caller can see the cluster through at least one member scope', async () => {
    const surface = await seededWithPolicy((ns, type) => ({
      allow: !(ns === 'cortext' && type === 'Decision')
    }));
    const row = await surface.mutations.labelCluster.resolver(ctx, {
      params: { id: 'cA', label: 'renamed' }
    });
    expect(row.label).toBe('renamed');
  });
});

// The mock returns the REAL `ReadPolicyCheck`/`PolicyDecision` shape
// (`{ allow, reason? }`), not the post-translation `PolicyProbe` shape
// (`{ allowed, reason? }`) `crystallise-core` consumes internally — mirrors
// crystallise-route.test.ts. A mock shaped like the translation's OUTPUT
// can't tell a correct translation from a missing one.
describe('recall/crystallise mutation — policy translation', () => {
  it('rejects as policy_denied when the read policy denies a scope', async () => {
    const surface = crystalliseSurface({
      checkReadPolicy: (): { allow: boolean; reason: string } => ({ allow: false, reason: 'nope' })
    });
    await expect(
      surface.mutations.crystallise.resolver(ctx, { params: CRYSTALLISE_PARAMS })
    ).rejects.toMatchObject({ code: 'policy_denied' });
  });

  // The discriminating case: a broken or absent `allow` → `allowed`
  // translation makes `decision.allowed` read `undefined` (falsy)
  // regardless of what the real check says, so EVERY call — including this
  // allowed one — would be denied. Only a correct translation reaches here.
  it('succeeds when the read policy allows every scope', async () => {
    const surface = crystalliseSurface({
      checkReadPolicy: (): { allow: boolean } => ({ allow: true })
    });
    const row = await surface.mutations.crystallise.resolver(ctx, { params: CRYSTALLISE_PARAMS });
    expect(row.mode).toBe('form');
    expect(row.clustersFormed).toBe(1);
  });
});

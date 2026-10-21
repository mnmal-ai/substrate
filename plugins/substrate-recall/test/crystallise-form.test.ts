import { beforeEach, describe, expect, it } from 'vitest';
import type { Candidate, CandidateSelector } from '../src/candidate-selection.js';
import type { ClusterStore } from '../src/cluster-store.js';
import type { CrystalliseCoreDeps } from '../src/crystallise-core.js';
import {
  DEFAULT_CRYSTALLISE_CONFIG,
  handleCrystallise,
  validateCrystalliseInput
} from '../src/crystallise-core.js';
import type { EmbeddingsStore } from '../src/embeddings-store.js';
import { InMemoryClusterStore } from '../src/in-memory-cluster-store.js';

const MODEL = 'fake:2';

const SELECT: CandidateSelector = {
  scopes: [{ namespace: 'cortext', type: 'Decision' }],
  excludeTextPrefixes: [],
  limit: 100
};

const candidate = (id: string, vector: number[], title: string): Candidate => ({
  namespace: 'cortext',
  type: 'Decision',
  id,
  vector: new Float32Array(vector),
  row: { id, title }
});

/**
 * Three tight groups. The fake clusterer below assigns by the index of the
 * dominant component, so the grouping is fixed and the test asserts what
 * crystallise does with an assignment — not what HDBSCAN decides.
 */
const CANDIDATES: Candidate[] = [
  candidate('a1', [1, 0, 0], 'plugin loader manifest'),
  candidate('a2', [0.98, 0.1, 0], 'plugin loader tier'),
  candidate('b1', [0, 1, 0], 'recall salience decay'),
  candidate('b2', [0.1, 0.98, 0], 'recall salience boost'),
  candidate('n1', [0, 0, 1], 'unique orphan row')
];

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

/** label = index of the largest component; the orphan is forced to noise. */
const fakeRunClusterer = async (vectors: readonly Float32Array[]): Promise<number[]> =>
  vectors.map((v) => {
    let best = 0;
    for (let i = 1; i < v.length; i++) if (v[i]! > v[best]!) best = i;
    return best === 2 ? -1 : best;
  });

describe('validateCrystalliseInput', () => {
  it('requires an explicit selection filter', () => {
    expect(() => validateCrystalliseInput({ mode: 'form' })).toThrow(
      /selection filter is required/i
    );
    try {
      validateCrystalliseInput({ mode: 'form' });
    } catch (err) {
      expect((err as { code?: string }).code).toBe('bad_request');
    }
  });

  it('rejects an unknown mode', () => {
    expect(() => validateCrystalliseInput({ mode: 'invent', select: SELECT })).toThrow(/mode/i);
  });

  it('defaults mode to accrete — the steady-state path, never formation', () => {
    expect(validateCrystalliseInput({ select: SELECT }).mode).toBe('accrete');
  });

  it('accepts params overrides and rejects malformed ones', () => {
    const ok = validateCrystalliseInput({ mode: 'form', select: SELECT, params: { seed: 7 } });
    expect(ok.params?.seed).toBe(7);
    expect(() =>
      validateCrystalliseInput({ mode: 'form', select: SELECT, params: { seed: 'x' } })
    ).toThrow(/seed/i);
  });

  // Per-request overrides must match the bootstrap schema's ranges (nComponents
  // nonnegative, nNeighbors/minClusterSize positive), or a caller can wedge
  // crystallisation (minClusterSize: 0 retires every cluster on the next
  // sweep) or feed the clusterer input it may hang on.
  it('rejects an out-of-range nComponents override', () => {
    expect(() =>
      validateCrystalliseInput({ mode: 'form', select: SELECT, params: { nComponents: -5 } })
    ).toThrow(/nComponents.*>= 0/);
    // Zero IS allowed — it's the documented "skip reduction" convention.
    expect(
      validateCrystalliseInput({ mode: 'form', select: SELECT, params: { nComponents: 0 } }).params
        ?.nComponents
    ).toBe(0);
  });

  it('rejects an out-of-range nNeighbors override', () => {
    expect(() =>
      validateCrystalliseInput({ mode: 'form', select: SELECT, params: { nNeighbors: -1 } })
    ).toThrow(/nNeighbors.*>= 1/);
    expect(() =>
      validateCrystalliseInput({ mode: 'form', select: SELECT, params: { nNeighbors: 0 } })
    ).toThrow(/nNeighbors.*>= 1/);
  });

  it('rejects an out-of-range minClusterSize override', () => {
    expect(() =>
      validateCrystalliseInput({ mode: 'form', select: SELECT, params: { minClusterSize: 0 } })
    ).toThrow(/minClusterSize.*>= 1/);
  });

  it('still allows any integer seed, including negative — the schema places no floor on it', () => {
    expect(
      validateCrystalliseInput({ mode: 'form', select: SELECT, params: { seed: -3 } }).params?.seed
    ).toBe(-3);
  });
});

describe('handleCrystallise — form', () => {
  let clusters: ClusterStore;
  let deps: CrystalliseCoreDeps;
  let idSeq: number;

  beforeEach(() => {
    clusters = new InMemoryClusterStore({ txScopeId: 'mem' });
    idSeq = 0;
    deps = {
      embeddings: fakeEmbeddings(CANDIDATES),
      clusters,
      model: MODEL,
      config: DEFAULT_CRYSTALLISE_CONFIG,
      runClusterer: fakeRunClusterer,
      newId: (): string => `id-${++idSeq}`,
      now: (): Date => new Date('2026-08-06T12:00:00Z')
    };
  });

  it('forms one cluster per non-noise label and leaves noise unclaimed', async () => {
    const out = await handleCrystallise({ mode: 'form', select: SELECT }, deps);

    expect(out.candidates).toBe(5);
    expect(out.considered).toBe(5);
    expect(out.clustersFormed).toBe(2);
    expect(out.membersAttached).toBe(4);
    expect(out.noise).toBe(1);

    const live = await clusters.listClusters();
    expect(live.length).toBe(2);
    const claimed = await clusters.claimedMembers([
      { namespace: 'cortext', type: 'Decision', id: 'n1' }
    ]);
    expect(claimed.size).toBe(0);
  });

  it('stores the centroid in the ORIGINAL embedding space, never reduced space', async () => {
    await handleCrystallise({ mode: 'form', select: SELECT }, deps);
    const [first] = await clusters.listClusters();
    expect(first?.centroid.length).toBe(3);
    // Mean of [1,0,0] and [0.98,0.1,0] — as stored, not as normalised for the clusterer.
    expect(first?.centroid[0]).toBeCloseTo(0.99, 5);
    expect(first?.centroid[1]).toBeCloseTo(0.05, 5);
  });

  it('records provenance naming BOTH the regime and the backend', async () => {
    await handleCrystallise({ mode: 'form', select: SELECT, params: { seed: 7 } }, deps);
    const [first] = await clusters.listClusters();
    expect(first?.provenance.backend).toBe('wasm');
    expect(first?.provenance.regime).toBe('normalised');
    expect(first?.provenance.model).toBe(MODEL);
    expect(first?.provenance.seed).toBe(7);
    expect(first?.provenance.params.minClusterSize).toBe(DEFAULT_CRYSTALLISE_CONFIG.minClusterSize);
    expect(first?.provenance.backendVersion).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('normalises before clustering and clusters the normalised copy', async () => {
    const seen: Float32Array[][] = [];
    deps.runClusterer = async (vectors): Promise<number[]> => {
      seen.push(vectors.map((v) => new Float32Array(v)));
      return fakeRunClusterer(vectors);
    };
    await handleCrystallise({ mode: 'form', select: SELECT }, deps);

    const passed = seen[0];
    expect(passed).toBeDefined();
    for (const v of passed ?? []) {
      let sum = 0;
      for (const x of v) sum += x * x;
      expect(Math.sqrt(sum)).toBeCloseTo(1, 5);
    }
  });

  it('labels each cluster deterministically and marks it labelledBy medoid', async () => {
    await handleCrystallise({ mode: 'form', select: SELECT }, deps);
    const live = await clusters.listClusters();
    for (const c of live) {
      expect(c.label.length).toBeGreaterThan(0);
      expect(c.labelledBy).toBe('medoid');
    }
    expect(live.some((c) => c.label.includes('loader'))).toBe(true);
  });

  it('records cohesion as the mean cosine of members to the centroid', async () => {
    await handleCrystallise({ mode: 'form', select: SELECT }, deps);
    for (const c of await clusters.listClusters()) {
      expect(c.cohesion).toBeGreaterThan(0.9);
      expect(c.cohesion).toBeLessThanOrEqual(1);
    }
  });

  it('attaches every member with origin formation and its similarity at attach time', async () => {
    await handleCrystallise({ mode: 'form', select: SELECT }, deps);
    const [first] = await clusters.listClusters();
    const members = await clusters.listMembers(first?.id ?? '');
    expect(members.length).toBe(2);
    for (const m of members) {
      expect(m.origin).toBe('formation');
      expect(m.similarity).toBeGreaterThan(0.9);
      expect(m.departedAt).toBeNull();
    }
  });

  it('never re-derives: a second form pass leaves existing clusters untouched', async () => {
    const first = await handleCrystallise({ mode: 'form', select: SELECT }, deps);
    const before = await clusters.listClusters();
    const beforeMembers = await clusters.listMembers(before[0]?.id ?? '');

    const second = await handleCrystallise({ mode: 'form', select: SELECT }, deps);

    expect(first.clustersFormed).toBe(2);
    expect(second.considered).toBe(1); // only the noise row is still unclaimed
    expect(second.clustersFormed).toBe(0);

    const after = await clusters.listClusters();
    expect(after.map((c) => c.id)).toEqual(before.map((c) => c.id));
    expect(await clusters.listMembers(before[0]?.id ?? '')).toEqual(beforeMembers);
  });

  it('returns zeros without invoking the clusterer when nothing is unclaimed', async () => {
    deps.embeddings = fakeEmbeddings([]);
    let called = false;
    deps.runClusterer = async (v): Promise<number[]> => {
      called = true;
      return fakeRunClusterer(v);
    };
    const out = await handleCrystallise({ mode: 'form', select: SELECT }, deps);
    expect(out.clustersFormed).toBe(0);
    expect(called).toBe(false);
  });

  it('refuses a scope the read policy denies', async () => {
    deps.checkReadPolicy = (_ns, type): { allow: boolean; reason?: string } =>
      type === 'Decision' ? { allow: false, reason: 'nope' } : { allow: true };
    await expect(handleCrystallise({ mode: 'form', select: SELECT }, deps)).rejects.toMatchObject({
      code: 'policy_denied'
    });
  });
});

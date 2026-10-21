/**
 * Crystallisation: cluster embedded rows and persist the result as
 * `recall/Cluster` + `recall/ClusterMember` rows with provenance.
 *
 * Shared by the kernelRoute and the frame resolver. Throws coded errors
 * (`bad_request`, `policy_denied`).
 *
 * Two operations, and only the first runs the clusterer:
 *
 *   FORM    cluster the unclaimed candidates and write new clusters.
 *   ACCRETE attach each unclaimed row to the nearest stored centroid within
 *           a threshold, else leave it unclaimed.
 *
 * A cluster is formed once and thereafter only accretes; it is never
 * re-derived, because clustering output shifts under perturbations far below
 * any semantic difference (seed, float rounding, CPU). Formation therefore
 * considers ONLY unclaimed candidates, so a row belongs to exactly one
 * cluster. That is a deliberate v0 position, not an oversight.
 */

import type { PolicyDecision } from '@mnmal-ai/substrate-types';
import { type Candidate, type CandidateSelector, validateSelector } from './candidate-selection.js';
import {
  type ClusterProvenance,
  type ClusterStore,
  type MemberRef,
  memberKey,
  type NewMember
} from './cluster-store.js';
import { CLUSTERER_BACKEND, CLUSTERER_BACKEND_VERSION } from './clusterer-version.js';
import { cosineSimilarity } from './cosine.js';
import type { EmbeddingsStore } from './embeddings-store.js';
import { l2normalize } from './l2normalize.js';
import { buildLabel } from './labelling.js';
import { type CallerContext, visibleRows } from './row-visibility.js';
import type { ClusterRunParams } from './run-clusterer.js';
import { runClusterer as defaultRunClusterer } from './run-clusterer.js';

export interface CrystalliseConfig {
  /** UMAP output dimensionality. 0 skips reduction (holomap convention). */
  nComponents: number;
  nNeighbors: number;
  /** HDBSCAN floor — and the live-member floor below which a cluster retires. */
  minClusterSize: number;
  seed: number;
  /**
   * Cosine floor for accretion: how eagerly an unclaimed row joins an
   * existing cluster. Tune it per corpus.
   */
  accretionThreshold: number;
}

export const DEFAULT_CRYSTALLISE_CONFIG: CrystalliseConfig = {
  nComponents: 10,
  nNeighbors: 15,
  minClusterSize: 5,
  seed: 42,
  accretionThreshold: 0.6
};

export interface CrystalliseInput {
  mode: 'form' | 'accrete';
  select: CandidateSelector;
  params?: Partial<ClusterRunParams>;
}

export interface CrystalliseOutput {
  mode: 'form' | 'accrete';
  /** Rows the selector matched. */
  candidates: number;
  /** Of those, how many were unclaimed and therefore eligible. */
  considered: number;
  clustersFormed: number;
  clustersAccretedInto: number;
  membersAttached: number;
  /** Candidates the clusterer assigned to no cluster (formation only). */
  noise: number;
  clusters: Array<{ id: string; label: string; memberCount: number; cohesion: number }>;
  /** Members whose source row has gone, marked departed this pass. */
  departed: number;
  /** Clusters that fell below `minClusterSize` live members this pass. */
  retired: number;
}

export type PolicyProbe = (namespace: string, type: string) => PolicyDecision;

export interface CrystalliseCoreDeps {
  embeddings: EmbeddingsStore;
  clusters: ClusterStore;
  /** Active embedder model — the vector space everything here lives in. */
  model: string;
  config: CrystalliseConfig;
  /** Seam for tests; defaults to the real worker-backed runner. */
  runClusterer?: (vectors: readonly Float32Array[], params: ClusterRunParams) => Promise<number[]>;
  newId?: () => string;
  now?: () => Date;
  /** Identity-bound read-policy probe, as the recall route already threads. */
  checkReadPolicy?: PolicyProbe;
  /** The caller's request context, for row-filter obligations. Absent → anonymous. */
  caller?: CallerContext;
  /**
   * Returns the `memberKey`s of those `refs` whose source row no longer
   * exists, in one batched call per sweep.
   *
   * Report only rows POSITIVELY known to be gone: anything unresolved stays
   * attached. Departure cannot be undone, so a partial answer must
   * under-depart rather than over-depart.
   *
   * When absent, the decay sweep does not run at all.
   */
  rowsMissing?: (refs: readonly MemberRef[]) => Promise<Set<string>>;
}

function bad(message: string): never {
  throw Object.assign(new Error(message), { code: 'bad_request' });
}

/**
 * Returns `raw[key]` as an integer, or undefined when absent. Throws
 * `bad_request` if it is not an integer or is below `opts.min`.
 *
 * `min` mirrors `CrystalliseSchema` (bootstrap.ts), which guards only the
 * config file; this guards the per-request override. An out-of-range value can
 * hang the clusterer worker, and `minClusterSize: 0` retires every cluster.
 */
function integerOverride(
  raw: Record<string, unknown>,
  key: string,
  opts: { min?: number } = {}
): number | undefined {
  const value = raw[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    bad(`"params.${key}" must be an integer`);
  }
  if (opts.min !== undefined && value < opts.min) {
    bad(`"params.${key}" must be >= ${opts.min}`);
  }
  return value;
}

export function validateCrystalliseInput(value: unknown): CrystalliseInput {
  const raw = (value ?? {}) as Record<string, unknown>;

  // Default to accrete, never to form: accrete is cheap, incremental and
  // cannot create identity. A caller that wants formation says so.
  const mode = raw.mode ?? 'accrete';
  if (mode !== 'form' && mode !== 'accrete') {
    bad('"mode" must be "form" or "accrete"');
  }

  const select = validateSelector(raw.select);

  let params: Partial<ClusterRunParams> | undefined;
  if (raw.params !== undefined) {
    if (raw.params === null || typeof raw.params !== 'object') {
      bad('"params" must be an object');
    }
    const p = raw.params as Record<string, unknown>;
    const overrides: Partial<ClusterRunParams> = {};
    const nComponents = integerOverride(p, 'nComponents', { min: 0 });
    const nNeighbors = integerOverride(p, 'nNeighbors', { min: 1 });
    const minClusterSize = integerOverride(p, 'minClusterSize', { min: 1 });
    const seed = integerOverride(p, 'seed');
    if (nComponents !== undefined) overrides.nComponents = nComponents;
    if (nNeighbors !== undefined) overrides.nNeighbors = nNeighbors;
    if (minClusterSize !== undefined) overrides.minClusterSize = minClusterSize;
    if (seed !== undefined) overrides.seed = seed;
    params = overrides;
  }

  return { mode, select, ...(params !== undefined ? { params } : {}) };
}

/** Mean of the members' vectors, in whatever space they were handed in. */
function meanVector(vectors: readonly Float32Array[]): Float32Array {
  const dims = vectors[0]!.length;
  const sums = new Float64Array(dims);
  for (const v of vectors) {
    for (let i = 0; i < dims; i++) sums[i]! += v[i]!;
  }
  const out = new Float32Array(dims);
  for (let i = 0; i < dims; i++) out[i] = sums[i]! / vectors.length;
  return out;
}

function assertScopesReadable(select: CandidateSelector, check: PolicyProbe | undefined): void {
  if (check === undefined) return;
  for (const scope of select.scopes) {
    const decision = check(scope.namespace, scope.type);
    if (decision.allow) continue;
    throw Object.assign(
      new Error(
        `read policy denies ${scope.namespace}/${scope.type}${
          decision.reason === undefined ? '' : ` — ${decision.reason}`
        }`
      ),
      { code: 'policy_denied' }
    );
  }
}

/**
 * Mark departed members and retire clusters that fell below the floor.
 *
 * Returns the counts departed and retired. No-op when `deps.rowsMissing` is
 * absent.
 *
 * Runs first in both modes, so accretion never attaches to a cluster about to
 * retire. Departure marks rather than removes, keeping membership auditable.
 *
 * Retirement also departs the cluster's survivors: `claimedMembers` ignores
 * `retiredAt` and there is no un-retire, so they would otherwise stay claimed
 * forever. `retire()` and `markDeparted()` are not one transaction, so every
 * pass re-checks already-retired clusters and departs any stranded survivors.
 */
async function sweepStaleMembership(
  deps: CrystalliseCoreDeps,
  stamp: Date
): Promise<{ departed: number; retired: number }> {
  const probe = deps.rowsMissing;
  if (probe === undefined) return { departed: 0, retired: 0 };

  // The whole membership in one read, indexed by cluster. The retirement loop
  // needs members of RETIRED clusters too, which a live-clusters walk misses.
  const membersByCluster = new Map<string, MemberRef[]>();
  for (const member of await deps.clusters.listAllMembers()) {
    const ref: MemberRef = {
      namespace: member.memberNs,
      type: member.memberType,
      id: member.memberId
    };
    const bucket = membersByCluster.get(member.clusterId);
    if (bucket === undefined) membersByCluster.set(member.clusterId, [ref]);
    else bucket.push(ref);
  }

  const live = await deps.clusters.listClusters();
  const attached = live.flatMap((cluster) => membersByCluster.get(cluster.id) ?? []);

  // One probe call for every live member, so the host can batch per type.
  const missing = attached.length === 0 ? new Set<string>() : await probe(attached);
  const gone = attached.filter((ref) => missing.has(memberKey(ref)));
  const goneKeys = new Set(gone.map(memberKey));

  const departed = gone.length === 0 ? 0 : await deps.clusters.markDeparted(gone, stamp);

  let retired = 0;
  // includeRetired: an already-retired cluster may still hold stranded
  // survivors. Read after `markDeparted`, so counts are current.
  for (const cluster of await deps.clusters.listClusters({ includeRetired: true })) {
    if (cluster.retiredAt === null) {
      // The floor recorded at this cluster's own formation, which may have
      // been a per-request override, not the config default.
      const floor = cluster.provenance.params.minClusterSize;
      if (cluster.memberCount >= floor) continue;

      await deps.clusters.retire(cluster.id, stamp);
      // Counts transitions only, not repairs of already-retired clusters.
      retired++;
    }

    // Depart any survivors of a retired cluster, whether it retired just now
    // or an earlier pass was interrupted (see the function doc).
    const survivors = (membersByCluster.get(cluster.id) ?? []).filter(
      (ref) => !goneKeys.has(memberKey(ref))
    );
    if (survivors.length > 0) {
      await deps.clusters.markDeparted(survivors, stamp);
    }
  }

  return { departed, retired };
}

export async function handleCrystallise(
  input: CrystalliseInput,
  deps: CrystalliseCoreDeps
): Promise<CrystalliseOutput> {
  assertScopesReadable(input.select, deps.checkReadPolicy);

  const now = deps.now ?? ((): Date => new Date());
  const newId = deps.newId ?? ((): string => crypto.randomUUID());

  const decay = await sweepStaleMembership(deps, now());

  // Only rows the caller can read are clustered, so a cluster formed here
  // carries no member, and no label text, its row filters hide.
  const candidates = visibleRows(
    await deps.embeddings.selectCandidates(input.select, deps.model),
    deps.checkReadPolicy,
    deps.caller
  );
  const claimed = await deps.clusters.claimedMembers(
    candidates.map((c) => ({ namespace: c.namespace, type: c.type, id: c.id }))
  );
  const unclaimed = candidates.filter((c) => !claimed.has(memberKey(c)));

  const empty: CrystalliseOutput = {
    mode: input.mode,
    candidates: candidates.length,
    considered: unclaimed.length,
    clustersFormed: 0,
    clustersAccretedInto: 0,
    membersAttached: 0,
    noise: 0,
    clusters: [],
    departed: decay.departed,
    retired: decay.retired
  };

  if (unclaimed.length === 0) return empty;

  if (input.mode === 'accrete') {
    return accrete(unclaimed, empty, deps, now(), newId);
  }

  const params: ClusterRunParams = {
    nComponents: input.params?.nComponents ?? deps.config.nComponents,
    nNeighbors: input.params?.nNeighbors ?? deps.config.nNeighbors,
    minClusterSize: input.params?.minClusterSize ?? deps.config.minClusterSize,
    seed: input.params?.seed ?? deps.config.seed
  };

  // Not a removable no-op: it changes results numerically, and is the
  // `normalised` regime recorded in provenance.
  const normalised = l2normalize(unclaimed.map((c) => c.vector));

  const run = deps.runClusterer ?? ((v, p): Promise<number[]> => defaultRunClusterer(v, p));
  const assignments = await run(normalised, params);

  const groups = new Map<number, Candidate[]>();
  let noise = 0;
  for (const [i, label] of assignments.entries()) {
    if (label < 0) {
      noise++;
      continue;
    }
    const bucket = groups.get(label);
    if (bucket === undefined) groups.set(label, [unclaimed[i]!]);
    else bucket.push(unclaimed[i]!);
  }

  const provenance: ClusterProvenance = {
    backend: CLUSTERER_BACKEND,
    backendVersion: CLUSTERER_BACKEND_VERSION,
    regime: 'normalised',
    seed: params.seed,
    params: {
      nComponents: params.nComponents,
      nNeighbors: params.nNeighbors,
      minClusterSize: params.minClusterSize
    },
    model: deps.model
  };

  const summaries: CrystalliseOutput['clusters'] = [];
  let membersAttached = 0;
  const stamp = now();

  // Ascending label order so a run's clusters are created in a reproducible
  // sequence — shortId and formedAt ordering then mean something.
  for (const label of Array.from(groups.keys()).sort((a, b) => a - b)) {
    const members = groups.get(label)!;
    // ORIGINAL space, not the normalised copy and never reduced space: a
    // reduced centroid cannot be searched against a full-dimension index.
    const centroid = meanVector(members.map((m) => m.vector));
    const similarities = members.map((m) => cosineSimilarity(m.vector, centroid));
    const cohesion = similarities.reduce((a, b) => a + b, 0) / similarities.length;

    const cluster = await deps.clusters.createCluster({
      id: newId(),
      centroid,
      cohesion,
      label: buildLabel(members, unclaimed, centroid),
      labelledBy: 'medoid',
      provenance,
      now: stamp
    });

    const attachments: NewMember[] = members.map((m, i) => ({
      id: newId(),
      clusterId: cluster.id,
      ref: { namespace: m.namespace, type: m.type, id: m.id },
      origin: 'formation',
      similarity: similarities[i]!,
      now: stamp
    }));
    await deps.clusters.attachMembers(attachments);
    membersAttached += attachments.length;

    summaries.push({
      id: cluster.id,
      label: cluster.label,
      memberCount: attachments.length,
      cohesion
    });
  }

  return {
    ...empty,
    clustersFormed: summaries.length,
    membersAttached,
    noise,
    clusters: summaries
  };
}

/**
 * Attach unclaimed rows to the nearest live centroid within the threshold.
 *
 * Never runs the clusterer, never touches an existing membership, and never
 * considers a retired cluster. An exact scan over live centroids.
 */
async function accrete(
  unclaimed: readonly Candidate[],
  empty: CrystalliseOutput,
  deps: CrystalliseCoreDeps,
  stamp: Date,
  newId: () => string
): Promise<CrystalliseOutput> {
  const live = await deps.clusters.listClusters();
  if (live.length === 0) return empty;

  const attachments: NewMember[] = [];
  const touched = new Set<string>();

  for (const candidate of unclaimed) {
    let bestId: string | null = null;
    let bestScore = Number.NEGATIVE_INFINITY;
    for (const cluster of live) {
      const score = cosineSimilarity(candidate.vector, cluster.centroid);
      // Ties break on the older cluster: `listClusters` is oldest-first and
      // the comparison is strict, so the first-seen winner is kept.
      if (score > bestScore) {
        bestScore = score;
        bestId = cluster.id;
      }
    }
    if (bestId === null || bestScore < deps.config.accretionThreshold) continue;

    attachments.push({
      id: newId(),
      clusterId: bestId,
      ref: { namespace: candidate.namespace, type: candidate.type, id: candidate.id },
      origin: 'accretion',
      similarity: bestScore,
      now: stamp
    });
    touched.add(bestId);
  }

  if (attachments.length === 0) return empty;
  await deps.clusters.attachMembers(attachments);

  const summaries: CrystalliseOutput['clusters'] = [];
  for (const clusterId of touched) {
    const cluster = await deps.clusters.getCluster(clusterId);
    if (cluster === null) continue;
    summaries.push({
      id: cluster.id,
      label: cluster.label,
      memberCount: cluster.memberCount,
      cohesion: cluster.cohesion
    });
  }

  return {
    ...empty,
    clustersAccretedInto: touched.size,
    membersAttached: attachments.length,
    clusters: summaries
  };
}

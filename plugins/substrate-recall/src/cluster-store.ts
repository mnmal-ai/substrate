/**
 * ClusterStore — persistence for crystallised clusters and their membership.
 * Implemented for pg and in-memory, like `EmbeddingsStore`.
 *
 * Membership is a row, not an edge: it carries `origin` (formation vs
 * accretion), the similarity at attach time, and a `departedAt` stamp for
 * mark-don't-remove.
 */

/**
 * How a clustering was produced. Required because different backends, and the
 * same backend on differently-rounded input, produce different assignments.
 */
export interface ClusterProvenance {
  /** `'wasm' | 'subprocess'` — which holomap-clusterer backend ran. */
  backend: string;
  /** The clusterer package version, e.g. `'0.1.0'`. */
  backendVersion: string;
  /**
   * The float path the input took. `'normalised'` means the vectors were
   * L2-normalised before the pipeline (which normalises again internally).
   */
  regime: 'raw' | 'normalised';
  seed: number;
  params: { nComponents: number; nNeighbors: number; minClusterSize: number };
  /** The embedder model whose vector space this cluster lives in. */
  model: string;
}

export interface ClusterRecord {
  id: string;
  shortId: number;
  /**
   * Mean of member vectors in the ORIGINAL embedding space, never reduced
   * space: a reduced centroid cannot be searched against the full index.
   */
  centroid: Float32Array;
  memberCount: number;
  departedCount: number;
  cohesion: number;
  label: string;
  labelledBy: 'medoid' | 'agent';
  provenance: ClusterProvenance;
  formedAt: Date;
  lastAccretedAt: Date | null;
  retiredAt: Date | null;
}

export interface ClusterMemberRecord {
  id: string;
  shortId: number;
  clusterId: string;
  memberNs: string;
  memberType: string;
  memberId: string;
  origin: 'formation' | 'accretion';
  similarity: number;
  attachedAt: Date;
  departedAt: Date | null;
}

/** Identifies one source row. */
export interface MemberRef {
  namespace: string;
  type: string;
  id: string;
}

export interface NewCluster {
  id: string;
  centroid: Float32Array;
  cohesion: number;
  label: string;
  labelledBy: 'medoid' | 'agent';
  provenance: ClusterProvenance;
  /** Override for tests. Defaults to `new Date()` inside the impl. */
  now?: Date;
}

export interface NewMember {
  id: string;
  clusterId: string;
  ref: MemberRef;
  origin: 'formation' | 'accretion';
  similarity: number;
  now?: Date;
}

export interface ClusterStore {
  /** Parallels `EmbeddingsStore.txScopeId` / `Dataset.txScopeId`. */
  readonly txScopeId: string;

  /** Insert a freshly formed cluster with zero members. */
  createCluster(input: NewCluster): Promise<ClusterRecord>;

  /**
   * Attach members and update the parent clusters' `memberCount` +
   * `lastAccretedAt` in one atomic unit. Re-attaching an existing
   * (cluster, member) pair is a silent no-op — accretion may legitimately
   * see the same row twice across concurrent passes.
   */
  attachMembers(inputs: readonly NewMember[]): Promise<void>;

  /** Live clusters, oldest first. Retired clusters excluded unless asked for. */
  listClusters(opts?: { includeRetired?: boolean }): Promise<ClusterRecord[]>;

  getCluster(id: string): Promise<ClusterRecord | null>;

  /** Members of one cluster. Departed members excluded unless asked for. */
  listMembers(
    clusterId: string,
    opts?: { includeDeparted?: boolean }
  ): Promise<ClusterMemberRecord[]>;

  /**
   * Every live (non-departed) membership across every cluster, in one query.
   * Spans RETIRED clusters deliberately: the decay sweep must release
   * survivors stranded on them.
   */
  listAllMembers(): Promise<ClusterMemberRecord[]>;

  /** The reverse walk: every membership row naming this source row. */
  findClustersForMember(ref: MemberRef): Promise<ClusterMemberRecord[]>;

  /**
   * Of `refs`, which are already claimed by a live (non-departed) membership?
   * Returned as `"ns/type/id"` keys. This is the never-reassign gate: both
   * formation and accretion subtract this set before doing anything.
   */
  claimedMembers(refs: readonly MemberRef[]): Promise<Set<string>>;

  /**
   * Mark memberships departed and re-derive the owning clusters' counts.
   * Idempotent — a already-departed membership keeps its original
   * `departedAt`. Returns how many rows transitioned.
   */
  markDeparted(refs: readonly MemberRef[], now?: Date): Promise<number>;

  /** Set `retiredAt`. Idempotent; a retired cluster keeps its original stamp. */
  retire(clusterId: string, now?: Date): Promise<void>;

  /** Replace the label. `labelledBy` becomes `'agent'`. Returns null if absent. */
  relabel(clusterId: string, label: string): Promise<ClusterRecord | null>;

  /**
   * Run `fn` holding a lock that excludes formation in EVERY process sharing
   * this store, or throw `crystallise_in_flight` at once if another holds it.
   * Never waits. Omitted by stores that only one process can see (in-memory).
   */
  withFormationLock?<T>(fn: () => Promise<T>): Promise<T>;
}

/** Canonical key for a member ref — the form `claimedMembers` returns. */
export function memberKey(ref: MemberRef): string {
  return `${ref.namespace}/${ref.type}/${ref.id}`;
}

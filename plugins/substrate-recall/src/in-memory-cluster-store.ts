/**
 * InMemoryClusterStore — non-persistent `ClusterStore` for tests and for
 * memory-backed deployments that want crystallisation without postgres.
 *
 * Parity with `PgClusterStore` at the interface boundary is the contract.
 * O(N) per lookup; not a production substrate.
 */

import type {
  ClusterMemberRecord,
  ClusterRecord,
  ClusterStore,
  MemberRef,
  NewCluster,
  NewMember
} from './cluster-store.js';
import { memberKey } from './cluster-store.js';

export interface InMemoryClusterStoreOptions {
  txScopeId?: string;
}

let nextTxScopeId = 1;

export class InMemoryClusterStore implements ClusterStore {
  readonly txScopeId: string;
  readonly #clusters = new Map<string, ClusterRecord>();
  readonly #members: ClusterMemberRecord[] = [];
  #nextShortId = 1;

  constructor(opts: InMemoryClusterStoreOptions = {}) {
    this.txScopeId = opts.txScopeId ?? `memory-clusters-${nextTxScopeId++}`;
  }

  async createCluster(input: NewCluster): Promise<ClusterRecord> {
    const record: ClusterRecord = {
      id: input.id,
      shortId: this.#nextShortId++,
      centroid: new Float32Array(input.centroid),
      memberCount: 0,
      departedCount: 0,
      cohesion: input.cohesion,
      label: input.label,
      labelledBy: input.labelledBy,
      provenance: input.provenance,
      formedAt: input.now ?? new Date(),
      lastAccretedAt: null,
      retiredAt: null
    };
    this.#clusters.set(record.id, record);
    return this.#copyCluster(record);
  }

  async attachMembers(inputs: readonly NewMember[]): Promise<void> {
    // Fallback for inputs without their own `now`. Each cluster's
    // `lastAccretedAt` comes from the inputs that touched it (`stamps`), so
    // differing explicit `now` values are not smeared across clusters.
    const batchNow = new Date();
    const stamps = new Map<string, Date>();
    for (const input of inputs) {
      const dup = this.#members.find(
        (m) =>
          m.clusterId === input.clusterId &&
          m.memberNs === input.ref.namespace &&
          m.memberType === input.ref.type &&
          m.memberId === input.ref.id
      );
      if (dup !== undefined) continue;
      this.#members.push({
        id: input.id,
        shortId: this.#nextShortId++,
        clusterId: input.clusterId,
        memberNs: input.ref.namespace,
        memberType: input.ref.type,
        memberId: input.ref.id,
        origin: input.origin,
        similarity: input.similarity,
        attachedAt: input.now ?? batchNow,
        departedAt: null
      });
      stamps.set(input.clusterId, input.now ?? batchNow);
    }
    for (const [clusterId, stamp] of stamps) {
      const cluster = this.#clusters.get(clusterId);
      if (cluster === undefined) continue;
      this.#recount(clusterId);
      cluster.lastAccretedAt = stamp;
    }
  }

  async listClusters(opts: { includeRetired?: boolean } = {}): Promise<ClusterRecord[]> {
    return Array.from(this.#clusters.values())
      .filter((c) => opts.includeRetired === true || c.retiredAt === null)
      .sort((a, b) => a.formedAt.getTime() - b.formedAt.getTime() || a.shortId - b.shortId)
      .map((c) => this.#copyCluster(c));
  }

  async getCluster(id: string): Promise<ClusterRecord | null> {
    const found = this.#clusters.get(id);
    return found === undefined ? null : this.#copyCluster(found);
  }

  async listMembers(
    clusterId: string | readonly string[],
    opts: { includeDeparted?: boolean } = {}
  ): Promise<ClusterMemberRecord[]> {
    const ids = new Set(typeof clusterId === 'string' ? [clusterId] : clusterId);
    return this.#members
      .filter((m) => ids.has(m.clusterId))
      .filter((m) => opts.includeDeparted === true || m.departedAt === null)
      .map((m) => ({ ...m }));
  }

  async listAllMembers(): Promise<ClusterMemberRecord[]> {
    return this.#members.filter((m) => m.departedAt === null).map((m) => ({ ...m }));
  }

  async findClustersForMember(ref: MemberRef): Promise<ClusterMemberRecord[]> {
    return this.#members
      .filter(
        (m) => m.memberNs === ref.namespace && m.memberType === ref.type && m.memberId === ref.id
      )
      .map((m) => ({ ...m }));
  }

  async claimedMembers(refs: readonly MemberRef[]): Promise<Set<string>> {
    const wanted = new Set(refs.map(memberKey));
    const out = new Set<string>();
    for (const m of this.#members) {
      if (m.departedAt !== null) continue;
      const key = memberKey({ namespace: m.memberNs, type: m.memberType, id: m.memberId });
      if (wanted.has(key)) out.add(key);
    }
    return out;
  }

  async markDeparted(refs: readonly MemberRef[], now?: Date): Promise<number> {
    const wanted = new Set(refs.map(memberKey));
    const stamp = now ?? new Date();
    const touched = new Set<string>();
    let count = 0;
    for (const m of this.#members) {
      if (m.departedAt !== null) continue;
      const key = memberKey({ namespace: m.memberNs, type: m.memberType, id: m.memberId });
      if (!wanted.has(key)) continue;
      m.departedAt = stamp;
      touched.add(m.clusterId);
      count++;
    }
    for (const clusterId of touched) this.#recount(clusterId);
    return count;
  }

  async retire(clusterId: string, now?: Date): Promise<void> {
    const cluster = this.#clusters.get(clusterId);
    if (cluster === undefined || cluster.retiredAt !== null) return;
    cluster.retiredAt = now ?? new Date();
  }

  async relabel(clusterId: string, label: string): Promise<ClusterRecord | null> {
    const cluster = this.#clusters.get(clusterId);
    if (cluster === undefined) return null;
    cluster.label = label;
    cluster.labelledBy = 'agent';
    return this.#copyCluster(cluster);
  }

  /**
   * Copy a cluster for return, including `centroid` and `provenance.params`,
   * so a caller mutating the result cannot corrupt the stored cluster.
   */
  #copyCluster(record: ClusterRecord): ClusterRecord {
    return {
      ...record,
      centroid: new Float32Array(record.centroid),
      provenance: { ...record.provenance, params: { ...record.provenance.params } }
    };
  }

  /** Re-derive both counters from the membership rows — never increment blind. */
  #recount(clusterId: string): void {
    const cluster = this.#clusters.get(clusterId);
    if (cluster === undefined) return;
    const mine = this.#members.filter((m) => m.clusterId === clusterId);
    cluster.memberCount = mine.filter((m) => m.departedAt === null).length;
    cluster.departedCount = mine.length - cluster.memberCount;
  }
}

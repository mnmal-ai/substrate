/**
 * Frame surface for the crystallisation rows: `recall/Cluster`,
 * `recall/ClusterMember`, and the `recall/crystallise` +
 * `recall/labelCluster` mutations.
 *
 * Resolver-backed virtual types reading through `ClusterStore`, not autoCRUD:
 * a substrate namespace is dataset-less, so the store IS the persistence.
 * `labelCluster` lets an agent replace the deterministic medoid label assigned
 * at formation; `labelledBy` records which happened.
 *
 * READ-POLICY GATE: clustering reads row bodies and vectors, so the derived
 * rows are gated at least as strictly. `centroid` is withheld from
 * `CLUSTER_FIELDS`; `ClusterMember` exposes row ids in gated namespaces, and
 * `Cluster.label` is built from member text. Three postures:
 *   - `recall/ClusterMember` — each row's own `(memberNs, memberType)` is
 *     checked, and its row filters run on the member's stored body; denied
 *     rows are silently dropped, since a cluster can span namespaces the
 *     caller has mixed access to.
 *   - `recall/Cluster` — visible if the caller can read at least one live
 *     member's scope (or it has no live members); otherwise silently dropped.
 *     `memberCount` / `departedCount` are policy-filtered too, so they cannot
 *     disclose that an unreadable member exists. `label` is null unless the
 *     caller can read every member's scope, since it is built from any of them.
 *   - `recall/labelCluster` — the same visibility predicate, but it mutates,
 *     so denial is a loud `policy_denied`.
 * With no `checkReadPolicy`, everything is visible and counts pass through.
 *
 * `crystalliseResolver` must share the route's `CrystalliseGuard` instance
 * (see `crystallise-guard.ts`), or a frame call can race a route call and
 * form duplicate clusters.
 */

import type { FieldDef, RequestContext, ResolverArgs, Row } from '@mnmal-ai/substrate-types';
import { ResolverFrameError } from '@mnmal-ai/substrate-types';
import type {
  ClusterMemberRecord,
  ClusterRecord,
  ClusterStore,
  MemberRef
} from './cluster-store.js';
import type { CrystalliseConfig } from './crystallise-core.js';
import { handleCrystallise, validateCrystalliseInput } from './crystallise-core.js';
import {
  CRYSTALLISE_IN_FLIGHT_CODE,
  type CrystalliseGuard,
  createCrystalliseGuard
} from './crystallise-guard.js';
import type { EmbeddingsStore } from './embeddings-store.js';
import { bindPolicy, type ReadPolicyCheck } from './recall-route.js';
import { callerFromContext, visibleRefs } from './row-visibility.js';
import type { ClusterRunParams } from './run-clusterer.js';

const scalar = (type: 'string' | 'number' | 'boolean' | 'date' | 'json'): FieldDef => ({
  kind: 'scalar',
  type
});

/**
 * Published shape of a `recall/Cluster` row.
 *
 * `centroid` is deliberately absent: it is a full embedding vector per row,
 * raw vector content that `/substrate/v1/embeddings/fetch` serves under its own gate.
 */
export const CLUSTER_FIELDS: Record<string, FieldDef> = {
  id: scalar('string'),
  shortId: scalar('number'),
  memberCount: scalar('number'),
  departedCount: scalar('number'),
  cohesion: scalar('number'),
  label: scalar('string'),
  labelledBy: scalar('string'),
  provenance: scalar('json'),
  formedAt: scalar('date'),
  lastAccretedAt: scalar('date'),
  retiredAt: scalar('date')
};

export const CLUSTER_MEMBER_FIELDS: Record<string, FieldDef> = {
  id: scalar('string'),
  shortId: scalar('number'),
  cluster: scalar('string'),
  memberNs: scalar('string'),
  memberType: scalar('string'),
  memberId: scalar('string'),
  origin: scalar('string'),
  similarity: scalar('number'),
  attachedAt: scalar('date'),
  departedAt: scalar('date')
};

export interface ClusterSurfaceDeps {
  embeddings: EmbeddingsStore;
  clusters: ClusterStore;
  model: string;
  config: CrystalliseConfig;
  runClusterer?: (vectors: readonly Float32Array[], params: ClusterRunParams) => Promise<number[]>;
  rowsMissing?: (refs: readonly MemberRef[]) => Promise<Set<string>>;
  checkReadPolicy?: ReadPolicyCheck;
  /**
   * Shared mutual-exclusion guard (see module doc); must be the instance the
   * route holds. Omitted = a private guard scoped to this surface only, which
   * is NOT sufficient for production wiring.
   */
  guard?: CrystalliseGuard;
}

function bad(message: string): never {
  throw new ResolverFrameError('bad_request', message);
}

/** Mirror of `frame-surface.ts`'s projectHit — same strip-all semantics. */
function project(row: Row, fields: Record<string, unknown> | undefined): Row {
  if (fields === undefined) return row;
  const keep = Object.entries(fields)
    .filter(([, v]) => v === true)
    .map(([k]) => k);
  const out: Record<string, unknown> = {};
  for (const k of keep) {
    if (k in row) out[k] = (row as Record<string, unknown>)[k];
  }
  return out as Row;
}

/**
 * `counts` overrides the record's own `memberCount`/`departedCount` — see
 * `resolveClusterVisibility`: policy-filtered when a read policy is wired,
 * otherwise identical to the record's stored counts.
 */
function clusterRow(
  c: ClusterRecord,
  counts: { memberCount: number; departedCount: number; labelReadable: boolean }
): Row {
  return {
    id: c.id,
    shortId: c.shortId,
    memberCount: counts.memberCount,
    departedCount: counts.departedCount,
    cohesion: c.cohesion,
    label: counts.labelReadable ? c.label : null,
    labelledBy: c.labelledBy,
    provenance: c.provenance,
    formedAt: c.formedAt,
    lastAccretedAt: c.lastAccretedAt,
    retiredAt: c.retiredAt
  };
}

function memberRow(m: ClusterMemberRecord): Row {
  return {
    id: m.id,
    shortId: m.shortId,
    cluster: m.clusterId,
    memberNs: m.memberNs,
    memberType: m.memberType,
    memberId: m.memberId,
    origin: m.origin,
    similarity: m.similarity,
    attachedAt: m.attachedAt,
    departedAt: m.departedAt
  };
}

function rethrowCoded(err: unknown): never {
  const code = (err as { code?: string } | null)?.code;
  const message = err instanceof Error ? err.message : String(err);
  if (code === 'policy_denied' || code === 'bad_request' || code === CRYSTALLISE_IN_FLIGHT_CODE) {
    throw new ResolverFrameError(code, message);
  }
  throw err;
}

interface ClusterVisibility {
  visible: boolean;
  memberCount: number;
  departedCount: number;
  labelReadable: boolean;
}

/**
 * Returns whether `record` is visible to this caller, plus its
 * policy-filtered `memberCount` / `departedCount`. Shared by `clusterResolver`
 * (silent filter) and `labelClusterResolver` (loud denial).
 *
 * Visible if the caller can read at least one LIVE member's
 * `(memberNs, memberType)` scope, or if there are no live members (nothing
 * left to leak). Without `checkReadPolicy`, always visible with stored counts
 * and no member query. One `listMembers({ includeDeparted: true })` call
 * answers both visibility and counts; `check` is cached per scope.
 */
async function resolveClusterVisibility(
  record: ClusterRecord,
  deps: ClusterSurfaceDeps,
  ctx: RequestContext
): Promise<ClusterVisibility> {
  if (deps.checkReadPolicy === undefined) return storedVisibility(record);
  const members = await deps.clusters.listMembers(record.id, { includeDeparted: true });
  return visibilityOf(members, await readableMembers(members, deps, ctx));
}

/**
 * `resolveClusterVisibility` for a whole listing: one member read and one
 * readability check across every cluster, rather than two per cluster.
 */
async function resolveListVisibility(
  records: readonly ClusterRecord[],
  deps: ClusterSurfaceDeps,
  ctx: RequestContext
): Promise<ClusterVisibility[]> {
  if (deps.checkReadPolicy === undefined || records.length === 0) {
    return records.map(storedVisibility);
  }
  const members = await deps.clusters.listMembers(
    records.map((r) => r.id),
    { includeDeparted: true }
  );
  const readable = await readableMembers(members, deps, ctx);
  const byCluster = new Map<string, ClusterMemberRecord[]>();
  for (const m of members) {
    const list = byCluster.get(m.clusterId);
    if (list === undefined) byCluster.set(m.clusterId, [m]);
    else list.push(m);
  }
  return records.map((r) => visibilityOf(byCluster.get(r.id) ?? [], readable));
}

function storedVisibility(record: ClusterRecord): ClusterVisibility {
  return {
    visible: true,
    memberCount: record.memberCount,
    departedCount: record.departedCount,
    labelReadable: true
  };
}

function visibilityOf(
  members: readonly ClusterMemberRecord[],
  readable: ReadonlySet<ClusterMemberRecord>
): ClusterVisibility {
  // `liveTotal` (unfiltered) is separate from `memberCount` (readable-live)
  // because a cluster with no live members stays visible, while one whose
  // live members are all unreadable does not.
  let liveTotal = 0;
  let memberCount = 0;
  let departedCount = 0;
  let labelReadable = true;
  for (const m of members) {
    const canRead = readable.has(m);
    if (!canRead) labelReadable = false;
    if (m.departedAt === null) {
      liveTotal++;
      if (canRead) memberCount++;
    } else if (canRead) {
      departedCount++;
    }
  }
  return {
    visible: liveTotal === 0 || memberCount > 0,
    memberCount,
    departedCount,
    labelReadable
  };
}

/**
 * The members this caller can read: their scope's read policy allows them,
 * and its row filters admit the member's stored row body.
 */
async function readableMembers(
  members: readonly ClusterMemberRecord[],
  deps: ClusterSurfaceDeps,
  ctx: RequestContext
): Promise<Set<ClusterMemberRecord>> {
  const check = deps.checkReadPolicy;
  if (check === undefined) return new Set(members);
  const refs = members.map((m) => ({
    namespace: m.memberNs,
    type: m.memberType,
    id: m.memberId,
    member: m
  }));
  const caller = callerFromContext(ctx);
  const kept = await visibleRefs(
    refs,
    (ns, type) => check(ns, type, caller.identity, caller),
    caller,
    deps.embeddings,
    deps.model
  );
  return new Set(kept.map((r) => r.member));
}

// Precise literal shapes rather than `Record<string, ...>`, so callers need
// not prove each key present under `noUncheckedIndexedAccess`.
type ClusterTypeEntry = {
  fields: Record<string, FieldDef>;
  resolver: (ctx: RequestContext, args: ResolverArgs) => Promise<Row[]>;
};
type ClusterMutationEntry = {
  resolver: (ctx: RequestContext, args: ResolverArgs) => Promise<Row>;
};

export function buildClusterSurface(deps: ClusterSurfaceDeps): {
  types: { Cluster: ClusterTypeEntry; ClusterMember: ClusterTypeEntry };
  mutations: { crystallise: ClusterMutationEntry; labelCluster: ClusterMutationEntry };
} {
  // Private fallback guard: NOT sufficient for production wiring (see
  // ClusterSurfaceDeps.guard).
  const guard = deps.guard ?? createCrystalliseGuard();

  const clusterResolver = async (ctx: RequestContext, args: ResolverArgs): Promise<Row[]> => {
    const p = (args.params ?? {}) as Record<string, unknown>;
    if (p.includeRetired !== undefined && typeof p.includeRetired !== 'boolean') {
      bad('"includeRetired" must be a boolean');
    }
    if (typeof p.id === 'string') {
      const one = await deps.clusters.getCluster(p.id);
      if (one === null) return [];
      const vis = await resolveClusterVisibility(one, deps, ctx);
      if (!vis.visible) return [];
      return [project(clusterRow(one, vis), args.fields)];
    }
    const rows = await deps.clusters.listClusters(
      p.includeRetired === true ? { includeRetired: true } : {}
    );
    const visibility = await resolveListVisibility(rows, deps, ctx);
    const visible: Row[] = [];
    for (const [i, c] of rows.entries()) {
      const vis = visibility[i];
      if (vis?.visible === true) visible.push(project(clusterRow(c, vis), args.fields));
    }
    return visible;
  };

  const memberResolver = async (ctx: RequestContext, args: ResolverArgs): Promise<Row[]> => {
    const p = (args.params ?? {}) as Record<string, unknown>;
    const readable = async (rows: ClusterMemberRecord[]): Promise<ClusterMemberRecord[]> => {
      const keep = await readableMembers(rows, deps, ctx);
      return rows.filter((m) => keep.has(m));
    };

    if (typeof p.cluster === 'string') {
      const rows = await deps.clusters.listMembers(
        p.cluster,
        p.includeDeparted === true ? { includeDeparted: true } : {}
      );
      return (await readable(rows)).map((m) => project(memberRow(m), args.fields));
    }

    if (
      typeof p.memberNs === 'string' &&
      typeof p.memberType === 'string' &&
      typeof p.memberId === 'string'
    ) {
      const rows = await deps.clusters.findClustersForMember({
        namespace: p.memberNs,
        type: p.memberType,
        id: p.memberId
      });
      return (await readable(rows)).map((m) => project(memberRow(m), args.fields));
    }

    // Refused rather than defaulted to "every membership row in the store":
    // the same hygiene posture the selection filter takes.
    bad(
      'recall/ClusterMember requires either "cluster" or the full ' +
        '("memberNs", "memberType", "memberId") triple'
    );
  };

  const crystalliseResolver = async (ctx: RequestContext, args: ResolverArgs): Promise<Row> => {
    const bound = bindPolicy(deps.checkReadPolicy, callerFromContext(ctx));
    try {
      const input = validateCrystalliseInput(args.params);
      const out = await guard.runExclusive(() =>
        handleCrystallise(input, {
          embeddings: deps.embeddings,
          clusters: deps.clusters,
          model: deps.model,
          config: deps.config,
          ...(deps.runClusterer !== undefined ? { runClusterer: deps.runClusterer } : {}),
          ...(deps.rowsMissing !== undefined ? { rowsMissing: deps.rowsMissing } : {}),
          ...(bound !== undefined ? { checkReadPolicy: bound } : {}),
          caller: callerFromContext(ctx)
        })
      );
      // Mutations must return a Row (id required); 'crystallise' is a
      // sentinel, never a real row id — same convention as boost's 'ack'.
      return { id: 'crystallise', ...out } as unknown as Row;
    } catch (err) {
      rethrowCoded(err);
    }
  };

  const labelClusterResolver = async (ctx: RequestContext, args: ResolverArgs): Promise<Row> => {
    const p = (args.params ?? {}) as Record<string, unknown>;
    if (typeof p.id !== 'string' || p.id.length === 0) bad('"id" must be a non-empty string');
    if (typeof p.label !== 'string' || p.label.trim().length === 0) {
      bad('"label" must be a non-empty string');
    }
    // Loud, not filtered: this mutates, so a caller with no visibility into
    // the cluster gets an explicit denial rather than a silent no-op.
    const before = await deps.clusters.getCluster(p.id);
    if (before === null) bad(`no cluster with id '${p.id}'`);
    const preVis = await resolveClusterVisibility(before, deps, ctx);
    if (!preVis.visible) {
      throw new ResolverFrameError('policy_denied', `read policy denies cluster '${p.id}'`);
    }
    const updated = await deps.clusters.relabel(p.id, p.label.trim());
    if (updated === null) bad(`no cluster with id '${p.id}'`);
    // Membership is unchanged by relabel, so the pre-mutation visibility
    // result's counts are still accurate — no need to re-fetch members.
    // The label echoed back is the caller's own, so it discloses nothing.
    return clusterRow(updated, { ...preVis, labelReadable: true });
  };

  return {
    types: {
      Cluster: { fields: CLUSTER_FIELDS, resolver: clusterResolver },
      ClusterMember: { fields: CLUSTER_MEMBER_FIELDS, resolver: memberResolver }
    },
    mutations: {
      crystallise: { resolver: crystalliseResolver },
      labelCluster: { resolver: labelClusterResolver }
    }
  };
}

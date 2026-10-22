/**
 * Sweep reconciler. Spec: §6.3.
 *
 * Drain-loop semantics:
 *   - Read base batches by cursor until the scan ends or the time budget runs out.
 *   - Walk a worklist, seeded by the base batch, extended with cascade fan-out.
 *   - Dedupe via the set of enqueued edge ids so diamonds process each edge once.
 *   - Cursor advances ONLY by base-batch `lastId`; cascade fan-out is
 *     idempotent and may re-appear in a later cycle.
 *   - Empty base batch → cursor wraps to null (head on next cycle).
 *   - A short base batch ends the call; the scan wraps on the next one.
 *
 * Target resolution:
 *   - EXISTS: row present, no _deletedAt.
 *   - DELETED: row present with _deletedAt.
 *   - MISSING: no dataset for ns OR row absent AND no tombstone cached.
 *
 * Bridge-unreachable appears in two places (spec §6.3):
 *   - Sweep loop on MISSING: bail, emit `bridge_unreachable`, edge untouched.
 *   - applyPolicy('cascade') on DELETED: set `blocked=true`, emit
 *     `cascade_blocked_bridge`.
 */

import type {
  ActorIdentity,
  Dataset,
  Edge,
  EdgeRef,
  SweepDeps,
  SweepState,
  TargetState
} from '@mnmal-ai/substrate-types';
import { BridgeUnreachableError } from './bridge-unreachable-error.js';

export type SweepMetricName =
  | 'swept'
  | 'policy_applied'
  | 'bridge_unreachable'
  | 'cascade_blocked_bridge'
  | 'restrict_violation'
  | 'from_ns_unknown';

const DEFAULT_BATCH_SIZE = 100;
const SWEEP_ACTOR: ActorIdentity = { kind: 'system', id: 'sweep' };

/** `UNKNOWN`: the bridge could not answer (down, or refused), so nothing may be applied. */
async function resolveTarget(ref: EdgeRef, deps: SweepDeps): Promise<TargetState | 'UNKNOWN'> {
  const ds: Dataset | undefined = deps.datasets.get(ref.ns);
  if (ds) {
    const { rows } = await ds.read(ref.type, { id: ref.id, includeDeleted: true });
    const row = rows[0];
    if (!row) return 'MISSING';
    return row._deletedAt != null ? 'DELETED' : 'EXISTS';
  }

  // No local dataset. If the namespace is bridged, go to the bridge for the
  // row. §5.8: a successful read classifies EXISTS/DELETED; a null row is
  // MISSING. A failed read is UNKNOWN, never MISSING: a 403 does not flip the
  // registry's `isUnreachable` flag, so MISSING would let the policy run and
  // delete local rows over a refusal (§6.3 leaves the edge untouched).
  const bridge = deps.bridges.get(ref.ns);
  if (bridge !== undefined) {
    try {
      const row = await bridge.readRow(ref);
      if (row === null) return 'MISSING';
      return row._deletedAt != null ? 'DELETED' : 'EXISTS';
    } catch (err) {
      if (err instanceof BridgeUnreachableError) return 'UNKNOWN';
      throw err;
    }
  }

  // Unknown namespace (neither local nor bridged) → MISSING, per §6.3.
  return 'MISSING';
}

export async function applyPolicy(
  edge: Edge,
  cascadeQueue: Edge[],
  deps: SweepDeps
): Promise<void> {
  // The edge was read at batch start; it may have been tombstoned since.
  const live = await deps.edges.findEdgesFrom(edge.from);
  if (!live.some((e) => e.id === edge.id)) return;

  const fromDs = deps.datasets.get(edge.from.ns);
  // Acts only while the source field still points at this edge's target.
  const stillPointing = { [edge.fieldName]: edge.to.id };

  switch (edge.policy) {
    case 'set_null': {
      if (!fromDs) {
        await deps.edges.tombstone(edge.id, deps.now());
        deps.metric('from_ns_unknown', edge.from.ns);
        return;
      }
      await fromDs.conditionalUpdate(
        edge.from.type,
        edge.from.id,
        stillPointing,
        { [edge.fieldName]: null },
        SWEEP_ACTOR,
        deps.now()
      );
      await deps.edges.tombstone(edge.id, deps.now());
      deps.metric('policy_applied', 'set_null');
      return;
    }

    case 'cascade': {
      if (edge.to.bridged === true && deps.bridges.isUnreachable(edge.to.ns)) {
        await deps.edges.update({ id: edge.id, blocked: true });
        deps.metric('cascade_blocked_bridge', edge.to.ns);
        return;
      }
      if (!fromDs) {
        await deps.edges.tombstone(edge.id, deps.now());
        deps.metric('from_ns_unknown', edge.from.ns);
        return;
      }
      // The match row-locks the source until the tombstone commits, so a
      // concurrent repoint either lands first (no match) or waits.
      const cascaded = await fromDs.withTransaction(async (tx) => {
        const { matched } = await tx.conditionalUpdate(
          edge.from.type,
          edge.from.id,
          stillPointing,
          {},
          SWEEP_ACTOR,
          deps.now()
        );
        if (matched) await tx.tombstone(edge.from.type, [edge.from.id]);
        return matched;
      });
      await deps.edges.tombstone(edge.id, deps.now());
      if (!cascaded) return;

      const fanout = await deps.edges.findEdgesTo(edge.from);
      for (const inEdge of fanout) {
        if (inEdge.deletedAt !== undefined) continue;
        cascadeQueue.push(inEdge);
      }
      deps.metric('policy_applied', 'cascade');
      return;
    }

    case 'restrict': {
      await deps.edges.update({ id: edge.id, lastSweptAt: deps.now() });
      deps.metric('restrict_violation', {
        edgeId: edge.id,
        from: edge.from,
        to: edge.to,
        fieldName: edge.fieldName
      });
      return;
    }

    case 'orphan': {
      await deps.edges.update({ id: edge.id, lastSweptAt: deps.now() });
      deps.metric('policy_applied', 'orphan');
      return;
    }
  }
}

/**
 * Sweeps base batches from `state`'s cursor until the edge scan reaches its
 * end or `budgetMs` of wall-clock has elapsed; at least one batch always runs.
 */
export async function runSweep(
  deps: SweepDeps,
  state: SweepState,
  batchSize: number = DEFAULT_BATCH_SIZE,
  budgetMs = 0
): Promise<SweepState> {
  const deadline = Date.now() + budgetMs;
  let cursor = state.lastSweptCursor;
  let swept = 0;
  for (;;) {
    const batch = await deps.edges.readNextBatch(cursor, batchSize);
    swept += await sweepBatch(batch.edges, deps);
    if (batch.edges.length === 0) {
      cursor = null;
      break;
    }
    cursor = batch.lastId;
    if (batch.edges.length < batchSize || Date.now() >= deadline) break;
  }
  deps.metric('swept', swept);
  return { lastSweptCursor: cursor };
}

/** Processes one base batch plus its cascade fan-out; returns the edge count. */
async function sweepBatch(base: Edge[], deps: SweepDeps): Promise<number> {
  const cascadeQueue: Edge[] = [];
  // Every edge ever enqueued, so diamonds process each edge once.
  const worklist: Edge[] = [...base];
  const queued = new Set<string>(worklist.map((e) => e.id));

  for (let i = 0; i < worklist.length; i++) {
    const edge = worklist[i] as Edge;
    if (edge.deletedAt !== undefined) continue;

    const target = await resolveTarget(edge.to, deps);

    if (target === 'EXISTS') {
      await deps.edges.update({ id: edge.id, lastSweptAt: deps.now() });
    } else if (target === 'UNKNOWN') {
      deps.metric('bridge_unreachable', edge.to.ns);
      // Edge untouched — no lastSweptAt, no blocked.
    } else if (target === 'DELETED') {
      await applyPolicy(edge, cascadeQueue, deps);
    } else {
      // MISSING
      if (edge.to.bridged === true && deps.bridges.isUnreachable(edge.to.ns)) {
        deps.metric('bridge_unreachable', edge.to.ns);
        // Edge untouched — no lastSweptAt, no blocked.
      } else {
        await applyPolicy(edge, cascadeQueue, deps);
      }
    }

    for (const e of cascadeQueue) {
      if (queued.has(e.id)) continue;
      queued.add(e.id);
      worklist.push(e);
    }
    cascadeQueue.length = 0;
  }

  return worklist.length;
}

const SWEEP_CURSOR_TYPE = 'SweepCursor';
// A fixed UUID, not a name: SUBSTRATE_ENFORCE_UUID_CHECK's rows_id_uuid_format
// constraint refuses any other id, and the sweep then fails every cycle.
const SWEEP_CURSOR_ID = '5ee9c0a5-0000-4000-8000-000000000001';

/** Reads the sweep cursor persisted by `saveSweepState`, or the scan head. */
export async function loadSweepState(ds: Dataset): Promise<SweepState> {
  const { rows } = await ds.read(SWEEP_CURSOR_TYPE, { id: SWEEP_CURSOR_ID, limit: 1 });
  const cursor = rows[0]?.cursor;
  return { lastSweptCursor: typeof cursor === 'string' ? cursor : null };
}

/** Persists the sweep cursor as one row, so a restart resumes the scan. */
export async function saveSweepState(ds: Dataset, state: SweepState): Promise<void> {
  await ds.write(SWEEP_CURSOR_TYPE, [{ id: SWEEP_CURSOR_ID, cursor: state.lastSweptCursor }]);
}

/**
 * ExpansionResolver — query-time crossRef walking.
 *
 * Counterpart to SpreadResolver. Where SpreadResolver enumerates neighbours
 * to boost AFTER a recall hit, ExpansionResolver enumerates neighbours to
 * FETCH-AND-SCORE alongside the primary knn pool. Reuses the SAME opt-in
 * registry — an edge with `spread: true` is eligible for both.
 *
 * Direction:
 *   - Forward  (seed → rows seed references) — read the seed row's field values.
 *   - Backward (seed ← rows that reference seed) — query EdgesStore inbound edges
 *     and filter to fields registered as opt-in. Memory-mode (edges=null) silently
 *     no-ops backward; forward still works.
 *
 * Output: deduplicated list of (namespace, type, id) with `seedId` recording
 * which seed walked to this neighbour first. Seeds iterate in caller order
 * (cosine-desc), so the highest-cosine seed wins on multi-seed reach.
 *
 * Caps: `maxNeighboursPerSeed` truncates per-seed; `maxTotalNeighbours`
 * truncates the whole batch (per-seed cap is applied first).
 *
 * Targets in the seed set are skipped — a row that's already in the knn
 * pool doesn't need to be re-scored via expansion.
 */

import type { Edge, EdgesStore } from '@mnmal-ai/substrate-types';
import type { SpreadEdgeRegistry } from './spread-resolver.js';

export interface ExpansionSourceRow {
  namespace: string;
  type: string;
  id: string;
  row: Record<string, unknown>;
}

export interface ExpansionNeighbour {
  namespace: string;
  type: string;
  id: string;
  /** ID of the seed row that walked to this neighbour (highest-cosine seed wins). */
  seedId: string;
  /**
   * True when this neighbour was reached via a BACKWARD walk on an edge
   * whose spec has `expandCrossType: true`. The recall-route scope filter
   * waives the TYPE check (never the namespace check) on these. Forward walks
   * NEVER set this; forward always honours scope strictly.
   */
  allowsCrossType: boolean;
}

export interface ExpansionConfig {
  /**
   * Maximum neighbours pushed per seed row, applied PER DIRECTION
   * (forward + backward each track separately). Effective max across both
   * directions is up to 2× this value when backward is enabled.
   */
  maxNeighboursPerSeed: number;
  maxTotalNeighbours: number;
}

export function makeExpansionResolver(
  registry: SpreadEdgeRegistry,
  edges: EdgesStore | null,
  cfg: ExpansionConfig
): (sources: ReadonlyArray<ExpansionSourceRow>) => Promise<ExpansionNeighbour[]> {
  return async (sources) => {
    if (sources.length === 0) return [];

    const seen = new Set<string>();
    const out: ExpansionNeighbour[] = [];
    const seedKeys = new Set<string>(sources.map((s) => `${s.namespace}/${s.type}/${s.id}`));

    for (const src of sources) {
      let pushedForThisSeed = 0;
      const tryPush = (n: ExpansionNeighbour): boolean => {
        if (out.length >= cfg.maxTotalNeighbours) return false;
        if (pushedForThisSeed >= cfg.maxNeighboursPerSeed) return false;
        const k = `${n.namespace}/${n.type}/${n.id}`;
        if (seedKeys.has(k)) return true; // count as "handled" — skip but don't fail seed cap
        if (seen.has(k)) return true;
        seen.add(k);
        out.push(n);
        pushedForThisSeed++;
        return true;
      };

      // Forward — opt-in crossRef field values on the seed row. Always
      // `allowsCrossType: false`: waiving scope on forward walks pollutes
      // results with cross-type neighbours.
      const specs = registry.forType(src.namespace, src.type);
      for (const spec of specs) {
        if (out.length >= cfg.maxTotalNeighbours) break;
        const value = src.row[spec.fieldName];
        if (typeof value === 'string' && value.length > 0) {
          tryPush({
            namespace: spec.targetNs,
            type: spec.targetType,
            id: value,
            seedId: src.id,
            allowsCrossType: false
          });
        }
      }
    }

    // Backward — inbound edges whose from-type opted in to spread the SAME
    // field that points at this seed type.
    if (edges !== null) {
      // One round-trip for all seeds; group by target so the per-seed cap +
      // caller-order (highest-cosine-first) semantics below are preserved.
      const inboundBySeed = new Map<string, Edge[]>();
      const allInbound = await edges.findEdgesToMany(
        sources.map((s) => ({ ns: s.namespace, type: s.type, id: s.id }))
      );
      for (const edge of allInbound) {
        const tk = `${edge.to.ns}/${edge.to.type}/${String(edge.to.id)}`;
        const list = inboundBySeed.get(tk);
        if (list === undefined) inboundBySeed.set(tk, [edge]);
        else list.push(edge);
      }
      for (const src of sources) {
        if (out.length >= cfg.maxTotalNeighbours) break;
        const inbound = inboundBySeed.get(`${src.namespace}/${src.type}/${src.id}`) ?? [];
        let pushedForThisSeed = 0;
        for (const edge of inbound) {
          if (out.length >= cfg.maxTotalNeighbours) break;
          if (pushedForThisSeed >= cfg.maxNeighboursPerSeed) break;
          const specs = registry.forType(edge.from.ns, edge.from.type);
          const optInSpec = specs.find(
            (s) =>
              s.fieldName === edge.fieldName &&
              s.targetNs === src.namespace &&
              s.targetType === src.type
          );
          if (optInSpec === undefined) continue;
          const k = `${edge.from.ns}/${edge.from.type}/${edge.from.id}`;
          // Bare `continue` here (not pushedForThisSeed++) matches forward's
          // tryPush silent-pass semantics — a seed-set hit or a seen duplicate
          // is "handled" without consuming this seed's per-seed cap budget.
          if (seedKeys.has(k)) continue;
          if (seen.has(k)) continue;
          seen.add(k);
          out.push({
            namespace: edge.from.ns,
            type: edge.from.type,
            id: String(edge.from.id),
            seedId: src.id,
            allowsCrossType: optInSpec.expandCrossType === true
          });
          pushedForThisSeed++;
        }
      }
    }

    return out;
  };
}

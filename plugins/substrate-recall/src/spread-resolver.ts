/**
 * SpreadResolver — activation-spreading via crossRefs.
 *
 * Per-edge opt-in is declared on `FieldDefCrossRef.spread`. When a
 * recall hit boosts row X, the resolver enumerates rows reachable via opt-in
 * crossRefs and returns them as `SalienceTarget`s. recall-route applies a
 * damped boost (typically 0.3×) on the result. Depth is bounded to 1 hop,
 * to bound latency and so that not every row gains a little on every access.
 *
 * Direction:
 *   - **Forward**  (X → rows X references) — read the boosted row's field
 *     values directly. Each opt-in crossRef field on X's type whose value is
 *     a string-shaped id contributes one target `(targetNs, targetType, id)`.
 *   - **Backward** (X ← rows that reference X) — query
 *     `EdgesStore.findEdgesToMany` for inbound edges across all boosted rows
 *     at once, then filter to edges whose source type's same-named field is
 *     opt-in. Each surviving edge contributes one target
 *     `(from.ns, from.type, from.id)`.
 *
 * Both feed into a deduplicated `SalienceTarget[]` for the secondary boost.
 * Depth 1 makes cycles a non-issue.
 */

import type { EdgesStore } from '@mnmal-ai/substrate-types';
import type { SalienceTarget } from './embeddings-store.js';

/**
 * One opt-in crossRef field on a (ns, type). Built at registration time
 * from FieldDefCrossRef.spread === true.
 */
export interface SpreadEdgeSpec {
  /** Field name on the source type. Used to match inbound edges by fieldName. */
  fieldName: string;
  /** Target namespace declared by the crossRef. */
  targetNs: string;
  /** Target type declared by the crossRef. */
  targetType: string;
  /**
   * Mirrors FieldDefCrossRef.expandCrossType. Gates BACKWARD cross-type
   * expansion walks; forward walks and salience spreading ignore it.
   */
  expandCrossType?: boolean;
}

/**
 * Registry of opt-in spread edges, keyed by source `"ns/type"`. The plugin's
 * `contributePostWrites(namespace)` populates this as namespaces register.
 * Forward lookups read by source-row's `ns/type`; backward lookups read by
 * inbound-edge's `from.ns/from.type` to decide whether the edge is opt-in.
 */
export class SpreadEdgeRegistry {
  readonly #byTypeKey = new Map<string, SpreadEdgeSpec[]>();

  /**
   * Register one opt-in edge. Idempotent on (ns, type, fieldName) — duplicate
   * registrations from re-installs are merged silently.
   */
  add(ns: string, type: string, spec: SpreadEdgeSpec): void {
    const key = `${ns}/${type}`;
    const existing = this.#byTypeKey.get(key) ?? [];
    if (existing.some((s) => s.fieldName === spec.fieldName)) return;
    existing.push(spec);
    this.#byTypeKey.set(key, existing);
  }

  /**
   * Look up the opt-in crossRef fields for a given (ns, type). Returns an
   * empty array when nothing is registered — caller short-circuits cleanly.
   */
  forType(ns: string, type: string): ReadonlyArray<SpreadEdgeSpec> {
    return this.#byTypeKey.get(`${ns}/${type}`) ?? [];
  }

  /** Total registered edges, for tests + introspection. */
  size(): number {
    let total = 0;
    for (const arr of this.#byTypeKey.values()) total += arr.length;
    return total;
  }
}

/** Identifies a recall hit whose neighbors should be enumerated. */
export interface SpreadSourceRow {
  namespace: string;
  type: string;
  id: string;
  /** Full row body (from `knnSearch.row`). Used to read forward field values. */
  row: Record<string, unknown>;
}

/**
 * Build a resolver that enumerates spread targets for a batch of boosted
 * rows. Closes over the registry + an EdgesStore handle so the recall route
 * can call it without taking on either dependency directly.
 *
 * When `edges` is `null`, the backward direction is a no-op; forward still
 * works because it only reads `row` field values.
 *
 * The returned function dedupes targets across sources: if A and B both
 * forward-link to the same Concept, the Concept appears once in the output.
 */
export function makeSpreadResolver(
  registry: SpreadEdgeRegistry,
  edges: EdgesStore | null
): (sources: ReadonlyArray<SpreadSourceRow>) => Promise<SalienceTarget[]> {
  return async (sources) => {
    if (sources.length === 0) return [];

    const seen = new Set<string>();
    const out: SalienceTarget[] = [];
    const sourceKeys = new Set<string>(sources.map((s) => `${s.namespace}/${s.type}/${s.id}`));
    const push = (t: SalienceTarget): void => {
      // Skip targets that are themselves in the boosted set — they already
      // got the primary boost.
      const k = `${t.namespace}/${t.type}/${t.id}`;
      if (sourceKeys.has(k)) return;
      if (seen.has(k)) return;
      seen.add(k);
      out.push(t);
    };

    // Forward direction — read the source row's own field values.
    for (const src of sources) {
      const specs = registry.forType(src.namespace, src.type);
      for (const spec of specs) {
        const value = src.row[spec.fieldName];
        if (typeof value === 'string' && value.length > 0) {
          push({ namespace: spec.targetNs, type: spec.targetType, id: value });
        }
      }
    }

    // Backward direction — inbound edges across ALL source rows in ONE
    // round-trip, keeping only those whose from-type's same-named field opted
    // into spreading.
    if (edges !== null) {
      const inbound = await edges.findEdgesToMany(
        sources.map((s) => ({ ns: s.namespace, type: s.type, id: s.id }))
      );
      for (const edge of inbound) {
        const specs = registry.forType(edge.from.ns, edge.from.type);
        const optIn = specs.some(
          (s) =>
            s.fieldName === edge.fieldName &&
            s.targetNs === edge.to.ns &&
            s.targetType === edge.to.type
        );
        if (!optIn) continue;
        push({
          namespace: edge.from.ns,
          type: edge.from.type,
          id: String(edge.from.id)
        });
      }
    }

    return out;
  };
}

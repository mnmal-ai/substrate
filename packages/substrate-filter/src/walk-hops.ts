/**
 * The one traversal of a walk-grammar frame's hops (spec 2026-10-24-typed-edge-walks
 * §2, §3), shared by substrate-core (the walk policy's walked types, the
 * advisor's walk sites) and the pg dataset (the type tables a read preloads),
 * so the three can never disagree on which hops a frame has.
 */

/** One hop of a frame entry. */
export interface WalkHop {
  /** A `_walk` in a where, an `_agg` (in a where or in `fields._agg`), or a nested selection's `_walk`. */
  kind: 'walk' | 'agg' | 'nested';
  /** The hop node: the `_walk` or `_agg` object itself. */
  node: Record<string, unknown>;
  /** The node's path inside the frame entry, e.g. `['where', 'AND', '0', '_walk']`. */
  path: string[];
  /** A nested hop's selection (`{ _walk, where?, orderBy?, fields }`) and its path. */
  selection?: { sel: Record<string, unknown>; path: string[] };
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Visits every hop of a frame entry `{ params: { where }, fields }` seeded at
 * `seed`, at any depth, each before the hops beneath it. `visit` gets the hop
 * and its near type and returns the far type; the hops in the far rows'
 * wheres (a pick's `among` and the node's `where`, then a nested selection's own `where`) and a
 * nested selection's `fields` are visited next. Returning `undefined` stops the
 * descent below that hop. A where is searched generically, under AND/OR/NOT
 * and anywhere else, as the walk gate does.
 */
export function forEachWalkHop(
  entry: Record<string, unknown>,
  seed: string,
  visit: (hop: WalkHop, near: string) => string | undefined
): void {
  const inWhere = (v: unknown, type: string, path: string[]): void => {
    if (Array.isArray(v)) {
      v.forEach((c, i) => {
        inWhere(c, type, [...path, String(i)]);
      });
      return;
    }
    if (!isObj(v)) return;
    for (const [k, child] of Object.entries(v)) {
      const at = [...path, k];
      if ((k === '_walk' || k === '_agg') && isObj(child)) {
        const far = visit({ kind: k === '_walk' ? 'walk' : 'agg', node: child, path: at }, type);
        if (far !== undefined) {
          inWhere(child.among, far, [...at, 'among']);
          inWhere(child.where, far, [...at, 'where']);
        }
      } else inWhere(child, type, at);
    }
  };

  const inFields = (fields: unknown, type: string, path: string[]): void => {
    if (!isObj(fields)) return;
    for (const [name, sel] of Object.entries(fields)) {
      const at = [...path, name];
      if (name === '_agg' && isObj(sel)) {
        for (const [n, agg] of Object.entries(sel)) {
          if (!isObj(agg)) continue;
          const far = visit({ kind: 'agg', node: agg, path: [...at, n] }, type);
          if (far !== undefined) inWhere(agg.where, far, [...at, n, 'where']);
        }
      } else if (isObj(sel) && isObj(sel._walk)) {
        const walk = sel._walk;
        const wp = [...at, '_walk'];
        const far = visit(
          { kind: 'nested', node: walk, path: wp, selection: { sel, path: at } },
          type
        );
        if (far === undefined) continue;
        inWhere(walk.where, far, [...wp, 'where']);
        inWhere(sel.where, far, [...at, 'where']);
        inFields(sel.fields, far, [...at, 'fields']);
      }
    }
  };

  const params = isObj(entry.params) ? entry.params : {};
  inWhere(params.where, seed, ['where']);
  inFields(entry.fields, seed, ['fields']);
}

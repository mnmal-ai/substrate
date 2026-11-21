/**
 * The one traversal of a walk-grammar frame's hops (spec 2026-10-24-typed-edge-walks
 * §2, §3), shared by substrate-core (the walk policy's walked types, the
 * advisor's walk sites) and the pg dataset (the type tables a read preloads),
 * so the three can never disagree on which hops a frame has.
 */

/** A type in a namespace. */
export interface TypeRef {
  ns: string;
  type: string;
}

/** One hop of a frame entry. */
export interface WalkHop {
  /**
   * A `_walk` in a where, an `_agg` (in a where or in `fields._agg`), a nested
   * selection's `_walk`, or the out hop a walked group key reads through.
   */
  kind: 'walk' | 'agg' | 'nested' | 'group';
  /** The hop node: the `_walk` or `_agg` object itself, or `{ out: <crossRef> }` for a group key. */
  node: Record<string, unknown>;
  /** The node's path inside the frame entry, e.g. `['where', 'AND', '0', '_walk']`. */
  path: string[];
  /** A nested hop's selection (`{ _walk, where?, orderBy?, fields }`) and its path. */
  selection?: { sel: Record<string, unknown>; path: string[] };
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Adds to `out` each walked field reference (`"<crossRef>.<field>"`) expression `e` reads. */
function walkedRefsIn(e: unknown, out: Set<string>): void {
  if (typeof e === 'string') {
    if (e.includes('.') && !e.startsWith('_agg.')) out.add(e);
  } else if (Array.isArray(e)) {
    for (const x of e) walkedRefsIn(x, out);
  } else if (isObj(e)) {
    // A lit or int64 holds a value, not a field.
    for (const [k, v] of Object.entries(e)) if (k !== 'lit' && k !== 'int64') walkedRefsIn(v, out);
  }
}

/**
 * The walked field references a frame's `groupBy` expressions read, each once:
 * `"<crossRef>.<field>"` names `<field>` of the row the out-walk through `<crossRef>` reaches.
 */
export function groupWalkRefs(groupBy: unknown): string[] {
  const out = new Set<string>();
  if (isObj(groupBy)) for (const e of Object.values(groupBy)) walkedRefsIn(e, out);
  return [...out];
}

/** A walked field reference split at its first dot: the crossRef walked out through, and the rest. */
export function splitWalkedRef(ref: string): { out: string; field: string } {
  const dot = ref.indexOf('.');
  return { out: ref.slice(0, dot), field: ref.slice(dot + 1) };
}

/**
 * Visits every hop of a frame entry `{ params: { where, groupBy }, fields }` seeded at
 * `seed`, at any depth, each before the hops beneath it. `visit` gets the hop
 * and its near type and returns the far type; the hops in the far rows'
 * wheres (a pick's `among` and the node's `where`, then a nested selection's own `where`) and a
 * nested selection's `fields` are visited next. Returning `undefined` stops the
 * descent below that hop. A where is searched generically, under AND/OR/NOT
 * and anywhere else, as the walk gate does. Walked group keys are one out hop
 * from the seed per crossRef, at the first `groupBy` entry that reads through it.
 */
export function forEachWalkHop(
  entry: Record<string, unknown>,
  seed: TypeRef,
  visit: (hop: WalkHop, near: TypeRef) => TypeRef | undefined
): void {
  const inWhere = (v: unknown, type: TypeRef, path: string[]): void => {
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

  const inFields = (fields: unknown, type: TypeRef, path: string[]): void => {
    if (!isObj(fields)) return;
    for (const [name, sel] of Object.entries(fields)) {
      const at = [...path, name];
      if (name === '_agg' && isObj(sel)) {
        for (const [n, agg] of Object.entries(sel)) {
          if (!isObj(agg)) continue;
          const far = visit({ kind: 'agg', node: agg, path: [...at, n] }, type);
          if (far !== undefined) inWhere(agg.where, far, [...at, n, 'where']);
        }
      } else if (isObj(sel) && Object.hasOwn(sel, '_walk') && isObj(sel._walk)) {
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
  const heads = new Set<string>();
  for (const [name, e] of Object.entries(isObj(params.groupBy) ? params.groupBy : {})) {
    for (const ref of groupWalkRefs({ [name]: e })) {
      const { out } = splitWalkedRef(ref);
      if (heads.has(out)) continue;
      heads.add(out);
      visit({ kind: 'group', node: { out }, path: ['groupBy', name] }, seed);
    }
  }
}

/** Path of the first `_walk`, `_agg` or `$ref` key anywhere in a where, under `path`, or null. */
function whereWalkPath(v: unknown, path: string[]): string[] | null {
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++) {
      const hit = whereWalkPath(v[i], [...path, String(i)]);
      if (hit) return hit;
    }
    return null;
  }
  if (!isObj(v)) return null;
  for (const [k, child] of Object.entries(v)) {
    if (k === '_walk' || k === '_agg' || k === '$ref') return [...path, k];
    const hit = whereWalkPath(child, [...path, k]);
    if (hit) return hit;
  }
  return null;
}

/** True when a where uses the walk grammar (`_walk`, `_agg` or a `$ref` operand) anywhere. */
export function whereUsesWalks(where: unknown): boolean {
  return whereWalkPath(where, []) !== null;
}

/** `_agg` or a `{ _walk }` selection anywhere in a field selection, sub-selections included. */
function fieldsWalkPath(fields: unknown, path: string[]): string[] | null {
  if (!isObj(fields)) return null;
  for (const [name, sel] of Object.entries(fields)) {
    if (name === '_agg') return [...path, name];
    if (!isObj(sel)) continue;
    if (Object.hasOwn(sel, '_walk')) return [...path, name, '_walk'];
    const hit = fieldsWalkPath(sel, [...path, name]);
    if (hit) return hit;
  }
  return null;
}

const WALK_PARAM_KEYS = ['aggregate', 'groupBy', 'having', 'offset'];

/**
 * Path (inside the frame) of the first walk-grammar construct in a frame entry
 * `{ params, fields }`, or null: the where and the field selection, then the
 * walk-only params unless `walkParams` is false. A resolver whose own params
 * may share those names (a virtual type, a stream) passes false (#1822, #1951).
 */
export function walkGrammarPath(
  entry: Record<string, unknown>,
  { walkParams = true }: { walkParams?: boolean } = {}
): string[] | null {
  const params = isObj(entry.params) ? entry.params : {};
  const where = whereWalkPath(params.where, ['where']);
  if (where) return where;
  if (walkParams) {
    // Only `count: true` is walk grammar, as pg's walkParams reads it.
    if (params.count === true) return ['count'];
    for (const k of WALK_PARAM_KEYS) if (Object.hasOwn(params, k)) return [k];
  }
  return fieldsWalkPath(entry.fields, ['fields']);
}

/** True when a frame entry `{ params, fields }` uses any walk-grammar construct. */
export function usesWalkGrammar(entry: Record<string, unknown>): boolean {
  return walkGrammarPath(entry) !== null;
}

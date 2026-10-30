/** Structural detector for the typed-edge-walk query grammar, which sits behind `SUBSTRATE_WALKS`. */

const WALK_PARAM_KEYS = ['count', 'aggregate', 'bucket', 'derive'];

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function inWhere(v: unknown, path: string[]): string[] | null {
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++) {
      const hit = inWhere(v[i], [...path, String(i)]);
      if (hit) return hit;
    }
    return null;
  }
  if (!isObj(v)) return null;
  for (const [k, child] of Object.entries(v)) {
    if (k === '_walk' || k === '_agg' || k === '$ref') return [...path, k];
    const hit = inWhere(child, [...path, k]);
    if (hit) return hit;
  }
  return null;
}

/** Path (inside the frame) of the first walk-grammar construct in a frame entry `{ params, fields }`, or null. */
export function walkGrammarPath(entry: Record<string, unknown>): string[] | null {
  const params = isObj(entry.params) ? entry.params : {};
  const where = inWhere(params.where, ['where']);
  if (where) return where;
  for (const k of WALK_PARAM_KEYS) if (k in params) return [k];
  return inFields(entry.fields, ['fields']);
}

/** `_agg` or a `{ _walk }` selection anywhere in a field selection, sub-selections included. */
function inFields(fields: unknown, path: string[]): string[] | null {
  if (!isObj(fields)) return null;
  for (const [name, sel] of Object.entries(fields)) {
    if (name === '_agg') return [...path, name];
    if (!isObj(sel)) continue;
    if ('_walk' in sel) return [...path, name, '_walk'];
    const hit = inFields(sel, [...path, name]);
    if (hit) return hit;
  }
  return null;
}

/** True when a frame entry `{ params, fields }` uses any walk-grammar construct. */
export function usesWalkGrammar(entry: Record<string, unknown>): boolean {
  return walkGrammarPath(entry) !== null;
}

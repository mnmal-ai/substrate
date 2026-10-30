/**
 * Index service of a walk-grammar read (spec 2026-10-24-typed-edge-walks
 * goal 7, §2): each clause is marked served or unserved for `plan`, and each
 * walk is a site the shape recorder turns into a far-type read shape. Nothing
 * here refuses anything; it only describes.
 */

import type { FieldDef, IndexPlan, PlanClause } from '@mnmal-ai/substrate-types';
import type { HopResolver } from '../walk-types.js';

type Order = Array<[string, 'asc' | 'desc']>;
type Fields = Record<string, FieldDef>;

/** One hop of a walk-grammar frame: a `_walk`, an `_agg` or a nested `{ _walk }` selection. */
export interface WalkSite {
  /** The hop node's path inside the frame entry. */
  path: string[];
  far: string;
  /** The far type's crossRef an inbound hop follows; undefined for an outbound hop (a primary-key read). */
  crossRef?: string;
  /** Each `where` filtering the far rows, with its path. */
  wheres: Array<{ where: unknown; path: string[] }>;
  /** The order the far rows are read in, when one matters: a nested `orderBy`, a pick, or a latest/min/max aggregate. */
  order?: { by: Order; path: string[]; kind: 'order' | 'agg' };
  /** A count, avg or sum aggregate: it reads every neighbour, which the hop alone narrows. */
  agg?: string[];
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const dirOf = (d: unknown): 'asc' | 'desc' => (d === 'desc' ? 'desc' : 'asc');

function orderOf(orderBy: unknown): Order {
  const out: Order = [];
  for (const clause of Array.isArray(orderBy) ? orderBy : []) {
    if (!isObj(clause)) continue;
    for (const [f, d] of Object.entries(clause)) out.push([f, dirOf(d)]);
  }
  return out;
}

/** Every walk site of a frame entry `{ params, fields }` seeded at `seed`, at any depth. */
export function walkSites(
  entry: Record<string, unknown>,
  seed: string,
  resolve: HopResolver
): WalkSite[] {
  const out: WalkSite[] = [];
  const site = (node: Record<string, unknown>, from: string, path: string[]): WalkSite => {
    const far = resolve(node, from, path);
    const s: WalkSite = { path, far, wheres: [] };
    // Validation proved `in` is '<ns>/<Type>.<field>' with no dot in the type.
    if (typeof node.in === 'string') s.crossRef = node.in.slice(node.in.indexOf('.') + 1);
    out.push(s);
    return s;
  };
  const addWhere = (s: WalkSite, where: unknown, path: string[]) => {
    if (where === undefined) return;
    s.wheres.push({ where, path });
    inWhere(where, s.far, path);
  };

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
      if (k === '_walk' && isObj(child)) {
        const s = site(child, type, at);
        const pick = isObj(child.pick) ? Object.entries(child.pick)[0] : undefined;
        if (pick !== undefined) {
          const [fn, field] = pick;
          s.order = {
            by: [[String(field), fn === 'min' ? 'asc' : 'desc']],
            path: [...at, 'pick'],
            kind: 'order'
          };
        }
        addWhere(s, child.where, [...at, 'where']);
      } else if (k === '_agg' && isObj(child)) {
        agg(child, type, at);
      } else inWhere(child, type, at);
    }
  };

  const agg = (node: Record<string, unknown>, from: string, path: string[]) => {
    const s = site(node, from, path);
    if (isObj(node.latest)) {
      s.order = { by: [[String(node.latest.by), 'desc']], path: [...path, 'latest'], kind: 'agg' };
    } else if (typeof node.min === 'string' || typeof node.max === 'string') {
      const fn = typeof node.min === 'string' ? 'min' : 'max';
      const by: Order = [[String(node[fn]), fn === 'min' ? 'asc' : 'desc']];
      s.order = { by, path: [...path, fn], kind: 'agg' };
    } else {
      s.agg = [...path, ['count', 'avg', 'sum'].find((k) => k in node) ?? 'count'];
    }
    addWhere(s, node.where, [...path, 'where']);
  };

  const inFields = (fields: unknown, type: string, path: string[]): void => {
    if (!isObj(fields)) return;
    for (const [name, sel] of Object.entries(fields)) {
      const at = [...path, name];
      if (name === '_agg' && isObj(sel)) {
        for (const [n, a] of Object.entries(sel)) if (isObj(a)) agg(a, type, [...at, n]);
      } else if (isObj(sel) && isObj(sel._walk)) {
        const wp = [...at, '_walk'];
        const s = site(sel._walk, type, wp);
        const by = orderOf(sel.orderBy);
        if (by.length > 0) s.order = { by, path: [...at, 'orderBy'], kind: 'order' };
        addWhere(s, sel._walk.where, [...wp, 'where']);
        addWhere(s, sel.where, [...at, 'where']);
        inFields(sel.fields, s.far, [...at, 'fields']);
      }
    }
  };

  const params = isObj(entry.params) ? entry.params : {};
  inWhere(params.where, seed, ['where']);
  inFields(entry.fields, seed, ['fields']);
  return out;
}

const COMBINATORS = new Set(['AND', 'OR', 'NOT']);
const SKIP = new Set(['_walk', '_agg', '$ref']);

/** The predicates of one type's `where`, not descending into walks: a field, its path, and whether its operand is a `$ref`. */
function predicates(
  where: unknown,
  fields: Fields | undefined,
  path: string[]
): Array<{ field: string; path: string[]; ref: boolean }> {
  const out: Array<{ field: string; path: string[]; ref: boolean }> = [];
  const visit = (w: unknown, defs: Fields | undefined, prefix: string, at: string[]): void => {
    if (Array.isArray(w)) {
      w.forEach((c, i) => {
        visit(c, defs, prefix, [...at, String(i)]);
      });
      return;
    }
    // A where-side `_agg` node's comparison is on the aggregate, not on a field.
    if (!isObj(w) || Object.hasOwn(w, '_agg')) return;
    for (const [k, v] of Object.entries(w)) {
      if (SKIP.has(k)) continue;
      if (COMBINATORS.has(k)) {
        visit(v, defs, prefix, [...at, k]);
        continue;
      }
      const def = defs !== undefined && Object.hasOwn(defs, k) ? defs[k] : undefined;
      if (def?.kind === 'struct') visit(v, def.fields, `${prefix}${k}.`, [...at, k]);
      else if (isObj(v)) {
        const ops = Object.values(v);
        const ref = ops.some((o) => isObj(o) && '$ref' in o);
        out.push({ field: `${prefix}${k}`, path: [...at, k], ref });
      }
    }
  };
  visit(where, fields, '', path);
  return out;
}

/** What an `indexes` entry may key on: a declared scalar or crossRef, or a metadata column. */
const declarable = (field: string, fields: Fields | undefined): boolean => {
  if (field === 'createdAt' || field === 'updatedAt') return true;
  const def = fields !== undefined && Object.hasOwn(fields, field) ? fields[field] : undefined;
  return def?.kind === 'crossRef' || (def?.kind === 'scalar' && def.type !== 'json');
};

type PlanIndex = IndexPlan['indexes'][number];

/**
 * Whether some full index's keys begin with `lead` and then `next`, by field
 * name. shortcut: direction is not compared (a btree scans either way, but a
 * mixed-direction order may still sort); compare it if plans start lying.
 */
const leads = (indexes: PlanIndex[], lead: string[], next: string[]): boolean =>
  indexes.some(
    (i) => i.only === undefined && [...lead, ...next].every((f, n) => i.keys[n]?.[0] === f)
  );

export interface ClassifyInput {
  entry: Record<string, unknown>;
  seed: string;
  resolve: HopResolver;
  /** A type's declared fields, for what an index may key on. */
  fieldsOf: (type: string) => Fields | undefined;
}

/**
 * Each clause of a walk-grammar frame, served or not (spec §2):
 * - every hop is served, inbound by the eager `(crossRef, natural order, id)`
 *   index and outbound by the primary key;
 * - a far filter or order is served when a full index on the far type leads
 *   with the hop's crossRef and that field next (after an outbound hop the
 *   far row is one primary-key read, so all of it is served);
 * - a `$ref` predicate is a residual on rows already narrowed: always served;
 * - a seed filter, or a bucket's field, is served by an index leading with it;
 * - a derived ordering is served only when a served seed filter bounds the
 *   result, and no index ever serves it, so it recommends none;
 * - anything else is unserved, recommending the index that would serve it
 *   when its fields can be declared.
 */
export function classifyWalkService(
  input: ClassifyInput,
  indexesOf: (type: string) => PlanIndex[]
): PlanClause[] {
  const { entry, seed, fieldsOf } = input;
  const out: PlanClause[] = [];
  const params = isObj(entry.params) ? entry.params : {};
  const clause = (
    path: string[],
    kind: PlanClause['kind'],
    served: boolean,
    type: string,
    keys: Array<string | { field: string; dir: 'asc' | 'desc' }>
  ) => {
    const c: PlanClause = { path, kind, served };
    const names = keys.map((k) => (typeof k === 'string' ? k : k.field));
    if (!served && names.every((f) => declarable(f, fieldsOf(type)))) {
      c.recommend = { fields: keys };
    }
    out.push(c);
  };

  const seedIndexes = indexesOf(seed);
  let bounded = false;
  for (const p of predicates(params.where, fieldsOf(seed), ['where'])) {
    if (p.ref) {
      out.push({ path: p.path, kind: 'ref', served: true });
      continue;
    }
    const served = leads(seedIndexes, [p.field], []);
    bounded ||= served;
    clause(p.path, 'filter', served, seed, [p.field]);
  }

  for (const s of walkSites(entry, seed, input.resolve)) {
    out.push({ path: s.path, kind: 'hop', served: true });
    const farIndexes = indexesOf(s.far);
    const cr = s.crossRef;
    for (const w of s.wheres) {
      for (const p of predicates(w.where, fieldsOf(s.far), w.path)) {
        if (p.ref) out.push({ path: p.path, kind: 'ref', served: true });
        else {
          const served = cr === undefined || leads(farIndexes, [cr], [p.field]);
          clause(p.path, 'filter', served, s.far, cr === undefined ? [] : [cr, p.field]);
        }
      }
    }
    if (s.order !== undefined) {
      const { by, path, kind } = s.order;
      const served =
        cr === undefined ||
        leads(
          farIndexes,
          [cr],
          by.map(([f]) => f)
        );
      const keys = cr === undefined ? [] : [cr, ...by.map(([field, dir]) => ({ field, dir }))];
      clause(path, kind, served, s.far, keys);
    }
    if (s.agg !== undefined) out.push({ path: s.agg, kind: 'agg', served: true });
  }

  if (isObj(params.bucket) && typeof params.bucket.field === 'string') {
    const field = params.bucket.field;
    clause(['bucket'], 'bucket', leads(seedIndexes, [field], []), seed, [field]);
  }

  orderOf(params.orderBy).forEach(([f], i) => {
    if (f.startsWith('$'))
      out.push({ path: ['orderBy', String(i)], kind: 'derive', served: bounded });
  });
  return out;
}

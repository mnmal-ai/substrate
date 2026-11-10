/**
 * Index service of a walk-grammar read (spec 2026-10-24-typed-edge-walks
 * goal 7, §2): each clause is marked served or unserved for `plan`, and each
 * walk is a site the shape recorder turns into a far-type read shape. Nothing
 * here refuses anything; it only describes.
 */

import { forEachWalkHop, sharedPicks, windowGroupBy } from '@mnmal-ai/substrate-filter';
import type {
  FieldDef,
  IndexPlan,
  OrderedBy,
  PlanClause,
  WalkAgg,
  WhereClause
} from '@mnmal-ai/substrate-types';
import type { HopResolver } from '../walk-types.js';

type Order = Array<[string, 'asc' | 'desc']>;
type Fields = Record<string, FieldDef>;

/** One hop of a walk-grammar frame: a `_walk`, an `_agg` or a nested `{ _walk }` selection. */
export interface WalkSite {
  /** The hop node's path inside the frame entry. */
  path: string[];
  /** The hop node itself: a `_walk`, an `_agg` or a nested selection's `_walk`. */
  node: Record<string, unknown>;
  far: string;
  /** The far type's crossRef an inbound hop follows; undefined for an outbound hop (a primary-key read). */
  crossRef?: string;
  /** Each `where` filtering the far rows, with its path. */
  wheres: Array<{ where: unknown; path: string[] }>;
  /**
   * The order the far rows are read in, when one matters: a nested `orderBy`
   * (or, absent one, the far type's natural order, which the engine gives
   * it), a pick, or a latest/min/max aggregate. `exact`: only an index in this very
   * direction serves it (a nested list's LIMIT); a pick is a min/max probe,
   * and a latest/min/max aggregate a top-1 written in the index's own
   * direction, so an index serves either in either direction.
   */
  order?: { by: Order; path: string[]; kind: 'order' | 'agg'; exact?: true };
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

/**
 * Every walk site of a frame entry `{ params, fields }` seeded at `seed`, at
 * any depth. `naturalOrder` gives a nested list without `orderBy` its far
 * type's natural order, as the engine reads it (#1821).
 */
export function walkSites(
  entry: Record<string, unknown>,
  seed: string,
  resolve: HopResolver,
  naturalOrder?: (type: string) => OrderedBy
): WalkSite[] {
  const out: WalkSite[] = [];
  forEachWalkHop(entry, seed, ({ kind, node, path, selection }, from) => {
    const far = resolve(node, from, path);
    const s: WalkSite = { path, node, far, wheres: [] };
    // Validation proved `in` is '<ns>/<Type>.<field>' with no dot in the type.
    if (typeof node.in === 'string') s.crossRef = node.in.slice(node.in.indexOf('.') + 1);
    out.push(s);
    const addWhere = (where: unknown, at: string[]) => {
      if (where !== undefined) s.wheres.push({ where, path: at });
    };
    if (kind === 'walk') {
      const pick = isObj(node.pick) ? Object.entries(node.pick)[0] : undefined;
      if (pick !== undefined) {
        const [fn, field] = pick;
        s.order = {
          by: [[String(field), fn === 'min' ? 'asc' : 'desc']],
          path: [...path, 'pick'],
          kind: 'order'
        };
      }
      addWhere(node.where, [...path, 'where']);
    } else if (kind === 'agg') {
      if (isObj(node.latest)) {
        s.order = {
          by: [[String(node.latest.by), 'desc']],
          path: [...path, 'latest'],
          kind: 'agg'
        };
      } else if (typeof node.min === 'string' || typeof node.max === 'string') {
        const fn = typeof node.min === 'string' ? 'min' : 'max';
        const by: Order = [[String(node[fn]), fn === 'min' ? 'asc' : 'desc']];
        s.order = { by, path: [...path, fn], kind: 'agg' };
      } else {
        s.agg = [...path, ['count', 'avg', 'sum'].find((k) => k in node) ?? 'count'];
      }
      addWhere(node.where, [...path, 'where']);
    } else if (selection !== undefined) {
      const { sel, path: at } = selection;
      let by = orderOf(sel.orderBy);
      if (by.length === 0 && naturalOrder !== undefined) by = orderOf([naturalOrder(far)]);
      if (by.length > 0) s.order = { by, path: [...at, 'orderBy'], kind: 'order', exact: true };
      addWhere(node.where, [...path, 'where']);
      addWhere(sel.where, [...at, 'where']);
    }
    return far;
  });
  return out;
}

const COMBINATORS = new Set(['AND', 'OR', 'NOT']);
const SKIP = new Set(['_walk', '_agg', '$ref']);

interface Predicate {
  field: string;
  path: string[];
  /** Its operand is a `$ref`. */
  ref: boolean;
  /** It narrows the result: AND-ed at the top (never under OR or NOT), with an operator besides `neq`. */
  bounds: boolean;
}

/** The predicates of one type's `where`, not descending into walks. */
function predicates(where: unknown, fields: Fields | undefined, path: string[]): Predicate[] {
  const out: Predicate[] = [];
  const visit = (
    w: unknown,
    defs: Fields | undefined,
    prefix: string,
    at: string[],
    conjunct = true
  ): void => {
    if (Array.isArray(w)) {
      w.forEach((c, i) => {
        visit(c, defs, prefix, [...at, String(i)], conjunct);
      });
      return;
    }
    // A where-side `_agg` node's comparison is on the aggregate, not on a field.
    if (!isObj(w) || Object.hasOwn(w, '_agg')) return;
    for (const [k, v] of Object.entries(w)) {
      if (SKIP.has(k)) continue;
      if (COMBINATORS.has(k)) {
        visit(v, defs, prefix, [...at, k], conjunct && k === 'AND');
        continue;
      }
      const def = defs !== undefined && Object.hasOwn(defs, k) ? defs[k] : undefined;
      if (def?.kind === 'struct') visit(v, def.fields, `${prefix}${k}.`, [...at, k], conjunct);
      else if (isObj(v)) {
        const ref = Object.values(v).some((o) => isObj(o) && '$ref' in o);
        const bounds = conjunct && Object.keys(v).some((op) => op !== 'neq');
        out.push({ field: `${prefix}${k}`, path: [...at, k], ref, bounds });
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
 * name, and when `next` gives a direction, in it: an index key is ascending
 * or descending, nulls last either way, so one scanned forward is the order
 * `<dir> NULLS LAST` that reads compile to, and one scanned backward is not.
 */
const leads = (indexes: PlanIndex[], lead: string[], next: Array<string | [string, string]>) =>
  indexes.some(
    (i) =>
      i.only === undefined &&
      [...lead, ...next].every((k, n) =>
        typeof k === 'string'
          ? i.keys[n]?.[0] === k
          : i.keys[n]?.[0] === k[0] && i.keys[n]?.[1] === k[1]
      )
  );

/** The fields that follow `lead` as the next key of a full index, i.e. what a walk through `lead` is served on. */
export const nextKeys = (indexes: PlanIndex[], lead: string): string[] => [
  ...new Set(
    indexes.flatMap((i) =>
      i.only === undefined && i.keys[0]?.[0] === lead && i.keys[1] !== undefined
        ? [i.keys[1][0]]
        : []
    )
  )
];

export interface ClassifyInput {
  entry: Record<string, unknown>;
  seed: string;
  resolve: HopResolver;
  /** A type's declared fields, for what an index may key on. */
  fieldsOf: (type: string) => Fields | undefined;
  /** A type's natural order: a nested list without `orderBy` reads in it (#1821). */
  naturalOrder?: (type: string) => OrderedBy;
}

/**
 * Each clause of a walk-grammar frame, served or not (spec §2):
 * - a hop is served, inbound by the eager `(crossRef, natural order)` index
 *   (absent for a crossRef declared `indexed: false`) and outbound by the
 *   primary key;
 * - a far filter, pick or latest/min/max is served when a full index on the
 *   far type leads with the hop's crossRef and that field next, and a nested
 *   list's order when its keys follow in its directions too (after an
 *   outbound hop the far row is one primary-key read, so all of it is served);
 * - a `$ref` predicate is a residual on rows already narrowed: always served;
 * - a seed filter, or the field a group key truncates, is served by an index leading with it;
 * - an ordering by a select name is served only when a served seed filter bounds the
 *   result (AND-ed, not under OR or NOT, and not only `neq`); no index ever
 *   serves it, so it recommends none;
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
    bounded ||= served && p.bounds;
    clause(p.path, 'filter', served, seed, [p.field]);
  }

  const shared = sharedPicks(params as Parameters<typeof sharedPicks>[0]);
  /** #1815: how a pick or a frame `_agg` is evaluated, by the rules pg compiles to. */
  const formOf = (s: WalkSite, indexes: PlanIndex[]): PlanClause['form'] => {
    const top = s.path.length === 3 && s.path[0] === 'fields' && s.path[1] === '_agg';
    if (s.node.pick !== undefined) return shared.has(s.node) ? 'per-hub' : 'per-seed';
    if (!top) return undefined;
    const fields = fieldsOf(s.far);
    const def = (f: string) =>
      fields !== undefined && Object.hasOwn(fields, f) ? fields[f] : undefined;
    const grouped = windowGroupBy(
      s.node as WalkAgg,
      params as { where?: WhereClause; limit?: number },
      def,
      (f) => leads(indexes, [f], [])
    );
    return grouped ? 'group-by' : 'per-seed';
  };

  for (const s of walkSites(entry, seed, input.resolve, input.naturalOrder)) {
    const farIndexes = indexesOf(s.far);
    const cr = s.crossRef;
    // A crossRef declared `indexed: false` has no eager index to serve its hop.
    const hop = cr === undefined || leads(farIndexes, [cr], []);
    clause(s.path, 'hop', hop, s.far, cr === undefined ? [] : [cr]);
    const form = formOf(s, farIndexes);
    if (form !== undefined) (out[out.length - 1] as PlanClause).form = form;
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
      const { by, path, kind, exact } = s.order;
      const served =
        cr === undefined ||
        leads(
          farIndexes,
          [cr],
          by.map(([f, d]) => (exact ? [f, d] : f))
        );
      const keys = cr === undefined ? [] : [cr, ...by.map(([field, dir]) => ({ field, dir }))];
      clause(path, kind, served, s.far, keys);
    }
    if (s.agg !== undefined) out.push({ path: s.agg, kind: 'agg', served: true });
  }

  // A group key that truncates a date field, as a bucket did: served by an index leading with it.
  if (isObj(params.groupBy)) {
    for (const [name, e] of Object.entries(params.groupBy)) {
      const args = isObj(e) && Array.isArray(e.dateTrunc) ? e.dateTrunc : undefined;
      const field = args?.[1];
      if (typeof field === 'string') {
        clause(['groupBy', name], 'group', leads(seedIndexes, [field], []), seed, [field]);
      }
    }
  }

  // An ordering by a select name is computed per row; only a bounded result keeps it cheap.
  const selected = isObj(params.select) ? params.select : {};
  orderOf(params.orderBy).forEach(([f], i) => {
    if (Object.hasOwn(selected, f))
      out.push({ path: ['orderBy', String(i)], kind: 'select', served: bounded });
  });
  return out;
}

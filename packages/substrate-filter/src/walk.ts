/**
 * Typed edge walk evaluation (spec 2026-10-24-typed-edge-walks §1, §4, §5).
 *
 * The reference semantics the pg compiler must match: a walk follows the
 * crossRef value in the row BODY, never `edges`; tombstoned far rows are never
 * walked (the dataset's `neighbours` / `get` leave them out); `any` walks with
 * `as` in one AND group are jointly quantified; a `$ref` to a null value is
 * never true. The tree is assumed validated (substrate-core walk-validator).
 */

import {
  type RefOperand,
  ResolverFrameError,
  type Row,
  WALK_BUDGET_EXCEEDED,
  type WalkNode,
  type WalkPick,
  type WhereClause
} from '@mnmal-ai/substrate-types';
import {
  asSortValue,
  compareFilterValues,
  evaluateMembers,
  evaluateWhere,
  type FieldDefOf,
  getFieldValue,
  isDateField,
  storedMicros
} from './predicate.js';

/** What a dataset hands the evaluator so walks can reach other rows of its namespace. */
export interface WalkContext {
  /** Live (untombstoned) rows of `type` whose own body `field` holds `id`. */
  neighbours(type: string, field: string, id: string): Row[];
  /** The live row of `type` with this id, if any. */
  get(type: string, id: string): Row | undefined;
  /** A type's field declarations. */
  fieldDefOf(type: string): FieldDefOf;
  /** The type of the row under evaluation. */
  type: string;
  /** The frame's seed row, named `$` by a `$ref`. */
  seed: Row;
  /** Rows bound by enclosing `any` walks' `as`. */
  bindings: ReadonlyMap<string, Row>;
  /** Binding assignments this read may still try, shared by every seed row of the read. */
  budget: { left: number };
}

/** Default per-read cap on joint-quantification assignments (each is one binding tried). */
export const WALK_EVALUATION_BUDGET = 1_000_000;

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

export const isRefOperand = (v: unknown): v is RefOperand => isObj(v) && typeof v.$ref === 'string';

/** The `any` walks with `as` in this AND group: the object's own `_walk` and, through AND, its conjuncts'. */
export function bindingWalks(where: unknown, out: WalkNode[] = []): WalkNode[] {
  if (!isObj(where)) return out;
  const w = where._walk;
  if (isObj(w) && typeof w.as === 'string') out.push(w as WalkNode);
  if (Array.isArray(where.AND)) for (const sub of where.AND) bindingWalks(sub, out);
  return out;
}

/** Binding names a `$ref` anywhere below `where` reads. */
function refNames(where: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(where)) for (const w of where) refNames(w, out);
  else if (isObj(where)) {
    if (typeof where.$ref === 'string') out.add(where.$ref.split('.', 1)[0] ?? '');
    for (const v of Object.values(where)) refNames(v, out);
  }
  return out;
}

/** The far type and the live rows one hop from `row`. */
function hop(row: Row, node: WalkNode, walk: WalkContext): { type: string; rows: Row[] } {
  if (node.in !== undefined) {
    const m = /^[^/]+\/([^./]+)\.(.+)$/.exec(node.in);
    if (m === null)
      throw new Error(`internal: walk 'in' '${node.in}' is not '<ns>/<Type>.<field>'`);
    const [, type, field] = m as unknown as [string, string, string];
    return { type, rows: typeof row.id === 'string' ? walk.neighbours(type, field, row.id) : [] };
  }
  const field = node.out ?? '';
  const def = walk.fieldDefOf(walk.type)(field);
  if (def?.kind !== 'crossRef') {
    throw new Error(`internal: walk 'out' '${field}' is not a crossRef on '${walk.type}'`);
  }
  const id = Object.hasOwn(row, field) ? row[field] : undefined;
  const far = typeof id === 'string' ? walk.get(def.type, id) : undefined;
  return { type: def.type, rows: far === undefined ? [] : [far] };
}

/**
 * The one neighbour a pick names: by the field descending (latest, max) or
 * ascending (min), nulls last either way, ties by id ascending.
 */
function pickOne(rows: Row[], pick: WalkPick, fieldDefOf: FieldDefOf): Row | undefined {
  const [dir, field] = Object.entries(pick)[0] as [string, string];
  const asDate = isDateField(field, fieldDefOf);
  const key = (r: Row) =>
    asSortValue(field, Object.hasOwn(r, field) ? r[field] : undefined, fieldDefOf);
  const before = (a: Row, b: Row): boolean => {
    const va = key(a);
    const vb = key(b);
    if ((va == null) !== (vb == null)) return vb == null;
    const c = va == null ? 0 : compareFilterValues(va, vb, asDate);
    if (c !== 0) return dir === 'min' ? c < 0 : c > 0;
    return compareFilterValues(a.id, b.id) < 0;
  };
  let best: Row | undefined;
  for (const r of rows) if (best === undefined || before(r, best)) best = r;
  return best;
}

/** A walk without `as` (any, none, all or pick), evaluated under the current bindings. */
export function evaluateWalk(row: Row, node: WalkNode, walk: WalkContext): boolean {
  const { type, rows } = hop(row, node, walk);
  const fieldDefOf = walk.fieldDefOf(type);
  const far: WalkContext = { ...walk, type };
  const where = node.where;
  const test = (n: Row) => where === undefined || evaluateWhere(n, where, fieldDefOf, far);
  if (node.pick !== undefined) {
    const one = pickOne(rows, node.pick, fieldDefOf);
    return one !== undefined && test(one);
  }
  switch (node.quantifier ?? 'any') {
    case 'none':
      return !rows.some(test);
    case 'all':
      return rows.every(test);
    default:
      return rows.some(test);
  }
}

/**
 * Joint quantification of an AND group's binding walks: true when some
 * assignment of one neighbour to each `as` makes every member true.
 * Assignments are enumerated left to right; each walk's own `where` is tested
 * as soon as every group binding it references is assigned.
 */
export function evaluateGroup(
  row: Row,
  where: WhereClause,
  fieldDefOf: FieldDefOf | undefined,
  walk: WalkContext,
  group: WalkNode[]
): boolean {
  const names = group.map((n) => n.as ?? '');
  const hops = group.map((n) => hop(row, n, walk));
  const checkAt = group.map((n, i) =>
    Math.max(i, ...[...refNames(n.where)].map((name) => names.indexOf(name)))
  );
  const bindings = new Map(walk.bindings);
  const ctx: WalkContext = { ...walk, bindings };
  const bound = new Set(group);
  const step = (i: number): boolean => {
    if (i === group.length) return evaluateMembers(row, where, fieldDefOf, ctx, bound);
    const name = names[i] ?? '';
    for (const n of hops[i]?.rows ?? []) {
      if (--walk.budget.left < 0) {
        throw new ResolverFrameError(
          WALK_BUDGET_EXCEEDED,
          'the walk tried more binding combinations than one read allows; narrow the walks or bind fewer of them'
        );
      }
      bindings.set(name, n);
      const ok = group.every((g, j) => {
        if (checkAt[j] !== i || g.where === undefined) return true;
        const h = hops[j] as { type: string };
        const far = bindings.get(names[j] ?? '') as Row;
        return evaluateWhere(far, g.where, walk.fieldDefOf(h.type), { ...ctx, type: h.type });
      });
      if (ok && step(i + 1)) return true;
    }
    bindings.delete(name);
    return false;
  };
  return step(0);
}

/**
 * A `$ref` operand's value: `$.f` reads the seed, `<as>.f` a binding. A
 * number becomes `value * times + plus`; a date shifts by `plus`
 * milliseconds. A null, or a value its kind cannot read, is `null`, which no
 * comparison matches.
 */
export function resolveRef(ref: RefOperand, asDate: boolean, walk: WalkContext): unknown {
  const dot = ref.$ref.indexOf('.');
  const name = ref.$ref.slice(0, dot);
  const field = ref.$ref.slice(dot + 1);
  if (name === '_agg')
    throw new Error(`internal: $ref '${ref.$ref}': _agg operands are not evaluated yet`);
  const row = name === '$' ? walk.seed : walk.bindings.get(name);
  if (row === undefined) throw new Error(`internal: $ref '${ref.$ref}' names no binding in scope`);
  const v = getFieldValue(row, field);
  if (v == null) return null;
  if (asDate) {
    const micros = storedMicros(v);
    if (micros === undefined) return null;
    return ref.plus ? isoFromMicros(micros + BigInt(Math.round(ref.plus * 1000))) : v;
  }
  if (typeof v !== 'number') return null;
  return v * (ref.times ?? 1) + (ref.plus ?? 0);
}

/** An instant in microseconds as an ISO string with six fraction digits. */
function isoFromMicros(micros: bigint): string {
  const sub = ((micros % 1000n) + 1000n) % 1000n;
  const ms = Number((micros - sub) / 1000n);
  return new Date(ms).toISOString().replace('Z', `${sub.toString().padStart(3, '0')}Z`);
}

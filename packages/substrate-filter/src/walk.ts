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
  type AggFn,
  type RefOperand,
  ResolverFrameError,
  type Row,
  WALK_BUDGET_EXCEEDED,
  type WalkAgg,
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
  /**
   * Walk work this read may still do, shared by every seed row of the read:
   * each far row a hop examines and each binding assignment tried costs one.
   */
  budget: { left: number };
  /** The frame's `_agg` value `name` for the seed row, read by `_agg.<name>` operands. */
  aggValue?: (name: string) => unknown;
}

/** Default per-read cap on walk work (far rows examined plus binding assignments tried). */
export const WALK_EVALUATION_BUDGET = 1_000_000;

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

export const isRefOperand = (v: unknown): v is RefOperand => isObj(v) && typeof v.$ref === 'string';

/**
 * One AND group, flattened: its `any` walks with `as` (the object's own
 * `_walk`, then, through AND, its conjuncts') and every other conjunct as a
 * one-key clause, except a `{ _agg, <cmp> }` object, which stays whole. OR
 * and NOT stay whole, so their walks start their own group.
 */
export function groupConjuncts(
  where: unknown,
  out: { binds: WalkNode[]; items: WhereClause[] } = { binds: [], items: [] }
): { binds: WalkNode[]; items: WhereClause[] } {
  if (!isObj(where)) return out;
  // `{ _agg, <cmp> }` is one comparison: kept whole, never split into its keys.
  if (Object.hasOwn(where, '_agg')) {
    out.items.push(where as WhereClause);
    return out;
  }
  const w = where._walk;
  if (isObj(w) && typeof w.as === 'string') out.binds.push(w as WalkNode);
  else if (Object.hasOwn(where, '_walk')) out.items.push({ _walk: w } as WhereClause);
  if (Array.isArray(where.AND)) for (const sub of where.AND) groupConjuncts(sub, out);
  for (const [k, v] of Object.entries(where)) {
    if (k !== '_walk' && k !== 'AND') out.items.push({ [k]: v } as WhereClause);
  }
  return out;
}

/** The `any` walks with `as` in this AND group (see {@link groupConjuncts}). */
export function bindingWalks(where: unknown): WalkNode[] {
  return groupConjuncts(where).binds;
}

/** Binding names a `$ref` anywhere below `where` reads. */
export function refNames(where: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(where)) for (const w of where) refNames(w, out);
  else if (isObj(where)) {
    if (typeof where.$ref === 'string') out.add(where.$ref.split('.', 1)[0] ?? '');
    for (const v of Object.values(where)) refNames(v, out);
  }
  return out;
}

function charge(walk: WalkContext, n: number): void {
  walk.budget.left -= n;
  if (walk.budget.left < 0) {
    throw new ResolverFrameError(
      WALK_BUDGET_EXCEEDED,
      'the walk examined more rows or binding combinations than one read allows; narrow the walks or bind fewer of them'
    );
  }
}

/** The far type and the live rows one hop from `row`, each charged to the read's budget. */
export function hop(
  row: Row,
  node: { in?: string; out?: string },
  walk: WalkContext
): { type: string; rows: Row[] } {
  const far = hopRows(row, node, walk);
  charge(walk, far.rows.length);
  return far;
}

function hopRows(
  row: Row,
  node: { in?: string; out?: string },
  walk: WalkContext
): { type: string; rows: Row[] } {
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
export function pickOne(rows: Row[], pick: WalkPick, fieldDefOf: FieldDefOf): Row | undefined {
  const [dir, field] = Object.entries(pick)[0] as [string, string];
  const asDate = isDateField(field, fieldDefOf);
  // getFieldValue, so a metadata field (createdAt) reads its `_metadata` value.
  const key = (r: Row) => asSortValue(field, getFieldValue(r, field), fieldDefOf);
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
      charge(walk, 1);
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
 * milliseconds. A null, a value its kind cannot read, or arithmetic that
 * overflows or underflows to 0, is `null`, which no comparison matches.
 */
export function resolveRef(ref: RefOperand, asDate: boolean, walk: WalkContext): unknown {
  const dot = ref.$ref.indexOf('.');
  const name = ref.$ref.slice(0, dot);
  const field = ref.$ref.slice(dot + 1);
  let v: unknown;
  if (name === '_agg') {
    if (walk.aggValue === undefined)
      throw new Error(`internal: $ref '${ref.$ref}' names no _agg in this frame`);
    v = walk.aggValue(field);
  } else {
    const row = name === '$' ? walk.seed : walk.bindings.get(name);
    if (row === undefined)
      throw new Error(`internal: $ref '${ref.$ref}' names no binding in scope`);
    v = getFieldValue(row, field);
  }
  if (v == null) return null;
  if (asDate) {
    const micros = storedMicros(v);
    if (micros === undefined) return null;
    return ref.plus ? isoFromMicros(micros + BigInt(Math.round(ref.plus * 1000))) : v;
  }
  if (typeof v !== 'number') return null;
  // Todo #1809, shared with pg's refOperand: a non-finite result, or a nonzero
  // product that underflows to 0 (pg's float8 raises on both), is null.
  const times = ref.times ?? 1;
  const product = v * times;
  if (product === 0 && v !== 0 && times !== 0) return null;
  const out = product + (ref.plus ?? 0);
  return Number.isFinite(out) ? out : null;
}

/** An instant in microseconds as an ISO string with six fraction digits. */
function isoFromMicros(micros: bigint): string {
  const sub = ((micros % 1000n) + 1000n) % 1000n;
  const ms = Number((micros - sub) / 1000n);
  return new Date(ms).toISOString().replace('Z', `${sub.toString().padStart(3, '0')}Z`);
}

/**
 * An aggregate over `rows`: avg/sum read only numbers (nulls and non-numeric
 * values drop out); min/max read numbers, or instants on a date field and
 * return the winning row's stored value (ties id ascending); each is null over
 * none. count counts rows; latest is the stored `value` of the row latest by
 * `by` (nulls last, ties id ascending), or null. Arithmetic is float64, and
 * a sum past float64's range is null.
 */
export function applyAgg(rows: Row[], fn: AggFn, fieldDefOf: FieldDefOf): unknown {
  if (Object.hasOwn(fn, 'count')) return rows.length;
  if ('latest' in fn && Object.hasOwn(fn, 'latest')) {
    const one = pickOne(rows, { latest: fn.latest.by }, fieldDefOf);
    return one === undefined ? null : (getFieldValue(one, fn.latest.value) ?? null);
  }
  // A walk aggregate also carries in/out/where, so find the function key by name.
  const op = (['avg', 'sum', 'min', 'max'] as const).find((k) => Object.hasOwn(fn, k));
  if (op === undefined) throw new Error('internal: aggregate names no function');
  const field = (fn as Record<string, string>)[op] as string;
  if ((op === 'min' || op === 'max') && isDateField(field, fieldDefOf)) {
    // pickOne orders a date field as instants, nulls and unreadable values last.
    const one = pickOne(rows, op === 'min' ? { min: field } : { max: field }, fieldDefOf);
    const v = one === undefined ? undefined : getFieldValue(one, field);
    return v == null || storedMicros(v) === undefined ? null : v;
  }
  let n = 0;
  let acc = 0;
  for (const r of rows) {
    const v = getFieldValue(r, field);
    if (typeof v !== 'number') continue;
    acc = n === 0 ? v : op === 'min' ? Math.min(acc, v) : op === 'max' ? Math.max(acc, v) : acc + v;
    n++;
  }
  if (n === 0) return null;
  if (!Number.isFinite(acc) && (op === 'sum' || op === 'avg')) {
    // Todo #1809: pg sums exactly and is null only when the exact sum is past
    // float8's range. Near enough, cheaply: re-sum scaled by 2^-64, so no
    // partial sum overflows. Order and cancellation drift between this and
    // the exact sum is accepted, as for the last bit of avg/sum.
    let scaled = 0;
    for (const r of rows) {
      const v = getFieldValue(r, field);
      if (typeof v === 'number') scaled += v * 2 ** -64;
    }
    const out = (op === 'avg' ? scaled / n : scaled) * 2 ** 64;
    return Number.isFinite(out) ? out : null;
  }
  return op === 'avg' ? acc / n : acc;
}

/** The field an aggregate's value is read from, or undefined for count. */
function valueField(fn: AggFn): string | undefined {
  if ('latest' in fn && Object.hasOwn(fn, 'latest')) return fn.latest.value;
  const op = (['avg', 'sum', 'min', 'max'] as const).find((k) => Object.hasOwn(fn, k));
  return op === undefined ? undefined : (fn as Record<string, string>)[op];
}

/**
 * A walk aggregate for `row`: the hop's live rows that pass the walk's
 * `where`, aggregated; `asDate` says whether the value is a date (compared
 * as an instant).
 */
export function computeAggTyped(
  row: Row,
  spec: WalkAgg,
  walk: WalkContext
): { value: unknown; asDate: boolean } {
  const { type, rows } = hop(row, spec, walk);
  const fieldDefOf = walk.fieldDefOf(type);
  const far: WalkContext = { ...walk, type };
  const where = spec.where;
  const kept =
    where === undefined ? rows : rows.filter((n) => evaluateWhere(n, where, fieldDefOf, far));
  const field = valueField(spec);
  return {
    value: applyAgg(kept, spec, fieldDefOf),
    asDate: field !== undefined && isDateField(field, fieldDefOf)
  };
}

/** {@link computeAggTyped}'s value. */
export function computeAgg(row: Row, spec: WalkAgg, walk: WalkContext): unknown {
  return computeAggTyped(row, spec, walk).value;
}

/**
 * The index advisor's view of reads: which shapes (filtered fields and
 * operators, plus the effective order) run, how often, and how slowly. Never
 * operand values, so nothing a caller filtered on is kept.
 */

import type { FieldDef } from '@mnmal-ai/substrate-types';
import { LogHistogram } from '../metrics/histogram.js';
import type { WalkSite } from './walk-service.js';

export interface ReadShape {
  namespace: string;
  type: string;
  filters: Array<{ field: string; op: string }>;
  orderBy: Array<[string, 'asc' | 'desc']>;
  /** An OR or a NOT somewhere in the filter: no composite index serves it as a conjunction. */
  disjunctive?: true;
  /**
   * The boolean or null operand of each top-level (or AND-ed) `eq`, the only
   * operand values kept: they decide whether a partial index's predicate
   * holds, and have three possible values.
   */
  literals?: Record<string, boolean | null>;
}

/** Stable across filter order and operand values: field names and operators only. */
export function shapeKey(s: ReadShape): string {
  const filters = [...new Set(s.filters.map((f) => `${f.field} ${f.op}`))].sort();
  const key: unknown[] = [s.namespace, s.type, filters, s.orderBy];
  const literals = Object.entries(s.literals ?? {}).sort(([a], [b]) => a.localeCompare(b));
  if (s.disjunctive === true || literals.length > 0) key.push(s.disjunctive === true, literals);
  return JSON.stringify(key);
}

const COMBINATORS = new Set(['AND', 'OR', 'NOT']);
/** Walk grammar inside a `where`: walks are recorded as far-type shapes of their own, never as fields. */
const WALK_KEYS = new Set(['_walk', '_agg', '$ref']);

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof Date);

/**
 * The shape of a read: every field `where` names, at any depth (through
 * AND/OR/NOT, and into struct fields as `a.b`), with each operator on it, and
 * the order it reads in. Takes the canonical `where` and `orderBy` as given.
 */
export function readShapeOf(
  namespace: string,
  type: string,
  fields: Record<string, FieldDef>,
  where: unknown,
  orderBy: unknown
): ReadShape {
  const filters: ReadShape['filters'] = [];
  const literals: Record<string, boolean | null> = {};
  let disjunctive = false;
  const walk = (
    w: unknown,
    defs: Record<string, FieldDef> | undefined,
    prefix: string,
    conjunct: boolean
  ): void => {
    // A where-side `_agg` node's comparison is on the aggregate, not on a field.
    if (!isObject(w) || Object.hasOwn(w, '_agg')) return;
    for (const [k, v] of Object.entries(w)) {
      if (WALK_KEYS.has(k)) continue;
      if (COMBINATORS.has(k)) {
        const under = conjunct && k === 'AND';
        if (!under) disjunctive = true;
        for (const sub of Array.isArray(v) ? v : [v]) walk(sub, defs, prefix, under);
        continue;
      }
      const def = defs !== undefined && Object.hasOwn(defs, k) ? defs[k] : undefined;
      if (def?.kind === 'struct') {
        walk(v, def.fields, `${prefix}${k}.`, conjunct);
      } else if (isObject(v)) {
        for (const op of Object.keys(v)) {
          if (op !== 'path') filters.push({ field: `${prefix}${k}`, op });
        }
        const operand = v.eq;
        if (conjunct && (operand === null || typeof operand === 'boolean')) {
          literals[`${prefix}${k}`] = operand;
        }
      }
    }
  };
  walk(where, fields, '', true);
  const order: ReadShape['orderBy'] = [];
  for (const clause of Array.isArray(orderBy) ? orderBy : []) {
    if (!isObject(clause)) continue;
    for (const [f, dir] of Object.entries(clause)) order.push([f, dir === 'desc' ? 'desc' : 'asc']);
  }
  return {
    namespace,
    type,
    filters,
    orderBy: order,
    ...(disjunctive ? { disjunctive: true as const } : {}),
    ...(Object.keys(literals).length > 0 ? { literals } : {})
  };
}

/**
 * One far-type shape per inbound walk: the far rows are read by the hop's
 * crossRef (an equality per seed row), then the walk's own filters, in the
 * walk's order. An outbound hop reads one row by primary key, which no index
 * could speed, so it has none.
 */
export function walkShapesOf(
  namespace: string,
  sites: WalkSite[],
  fieldsOf: (type: string) => Record<string, FieldDef> | undefined
): ReadShape[] {
  const out: ReadShape[] = [];
  for (const s of sites) {
    if (s.crossRef === undefined) continue;
    const wheres = s.wheres.map((w) => w.where);
    const where = wheres.length === 1 ? wheres[0] : { AND: wheres };
    const order = (s.order?.by ?? []).map(([f, d]) => ({ [f]: d }));
    const shape = readShapeOf(namespace, s.far, fieldsOf(s.far) ?? {}, where, order);
    shape.filters.unshift({ field: s.crossRef, op: 'eq' });
    out.push(shape);
  }
  return out;
}

/** Distinct shapes held between drains; past it the least recently seen is dropped. */
const MAX_SHAPES = 1024;

export class ShapeRecorder {
  // A Map iterates in insertion order: re-inserting on each observe keeps the
  // least recently seen first.
  readonly #shapes = new Map<string, { shape: ReadShape; hist: LogHistogram }>();
  readonly #now: () => number;
  /** When this recorder was created or last drained: the start of what `drain` returns. */
  since: number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
    this.since = now();
  }

  observe(shape: ReadShape, durationMs: number): void {
    const key = shapeKey(shape);
    const held = this.#shapes.get(key);
    const entry = held ?? { shape, hist: new LogHistogram() };
    if (held !== undefined) this.#shapes.delete(key);
    entry.hist.observe(durationMs);
    this.#shapes.set(key, entry);
    if (this.#shapes.size > MAX_SHAPES) {
      const oldest = this.#shapes.keys().next().value as string;
      this.#shapes.delete(oldest);
    }
  }

  /** Every shape seen since the last drain, with its count and p95; then forgets them. */
  drain(): Array<{ shape: ReadShape; count: number; p95Ms: number }> {
    const out = [...this.#shapes.values()].map(({ shape, hist }) => ({
      shape,
      count: hist.count,
      p95Ms: hist.percentile(0.95)
    }));
    this.#shapes.clear();
    this.since = this.#now();
    return out;
  }
}

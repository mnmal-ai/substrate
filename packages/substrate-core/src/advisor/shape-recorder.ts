/**
 * The index advisor's view of reads: which shapes (filtered fields and
 * operators, plus the effective order) run, how often, and how slowly. Never
 * operand values, so nothing a caller filtered on is kept.
 */

import type { FieldDef } from '@mnmal-ai/substrate-types';
import { LogHistogram } from '../metrics/histogram.js';

export interface ReadShape {
  namespace: string;
  type: string;
  filters: Array<{ field: string; op: string }>;
  orderBy: Array<[string, 'asc' | 'desc']>;
}

/** Stable across filter order and operand values: field names and operators only. */
export function shapeKey(s: ReadShape): string {
  const filters = [...new Set(s.filters.map((f) => `${f.field} ${f.op}`))].sort();
  return JSON.stringify([s.namespace, s.type, filters, s.orderBy]);
}

const COMBINATORS = new Set(['AND', 'OR', 'NOT']);

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
  const walk = (w: unknown, defs: Record<string, FieldDef> | undefined, prefix: string): void => {
    if (!isObject(w)) return;
    for (const [k, v] of Object.entries(w)) {
      if (COMBINATORS.has(k)) {
        for (const sub of Array.isArray(v) ? v : [v]) walk(sub, defs, prefix);
        continue;
      }
      const def = defs !== undefined && Object.hasOwn(defs, k) ? defs[k] : undefined;
      if (def?.kind === 'struct') {
        walk(v, def.fields, `${prefix}${k}.`);
      } else if (isObject(v)) {
        for (const op of Object.keys(v)) {
          if (op !== 'path') filters.push({ field: `${prefix}${k}`, op });
        }
      }
    }
  };
  walk(where, fields, '');
  const order: ReadShape['orderBy'] = [];
  for (const clause of Array.isArray(orderBy) ? orderBy : []) {
    if (!isObject(clause)) continue;
    for (const [f, dir] of Object.entries(clause)) order.push([f, dir === 'desc' ? 'desc' : 'asc']);
  }
  return { namespace, type, filters, orderBy: order };
}

/** Distinct shapes held between drains; past it the least recently seen is dropped. */
const MAX_SHAPES = 1024;

export class ShapeRecorder {
  // A Map iterates in insertion order: re-inserting on each observe keeps the
  // least recently seen first.
  readonly #shapes = new Map<string, { shape: ReadShape; hist: LogHistogram }>();

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
    return out;
  }
}

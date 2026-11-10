/**
 * Grouped reads (`aggregate` with `groupBy`, `having`, `orderBy`, `offset`) in
 * memory: the reference the Postgres compiler is held to. Groups are keyed by
 * a stable encoding of the key tuple; nulls form one group, as SQL's GROUP BY.
 */
import {
  type Expr,
  type ExprType,
  type FrameAgg,
  type OrderByClause,
  ResolverFrameError,
  type Row,
  VALUE_OUT_OF_RANGE
} from '@mnmal-ai/substrate-types';
import { checkExpr } from './expr-check.js';
import { evalExpr } from './expr-eval.js';
import { metadataExprType } from './expr-scope.js';
import { getFieldValue, storedMicros } from './predicate.js';
import { isoFromMicros, numericAgg } from './walk.js';

const ARITHMETIC = new Set(['add', 'sub', 'mul', 'div', 'mod', 'neg']);

/** Whether evaluating `e` can raise a range error (arithmetic anywhere in it). */
export function canRaise(e: unknown): boolean {
  if (Array.isArray(e)) return e.some(canRaise);
  if (typeof e !== 'object' || e === null || 'lit' in e || 'int64' in e) return false;
  return Object.entries(e).some(([k, v]) => ARITHMETIC.has(k) || canRaise(v));
}

const MIN_INT64 = -(2n ** 63n);
const MAX_INT64 = 2n ** 63n - 1n;
type Op = 'count' | 'countDistinct' | 'avg' | 'sum' | 'min' | 'max';
const OPS: readonly Op[] = ['count', 'countDistinct', 'avg', 'sum', 'min', 'max'];

/** An aggregate's function and argument. */
export function aggParts(spec: FrameAgg): { op: Op; arg: Expr } {
  const op = OPS.find((k) => Object.hasOwn(spec, k));
  if (op === undefined) throw new Error('internal: aggregate names no function');
  return { op, arg: (spec as unknown as Record<Op, Expr>)[op] };
}

/** The type an aggregate over an argument of type `arg` returns (`count` is a number). */
export function aggType(op: Op, arg: ExprType | null): ExprType {
  if (op === 'count' || op === 'countDistinct' || op === 'avg') return 'number';
  return arg ?? 'string';
}

export interface GroupedParams {
  aggregate?: Record<string, FrameAgg>;
  groupBy?: Record<string, Expr>;
  having?: Expr;
  offset?: number;
  orderBy?: OrderByClause[];
}

const isoMicros = (v: unknown): string | null => {
  const m = storedMicros(v);
  return m === undefined ? null : isoFromMicros(m);
};

/** A value as a Map key, equal exactly when SQL would put two values in one group. */
function encode(v: unknown, t: ExprType | null): string {
  if (v === null || v === undefined) return 'n';
  if (t === 'date') return `d${storedMicros(v)}`;
  if (typeof v === 'bigint') return `i${v}`;
  if (typeof v === 'number') return `f${v === 0 ? 0 : v}`;
  return `${typeof v === 'string' ? 's' : 'b'}${JSON.stringify(v)}`;
}

/** A date value `substrate_ts` cannot read is NULL on pg; so here. */
const readable = (v: unknown, t: ExprType | null): unknown =>
  t === 'date' && v !== null && storedMicros(v) === undefined ? null : v;

const bytes = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b));

/** Nulls compare after everything; otherwise by type, as pg sorts it (text in byte order). */
function compare(a: unknown, b: unknown, t: ExprType | null): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  if (t === 'date') return Number((storedMicros(a) as bigint) - (storedMicros(b) as bigint));
  if (t === 'string') return bytes(a as string, b as string);
  return (a as number) < (b as number) ? -1 : (a as number) > (b as number) ? 1 : 0;
}

/** The evaluator's int64 range error and its float overflow/underflow error: pg's 22003. */
const isRangeError = (err: unknown): err is Error =>
  (err instanceof RangeError && err.message === 'bigint out of range') ||
  (err instanceof Error && err.message.startsWith('value out of range: '));

export function outOfRange(err: unknown): never {
  if (isRangeError(err)) throw new ResolverFrameError(VALUE_OUT_OF_RANGE, err.message);
  throw err;
}

function aggregateOf(op: Op, arg: Expr, t: ExprType | null, values: unknown[], rows: number) {
  if (op === 'count') return arg === true ? rows : values.filter((v) => v !== null).length;
  const present = values.filter((v) => v !== null);
  if (op === 'countDistinct') return new Set(present.map((v) => encode(v, t))).size;
  if (present.length === 0) return null;
  if (t === 'int64') {
    const ns = present as bigint[];
    if (op === 'min' || op === 'max')
      return ns.reduce((a, b) => ((op === 'min' ? b < a : b > a) ? b : a));
    const sum = ns.reduce((a, b) => a + b, 0n);
    if (op === 'avg') return Number(sum) / ns.length;
    if (sum < MIN_INT64 || sum > MAX_INT64) outOfRange(new RangeError('bigint out of range'));
    return sum;
  }
  if (t === 'string' || t === 'date') {
    const best = present.reduce((a, b) =>
      (op === 'min' ? compare(b, a, t) < 0 : compare(b, a, t) > 0) ? b : a
    );
    return t === 'date' ? isoMicros(best) : best;
  }
  return numericAgg(present, op as 'avg' | 'sum' | 'min' | 'max');
}

export interface Grouped {
  groups: Array<Record<string, unknown>>;
  truncated: boolean;
}

/**
 * `pool`'s rows grouped, aggregated, filtered by `having`, ordered (default:
 * the group keys ascending, ties by them too), then cut to `limit` after `offset`.
 * `fieldType` must be one stable lookup per read: the evaluator caches on it.
 */
export function groupRows(
  pool: Row[],
  p: Required<Pick<GroupedParams, 'aggregate'>> & GroupedParams,
  fieldType: (name: string) => ExprType | undefined,
  limit: number | undefined
): Grouped {
  const keys = Object.entries(p.groupBy ?? {});
  const aggs = Object.entries(p.aggregate).map(([name, spec]) => ({ name, ...aggParts(spec) }));
  const typeOf = (e: Expr): ExprType | null => {
    const r = checkExpr(e, { field: fieldType }, []);
    return r.ok ? r.type : null;
  };
  const keyTypes = keys.map(([, e]) => typeOf(e));
  const argTypes = aggs.map((a) => typeOf(a.arg));
  const outTypes = new Map<string, ExprType | null>([
    ...keys.map(([n], i) => [n, keyTypes[i] as ExprType | null] as const),
    ...aggs.map((a, i) => [a.name, aggType(a.op, argTypes[i] as ExprType | null)] as const)
  ]);
  const outType = (name: string) => outTypes.get(name) ?? undefined;
  const env = { fieldType };

  const buckets = new Map<string, { key: unknown[]; rows: Row[] }>();
  try {
    for (const row of pool) {
      const key = keys.map(([, e], i) =>
        readable(evalExpr(e, row, env) ?? null, keyTypes[i] as ExprType | null)
      );
      const id = key.map((v, i) => encode(v, keyTypes[i] as ExprType | null)).join('\u0000');
      const b = buckets.get(id);
      if (b === undefined) buckets.set(id, { key, rows: [row] });
      else b.rows.push(row);
    }
    // Without keys there is always one group, over no rows as well.
    if (keys.length === 0 && buckets.size === 0) buckets.set('', { key: [], rows: [] });
  } catch (err) {
    outOfRange(err);
  }

  let groups: Array<Record<string, unknown>> = [];
  try {
    for (const { key, rows } of buckets.values()) {
      const g: Record<string, unknown> = {};
      keys.forEach(([n], i) => {
        g[n] = keyTypes[i] === 'date' ? isoMicros(key[i]) : key[i];
      });
      aggs.forEach((a, i) => {
        const at = argTypes[i] as ExprType | null;
        const values = rows.map((r) => readable(evalExpr(a.arg, r, env) ?? null, at));
        g[a.name] = aggregateOf(a.op, a.arg, argTypes[i] as ExprType | null, values, rows.length);
      });
      groups.push(g);
    }
  } catch (err) {
    outOfRange(err);
  }

  if (p.having !== undefined) {
    const having = p.having;
    try {
      groups = groups.filter(
        (g) => evalExpr(having, {}, { output: g, fieldType: outType }) === true
      );
    } catch (err) {
      outOfRange(err);
    }
  }

  const order = [
    ...(p.orderBy ?? []).map((c) => Object.entries(c)[0] as [string, 'asc' | 'desc']),
    ...keys.map(([n]) => [n, 'asc'] as [string, 'asc' | 'desc'])
  ];
  groups.sort((a, b) => {
    for (const [name, dir] of order) {
      const t = outTypes.get(name) ?? null;
      const x = a[name] as unknown;
      const y = b[name] as unknown;
      const c = compare(x ?? null, y ?? null, t);
      // Nulls stay last in either direction.
      if (c !== 0) return dir === 'desc' && x != null && y != null ? -c : c;
    }
    return 0;
  });

  const start = p.offset ?? 0;
  const end = limit === undefined ? undefined : start + limit;
  const truncated = end !== undefined && groups.length > end;
  return { groups: groups.slice(start, end), truncated };
}

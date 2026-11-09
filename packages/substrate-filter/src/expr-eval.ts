/**
 * In-memory evaluator for read-grammar expressions. Assumes the input passed
 * `checkExpr`; SQL null never throws and propagates as `null`. Values are
 * `number`, `string`, `boolean`, `bigint` (int64) and ISO-8601 UTC strings (dates).
 */
import type { Expr, ExprType } from '@mnmal-ai/substrate-types';
import { checkExpr } from './expr-check.js';
import { compileRegex, execRegex } from './regex-vm.js';

export interface EvalEnv {
  /** Named outputs, which a bare string resolves to before the row (for `having`). */
  output?: Record<string, unknown>;
  /** The type of a bare string, where its value alone (a null) does not say. */
  fieldType?: (name: string) => ExprType | undefined;
}

const MIN_INT64 = -(2n ** 63n);
const MAX_INT64 = 2n ** 63n - 1n;

const int64 = (n: bigint): bigint => {
  if (n < MIN_INT64 || n > MAX_INT64) throw new RangeError('int64 overflow');
  return n;
};

/** A small Map-based LRU: bounded so caller-supplied patterns cannot grow memory. */
export function lru<V>(max: number, make: (k: string) => V): (k: string) => V {
  const m = new Map<string, V>();
  return (k) => {
    let v = m.get(k);
    if (v !== undefined) m.delete(k);
    else {
      v = make(k);
      if (m.size >= max) m.delete(m.keys().next().value as string);
    }
    m.set(k, v);
    return v;
  };
}

const compile = lru(256, compileRegex);

type LikeToken = '%' | '_' | { lit: string };

function likeTokens(pattern: string): LikeToken[] {
  const cps = Array.from(pattern);
  const out: LikeToken[] = [];
  for (let i = 0; i < cps.length; i++) {
    const c = cps[i] as string;
    if (c === '\\') {
      if (i + 1 >= cps.length) throw new Error('LIKE pattern must not end with escape character');
      out.push({ lit: cps[++i] as string });
    } else if (c === '%' || c === '_') out.push(c);
    else out.push({ lit: c });
  }
  return out;
}

/** Linear-time-ish wildcard match (backtracks only to the last `%`), over code points. */
function likeMatch(text: string, pattern: string): boolean {
  const toks = likeTokens(pattern);
  const t = Array.from(text);
  let ti = 0;
  let pi = 0;
  let star = -1;
  let mark = 0;
  while (ti < t.length) {
    const tok = toks[pi];
    if (tok === '%') {
      star = pi++;
      mark = ti;
    } else if (tok !== undefined && (tok === '_' || tok.lit === t[ti])) {
      pi++;
      ti++;
    } else if (star >= 0) {
      pi = star + 1;
      ti = ++mark;
    } else return false;
  }
  while (toks[pi] === '%') pi++;
  return pi === toks.length;
}

/** Maps ASCII letters only, as pg does under the "C" collation; every other code point is unchanged. */
const asciiCase = (s: string, from: RegExp, f: (c: string) => string): string => s.replace(from, f);

/** float8 arithmetic as Postgres does it: a non-finite result from finite operands, or a nonzero product or quotient that underflows to 0, raises. */
function float8(v: number, a: number, b: number, underflows: boolean): number {
  if (!Number.isFinite(v) && Number.isFinite(a) && Number.isFinite(b)) {
    throw new Error('value out of range: overflow');
  }
  if (underflows && v === 0 && a !== 0 && b !== 0) throw new Error('value out of range: underflow');
  return v;
}

/** The replacement's `\1`-`\9` as group references, `\&` as the whole match; `\\` is a backslash; everything else is literal. */
function expandReplacement(rep: string, whole: string, groups: (string | undefined)[]): string {
  let out = '';
  const cps = Array.from(rep);
  for (let i = 0; i < cps.length; i++) {
    const c = cps[i] as string;
    const next = cps[i + 1];
    if (c === '\\' && next !== undefined && /[1-9]/.test(next)) {
      out += groups[Number(next) - 1] ?? '';
      i++;
    } else if (c === '\\' && next === '&') {
      out += whole;
      i++;
    } else if (c === '\\' && next === '\\') {
      out += '\\';
      i++;
    } else out += c;
  }
  return out;
}

const toDate = (v: unknown): Date | null => {
  const d = new Date(v as string);
  return Number.isNaN(d.getTime()) ? null : d;
};

function trunc(unit: string, d: Date): Date {
  const [y, mo, da, h, mi, s] = [
    d.getUTCFullYear(),
    d.getUTCMonth(),
    d.getUTCDate(),
    d.getUTCHours(),
    d.getUTCMinutes(),
    d.getUTCSeconds()
  ];
  switch (unit) {
    case 'year':
      return new Date(Date.UTC(y, 0, 1));
    case 'month':
      return new Date(Date.UTC(y, mo, 1));
    case 'week':
      return new Date(Date.UTC(y, mo, da - ((d.getUTCDay() + 6) % 7)));
    case 'day':
      return new Date(Date.UTC(y, mo, da));
    case 'hour':
      return new Date(Date.UTC(y, mo, da, h));
    case 'minute':
      return new Date(Date.UTC(y, mo, da, h, mi));
    default:
      return new Date(Date.UTC(y, mo, da, h, mi, s));
  }
}

function isoWeek(d: Date): number {
  const day = (d.getUTCDay() + 6) % 7;
  const thursday = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day + 3);
  const jan1 = Date.UTC(new Date(thursday).getUTCFullYear(), 0, 1);
  return Math.floor((thursday - jan1) / 604_800_000) + 1;
}

function extract(unit: string, d: Date): number {
  switch (unit) {
    case 'year':
      return d.getUTCFullYear();
    case 'month':
      return d.getUTCMonth() + 1;
    case 'week':
      return isoWeek(d);
    case 'day':
      return d.getUTCDate();
    case 'hour':
      return d.getUTCHours();
    case 'minute':
      return d.getUTCMinutes();
    default:
      return d.getUTCSeconds() + d.getUTCMilliseconds() / 1000;
  }
}

const isSafeIntLiteral = (e: Expr): boolean => typeof e === 'number' && Number.isSafeInteger(e);

type Arith = (a: bigint, b: bigint) => bigint;
const ARITH: Record<string, [Arith, (a: number, b: number) => number]> = {
  add: [(a, b) => a + b, (a, b) => a + b],
  sub: [(a, b) => a - b, (a, b) => a - b],
  mul: [(a, b) => a * b, (a, b) => a * b]
};

export function evalExpr(expr: Expr, row: Record<string, unknown>, env: EvalEnv = {}): unknown {
  if (expr === null) return null;
  if (typeof expr === 'string') {
    const v =
      env.output && Object.hasOwn(env.output, expr)
        ? env.output[expr]
        : Object.hasOwn(row, expr)
          ? row[expr]
          : null;
    if (v === undefined || v === null) return null;
    return v instanceof Date ? v.toISOString() : v;
  }
  if (typeof expr !== 'object') return expr;
  if ('lit' in expr) return (expr as { lit: string }).lit;
  if ('int64' in expr) return BigInt((expr as { int64: string }).int64);

  const key = Object.keys(expr)[0] as string;
  const args = (expr as Record<string, Expr[]>)[key] as Expr[];
  const ev = (e: Expr): unknown => evalExpr(e, row, env);

  // Functions that do not propagate null by default.
  switch (key) {
    case 'case': {
      for (let i = 0; i < args.length - 1; i++) {
        const [cond, then] = args[i] as unknown as [Expr, Expr];
        if (ev(cond) === true) return unified(expr, ev(then), row, env);
      }
      return unified(expr, ev(args[args.length - 1] as Expr), row, env);
    }
    case 'coalesce':
      for (const a of args) {
        const v = ev(a);
        if (v !== null) return unified(expr, v, row, env);
      }
      return null;
    case 'isNull':
      return ev(args[0] as Expr) === null;
    case 'and':
    case 'or': {
      const stop = key === 'or';
      let sawNull = false;
      for (const a of args) {
        const v = ev(a);
        if (v === null) sawNull = true;
        else if (v === stop) return stop;
      }
      return sawNull ? null : !stop;
    }
  }

  const vals = args.map(ev);
  if (key === 'in') {
    const [needle, ...rest] = vals as [unknown, ...unknown[]];
    if (needle === null) return null;
    // biome-ignore lint/suspicious/noExplicitAny: comparisons span bigint, number and string.
    if (rest.some((v: any) => v !== null && !((needle as any) < v) && !((needle as any) > v)))
      return true;
    return rest.includes(null) ? null : false;
  }
  if (key === 'dateTrunc' || key === 'extract') {
    const d = vals[1] === null ? null : toDate(vals[1]);
    if (!d) return null;
    return key === 'extract'
      ? extract(vals[0] as string, d)
      : trunc(vals[0] as string, d).toISOString();
  }
  if (vals.some((v) => v === null)) return null;

  // biome-ignore lint/suspicious/noExplicitAny: operands are checked upstream; comparisons span bigint, number and string.
  const [a, b, c] = vals as [any, any, any];
  switch (key) {
    case 'add':
    case 'sub':
    case 'mul': {
      const [big, num] = ARITH[key] as NonNullable<(typeof ARITH)[string]>;
      return arith(args, vals, big, num, key === 'mul');
    }
    case 'div':
      return Number(b) === 0 ? null : float8(Number(a) / Number(b), Number(a), Number(b), true);
    case 'mod':
      // int64 only; a safe-integer literal counts as one.
      return BigInt(b) === 0n ? null : int64(BigInt(a) % BigInt(b));
    case 'neg':
      return typeof a === 'bigint' ? int64(-a) : -a;
    case 'eq':
      return !(a < b) && !(a > b);
    case 'neq':
      return a < b || a > b;
    case 'gt':
      return a > b;
    case 'gte':
      return !(a < b);
    case 'lt':
      return a < b;
    case 'lte':
      return !(a > b);
    case 'not':
      return !a;
    case 'length':
      return Array.from(a as string).length;
    case 'lower':
      return asciiCase(a as string, /[A-Z]/g, (x) => x.toLowerCase());
    case 'upper':
      return asciiCase(a as string, /[a-z]/g, (x) => x.toUpperCase());
    case 'substring': {
      // Positions p with start <= p < start + len, p >= 1, as in Postgres.
      const start = Math.round(Number(b));
      const end = start + Math.round(Number(c));
      return Array.from(a as string)
        .slice(Math.max(start, 1) - 1, Math.max(end - 1, 0))
        .join('');
    }
    case 'concat':
      return vals.join('');
    case 'like':
      return likeMatch(a, b);
    case 'notLike':
      return !likeMatch(a, b);
    case 'regexpMatch':
      return execRegex(compile(b), a) !== null;
    case 'regexpReplace': {
      const m = execRegex(compile(b), a);
      if (!m) return a;
      return (
        a.slice(0, m.index) +
        expandReplacement(c, a.slice(m.index, m.end), m.groups) +
        a.slice(m.end)
      );
    }
    default:
      throw new Error(`unknown function '${key}'`);
  }
}

/** int64 when both operands are int64 (a safe-integer literal counts), else number. */
function arith(
  args: Expr[],
  vals: unknown[],
  big: Arith,
  num: (a: number, b: number) => number,
  mulUnderflow = false
): bigint | number | null {
  const [a, b] = vals as [bigint | number, bigint | number];
  const lift = (v: bigint | number, e: Expr, other: unknown): bigint | number =>
    typeof v === 'number' && typeof other === 'bigint' && isSafeIntLiteral(e) ? BigInt(v) : v;
  const x = lift(a, args[0] as Expr, b);
  const y = lift(b, args[1] as Expr, a);
  if (typeof x === 'bigint' && typeof y === 'bigint') return int64(big(x, y));
  return float8(num(Number(x), Number(y)), Number(x), Number(y), mulUnderflow);
}

/** A case or coalesce value in the type the checker gives the whole call: int64 widens to number, a number literal adopts int64. */
function unified(expr: Expr, v: unknown, row: Record<string, unknown>, env: EvalEnv): unknown {
  if (typeof v !== 'bigint' && typeof v !== 'number') return v;
  const scope = {
    field(name: string): ExprType | undefined {
      const t = env.fieldType?.(name);
      if (t !== undefined) return t;
      const x = env.output && Object.hasOwn(env.output, name) ? env.output[name] : row[name];
      return typeof x === 'bigint'
        ? 'int64'
        : typeof x === 'number'
          ? 'number'
          : typeof x === 'string'
            ? 'string'
            : typeof x === 'boolean'
              ? 'boolean'
              : undefined;
    }
  };
  const c = checkExpr(expr, scope, []);
  if (!c.ok) return v;
  if (c.type === 'number' && typeof v === 'bigint') return Number(v);
  if (c.type === 'int64' && typeof v === 'number') return BigInt(v);
  return v;
}

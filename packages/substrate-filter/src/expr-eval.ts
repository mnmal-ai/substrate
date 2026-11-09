/**
 * In-memory evaluator for read-grammar expressions. Assumes the input passed
 * `checkExpr`; SQL null never throws and propagates as `null`. Values are
 * `number`, `string`, `boolean`, `bigint` (int64) and ISO-8601 UTC strings (dates).
 */
import type { Expr } from '@mnmal-ai/substrate-types';
import { checkRegexSubset } from './regex-subset.js';

export interface EvalEnv {
  /** Named outputs, which a bare string resolves to before the row (for `having`). */
  output?: Record<string, unknown>;
}

const MIN_INT64 = -(2n ** 63n);
const MAX_INT64 = 2n ** 63n - 1n;

const int64 = (n: bigint): bigint => {
  if (n < MIN_INT64 || n > MAX_INT64) throw new RangeError('int64 overflow');
  return n;
};

const regexCache = new Map<string, RegExp>();
function compile(pattern: string): RegExp {
  let re = regexCache.get(pattern);
  if (!re) {
    const bad = checkRegexSubset(pattern);
    if (bad) throw new Error(`invalid regex: ${bad}`);
    re = new RegExp(pattern, 'us');
    regexCache.set(pattern, re);
  }
  return re;
}

const likeCache = new Map<string, RegExp>();
function likeRegex(pattern: string): RegExp {
  let re = likeCache.get(pattern);
  if (!re) {
    let src = '';
    const cps = Array.from(pattern);
    for (let i = 0; i < cps.length; i++) {
      const c = cps[i] as string;
      if (c === '\\' && i + 1 < cps.length) src += escapeRe(cps[++i] as string);
      else if (c === '%') src += '.*';
      else if (c === '_') src += '.';
      else src += escapeRe(c);
    }
    re = new RegExp(`^${src}$`, 'us');
    likeCache.set(pattern, re);
  }
  return re;
}
const escapeRe = (c: string): string => c.replace(/[\\^$.*+?()[\]{}|/]/g, '\\$&');

/** The replacement's `\1`-`\9` as group references; `\\` is a backslash; everything else is literal. */
function expandReplacement(rep: string, groups: (string | undefined)[]): string {
  let out = '';
  const cps = Array.from(rep);
  for (let i = 0; i < cps.length; i++) {
    const c = cps[i] as string;
    const next = cps[i + 1];
    if (c === '\\' && next !== undefined && /[1-9]/.test(next)) {
      out += groups[Number(next) - 1] ?? '';
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
      return d.getUTCSeconds();
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
    const v = env.output && expr in env.output ? env.output[expr] : row[expr];
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
        if (ev(cond) === true) return ev(then);
      }
      return ev(args[args.length - 1] as Expr);
    }
    case 'coalesce':
      for (const a of args) {
        const v = ev(a);
        if (v !== null) return v;
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
      return arith(args, vals, big, num);
    }
    case 'div':
      return Number(b) === 0 ? null : Number(a) / Number(b);
    case 'mod':
      if (Number(b) === 0) return null;
      return arith(
        args,
        vals,
        (x, y) => x % y,
        (x, y) => x % y
      );
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
      return (a as string).toLowerCase();
    case 'upper':
      return (a as string).toUpperCase();
    case 'substring': {
      // Positions p with start <= p < start + len, p >= 1, as in Postgres.
      const start = Math.round(b);
      const end = start + Math.round(c);
      return Array.from(a as string)
        .slice(Math.max(start, 1) - 1, Math.max(end - 1, 0))
        .join('');
    }
    case 'concat':
      return vals.join('');
    case 'like':
      return likeRegex(b).test(a);
    case 'notLike':
      return !likeRegex(b).test(a);
    case 'regexpMatch':
      return compile(b).test(a);
    case 'regexpReplace':
      return (a as string).replace(compile(b), (...m: unknown[]) => {
        const groups = m.slice(
          1,
          m.findIndex((x) => typeof x === 'number')
        ) as (string | undefined)[];
        return expandReplacement(c, groups);
      });
    default:
      throw new Error(`unknown function '${key}'`);
  }
}

/** int64 when both operands are int64 (a safe-integer literal counts), else number. */
function arith(
  args: Expr[],
  vals: unknown[],
  big: Arith,
  num: (a: number, b: number) => number
): bigint | number {
  const [a, b] = vals as [bigint | number, bigint | number];
  const lift = (v: bigint | number, e: Expr, other: unknown): bigint | number =>
    typeof v === 'number' && typeof other === 'bigint' && isSafeIntLiteral(e) ? BigInt(v) : v;
  const x = lift(a, args[0] as Expr, b);
  const y = lift(b, args[1] as Expr, a);
  if (typeof x === 'bigint' && typeof y === 'bigint') return int64(big(x, y));
  return num(Number(x), Number(y));
}

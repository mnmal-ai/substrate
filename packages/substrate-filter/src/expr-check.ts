/**
 * Type checker for read-grammar expressions. Infers the type of every node,
 * refuses mismatches, unknown functions and fields, and enforces the per-
 * expression limits (`EXPR_LIMITS`). `int64` mixed with `number` widens to
 * `number`; a safe-integer literal beside an int64 stays int64.
 */
import {
  type ArgType,
  DATE_UNITS,
  EXPR_FUNCTIONS,
  EXPR_LIMITS,
  type Expr,
  type ExprType,
  type FunctionSig,
  parseInt64
} from '@mnmal-ai/substrate-types';
import { checkRegexSubset } from './regex-subset.js';

export interface ExprScope {
  /** The type of a bare string: a field, `_agg.<name>`, or an output name in `having`. */
  field(name: string): ExprType | undefined;
}

export type ExprCheck =
  | { ok: true; type: ExprType; nodes: number; depth: number }
  | { ok: false; code: 'expr_invalid'; message: string; path: string[] };

const SIGS = new Map<string, FunctionSig>(EXPR_FUNCTIONS.map((s) => [s.name, s]));
const isNumeric = (t: ExprType): boolean => t === 'number' || t === 'int64';

class Refusal extends Error {
  constructor(
    message: string,
    readonly at: string[]
  ) {
    super(message);
  }
}

/** A node's type; `null` for an untyped null literal, which adopts its partners' type. */
interface Typed {
  type: ExprType | null;
  /** A safe-integer number literal, which adopts int64 beside an int64. */
  intLiteral?: boolean;
  /** An unsafe-integer number literal, refused beside an int64. */
  bigLiteral?: boolean;
}

export const LIKE_TRAILING_ESCAPE = 'LIKE pattern must not end with escape character';

/** Whether a LIKE pattern ends in an unescaped backslash. */
export const endsWithEscape = (text: string): boolean => /(^|[^\\])(\\\\)*\\$/.test(text);

export function checkExpr(expr: Expr, scope: ExprScope, path: string[]): ExprCheck {
  let nodes = 0;
  const refuse = (msg: string, at: string[]): never => {
    throw new Refusal(`${at.join('.')}: ${msg}`, at);
  };

  const checkDepth = (depth: number, at: string[]): void => {
    if (depth > EXPR_LIMITS.maxDepth)
      refuse(`expression is deeper than maxDepth (${EXPR_LIMITS.maxDepth})`, at);
  };
  const count = (at: string[]): void => {
    if (++nodes > EXPR_LIMITS.maxNodesPerExpr) {
      refuse(`expression has more than maxNodesPerExpr (${EXPR_LIMITS.maxNodesPerExpr}) nodes`, at);
    }
  };

  const unify = (items: Typed[], what: string, at: string[]): ExprType => {
    const types = items.map((x) => x.type).filter((t): t is ExprType => t !== null);
    if (types.length === 0) return refuse(`${what}: cannot infer a type from null alone`, at);
    if (types.every(isNumeric)) {
      if (types.includes('int64')) {
        if (items.some((x) => x.bigLiteral))
          refuse(`${what}: a number beside an int64 must be a safe integer`, at);
        const adopts = items.every((x) => x.type === 'int64' || x.type === null || x.intLiteral);
        return adopts ? 'int64' : 'number';
      }
      return 'number';
    }
    const first = types[0] as ExprType;
    if (types.some((t) => t !== first))
      refuse(`${what}: arguments must share a type, got ${types.join(' and ')}`, at);
    return first;
  };

  const need = (a: Typed, want: ExprType, what: string, at: string[]): void => {
    if (a.type === null) return;
    const ok = want === 'number' ? isNumeric(a.type) : a.type === want;
    if (!ok) refuse(`${what}: expected ${want}, got ${a.type}`, at);
  };

  const lit = (arg: Expr, what: string, at: string[]): string => {
    if (
      typeof arg === 'object' &&
      arg !== null &&
      typeof (arg as { lit?: unknown }).lit === 'string'
    ) {
      return (arg as { lit: string }).lit;
    }
    return refuse(`${what}: expected a { lit } string`, at);
  };

  const walk = (e: unknown, at: string[], depth: number): { t: Typed; depth: number } => {
    if (depth > EXPR_LIMITS.maxDepth)
      refuse(`expression is deeper than maxDepth (${EXPR_LIMITS.maxDepth})`, at);
    count(at);
    if (e === null) return { t: { type: null }, depth };
    if (typeof e === 'boolean') return { t: { type: 'boolean' }, depth };
    if (typeof e === 'number') {
      if (!Number.isFinite(e)) return refuse('number literal must be finite', at);
      return {
        t: {
          type: 'number',
          intLiteral: Number.isSafeInteger(e),
          bigLiteral: Number.isInteger(e) && !Number.isSafeInteger(e)
        },
        depth
      };
    }
    if (typeof e === 'string') {
      const t = scope.field(e);
      if (t === undefined) return refuse(`unknown field '${e}'`, at);
      return { t: { type: t }, depth };
    }
    if (typeof e !== 'object' || Array.isArray(e)) return refuse('not an expression', at);
    const keys = Object.keys(e);
    if (keys.length !== 1)
      return refuse(`an expression object has exactly one key, got ${keys.length}`, at);
    const key = keys[0] as string;
    const val = (e as Record<string, unknown>)[key];
    if (key === 'lit') {
      return typeof val === 'string'
        ? { t: { type: 'string' }, depth }
        : refuse('lit takes a string', at);
    }
    if (key === 'int64') {
      return typeof val === 'string' && parseInt64(val) !== undefined
        ? { t: { type: 'int64' }, depth }
        : refuse(
            `int64 takes a decimal string within the int64 range, got ${JSON.stringify(val)}`,
            at
          );
    }
    const sig = SIGS.get(key);
    if (!sig) return refuse(`unknown function '${key}'`, at);
    if (!Array.isArray(val)) return refuse(`'${key}' takes an array of arguments`, at);

    const fnAt = [...at, key];
    let maxDepth = depth;
    const arg = (a: unknown, idx: number | string): Typed => {
      const r = walk(a, [...fnAt, String(idx)], depth + 1);
      maxDepth = Math.max(maxDepth, r.depth);
      return r.t;
    };
    const arity = (n: number | [number, number?]): void => {
      const [lo, hi] = Array.isArray(n) ? [n[0], n[1]] : [n, n];
      if (val.length < lo || (hi !== undefined && val.length > hi)) {
        refuse(
          `'${key}' takes ${hi === lo ? lo : `at least ${lo}`} argument(s), got ${val.length}`,
          fnAt
        );
      }
    };
    const result = (type: ExprType): { t: Typed; depth: number } => ({
      t: { type },
      depth: maxDepth
    });
    const where = (i: number) => [...fnAt, String(i)];

    if (key === 'case') {
      arity([2]);
      const branches: Typed[] = [];
      for (let i = 0; i < val.length - 1; i++) {
        const pair: unknown = val[i];
        if (!Array.isArray(pair) || pair.length !== 2)
          return refuse(`'case' branch ${i} must be [cond, then]`, where(i));
        need(arg(pair[0], `${i}.0`), 'boolean', `'case' condition ${i}`, where(i));
        branches.push(arg(pair[1], `${i}.1`));
      }
      branches.push(arg(val[val.length - 1], val.length - 1));
      return result(unify(branches, "'case' branches", fnAt));
    }
    if (key === 'coalesce') {
      arity([1]);
      return result(
        unify(
          val.map((a, i) => arg(a, i)),
          "'coalesce'",
          fnAt
        )
      );
    }
    if (key === 'in') {
      arity([2]);
      unify(
        val.map((a, i) => arg(a, i)),
        "'in'",
        fnAt
      );
      return result('boolean');
    }
    if (key === 'and' || key === 'or') {
      arity([1]);
      for (const [i, a] of val.entries()) need(arg(a, i), 'boolean', `'${key}'`, where(i));
      return result('boolean');
    }
    if (key === 'concat') {
      arity([1]);
      for (const [i, a] of val.entries()) need(arg(a, i), 'string', "'concat'", where(i));
      return result('string');
    }

    // Fixed signatures. Units and regex patterns must be literals.
    const kinds = sig.args as ArgType[];
    arity(kinds.length);
    const group: Typed[] = [];
    for (const [i, a] of val.entries()) {
      const kind = kinds[i] as ArgType;
      if (kind === 'unit' || kind === 'pattern' || kind === 'likePattern') {
        const text = lit(a as Expr, `'${key}' ${kind}`, where(i));
        checkDepth(depth + 1, where(i));
        count(where(i));
        if (kind === 'unit' && !(DATE_UNITS as readonly string[]).includes(text)) {
          refuse(`'${key}' unit '${text}' is not one of ${DATE_UNITS.join(', ')}`, where(i));
        }
        if (kind === 'likePattern' && endsWithEscape(text)) {
          refuse(LIKE_TRAILING_ESCAPE, where(i));
        }
        if (kind === 'pattern') {
          const why = checkRegexSubset(text);
          if (why) refuse(`'${key}' regex is outside the portable subset: ${why}`, where(i));
        }
        maxDepth = Math.max(maxDepth, depth + 1);
        continue;
      }
      const t = arg(a, i);
      // A safe-integer literal fills an int64 slot.
      if (kind !== 'any' && !(kind === 'int64' && t.intLiteral))
        need(t, kind, `'${key}' argument ${i}`, where(i));
      if (kind === 'any' || (kind === 'number' && sig.returns === 'any')) group.push(t);
    }
    if (sig.returns === 'any') return result(unify(group, `'${key}'`, fnAt));
    if (group.length > 1) unify(group, `'${key}'`, fnAt);
    return result(sig.returns);
  };

  try {
    const { t, depth } = walk(expr, path, 1);
    if (t.type === null) return refuse('cannot infer a type from null alone', path);
    return { ok: true, type: t.type, nodes, depth };
  } catch (e) {
    if (e instanceof Refusal)
      return { ok: false, code: 'expr_invalid', message: e.message, path: e.at };
    throw e;
  }
}

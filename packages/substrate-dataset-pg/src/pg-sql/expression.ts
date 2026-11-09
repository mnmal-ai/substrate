/**
 * Compiles a read-grammar `Expr` to a Postgres scalar expression that returns
 * what the memory evaluator (`evalExpr`) returns. Every literal is a bound
 * parameter; the only inlined constants are date units drawn from
 * `DATE_UNITS`. Types: number is float8, int64 bigint, string text, boolean
 * boolean, date timestamptz.
 */

import { DATE_UNITS, type Expr, type ExprType } from '@mnmal-ai/substrate-types';
import type { Sql, TransactionSql } from 'postgres';
import type { ColumnKind, TypeTable } from '../type-table.js';
import { type FieldAs, type Fragment, fieldExprSql } from './primitives.js';

export interface CompileCtx {
  table: TypeTable;
  alias: string;
  /** Group and aggregate names, which a bare string resolves to before a row field. */
  outputs?: Map<string, Fragment>;
  /** The type of a bare string a column does not declare (a pending field, an output). */
  fieldType?: (name: string) => ExprType | undefined;
}

type S = Sql | TransactionSql;

/** A compiled node. `bigint` is an int-literal's int64 form, used when it sits beside an int64. */
interface Node {
  f: Fragment;
  t: ExprType | null;
  bigint?: Fragment;
}

const KIND_TYPE: Record<ColumnKind, ExprType> = {
  text: 'string',
  enum: 'string',
  crossRef: 'string',
  number: 'number',
  int64: 'int64',
  date: 'date',
  boolean: 'boolean'
};
const AS: Record<ExprType, FieldAs> = {
  string: 'text',
  number: 'number',
  int64: 'int64',
  date: 'date',
  boolean: 'boolean'
};
const PG_TYPE: Record<ExprType, string> = {
  string: 'text',
  number: 'float8',
  int64: 'bigint',
  date: 'timestamptz',
  boolean: 'boolean'
};

/** The compiled expression and its type (`null` for a bare null literal). */
export function compileExprTyped(
  sql: S,
  expr: Expr,
  ctx: CompileCtx
): { fragment: Fragment; type: ExprType | null } {
  const u = (s: string): Fragment => sql.unsafe(s);
  const cast = (t: ExprType): string => PG_TYPE[t];
  /** `NULL` typed as `t`, for a slot that needs a type. */
  const nul = (t: ExprType): Fragment => u(`NULL::${cast(t)}`);
  /** `n` as type `t`: a null literal takes the type, int64 widens to float8. */
  const as = (n: Node, t: ExprType): Fragment =>
    n.t === null ? nul(t) : n.t === 'int64' && t === 'number' ? sql`(${n.f})::float8` : n.f;
  const join = (fs: Fragment[], op: string): Fragment[] => {
    const out: Fragment[] = [fs[0] as Fragment];
    for (const f of fs.slice(1)) out.push(u(op), f);
    return out;
  };
  const interleave = (fs: Fragment[], op: string): Fragment => sql`(${join(fs, op)})`;
  const isInt = (a: Node, b: Node): boolean =>
    (a.t === 'int64' && (b.t === 'int64' || b.bigint !== undefined)) ||
    (b.t === 'int64' && a.bigint !== undefined);
  const big = (n: Node): Fragment => (n.t === 'int64' ? n.f : (n.bigint as Fragment));
  /** `r` (a float8 expression over the columns x and y) when it is zero or within 1e-300..1e300, else NULL. */
  const inRange = (r: string): string =>
    `CASE WHEN ${r} = 0 OR abs(${r}) BETWEEN 1e-300 AND 1e300 THEN ${r} END`;
  /** `body` over the float8 operands x and y, each evaluated once. */
  const over = (x: Fragment, y: Fragment, body: string): Fragment =>
    sql`(SELECT ${u(body)} FROM (SELECT ${x} AS x, ${y} AS y OFFSET 0) o)`;

  /**
   * IEEE fmod, exactly: both doubles are split into integer mantissa and exponent (from their
   * bytes), reduced with numeric `mod` (exact on integers), and scaled back by powers of two.
   * A zero divisor, a non-finite operand or an out-of-range result is NULL.
   */
  const fmod = (x: Fragment, y: Fragment): Fragment => {
    // Exponent bits and mantissa bits of the double whose bytes are `b`.
    const bits = (b: string, p: string): string => `
      (get_byte(${b}, 0) & 127) * 16 + get_byte(${b}, 1) / 16 AS ${p}e,
      ((get_byte(${b}, 1) & 15)::bigint << 48) | (get_byte(${b}, 2)::bigint << 40)
        | (get_byte(${b}, 3)::bigint << 32) | (get_byte(${b}, 4)::bigint << 24)
        | (get_byte(${b}, 5)::bigint << 16) | (get_byte(${b}, 6)::bigint << 8)
        | get_byte(${b}, 7)::bigint AS ${p}f`;
    return sql`(SELECT ${u(inRange('v'))} FROM (SELECT
        CASE WHEN ye = 2047 OR xe = 2047 OR y = 0 THEN NULL ELSE
          CASE WHEN x < 0 THEN -1 ELSE 1 END *
          (CASE WHEN e >= 0 THEN r::float8 * power(2::float8, e)
                ELSE r::float8 / power(2::float8, least(-e, 1000)) / power(2::float8, -e - least(-e, 1000)) END)
        END AS v
        FROM (SELECT x, y, xe, ye, e,
            mod(xm::numeric * power(2::numeric, xx - e), NULLIF(ym::numeric * power(2::numeric, yx - e), 0)) AS r
          FROM (SELECT x, y, xe, ye, xm, ym, xx, yx, least(xx, yx) AS e
            FROM (SELECT x, y, xe, ye,
                xf + CASE WHEN xe = 0 THEN 0 ELSE 4503599627370496 END AS xm,
                yf + CASE WHEN ye = 0 THEN 0 ELSE 4503599627370496 END AS ym,
                CASE WHEN xe = 0 THEN -1074 ELSE xe - 1075 END AS xx,
                CASE WHEN ye = 0 THEN -1074 ELSE ye - 1075 END AS yx
              FROM (SELECT x, y, ${u(bits('bx', 'x'))}, ${u(bits('by', 'y'))}
                FROM (SELECT x, y, float8send(x) AS bx, float8send(y) AS by
                  FROM (SELECT ${x} AS x, ${y} AS y OFFSET 0) o) d) p) q) m) n) w)`;
  };

  const toDate = (n: Node): Fragment =>
    n.t === 'date' ? n.f : n.t === null ? nul('date') : sql`substrate_ts(to_jsonb((${n.f})::text))`;

  /** The type branches unify to, and each branch cast to it (an int64 beside a number widens). */
  const unifyAll = (ns: Node[]): { t: ExprType | null; fs: Fragment[] } => {
    const types = ns.map((n) => n.t).filter((t): t is ExprType => t !== null);
    const numeric_ = types.length > 0 && types.every((t) => t === 'number' || t === 'int64');
    const int =
      types.includes('int64') && ns.every((n) => n.t === 'int64' || n.t === null || n.bigint);
    const t: ExprType | null = !numeric_ ? (types[0] ?? null) : int ? 'int64' : 'number';
    return {
      t,
      fs: ns.map((n) =>
        t === null ? n.f : t === 'int64' && n.t !== 'int64' && n.bigint ? n.bigint : as(n, t)
      )
    };
  };

  const go = (e: Expr): Node => {
    if (e === null) return { f: u('NULL'), t: null };
    if (typeof e === 'boolean') return { f: sql`${e}::boolean`, t: 'boolean' };
    if (typeof e === 'number') {
      return {
        f: sql`${String(e)}::float8`,
        t: 'number',
        ...(Number.isSafeInteger(e) ? { bigint: sql`${String(e)}::bigint` } : {})
      };
    }
    if (typeof e === 'string') return field(e);
    if ('lit' in e) return { f: sql`${(e as { lit: string }).lit}::text`, t: 'string' };
    if ('int64' in e) return { f: sql`${(e as { int64: string }).int64}::bigint`, t: 'int64' };
    const key = Object.keys(e)[0] as string;
    return call(key, (e as Record<string, Expr[]>)[key] as Expr[]);
  };

  const field = (name: string): Node => {
    const out = ctx.outputs?.get(name);
    const col = ctx.table.column(name);
    const t = ctx.fieldType?.(name) ?? (col ? KIND_TYPE[col.kind] : undefined);
    if (t === undefined) throw new Error(`internal: no type for expression field '${name}'`);
    if (out !== undefined) return { f: out, t };
    const f = fieldExprSql(ctx.table, name, AS[t], ctx.alias);
    // shortcut: a promoting or extra number is numeric; the float8 cast raises past float8's range, widen if such values can be stored.
    return { f: u(t === 'number' ? `(${f})::float8` : f), t };
  };

  const call = (key: string, args: Expr[]): Node => {
    // A case's branch pairs are arrays, compiled in its own arm.
    const n = key === 'case' ? [] : args.map(go);
    const [a, b, c] = n as [Node, Node, Node];
    const bool = (f: Fragment): Node => ({ f, t: 'boolean' });
    const str = (f: Fragment): Node => ({ f, t: 'string' });
    const text = (x: Node): Fragment => (x.t === null ? nul('string') : x.f);
    const compare = (x: Node, y: Node, op: string): Fragment => {
      if (x.t === 'string' || y.t === 'string') {
        return sql`((${as(x, 'string')}) COLLATE "C" ${u(op)} (${as(y, 'string')}) COLLATE "C")`;
      }
      if (isInt(x, y)) return sql`(${big(x)} ${u(op)} ${big(y)})`;
      if (
        x.t !== null &&
        y.t !== null &&
        (x.t === 'int64') !== (y.t === 'int64') &&
        x.t !== 'date' &&
        y.t !== 'date' &&
        x.t !== 'boolean' &&
        y.t !== 'boolean'
      ) {
        // An int64 against a number compares exactly: float8 rounding is monotonic, so only a tie
        // (the bigint rounds to the double) needs the double read back as a bigint.
        const [i, d] = x.t === 'int64' ? [x, y] : [y, x];
        const flip = x.t === 'int64' ? '' : '-';
        return sql`(SELECT ${u(flip)}c ${u(op)} 0 FROM (SELECT CASE WHEN b IS NULL OR d IS NULL THEN NULL
          WHEN b::float8 < d THEN -1 WHEN b::float8 > d THEN 1 WHEN d >= 9223372036854775808 THEN -1
          WHEN b < d::bigint THEN -1 WHEN b > d::bigint THEN 1 ELSE 0 END AS c
          FROM (SELECT ${i.f} AS b, ${d.f} AS d OFFSET 0) j) k)`;
      }
      return sql`(${x.f} ${u(op)} ${y.f})`;
    };
    const cmp = (op: string): Node => bool(compare(a, b, op));

    switch (key) {
      case 'add':
      case 'sub':
      case 'mul':
      case 'mod': {
        const op = { add: '+', sub: '-', mul: '*', mod: '%' }[key] as string;
        const t: ExprType = isInt(a, b) ? 'int64' : 'number';
        if (a.t === null || b.t === null) return { f: nul(t), t };
        if (t === 'int64') {
          return {
            f:
              key === 'mod'
                ? sql`(${big(a)} % NULLIF(${big(b)}, 0))`
                : sql`(${big(a)} ${u(op)} ${big(b)})`,
            t
          };
        }
        const [x, y] = [as(a, 'number'), as(b, 'number')];
        // Each form computes only where float8 cannot raise: the guard bounds the operands, then the result is range-tested.
        if (key === 'mod') return { f: fmod(x, y), t };
        if (key === 'mul') {
          return {
            f: over(
              x,
              y,
              `CASE WHEN x = 0 OR y = 0 THEN x * y WHEN abs(ln(abs(x)) + ln(abs(y))) <= 692 THEN ${inRange('x * y')} END`
            ),
            t
          };
        }
        const same = key === 'add' ? '<=' : '>=';
        return {
          f: over(
            x,
            y,
            `CASE WHEN sign(x) * sign(y) ${same} 0 OR greatest(abs(x), abs(y)) <= 1e307 THEN ${inRange(`x ${op} y`)} END`
          ),
          t
        };
      }
      case 'div':
        if (a.t === null || b.t === null) return { f: nul('number'), t: 'number' };
        return {
          // The derive ratio guard: ln keeps x / y inside float8's range, where it cannot raise.
          f: sql`(SELECT CASE WHEN y = 0 THEN NULL WHEN x = 0 THEN x / y
            WHEN abs(ln(abs(x)) - ln(abs(y))) <= 692
            THEN CASE WHEN abs(x / y) BETWEEN 1e-300 AND 1e300 THEN x / y END END
            FROM (SELECT ${as(a, 'number')} AS x, ${as(b, 'number')} AS y OFFSET 0) d)`,
          t: 'number'
        };
      case 'neg':
        if (a.t === null) return { f: nul('number'), t: 'number' };
        if (a.t === 'int64') return { f: sql`(-(${a.f}))`, t: 'int64' };
        return {
          f: sql`(SELECT CASE WHEN x = 0 OR abs(x) BETWEEN 1e-300 AND 1e300 THEN -x END FROM (SELECT ${a.f} AS x OFFSET 0) g)`,
          t: 'number'
        };
      case 'eq':
        return cmp('=');
      case 'neq':
        return cmp('<>');
      case 'gt':
        return cmp('>');
      case 'gte':
        return cmp('>=');
      case 'lt':
        return cmp('<');
      case 'lte':
        return cmp('<=');
      case 'and':
      case 'or':
        return bool(
          interleave(
            n.map((x) => as(x, 'boolean')),
            key === 'and' ? ' AND ' : ' OR '
          )
        );
      case 'not':
        return bool(sql`(NOT ${as(a, 'boolean')})`);
      case 'isNull':
        return bool(sql`((${a.f}) IS NULL)`);
      case 'in': {
        const rest = n.slice(1);
        return bool(
          interleave(
            rest.map((r) => compare(a, r, '=')),
            ' OR '
          )
        );
      }
      case 'length':
        return { f: sql`char_length(${text(a)})::float8`, t: 'number' };
      // COLLATE "default": a "C" column would case-map ASCII only.
      case 'lower':
        return str(sql`lower((${text(a)}) COLLATE "default")`);
      case 'upper':
        return str(sql`upper((${text(a)}) COLLATE "default")`);
      case 'substring': {
        // Round half up, clamp into int4; a negative length is empty.
        const int = (x: Node, lo: number): Fragment =>
          sql`LEAST(GREATEST(floor(${as(x, 'number')} + 0.5), ${u(String(lo))}), 2147483647)::int`;
        return str(
          sql`substring(${text(a)} from ${int(b, -2147483648)} for GREATEST(${int(c, 0)}, 0))`
        );
      }
      case 'concat':
        return str(interleave(n.map(text), ' || '));
      case 'like':
      case 'notLike':
        // Postgres raises on a trailing escape only when matching reaches it, the evaluator whenever
        // both operands exist: probing `'x' LIKE '\'` (on a column, so it is not folded at plan time) makes it always.
        return bool(
          sql`(SELECT CASE WHEN s IS NOT NULL AND p ~ '(^|[^\\\\])(\\\\\\\\)*\\\\$' THEN ${u(key === 'like' ? '' : 'NOT ')}('x' LIKE right(p, 1) ESCAPE '\\')
            ELSE ${u(key === 'like' ? '' : 'NOT ')}(s LIKE p ESCAPE '\\') END
            FROM (SELECT ${text(a)} AS s, ${text(b)} AS p OFFSET 0) l)`
        );
      // Default collation: the regex classes follow the database ctype, as Postgres users expect.
      case 'regexpMatch':
        return bool(sql`((${text(a)}) COLLATE "default" ~ ${text(b)})`);
      case 'regexpReplace':
        return str(sql`regexp_replace(${text(a)}, ${text(b)}, ${text(c)})`);
      case 'dateTrunc':
      case 'extract': {
        const unit = (args[0] as { lit: string }).lit;
        if (!(DATE_UNITS as readonly string[]).includes(unit)) {
          throw new Error(`internal: '${unit}' is not a date unit`);
        }
        const d = sql`(${toDate(b)}) AT TIME ZONE 'UTC'`;
        return key === 'extract'
          ? { f: sql`extract(${u(unit)} FROM ${d})::float8`, t: 'number' }
          : { f: sql`(date_trunc(${u(`'${unit}'`)}, ${d}) AT TIME ZONE 'UTC')`, t: 'date' };
      }
      case 'case': {
        const branches = args
          .slice(0, -1)
          .map((p) => (p as unknown as Expr[]).map(go) as [Node, Node]);
        const els = go(args[args.length - 1] as Expr);
        const { t, fs } = unifyAll([...branches.map(([, th]) => th), els]);
        const parts: Fragment[] = [u('CASE')];
        branches.forEach(([cond], i) => {
          parts.push(u('WHEN'), as(cond, 'boolean'), u('THEN'), fs[i] as Fragment);
        });
        parts.push(u('ELSE'), fs[fs.length - 1] as Fragment, u('END'));
        return { f: sql`(${parts})`, t };
      }
      case 'coalesce': {
        const { t, fs } = unifyAll(n);
        return { f: sql`COALESCE(${join(fs, ',')})`, t };
      }
      default:
        throw new Error(`unknown function '${key}'`);
    }
  };

  const root = go(expr);
  return { fragment: root.f, type: root.t };
}

export function compileExpr(sql: S, expr: Expr, ctx: CompileCtx): Fragment {
  return compileExprTyped(sql, expr, ctx).fragment;
}

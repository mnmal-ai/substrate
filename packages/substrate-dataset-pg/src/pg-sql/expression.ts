/**
 * Compiles a read-grammar `Expr` to a Postgres scalar expression that returns
 * what the memory evaluator (`evalExpr`) returns. Every literal is a bound
 * parameter; the only inlined constants are date units drawn from
 * `DATE_UNITS`. Types: number is float8, int64 bigint, string text, boolean
 * boolean, date timestamptz.
 */

import { metadataExprType } from '@mnmal-ai/substrate-filter';
import { DATE_UNITS, type Expr, type ExprType } from '@mnmal-ai/substrate-types';
import type { Sql, TransactionSql } from 'postgres';
import type { ColumnKind, TypeTable } from '../type-table.js';
import { metadataColumnSql } from './predicates-metadata.js';
import { type FieldAs, type Fragment, fieldExprSql, type MetadataFieldName } from './primitives.js';

export interface CompileCtx {
  table: TypeTable;
  alias?: string;
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
  int32: 'int64',
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
    // createdAt, updatedAt and seq always mean the metadata column, as in where and orderBy.
    const meta = out === undefined ? metadataExprType(name) : undefined;
    if (meta !== undefined) {
      const c = u(metadataColumnSql(name as MetadataFieldName, ctx.alias));
      return meta === 'number' ? { f: sql`(${c})::float8`, t: meta } : { f: c, t: meta };
    }
    const t = ctx.fieldType?.(name) ?? (col ? KIND_TYPE[col.kind] : undefined);
    if (t === undefined) throw new Error(`internal: no type for expression field '${name}'`);
    // An aggregate such as count(*) is bigint; a number-typed output is float8, so division is not integer division.
    if (out !== undefined) return { f: t === 'number' ? sql`(${out})::float8` : out, t };
    const f = fieldExprSql(ctx.table, name, AS[t], ctx.alias);
    // shortcut: a promoting or extra number is numeric; the float8 cast raises past float8's range, widen if such values can be stored.
    // An int32 column widens to bigint, so its arithmetic is int64's.
    const wide = t === 'number' ? `(${f})::float8` : col?.kind === 'int32' ? `(${f})::bigint` : f;
    return { f: u(wide), t };
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
      return sql`(${x.f} ${u(op)} ${y.f})`;
    };
    const cmp = (op: string): Node => bool(compare(a, b, op));

    switch (key) {
      // float8 and bigint arithmetic as Postgres does it: overflow and underflow raise natively.
      case 'add':
      case 'sub':
      case 'mul': {
        const op = { add: '+', sub: '-', mul: '*' }[key] as string;
        const t: ExprType = isInt(a, b) ? 'int64' : 'number';
        if (a.t === null || b.t === null) return { f: nul(t), t };
        return t === 'int64'
          ? { f: sql`(${big(a)} ${u(op)} ${big(b)})`, t }
          : { f: sql`(${as(a, 'number')} ${u(op)} ${as(b, 'number')})`, t };
      }
      case 'mod':
        // int64 arguments only (the checker); a zero divisor is NULL.
        if (a.t === null || b.t === null) return { f: nul('int64'), t: 'int64' };
        return { f: sql`(${big(a)} % NULLIF(${big(b)}, 0))`, t: 'int64' };
      case 'div':
        if (a.t === null || b.t === null) return { f: nul('number'), t: 'number' };
        return {
          f: sql`(${as(a, 'number')} / NULLIF(${as(b, 'number')}, 0))`,
          t: 'number'
        };
      case 'neg':
        if (a.t === null) return { f: nul('number'), t: 'number' };
        return { f: sql`(-(${a.f}))`, t: a.t === 'int64' ? 'int64' : 'number' };
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
        // int64 beside number widens to float8 in the list, as the evaluator compares them.
        const rest = n.slice(1).map((r) => (a.t === 'int64' && r.bigint ? r.bigint : r.f));
        return bool(sql`(${a.f} IN (${join(rest, ',')}))`);
      }
      case 'length':
        return { f: sql`char_length(${text(a)})::float8`, t: 'number' };
      // COLLATE "C" maps ASCII letters only, as the evaluator does.
      case 'lower':
        return str(sql`lower((${text(a)}) COLLATE "C")`);
      case 'upper':
        return str(sql`upper((${text(a)}) COLLATE "C")`);
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
        // The checker holds the pattern to a literal that does not end in an escape; it binds as a parameter.
        return bool(
          sql`(${u(key === 'like' ? '' : 'NOT ')}(${text(a)} LIKE ${text(b)} ESCAPE '\\'))`
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

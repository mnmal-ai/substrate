/**
 * A grouped read as one statement:
 *
 *   SELECT … FROM (SELECT <keys>, <aggs> FROM T r JOIN… WHERE … GROUP BY 1, 2…) x
 *   WHERE <having> ORDER BY … LIMIT limit+1 OFFSET offset
 *
 * The inner select's `GROUP BY` names the keys by ordinal and everything after
 * it reads them as `x.k<i>` / `x.a<j>`: a key expression is never written
 * twice, because each copy of a literal is its own bind parameter and Postgres
 * would then not see them as one expression. The memory reference is
 * `@mnmal-ai/substrate-filter`'s `groupRows`.
 */
import {
  aggParts,
  aggType,
  canRaise,
  exprTypeOfField,
  metadataExprType
} from '@mnmal-ai/substrate-filter';
import type { Expr, ExprType, FieldDef, FrameAgg, OrderByClause } from '@mnmal-ai/substrate-types';
import type { Sql, TransactionSql } from 'postgres';
import type { TypeTable } from '../type-table.js';
import { exactNumeric } from './aggregate.js';
import { compileExprTyped } from './expression.js';
import { metadataColumnSql } from './predicates-metadata.js';
import { type Fragment, isMetadataField } from './primitives.js';

/** 2^1024 − 2^970, the least value float8 rounds to Infinity, as an exact numeric. */
const OVERFLOW = `${2n ** 1024n - 2n ** 970n}::numeric`;
/** 2^-1075, the greatest value float8 rounds to 0, as an exact numeric. */
const UNDERFLOW = `0.${(5n ** 1075n).toString().padStart(1075, '0')}::numeric`;

const MICROS = `'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'`;

export interface GroupedSpec {
  groupBy?: Record<string, Expr> | undefined;
  aggregate: Record<string, FrameAgg>;
  having?: Expr | undefined;
  orderBy?: OrderByClause[] | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}

export interface GroupedStatement {
  statement: Fragment;
  /** A result row as the group memory builds: int64 as bigint, dates as microsecond text. */
  decode: (row: Record<string, unknown>) => Record<string, unknown>;
}

type S = Sql | TransactionSql;

export function buildGroupedRead(
  sql: S,
  spec: GroupedSpec,
  matched: Fragment,
  joins: Fragment,
  table: TypeTable,
  fieldDef: (field: string) => FieldDef | undefined
): GroupedStatement {
  const u = (s: string): Fragment => sql.unsafe(s);
  const fieldType = (name: string) => exprTypeOfField(fieldDef(name));
  const compile = (e: Expr) =>
    compileExprTyped(sql, e, { table, alias: 'r', fieldType }) as {
      fragment: Fragment;
      type: ExprType | null;
    };
  const list = (fs: Fragment[]): Fragment => fs.reduce((a, b) => sql`${a}, ${b}`);

  const keys = Object.entries(spec.groupBy ?? {}).map(([name, e], i) => {
    const c = compile(e);
    // The validator refuses a key with no type.
    if (c.type === null) throw new Error(`internal: group key '${name}' has no type`);
    return { name, i, frag: c.fragment, type: c.type };
  });
  const aggs = Object.entries(spec.aggregate).map(([name, a], j) => {
    const { op, arg } = aggParts(a);
    const meta =
      typeof arg === 'string' && fieldType(arg) === undefined && isMetadataField(arg)
        ? metadataExprType(arg)
        : undefined;
    const c =
      arg === true && op === 'count'
        ? undefined
        : meta !== undefined
          ? {
              // seq is a bigint column; a number is float8.
              fragment: sql`${u(metadataColumnSql(arg as 'seq', 'r'))}${u(meta === 'number' ? '::float8' : '')}`,
              type: meta
            }
          : compile(arg);
    const t = c?.type ?? null;
    const f = c?.fragment as Fragment;
    // A bare number field keeps its stored decimal exactly; any other float8 goes through its shortest text.
    const text =
      typeof arg === 'string' && t === 'number'
        ? exactNumeric(sql, table, arg, 'r')
        : sql`(${f})::text::numeric`;
    let raw: Fragment;
    switch (op) {
      case 'count':
        raw = c === undefined ? sql`count(*)` : sql`count(${f})`;
        break;
      case 'countDistinct':
        raw = sql`count(DISTINCT ${f})`;
        break;
      case 'sum':
        // Todo #1809: float sums are exact in numeric, cast once to float8 below. An
        // int64 sum is range-checked here, in the fenced inner select, for every group.
        raw = t === 'int64' ? sql`sum(${f})::bigint` : sql`sum(${text})`;
        break;
      case 'avg':
        // float8(exact sum) / count: one correctly rounded conversion and one division, as memory.
        raw =
          t === 'int64'
            ? sql`sum(${f})::float8 / NULLIF(count(${f}), 0)::float8`
            : sql`avg(${text})`;
        break;
      default:
        raw = sql`${u(op)}(${t === 'string' ? sql`(${f}) COLLATE "C"` : f})`;
    }
    const type = aggType(op, t);
    const a_ = u(`x.a${j}`);
    // The value as an expression of `type`, for having.
    let typed: Fragment;
    if (op === 'count' || op === 'countDistinct') typed = sql`${a_}::float8`;
    else if (op === 'avg' || op === 'sum') typed = t === 'int64' ? a_ : floatOf(a_);
    else typed = a_;
    return { name, j, raw, typed, type, raises: (op === 'sum' && t === 'int64') || canRaise(arg) };
  });
  function floatOf(s: Fragment): Fragment {
    return sql`(CASE WHEN abs(${s}) >= ${u(OVERFLOW)} THEN NULL WHEN abs(${s}) <= ${u(UNDERFLOW)} THEN 0::float8 ELSE ${s}::float8 END)`;
  }

  // OFFSET 0 fences the subquery: having, order and limit read its columns, so no qual
  // reaches the Agg node ahead of the int64 range checks.
  const raises =
    aggs.some((a) => a.raises) ||
    Object.values(spec.groupBy ?? {}).some(canRaise) ||
    canRaise(spec.having);
  const grouped = sql`SELECT ${list([
    ...keys.map((k) => sql`${k.frag} AS ${u(`k${k.i}`)}`),
    ...aggs.map((a) => sql`${a.raw} AS ${u(`a${a.j}`)}`)
  ])} FROM ${u(table.from)} r${joins} WHERE ${matched}${
    keys.length === 0 ? sql`` : sql` GROUP BY ${u(keys.map((_, i) => i + 1).join(', '))}`
  } OFFSET 0`;
  // Anything that can raise (an int64 sum, arithmetic in an argument) must raise for every group.
  // A GroupAggregate under LIMIT stops pulling groups early, so a window over them all, in its own
  // select above the grouping (the planner would otherwise evaluate the range check above the
  // window), makes every group be produced first. The outer select names `w` too, since the
  // planner drops a subquery column nothing reads; decode ignores it.
  const inner = raises
    ? sql`SELECT y.*, count(*) OVER () AS w FROM (${grouped}) y OFFSET 0`
    : grouped;

  const outputs = new Map<string, Fragment>([
    ...keys.map((k) => [k.name, u(`x.k${k.i}`)] as const),
    ...aggs.map((a) => [a.name, a.typed] as const)
  ]);
  const types = new Map<string, ExprType>([
    ...keys.map((k) => [k.name, k.type] as const),
    ...aggs.map((a) => [a.name, a.type] as const)
  ]);
  const having =
    spec.having === undefined
      ? sql``
      : sql` WHERE ${
          compileExprTyped(sql, spec.having, {
            table,
            alias: 'r',
            outputs,
            fieldType: (n) => types.get(n)
          }).fragment
        }`;

  // An ordered name is a key or an aggregate: the value it returns, so a NULL sorts last.
  const col = new Map<string, Fragment>([
    ...keys.map((k) => [k.name, u(`x.k${k.i}`)] as const),
    ...aggs.map((a) => [a.name, a.typed] as const)
  ]);
  const order = [
    ...(spec.orderBy ?? []).map((c) => Object.entries(c)[0] as [string, 'asc' | 'desc']),
    ...keys.map((k) => [k.name, 'asc'] as [string, 'asc' | 'desc'])
  ].map(([name, dir]) => {
    const c = col.get(name);
    if (c === undefined) throw new Error(`internal: orderBy '${name}' names no output`);
    const text = types.get(name) === 'string' ? sql`${c} COLLATE "C"` : c;
    return sql`${text} ${u(dir === 'asc' ? 'ASC' : 'DESC')} NULLS LAST`;
  });

  const project = (frag: Fragment, type: ExprType): Fragment =>
    type === 'date'
      ? sql`to_char((${frag}) AT TIME ZONE 'UTC', ${u(MICROS)})`
      : type === 'int64'
        ? sql`(${frag})::text`
        : frag;
  const outs = [
    ...keys.map((k) => ({ name: k.name, type: k.type, frag: u(`x.k${k.i}`) })),
    ...aggs.map((a) => ({ name: a.name, type: a.type, frag: a.typed }))
  ];
  const limit = spec.limit === undefined ? sql`` : sql` LIMIT ${spec.limit + 1}`;
  const offset =
    spec.offset === undefined || spec.offset === 0 ? sql`` : sql` OFFSET ${spec.offset}`;
  const statement = sql`SELECT 1 AS g, ${list([
    ...outs.map((o, n) => sql`${project(o.frag, o.type)} AS ${u(`o${n}`)}`),
    ...(raises ? [sql`x.w`] : [])
  ])} FROM (${inner}) x${having}${
    order.length === 0 ? sql`` : sql` ORDER BY ${list(order)}`
  }${limit}${offset}`;

  return {
    statement,
    decode: (row) =>
      Object.fromEntries(
        outs.map((o, n) => {
          const v = row[`o${n}`] ?? null;
          return [o.name, o.type === 'int64' && v !== null ? BigInt(v as string) : v];
        })
      )
  };
}

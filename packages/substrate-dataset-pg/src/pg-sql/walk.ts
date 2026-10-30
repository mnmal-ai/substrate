/**
 * Typed edge walks in `where`, compiled to SQL (spec 2026-10-24-typed-edge-walks
 * §1, §3, §5). The memory dataset's evaluator (`@mnmal-ai/substrate-filter`
 * walk.ts) is the reference; these fragments answer the same rows:
 *
 * - a hop follows the crossRef value in the row BODY: inbound through the
 *   eager crossRef index expression, outbound through the far row's id;
 * - every far row is pinned to its namespace and type (partition pruning) and
 *   must be live;
 * - `any` → EXISTS, `none` → NOT EXISTS, `all` → NOT EXISTS of a neighbour
 *   whose predicate IS NOT TRUE, `pick` → the one neighbour of a LATERAL
 *   `ORDER BY … NULLS LAST, id LIMIT 1`;
 * - the `any` walks with `as` in one AND group are ONE EXISTS over all their
 *   rows, so they are jointly quantified;
 * - a `$ref` comparison is never true when either side is NULL, eq and neq
 *   included; numbers compare as float8 (IEEE double, as JS does).
 *
 * The tree is assumed validated (substrate-core walk-validator).
 */

import { groupConjuncts, refNames } from '@mnmal-ai/substrate-filter';
import {
  type FieldDef,
  type RefOperand,
  ResolverFrameError,
  UnsupportedFilterError,
  WALK_UNSUPPORTED_REF,
  type WalkNode,
  type WhereClause
} from '@mnmal-ai/substrate-types';
import type { Sql, TransactionSql } from 'postgres';
import { metadataColumnSql } from './predicates-metadata.js';
import {
  type BodyOrderByCast,
  bodyNum,
  bodyRawText,
  bodyText,
  bodyTs,
  combineAnd,
  type Fragment,
  indexExpressionSql,
  isMetadataField,
  type PromotedColumnLookup,
  qualifier,
  sqlStringLiteral
} from './primitives.js';
import { resolveBodyOrderByCast } from './sorting.js';
import { buildWhere } from './where.js';

/** Where a where clause is being compiled: whose row it filters and which walk rows are bound. */
export interface WalkScope {
  namespace: string;
  /** The alias of the row this clause filters. */
  alias: string;
  type: string;
  /** The frame's seed row, named `$` by a `$ref`. */
  seedAlias: string;
  seedType: string;
  /** Rows bound by enclosing or sibling `any` walks' `as`. */
  bindings: ReadonlyMap<string, { alias: string; type: string }>;
  /** A fresh table alias, unique within the statement. */
  nextAlias(): string;
  fieldDef(type: string, field: string): FieldDef | undefined;
}

/** The scope of a read's top-level where, over `type` rows aliased `alias`. */
export function walkScope(
  namespace: string,
  type: string,
  alias: string,
  fieldDef: (type: string, field: string) => FieldDef | undefined
): WalkScope {
  let n = 0;
  return {
    namespace,
    alias,
    type,
    seedAlias: alias,
    seedType: type,
    bindings: new Map(),
    nextAlias: () => `w${++n}`,
    fieldDef
  };
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** True when `where` uses the walk grammar (`_walk`, `_agg` or a `$ref` operand) anywhere. */
export function whereUsesWalks(where: unknown): boolean {
  if (Array.isArray(where)) return where.some(whereUsesWalks);
  if (!isObj(where)) return false;
  return Object.entries(where).some(
    ([k, v]) => k === '_walk' || k === '_agg' || k === '$ref' || whereUsesWalks(v)
  );
}

const castFor =
  (scope: WalkScope, type: string) =>
  (field: string): BodyOrderByCast | null =>
    resolveBodyOrderByCast(scope.fieldDef(type, field));

/**
 * The far type of one hop from `scope`'s row, and the condition that pins the
 * far row `alias` to it: namespace, type, live, and the crossRef join.
 */
function hop(
  sql: Sql | TransactionSql,
  node: { in?: string; out?: string },
  scope: WalkScope,
  alias: string
): { type: string; cond: Fragment } {
  let type: string;
  let join: Fragment;
  const near = qualifier(scope.alias);
  if (node.in !== undefined) {
    const m = /^[^/]+\/([^./]+)\.(.+)$/.exec(node.in);
    if (m === null)
      throw new Error(`internal: walk 'in' '${node.in}' is not '<ns>/<Type>.<field>'`);
    const [, farType, field] = m as unknown as [string, string, string];
    type = farType;
    // Verbatim the eager crossRef index's key, so the index serves the hop.
    join = sql.unsafe(
      `${indexExpressionSql('text', field, alias)} = (${near}id::text COLLATE "C")`
    );
  } else {
    const field = node.out ?? '';
    const def = scope.fieldDef(scope.type, field);
    if (def?.kind !== 'crossRef') {
      throw new Error(`internal: walk 'out' '${field}' is not a crossRef on '${scope.type}'`);
    }
    type = def.type;
    join = sql`${sql.unsafe(`${qualifier(alias)}id::text`)} = ${bodyRawText(sql, [field], scope.alias)}`;
  }
  const far = qualifier(alias);
  // A walk never leaves the frame's namespace (the validator refuses it), so
  // the far row is pinned to the dataset's, as the memory reference reads it.
  return {
    type,
    cond: sql`${sql.unsafe(
      `${far}namespace = ${sqlStringLiteral(scope.namespace)} AND ${far}type = ${sqlStringLiteral(type)} AND ${far}deleted_at IS NULL`
    )} AND ${join}`
  };
}

/** A walk without `as` (any, none, all or pick), under the current bindings. */
export function buildWalk(
  sql: Sql | TransactionSql,
  node: WalkNode,
  promotedFor: PromotedColumnLookup,
  scope: WalkScope
): Fragment {
  const alias = scope.nextAlias();
  const a = sql.unsafe(alias);
  const { type, cond } = hop(sql, node, scope, alias);
  const far =
    node.where === undefined
      ? null
      : buildWhere(sql, node.where, castFor(scope, type), promotedFor, { ...scope, alias, type });
  if (node.pick !== undefined) {
    const [dir, field] = Object.entries(node.pick)[0] as [string, string];
    const key = sortKey(sql, field, castFor(scope, type)(field), alias);
    const order = sql.unsafe(dir === 'min' ? 'ASC NULLS LAST' : 'DESC NULLS LAST');
    return sql`EXISTS (SELECT 1 FROM LATERAL (SELECT ${a}.* FROM rows ${a} WHERE ${cond} ORDER BY ${key} ${order}, ${a}.id COLLATE "C" ASC LIMIT 1) ${a}${far === null ? sql`` : sql` WHERE ${far}`})`;
  }
  const rows = sql`SELECT 1 FROM rows ${a} WHERE ${cond}`;
  switch (node.quantifier ?? 'any') {
    case 'none':
      return sql`NOT EXISTS (${rows}${far === null ? sql`` : sql` AND ${far}`})`;
    case 'all':
      // A neighbour whose predicate is NULL fails it, as in memory.
      return far === null ? sql`TRUE` : sql`NOT EXISTS (${rows} AND (${far}) IS NOT TRUE)`;
    default:
      return sql`EXISTS (${rows}${far === null ? sql`` : sql` AND ${far}`})`;
  }
}

/** A pick's ordering key: an instant for a date, a number for a number. */
function sortKey(
  sql: Sql | TransactionSql,
  field: string,
  cast: BodyOrderByCast | null,
  alias: string
): Fragment {
  if (isMetadataField(field)) return sql.unsafe(metadataColumnSql(field, alias));
  if (cast === 'numeric') return bodyNum(sql, [field], alias);
  if (cast === 'timestamptz') return bodyTs(sql, [field], alias);
  return bodyText(sql, [field], alias);
}

/**
 * An AND group whose `any` walks with `as` are jointly quantified: one EXISTS
 * with a `rows` alias per binding, holding each binding's hop and where and
 * every conjunct that reads a binding. Conjuncts that read none stay outside,
 * where they constrain the outer row directly (∃b: A ∧ P(b) ≡ A ∧ ∃b: P(b)).
 */
export function buildGroup(
  sql: Sql | TransactionSql,
  where: WhereClause,
  rowCastFor: (field: string) => BodyOrderByCast | null,
  promotedFor: PromotedColumnLookup,
  scope: WalkScope
): Fragment | null {
  // The memory reference's own grouping, so the two quantify the same bindings jointly.
  const { binds, items } = groupConjuncts(where);

  const bindings = new Map(scope.bindings);
  const hops = binds.map((node) => {
    const alias = scope.nextAlias();
    const h = hop(sql, node, scope, alias);
    bindings.set(node.as as string, { alias, type: h.type });
    return { node, alias, ...h };
  });
  const group: WalkScope = { ...scope, bindings };
  const inside: Fragment[] = hops.map((h) => h.cond);
  for (const h of hops) {
    if (h.node.where === undefined) continue;
    const f = buildWhere(sql, h.node.where, castFor(scope, h.type), promotedFor, {
      ...group,
      alias: h.alias,
      type: h.type
    });
    if (f !== null) inside.push(f);
  }
  const names = new Set(binds.map((b) => b.as));
  const outside: Fragment[] = [];
  for (const item of items) {
    const bound = [...refNames(item)].some((n) => names.has(n));
    const f = buildWhere(sql, item, rowCastFor, promotedFor, bound ? group : scope);
    if (f !== null) (bound ? inside : outside).push(f);
  }
  const from = sql.unsafe(hops.map((h) => `rows ${h.alias}`).join(', '));
  outside.push(sql`EXISTS (SELECT 1 FROM ${from} WHERE ${combineAnd(sql, inside)})`);
  return combineAnd(sql, outside);
}

/** The value a `$ref` comparison reads from `field` of `alias`'s row, by kind. */
function refValue(
  sql: Sql | TransactionSql,
  field: string,
  kind: 'number' | 'date',
  alias: string
): Fragment {
  if (isMetadataField(field)) {
    const col = metadataColumnSql(field, alias);
    return sql.unsafe(kind === 'number' ? `${col}::float8` : col);
  }
  return kind === 'number'
    ? sql`${bodyNum(sql, [field], alias)}::float8`
    : bodyTs(sql, [field], alias);
}

/**
 * `field <op> $ref`, never NULL and true only when both sides are present:
 * a null `$ref` matches nothing, eq and neq included. `neq` is true for an
 * absent or unreadable `field` against a present `$ref`, as memory's
 * `!equals` is. Numbers are float8 on both sides with `times`/`plus`
 * inlined; a date shifts by `plus` milliseconds, to the microsecond.
 */
export function buildRefCompare(
  sql: Sql | TransactionSql,
  field: string,
  op: string,
  ref: RefOperand,
  rowCastFor: (field: string) => BodyOrderByCast | null,
  scope: WalkScope
): Fragment {
  const cast = isMetadataField(field)
    ? field === 'seq'
      ? 'numeric'
      : field === 'createdAt' || field === 'updatedAt'
        ? 'timestamptz'
        : null
    : rowCastFor(field);
  if (cast !== 'numeric' && cast !== 'timestamptz') {
    throw new UnsupportedFilterError(field, op, 'a $ref compares number or date fields');
  }
  const kind = cast === 'numeric' ? 'number' : 'date';
  const dot = ref.$ref.indexOf('.');
  const name = ref.$ref.slice(0, dot);
  const refField = ref.$ref.slice(dot + 1);
  if (name === '_agg') {
    throw new ResolverFrameError(
      WALK_UNSUPPORTED_REF,
      `$ref '${ref.$ref}' is not yet supported on pg`
    );
  }
  const target =
    name === '$' ? { alias: scope.seedAlias, type: scope.seedType } : scope.bindings.get(name);
  if (dot < 0 || target === undefined) {
    throw new UnsupportedFilterError(field, op, `$ref '${ref.$ref}' names no binding in scope`);
  }
  const left = refValue(sql, field, kind, scope.alias);
  let right = refValue(sql, refField, kind, target.alias);
  // `'<n>'::float8`, inlined: only a finite number reaches the text.
  const lit = (n: unknown): Fragment => {
    if (typeof n !== 'number' || !Number.isFinite(n)) {
      throw new UnsupportedFilterError(field, op, '$ref times and plus must be finite numbers');
    }
    return sql.unsafe(`'${String(n)}'::float8`);
  };
  if (kind === 'number') {
    if (ref.times !== undefined) right = sql`${right} * ${lit(ref.times)}`;
    if (ref.plus !== undefined) right = sql`${right} + ${lit(ref.plus)}`;
    right = sql`(${right})`;
  } else {
    if (ref.times !== undefined) {
      throw new UnsupportedFilterError(field, op, "a date $ref takes 'plus', not 'times'");
    }
    if (ref.plus !== undefined) lit(ref.plus);
    // As memory: the shift is `plus` ms rounded to whole microseconds.
    const micros = ref.plus === undefined ? 0 : Math.round(ref.plus * 1000);
    if (micros !== 0)
      right = sql`(${right} + ${sql.unsafe(`(${micros})`)} * interval '1 microsecond')`;
  }
  const cmp = (o: string): Fragment =>
    sql`(${left} IS NOT NULL AND ${right} IS NOT NULL AND ${left} ${sql.unsafe(o)} ${right})`;
  switch (op) {
    case 'eq':
      return cmp('=');
    case 'neq':
      return sql`(${right} IS NOT NULL AND NOT (${left} IS NOT NULL AND ${left} = ${right}))`;
    case 'gt':
      return cmp('>');
    case 'gte':
      return cmp('>=');
    case 'lt':
      return cmp('<');
    case 'lte':
      return cmp('<=');
    default:
      throw new UnsupportedFilterError(
        field,
        op,
        'a $ref operand is allowed on eq, neq, gt, gte, lt and lte'
      );
  }
}

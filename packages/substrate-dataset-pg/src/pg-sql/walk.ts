/**
 * Typed edge walks in `where`, compiled to SQL (spec 2026-10-24-typed-edge-walks
 * §1, §3, §5). The memory dataset's evaluator (`@mnmal-ai/substrate-filter`
 * walk.ts) is the reference; these fragments answer the same rows:
 *
 * - a hop follows the crossRef value in the row (its column on a type table,
 *   else its BODY or `extra` key): inbound through the eager crossRef index
 *   expression, outbound through the far row's id;
 * - every far row is read from its type's table (`scope.tableFor`), pinned to
 *   its namespace and type there on `rows` (partition pruning), and must be live;
 * - `any` → EXISTS, `none` → NOT EXISTS, `all` → NOT EXISTS of a neighbour
 *   whose predicate IS NOT TRUE, `pick` → the one neighbour `firstRow`
 *   finds by index probes;
 * - the `any` walks with `as` in one AND group are ONE EXISTS over all their
 *   rows, so they are jointly quantified;
 * - a `$ref` comparison is never true when either side is NULL, eq and neq
 *   included; numbers compare as float8 (IEEE double, as JS does).
 *
 * The tree is assumed validated (substrate-core walk-validator).
 */

import {
  forEachWalkHop,
  groupConjuncts,
  refNames,
  sharedPicks,
  whereUsesWalks
} from '@mnmal-ai/substrate-filter';
import {
  type FieldDef,
  type RefOperand,
  UnsupportedFilterError,
  type WalkNode,
  type WhereClause
} from '@mnmal-ai/substrate-types';
import type { Sql, TransactionSql } from 'postgres';
import type { TypeTable } from '../type-table.js';
import { metadataColumnSql } from './predicates-metadata.js';
import {
  type BodyOrderByCast,
  bodyInt64,
  bodyNum,
  bodyText,
  bodyTs,
  columnOrderExpr,
  combineAnd,
  type Fragment,
  fieldExpr,
  fieldExprSql,
  isMetadataField,
  qualifier
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
  /**
   * The table of `type` in this namespace. Synchronous, since the compiler
   * cannot await: the caller preloads the seed and every far type
   * ({@link walkTypes}) and this throws on a type it was not given (F19).
   */
  tableFor(type: string): TypeTable;
  /** The frame's `_agg` value `name` for the seed row, as jsonb, read by `_agg.<name>` operands. */
  aggValue?: (name: string) => Fragment;
  /** The direction of `key` in a full index on `type` keyed `(crossRef, key, …)`, when one is declared. */
  indexDir?: (type: string, crossRef: string, key: string) => 'asc' | 'desc' | undefined;
  /** Statement-level CTEs every statement of the read starts with (`WITH …`), shared by all seeds. */
  ctes?: Fragment[];
  /** Per-hub picks (#1815): a hub walk, and each of its picks' CTE, keyed `__hub`. */
  hubPicks?: Map<WalkNode, Array<{ pick: WalkNode; cte: string }>>;
  /** Group-by windows (#1815): the CTE of a frame `_agg` window, by `windowKey`. */
  windows?: Map<string, string>;
}

/** A hop and where, as JSON: the walks and aggregates over one window share it. */
export const windowKey = (node: { in?: string; out?: string; where?: unknown }): string =>
  JSON.stringify([node.in, node.out, node.where]);

/** `WITH …` for the read's CTEs, or nothing. */
export function withCtes(sql: Sql | TransactionSql, scope: WalkScope | undefined): Fragment {
  const ctes = scope?.ctes ?? [];
  if (ctes.length === 0) return sql``;
  return sql`WITH ${ctes.reduce((a, b) => sql`${a}, ${b}`)} `;
}

/** The scope of a read's top-level where, over `type` rows aliased `alias`. */
export function walkScope(
  namespace: string,
  type: string,
  alias: string,
  fieldDef: (type: string, field: string) => FieldDef | undefined,
  tableFor: (type: string) => TypeTable
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
    fieldDef,
    tableFor
  };
}

/** A map lookup over `tables` by type, which throws on a type it does not hold (F19). */
export function tableLookup(tables: readonly TypeTable[]): (type: string) => TypeTable {
  const byType = new Map(tables.map((t) => [t.type, t]));
  return (type) => {
    const t = byType.get(type);
    if (t === undefined) throw new Error(`internal: no type table was preloaded for '${type}'`);
    return t;
  };
}

/** The far type of hop `node` from a `near` row, or undefined when it names none. */
export function farTypeOf(
  node: { in?: string; out?: string },
  near: string,
  fieldDef: (type: string, field: string) => FieldDef | undefined
): string | undefined {
  if (node.in !== undefined) return /^[^/]+\/([^./]+)\./.exec(node.in)?.[1];
  const def = fieldDef(near, node.out ?? '');
  return def?.kind === 'crossRef' ? def.type : undefined;
}

/**
 * The seed and every type a read's walks reach (where, frame `agg`, nested, at
 * any depth): the types `tableFor` must be given before compiling (F19). The
 * hops are substrate-filter's `forEachWalkHop`, which substrate-core's walk
 * sites and walked types share. A hop naming no type is left to `hop`, which
 * refuses it.
 */
export function walkTypes(
  params: { where?: unknown; agg?: unknown; nested?: unknown },
  seed: string,
  fieldDef: (type: string, field: string) => FieldDef | undefined
): Set<string> {
  const types = new Set([seed]);
  // The frame entry these params were split from: nested selections and `_agg` under `fields`.
  const fields = { ...(isObj(params.nested) ? params.nested : {}), _agg: params.agg };
  forEachWalkHop({ params: { where: params.where }, fields }, seed, ({ node }, near) => {
    const far = farTypeOf(node as { in?: string; out?: string }, near, fieldDef);
    if (far !== undefined) types.add(far);
    return far;
  });
  return types;
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const castFor =
  (scope: WalkScope, type: string) =>
  (field: string): BodyOrderByCast | null =>
    resolveBodyOrderByCast(scope.fieldDef(type, field));

/**
 * The far type of one hop from `scope`'s row (whose table is `near`), the
 * table `from` its rows are read FROM, and the condition that pins the far row
 * `alias` to it: namespace and type on `rows`, live, and the crossRef join.
 */
export function hop(
  sql: Sql | TransactionSql,
  node: { in?: string; out?: string },
  scope: WalkScope,
  alias: string,
  near: TypeTable
): { type: string; from: string; cond: Fragment; via?: string; pin: Fragment } {
  let type: string;
  let via: string | undefined;
  let join: Fragment;
  if (node.in !== undefined) {
    const m = /^[^/]+\/([^./]+)\.(.+)$/.exec(node.in);
    if (m === null)
      throw new Error(`internal: walk 'in' '${node.in}' is not '<ns>/<Type>.<field>'`);
    const [, farType, field] = m as unknown as [string, string, string];
    type = farType;
    via = field;
    // Verbatim the eager crossRef index's key, so the index serves the hop. A
    // crossRef column has `id`'s collation, so it joins bare.
    const farTable = scope.tableFor(type);
    const nearId =
      farTable.column(field) === undefined
        ? `(${qualifier(scope.alias)}id::text COLLATE "C")`
        : `${qualifier(scope.alias)}id`;
    join = sql.unsafe(`${fieldExprSql(farTable, field, 'text', alias)} = ${nearId}`);
  } else {
    const field = node.out ?? '';
    const def = scope.fieldDef(scope.type, field);
    if (def?.kind !== 'crossRef') {
      throw new Error(`internal: walk 'out' '${field}' is not a crossRef on '${scope.type}'`);
    }
    type = def.type;
    // Uncollated, as `id` is, so the far id's index serves it; a crossRef column joins bare.
    const farId = `${qualifier(alias)}id${near.column(field) === undefined ? '::text' : ''}`;
    join = sql`${sql.unsafe(farId)} = ${fieldExpr(sql, near, field, 'rawText', scope.alias)}`;
  }
  const table = scope.tableFor(type);
  // A walk never leaves the frame's namespace (the validator refuses it), so
  // the far row is pinned to the dataset's, as the memory reference reads it.
  const pin: Fragment = sql`${sql.unsafe(`${qualifier(alias)}deleted_at IS NULL`)}`;
  return {
    type,
    from: table.from,
    ...(via === undefined ? {} : { via }),
    pin,
    cond: sql`${pin} AND ${join}`
  };
}

/** A walk without `as` (any, none, all or pick), under the current bindings. */
export function buildWalk(
  sql: Sql | TransactionSql,
  node: WalkNode,
  table: TypeTable,
  scope: WalkScope
): Fragment {
  const shared = scope.hubPicks?.get(node);
  if (shared !== undefined) return buildHubWalk(sql, node, shared, table, scope);
  const window =
    node.pick === undefined &&
    (node.quantifier ?? 'any') === 'any' &&
    scope.alias === scope.seedAlias
      ? scope.windows?.get(windowKey(node))
      : undefined;
  if (window !== undefined) {
    // The window's keys are exactly the seeds with a neighbour in it (null keys left out).
    return sql`(${sql.unsafe(`${qualifier(scope.alias)}id::text COLLATE "C"`)}) IN (SELECT __k FROM ${sql.unsafe(window)})`;
  }
  const alias = scope.nextAlias();
  const a = sql.unsafe(alias);
  const { type, from, cond } = hop(sql, node, scope, alias, table);
  const farTable = scope.tableFor(type);
  const far =
    node.where === undefined
      ? null
      : buildWhere(sql, node.where, castFor(scope, type), farTable, { ...scope, alias, type });
  if (node.pick !== undefined) {
    const [dir, field] = Object.entries(node.pick)[0] as [string, string];
    const key = sortKey(sql, farTable, field, castFor(scope, type)(field), alias);
    // Correlated on the lateral `h`, so firstRow's in-order, non-parallel Append still holds.
    const picked = firstRow(
      sql,
      sql`${a}.*`,
      from,
      alias,
      amongCond(sql, node, cond, farTable, { ...scope, alias, type }),
      key,
      dir === 'min' ? 'ASC' : 'DESC'
    );
    return sql`EXISTS (SELECT 1 FROM (${picked}) ${a}${far === null ? sql`` : sql` WHERE ${far}`})`;
  }
  const rows = sql`SELECT 1 FROM ${sql.unsafe(from)} ${a} WHERE ${cond}`;
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

/** A pick's candidate condition: the hop's `cond`, AND its `among` compiled over the far row (#1810). */
function amongCond(
  sql: Sql | TransactionSql,
  node: WalkNode,
  cond: Fragment,
  farTable: TypeTable,
  far: WalkScope
): Fragment {
  if (node.among === undefined) return cond;
  const among = buildWhere(sql, node.among, castFor(far, far.type), farTable, far);
  return among === null ? cond : sql`${cond} AND ${among}`;
}

/** True when a `pick` walk sits anywhere in `where`. */
const holdsPick = (where: unknown): boolean =>
  Array.isArray(where)
    ? where.some(holdsPick)
    : isObj(where) &&
      Object.entries(where).some(
        ([k, v]) => (k === '_walk' && isObj(v) && v.pick !== undefined) || holdsPick(v)
      );

/**
 * A hub walk's where, split for the per-hub form: `own` reads only the hub row
 * (no `$ref` of any kind, so neither `$`, a bind nor `_agg`) and is tested
 * once per hub in the CTE; `rest` (the binds and what reads `$` or a bind) is
 * tested per seed. The shared picks, which have their CTEs, are in neither.
 */
function splitHubWhere(
  node: WalkNode,
  picks: ReadonlySet<WalkNode>
): { own: WhereClause[]; rest: WhereClause[] } {
  const { binds, items } = groupConjuncts(node.where);
  const others = items.filter((i) => !picks.has((i as { _walk?: WalkNode })._walk as WalkNode));
  return {
    own: others.filter((i) => refNames(i).size === 0),
    rest: [
      ...binds.map((b) => ({ _walk: b }) as WhereClause),
      ...others.filter((i) => refNames(i).size > 0)
    ]
  };
}

/** The seeds a read's CTEs may narrow to: its own clauses (scope, `ids`, live), and whether `ids` is among them. */
export interface SeedBase {
  clauses: Fragment[];
  ids: boolean;
}

/**
 * A filter every matching seed (alias `scope.seedAlias`) passes: `base` and
 * each top-level conjunct of `where` but those `skip` names, the `as` binds
 * and the conjuncts that read them (a bind is quantified jointly, so alone
 * it is no conjunct). Walks and `_agg` comparisons included, so a selective
 * one narrows a CTE as it narrows the read. Compiled without the shared
 * forms, so no CTE reads another. A conjunct holding a `pick` (so any shared
 * hub walk) is left out too: compiled per seed it would probe once per seed
 * inside the CTE, the cost the shared form exists to avoid. Leaving out a
 * conjunct only widens the superset. `narrows`: anything beyond the type's rows.
 */
export function seedFilter(
  sql: Sql | TransactionSql,
  where: WhereClause | undefined,
  base: SeedBase,
  rowCastFor: (field: string) => BodyOrderByCast | null,
  table: TypeTable,
  scope: WalkScope,
  skip: (item: WhereClause) => boolean
): { filter: Fragment; narrows: boolean } {
  const { binds, items } = groupConjuncts(where);
  const bound = new Set(binds.map((b) => b.as));
  const { hubPicks: _p, windows: _w, ...plain } = scope;
  const parts = items
    .filter((i) => !skip(i) && !holdsPick(i) && ![...refNames(i)].some((n) => bound.has(n)))
    .flatMap((i) => buildWhere(sql, i, rowCastFor, table, plain) ?? []);
  return {
    filter: combineAnd(sql, [...base.clauses, ...parts]),
    narrows: base.ids || parts.length > 0
  };
}

/**
 * Registers the read's per-hub picks (#1815, `sharedPicks` holds the rule)
 * and returns the LEFT JOINs the statement reading the seeds' where must
 * carry. Each pick is a CTE of every distinct hub the seeds reach (those
 * passing every other top-level conjunct, `seedFilter`: a superset of the
 * hubs any matching seed reaches) whose hub row exists and whose pick
 * passes the pick's seed-independent conjuncts (no `_walk`, `_agg` or
 * `$ref`, e.g. `soldAt >= since`), with that picked row, keyed `__hub`.
 *
 * The CTE exports only `__hub` and `__row` (the picked row as one `rows`
 * value), so its columns can never collide with the seed row's unqualified
 * ones (`id`, `body`) in the statement that joins it.
 *
 * The seeds read it through `LEFT JOIN pick ON __hub = <seed's hub>`, a
 * join pg can hash: never a correlated EXISTS over the CTE, which pg may
 * nest-loop and so rescan once per seed (it cannot estimate jsonb seed
 * filters, so it may think there are few). At most one CTE row per hub, so
 * the join never multiplies a seed. Each conjunct is evaluated once: the
 * seed-independent ones in the CTE, the rest (reading `$`) per seed.
 *
 * Inside the CTE a hub is probed only when some neighbour passes those
 * conjuncts (pg may answer that from the far side's range index or by a
 * probe per hub), and only a pick that passes them is kept. Both drop only
 * hubs whose seeds fail the pick's where anyway.
 */
export function prepareSharedPicks(
  sql: Sql | TransactionSql,
  params: { where?: WhereClause; count?: boolean; aggregate?: unknown; limit?: number },
  base: SeedBase,
  rowCastFor: (field: string) => BodyOrderByCast | null,
  table: TypeTable,
  scope: WalkScope
): Fragment {
  const picks = sharedPicks(params);
  let joins = sql``;
  if (picks.size === 0) return joins;
  scope.hubPicks ??= new Map();
  scope.ctes ??= [];
  const sharedOf = (hub: WalkNode) =>
    new Set([...picks].filter(([, h]) => h === hub).map(([p]) => p));
  const { hubPicks: _p, windows: _w, ...plain } = scope;
  for (const [pick, hub] of picks) {
    const hubType = scope.fieldDef(scope.seedType, hub.out as string);
    if (hubType?.kind !== 'crossRef') continue;
    const { filter } = seedFilter(
      sql,
      params.where,
      base,
      rowCastFor,
      table,
      scope,
      (i) => (i as { _walk?: WalkNode })._walk === hub
    );
    const hubScope: WalkScope = { ...scope, alias: 'h', type: hubType.type };
    const hubTable = scope.tableFor(hubType.type);
    const alias = scope.nextAlias();
    const a = sql.unsafe(alias);
    const cte = `pick_${alias}`;
    const { type, from, cond } = hop(sql, pick, hubScope, alias, hubTable);
    const farTable = scope.tableFor(type);
    const [dir, field] = Object.entries(pick.pick ?? {})[0] as [string, string];
    const key = sortKey(sql, farTable, field, castFor(scope, type)(field), alias);
    // Correlated on the lateral `h`, so firstRow's in-order, non-parallel Append still holds.
    // The picked row also as one `rows` value, `__row`: the CTE exports only `__`-named
    // columns, so none can collide with the seed row's unqualified columns in the main query.
    const picked = firstRow(
      sql,
      sql`${a}.*, ${a} AS __row`,
      from,
      alias,
      amongCond(sql, pick, cond, farTable, { ...hubScope, alias, type }),
      key,
      dir === 'min' ? 'ASC' : 'DESC'
    );
    // Uncollated, so the hub row's id index serves the join below.
    const hubOf = fieldExpr(sql, table, hub.out as string, 'rawText', scope.seedAlias);
    const hubs = sql`SELECT DISTINCT ${hubOf} AS id FROM ${sql.unsafe(table.from)} ${sql.unsafe(scope.seedAlias)} WHERE ${filter}`;
    const own = groupConjuncts(pick.where).items.filter((i) => !whereUsesWalks(i));
    const farWhere = (at: string): Fragment | null =>
      own.length === 0
        ? null
        : buildWhere(sql, { AND: own }, castFor(scope, type), farTable, {
            ...hubScope,
            alias: at,
            type
          });
    const kept = farWhere(alias);
    const filters: Fragment[] = [];
    if (kept !== null) {
      const f = scope.nextAlias();
      filters.push(
        sql`EXISTS (SELECT 1 FROM ${sql.unsafe(from)} ${sql.unsafe(f)} WHERE ${hop(sql, pick, hubScope, f, hubTable).cond} AND ${farWhere(f) as Fragment})`,
        kept
      );
    }
    // The hub row itself, live and of its type: the hub walk's own hop, once per hub.
    const hb = scope.nextAlias();
    const live = hop(sql, hub, { ...scope, alias: scope.seedAlias }, hb, table).pin;
    const on: Fragment[] = [live, sql.unsafe(`${hb}.id::text = h.id`)];
    // The hub where's own conjuncts, once per hub, in the hub's first CTE.
    if (scope.hubPicks.get(hub) === undefined) {
      const { own } = splitHubWhere(hub, sharedOf(hub));
      if (own.length > 0) {
        const f = buildWhere(sql, { AND: own }, castFor(scope, hubType.type), hubTable, {
          ...plain,
          alias: hb,
          type: hubType.type
        });
        if (f !== null) on.push(f);
      }
    }
    const hubRow = sql`JOIN ${sql.unsafe(hubTable.from)} ${sql.unsafe(hb)} ON ${combineAnd(sql, on)}`;
    const where = filters.length === 0 ? sql`` : sql` WHERE ${combineAnd(sql, filters)}`;
    scope.ctes.push(
      sql`${sql.unsafe(cte)} AS MATERIALIZED (SELECT h.id AS __hub, ${a}.__row AS __row FROM (${hubs}) h ${hubRow} CROSS JOIN LATERAL (${picked}) ${a}${where})`
    );
    joins = sql`${joins} LEFT JOIN ${sql.unsafe(cte)} ON ${sql.unsafe(`${cte}.__hub = `)}${hubOf}`;
    scope.hubPicks.set(hub, [...(scope.hubPicks.get(hub) ?? []), { pick, cte }]);
  }
  return joins;
}

/**
 * A hub walk with per-hub picks among its where's conjuncts, read from the
 * picks' CTEs the statement LEFT JOINs (see `prepareSharedPicks`): each
 * pick's row is present (so is the hub row, it passes the hub where's own
 * conjuncts, and the pick passes its seed-independent ones) and passes the
 * rest of its where, which reads `$`. The hub where's conjuncts that read `$`
 * or a bind, if any, are one EXISTS on the hub row. Same rows: an outbound hop reaches at most one hub row (its id), so
 * ∃h: A(h) ∧ ∃p ∈ pick(h): P(p) ≡ (∃h: A(h)) ∧ (∃h: ∃p ∈ pick(h): P(p)),
 * since each pick is an AND conjunct of an `any` walk. Two-valued (`IS
 * TRUE`), as the EXISTS was.
 */
function buildHubWalk(
  sql: Sql | TransactionSql,
  node: WalkNode,
  shared: Array<{ pick: WalkNode; cte: string }>,
  table: TypeTable,
  scope: WalkScope
): Fragment {
  const hubType = hop(sql, node, scope, 'x', table).type;
  const near: WalkScope = { ...scope, type: hubType };
  const parts: Fragment[] = [];
  for (const { pick, cte } of shared) {
    parts.push(sql.unsafe(`${cte}.__hub IS NOT NULL`));
    const pickType = hop(sql, pick, near, 'x', scope.tableFor(hubType)).type;
    // The seed-independent conjuncts were applied in the CTE; the rest are read here, over
    // the picked row expanded from `__row` (one row, never a scan of the CTE).
    const { binds, items } = groupConjuncts(pick.where);
    const rest = [
      ...binds.map((b) => ({ _walk: b }) as WhereClause),
      ...items.filter((i) => whereUsesWalks(i))
    ];
    if (rest.length === 0) continue;
    const p = scope.nextAlias();
    const f = buildWhere(sql, { AND: rest }, castFor(scope, pickType), scope.tableFor(pickType), {
      ...near,
      alias: p,
      type: pickType
    });
    if (f === null) continue;
    parts.push(
      sql`EXISTS (SELECT 1 FROM (SELECT (${sql.unsafe(cte)}.__row).*) ${sql.unsafe(p)} WHERE ${f})`
    );
  }
  // The hub where's own conjuncts were applied in its first CTE; the rest read `$` or a bind.
  const { rest } = splitHubWhere(node, new Set(shared.map((s) => s.pick)));
  if (rest.length > 0) {
    const alias = scope.nextAlias();
    const { type, from, cond } = hop(sql, node, scope, alias, table);
    const f = buildWhere(sql, { AND: rest }, castFor(scope, type), scope.tableFor(type), {
      ...scope,
      alias,
      type
    });
    parts.push(
      sql`EXISTS (SELECT 1 FROM ${sql.unsafe(from)} ${sql.unsafe(alias)} WHERE ${f === null ? cond : sql`${cond} AND ${f}`})`
    );
  }
  return sql`(${combineAnd(sql, parts)} IS TRUE)`;
}

/**
 * `select` of the first `alias` row of table `from` passing `where` by `key` in `dir`, nulls
 * last, ties id ascending: at most one row. Not `ORDER BY key … LIMIT 1`,
 * which only an index in exactly that direction serves: min/max(key) is an
 * index probe in either direction, then the rows at that key are fetched by
 * it, and only when no key is present (and `nullable`), the least id with a
 * null key. The subquery repeats `where` under the same alias, shadowing the
 * outer row; `where` is so written out three times, with its parameters,
 * which compounds per nesting level (bounded by walk depth, far below pg's
 * 65,535-parameter cap).
 */
export function firstRow(
  sql: Sql | TransactionSql,
  select: Fragment,
  from: string,
  alias: string,
  where: Fragment,
  key: Fragment,
  dir: 'ASC' | 'DESC',
  nullable = true
): Fragment {
  const a = sql.unsafe(alias);
  const t = sql.unsafe(from);
  const best = sql.unsafe(dir === 'ASC' ? 'min' : 'max');
  const byId = sql.unsafe(`ORDER BY ${alias}.id COLLATE "C" ASC LIMIT 1`);
  const keyed = sql`SELECT ${select} FROM ${t} ${a} WHERE ${where} AND ${key} = (SELECT ${best}(${key}) FROM ${t} ${a} WHERE ${where}) ${byId}`;
  if (!nullable) return keyed;
  // Invariant: the null branch answers only when the keyed one is empty, because a
  // non-parallel Append runs its children in order under LIMIT 1. `where` is always
  // correlated (the hop), which keeps this subplan non-parallel; keep it so.
  return sql`(${keyed}) UNION ALL (SELECT ${select} FROM ${t} ${a} WHERE ${where} AND ${key} IS NULL ${byId}) LIMIT 1`;
}

/** A pick's ordering key, of `table`'s row `alias`: an instant for a date, a number for a number. */
export function sortKey(
  sql: Sql | TransactionSql,
  table: TypeTable,
  field: string,
  cast: BodyOrderByCast | null,
  alias: string
): Fragment {
  if (isMetadataField(field)) {
    // Text columns sort by byte order, as the main read's sortExpr and memory do.
    const col = metadataColumnSql(field, alias);
    const ordered = field === 'createdAt' || field === 'updatedAt' || field === 'seq';
    return sql.unsafe(ordered ? col : `${col} COLLATE "C"`);
  }
  const column = table.column(field);
  if (column !== undefined) return columnOrderExpr(sql, table, column, alias);
  if (cast === 'numeric') return bodyNum(sql, [field], alias, table.jsonb);
  if (cast === 'bigint') return bodyInt64(sql, [field], alias, table.jsonb);
  if (cast === 'timestamptz') return bodyTs(sql, [field], alias, table.jsonb);
  return bodyText(sql, [field], alias, table.jsonb);
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
  table: TypeTable,
  scope: WalkScope
): Fragment | null {
  // The memory reference's own grouping, so the two quantify the same bindings jointly.
  const { binds, items } = groupConjuncts(where);

  const bindings = new Map(scope.bindings);
  const hops = binds.map((node) => {
    const alias = scope.nextAlias();
    const h = hop(sql, node, scope, alias, table);
    bindings.set(node.as as string, { alias, type: h.type });
    return { node, alias, ...h };
  });
  const group: WalkScope = { ...scope, bindings };
  const inside: Fragment[] = hops.map((h) => h.cond);
  for (const h of hops) {
    if (h.node.where === undefined) continue;
    const f = buildWhere(sql, h.node.where, castFor(scope, h.type), scope.tableFor(h.type), {
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
    const f = buildWhere(sql, item, rowCastFor, table, bound ? group : scope);
    if (f !== null) (bound ? inside : outside).push(f);
  }
  const from = sql.unsafe(hops.map((h) => `${h.from} ${h.alias}`).join(', '));
  outside.push(sql`EXISTS (SELECT 1 FROM ${from} WHERE ${combineAnd(sql, inside)})`);
  return combineAnd(sql, outside);
}

/** The value a `$ref` comparison reads from `field` of `table`'s row `alias`, by kind. */
export function refValue(
  sql: Sql | TransactionSql,
  table: TypeTable,
  field: string,
  kind: 'number' | 'date',
  alias: string
): Fragment {
  if (isMetadataField(field)) {
    const col = metadataColumnSql(field, alias);
    return sql.unsafe(kind === 'number' ? `${col}::float8` : col);
  }
  return kind === 'number'
    ? sql`${fieldExpr(sql, table, field, 'number', alias)}::float8`
    : fieldExpr(sql, table, field, 'date', alias);
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
  const right = refOperand(sql, field, op, ref, kind, scope);
  return compareRef(
    sql,
    field,
    op,
    refValue(sql, scope.tableFor(scope.type), field, kind, scope.alias),
    right,
    refIsCostly(ref)
  );
}

/** A `$ref` operand that compiles to a subquery (an _agg, or guarded arithmetic), so is read once. */
export const refIsCostly = (ref: RefOperand): boolean =>
  ref.$ref.startsWith('_agg.') || ref.times !== undefined || ref.plus !== undefined;

/**
 * A `$ref` operand's value, typed by `kind`: `$.f` reads the seed, `<as>.f` a
 * binding, `_agg.<name>` the frame's aggregate for the seed row. Numbers are
 * float8 with `times`/`plus` inlined; a date shifts by `plus` milliseconds,
 * to the microsecond. NULL where memory's `resolveRef` is null.
 */
export function refOperand(
  sql: Sql | TransactionSql,
  field: string,
  op: string,
  ref: RefOperand,
  kind: 'number' | 'date',
  scope: WalkScope
): Fragment {
  const dot = ref.$ref.indexOf('.');
  const name = ref.$ref.slice(0, dot);
  const refField = ref.$ref.slice(dot + 1);
  let right: Fragment;
  if (name === '_agg') {
    if (scope.aggValue === undefined) {
      throw new UnsupportedFilterError(field, op, `$ref '${ref.$ref}' names no _agg in this frame`);
    }
    const v = scope.aggValue(refField);
    right = kind === 'number' ? sql`substrate_num(${v})::float8` : sql`substrate_ts(${v})`;
  } else {
    const target =
      name === '$' ? { alias: scope.seedAlias, type: scope.seedType } : scope.bindings.get(name);
    if (dot < 0 || target === undefined) {
      throw new UnsupportedFilterError(field, op, `$ref '${ref.$ref}' names no binding in scope`);
    }
    right = refValue(sql, scope.tableFor(target.type), refField, kind, target.alias);
  }
  if (kind === 'number') {
    // Todo #1809, as memory's resolveRef: a product or sum that would be
    // non-finite, or a nonzero product that underflows to 0, is NULL, which
    // no comparison matches. float8 raises on each, so the operand is checked
    // against the exact double bound past which it would, and `times`/`plus`
    // are literals, so the bound is found here in the same IEEE arithmetic.
    // The operand is read once, as `rv`; the guards nest, so none is skipped.
    if (ref.times === undefined && ref.plus === undefined) return sql`(${right})`;
    const guards: Fragment[] = [];
    let value: Fragment = sql`rv`;
    if (ref.times !== undefined) {
      const m = Math.abs(ref.times);
      if (m > 1) {
        const hi = float8Lit(
          sql,
          field,
          op,
          largest((x) => Number.isFinite(x * m))
        );
        guards.push(sql`abs(rv) <= ${hi}`);
      } else if (m > 0 && m < 1) {
        const lo = float8Lit(sql, field, op, nextUp(largest((x) => x * m === 0)));
        guards.push(sql`rv = 0 OR abs(rv) >= ${lo}`);
      }
      value = sql`rv * ${float8Lit(sql, field, op, ref.times)}`;
    }
    if (ref.plus !== undefined) {
      const p = ref.plus;
      const edge = float8Lit(
        sql,
        field,
        op,
        largest((x) => Number.isFinite(x + Math.abs(p)))
      );
      guards.push(p >= 0 ? sql`${value} <= ${edge}` : sql`${value} >= -${edge}`);
      value = sql`${value} + ${float8Lit(sql, field, op, p)}`;
    }
    const guarded = guards.reduceRight<Fragment>(
      (inner, g) => sql`CASE WHEN ${g} THEN ${inner} END`,
      value
    );
    return sql`(SELECT ${guarded} FROM (SELECT ${right} AS rv OFFSET 0) ref_g)`;
  }
  if (ref.times !== undefined) {
    throw new UnsupportedFilterError(field, op, "a date $ref takes 'plus', not 'times'");
  }
  if (ref.plus !== undefined) float8Lit(sql, field, op, ref.plus);
  // As memory: the shift is `plus` ms rounded to whole microseconds.
  const micros = ref.plus === undefined ? 0 : Math.round(ref.plus * 1000);
  return micros === 0
    ? right
    : sql`(${right} + ${sql.unsafe(`(${micros})`)} * interval '1 microsecond')`;
}

const f64 = new Float64Array(1);
const u64 = new BigUint64Array(f64.buffer);
function bitsOf(x: number): bigint {
  f64[0] = x;
  return u64[0] as bigint;
}
function fromBits(b: bigint): number {
  u64[0] = b;
  return f64[0] as number;
}
const nextUp = (x: number): number => fromBits(bitsOf(x) + 1n);

/** The largest double in [0, MAX_VALUE] passing `ok`, which holds at 0 and fails past one point. */
function largest(ok: (x: number) => boolean): number {
  let lo = 0n; // passes
  let hi = bitsOf(Number.MAX_VALUE) + 1n; // +Infinity: fails or lies past the range
  while (hi - lo > 1n) {
    const mid = (lo + hi) / 2n;
    if (ok(fromBits(mid))) lo = mid;
    else hi = mid;
  }
  return fromBits(lo);
}

/** `'<n>'::float8`, inlined: only a finite number reaches the text. */
export function float8Lit(
  sql: Sql | TransactionSql,
  field: string,
  op: string,
  n: unknown
): Fragment {
  if (typeof n !== 'number' || !Number.isFinite(n)) {
    throw new UnsupportedFilterError(field, op, 'numeric operands must be finite numbers');
  }
  return sql.unsafe(`'${String(n)}'::float8`);
}

/**
 * `left <op> right`, never NULL and true only when both sides are present;
 * `neq` is true for a NULL `left` against a present `right`, as memory's
 * `!equals` is. `once` reads `right` once, through a subquery, for an
 * operand too costly to repeat.
 */
export function compareRef(
  sql: Sql | TransactionSql,
  field: string,
  op: string,
  left: Fragment,
  right: Fragment,
  once = false
): Fragment {
  if (once) {
    const inner = compareRef(sql, field, op, left, sql`cv`);
    return sql`(SELECT ${inner} FROM (SELECT ${right} AS cv OFFSET 0) cmp_g)`;
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

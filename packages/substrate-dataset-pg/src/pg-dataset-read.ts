/** `PgDataset.read`: one attempt at a read, as SQL, and the rows it answers. */

import {
  applyExtensionResultMeta,
  decodeCursor,
  type ExtensionOpResultMeta,
  encodeCursor,
  exprTypeOfField,
  fieldRequested,
  type preResolveExtensionOperatorsDetailed,
  type TypeRef,
  walkAggExprType,
  whereUsesWalks
} from '@mnmal-ai/substrate-filter';
import type {
  Expr,
  ExprType,
  FieldDef,
  ReadParams,
  ReadResult,
  Row
} from '@mnmal-ai/substrate-types';
import {
  ResolverFrameError,
  UnsupportedFilterError,
  VALUE_OUT_OF_RANGE
} from '@mnmal-ai/substrate-types';
import type { PendingQuery, Row as PgRow } from 'postgres';
import { desiredIndexKeys } from './index-reconciler.js';
import { castFor, indexArgs, type PgContext } from './pg-dataset-context.js';
import { materialize, type TableRowRecord } from './pg-dataset-row.js';
import {
  buildFrameCount,
  buildWalkAgg,
  buildWalkColumns,
  decodeInt64,
  int64Plan,
  mergeWalkColumns,
  prepareWindows
} from './pg-sql/aggregate.js';
import { compileExprTyped } from './pg-sql/expression.js';
import { buildGroupedRead } from './pg-sql/grouped.js';
import { sqlStringLiteral } from './pg-sql/primitives.js';
import type { ComputedLookup } from './pg-sql/sorting.js';
import {
  prepareSharedPicks,
  tableLookup,
  type WalkScope,
  walkScope,
  walkTypes,
  withCtes
} from './pg-sql/walk.js';
import {
  buildCursorCompare,
  buildCursorNullTail,
  buildOrderBy,
  buildProjectedOrderBy,
  buildRowProjection,
  buildSortKeyProjection,
  buildWhere,
  combineAnd,
  type Fragment,
  idToText,
  normalizeOrderBy,
  readsRowMetadata,
  readsShortId,
  whereReferencesField
} from './pg-sql.js';
import { absentTypeTable, type TypeTable } from './type-table.js';
import { guardedRead, type ReadGuardEntry } from './write-rows.js';

/** {@link preResolveExtensionOperatorsDetailed}, as a read's attempts share it. */
export type ResolveWhere = typeof preResolveExtensionOperatorsDetailed;

/** A read whose statement found one of its tables past the version it was built for. */
export class StaleRead {
  constructor(
    readonly types: readonly TypeRef[],
    /** The transaction's isolation level, as the statement saw it. */
    readonly iso: string
  ) {}
}

/** Rows materialised between event-loop yields on a read (a few ms of work). */
const MATERIALIZE_BATCH_ROWS = 5000;

/** The params that run under the statement timeout: `count: true`, and each non-empty object. */
function walkParams(params: ReadParams): string[] {
  const used = (['aggregate', 'agg', 'nested', 'select'] as const).filter((k) => {
    const v = params[k];
    return typeof v === 'object' && v !== null && Object.keys(v).length > 0;
  });
  return params.count === true ? ['count', ...used] : used;
}

/** True when a read uses the walk grammar: in its where, or a walk-only param. */
export function usesWalkGrammar(params: ReadParams): boolean {
  return whereUsesWalks(params.where) || walkParams(params).length > 0;
}

/** Awaits `query`, cancelling the statement in flight when `signal` aborts. */
export async function cancellable<T extends readonly (PgRow | undefined)[]>(
  query: PendingQuery<T>,
  signal: AbortSignal | undefined
): Promise<T> {
  try {
    return await query.signal(signal);
  } catch (err) {
    // pg reports its own cancel as 57014; surface the caller's reason instead.
    if (signal?.aborted === true) signal.throwIfAborted();
    throw err;
  }
}

/** Runs a read's statement and returns its rows; a stale read throws {@link StaleRead}. */
type RunGuarded = <R extends object>(statement: Fragment, key: keyof R) => Promise<R[]>;

/** A type's declared field, by the namespace that declares it. */
type FieldDefOf = (t: TypeRef, f: string) => FieldDef | undefined;

/** A walk read's count or whole-result aggregate, which returns no rows and ignores any cursor. */
async function readWholeResult(
  sql: PgContext['sql'],
  params: ReadParams,
  limit: number | undefined,
  matched: Fragment,
  pickJoins: Fragment,
  table: TypeTable,
  scope: WalkScope,
  fieldDef: (field: string) => FieldDef | undefined,
  run: RunGuarded
): Promise<ReadResult> {
  if (params.count === true) {
    const [row] = await run<{ n: number }>(
      sql`${withCtes(sql, scope)}${buildFrameCount(sql, matched, scope, pickJoins)}`,
      'n'
    );
    return { rows: [], hasMore: false, count: row?.n ?? 0 };
  }
  const aggregate = params.aggregate ?? {};
  const grouped = buildGroupedRead(
    sql,
    { ...params, aggregate, limit },
    matched,
    pickJoins,
    table,
    fieldDef,
    scope
  );
  const rows = await run<{ g: number } & Record<string, unknown>>(
    sql`${withCtes(sql, scope)}${grouped.statement}`,
    'g'
  );
  const truncated = limit !== undefined && rows.length > limit;
  const page = truncated ? rows.slice(0, limit) : rows;
  return {
    rows: [],
    hasMore: false,
    groups: page.map(grouped.decode),
    ...(truncated ? { truncated: true } : {})
  };
}

/** A read's `select`: each entry's SQL and the type its value reads as. */
interface CompiledSelect {
  selectEntries: Array<[string, Expr]>;
  selectFragments: Map<string, Fragment>;
  selectTypes: Map<string, ExprType>;
}

/**
 * `select` expressions, compiled once: each is a column of the page, and an
 * orderBy key by its name. A string sorts by byte order, as memory's.
 */
function compileSelect(
  sql: PgContext['sql'],
  params: ReadParams,
  seed: TypeRef,
  fieldDef: FieldDefOf,
  table: TypeTable,
  scope: WalkScope | undefined
): CompiledSelect {
  const frameAggs = params.agg;
  const selectEntries = Object.entries(params.select ?? {});
  const selectFragments = new Map<string, Fragment>();
  const selectTypes = new Map<string, ExprType>();
  if (selectEntries.length > 0) {
    const used = JSON.stringify(params.select);
    const outputs = new Map<string, Fragment>();
    const aggTypes = new Map<string, ExprType>();
    for (const [name, spec] of Object.entries(frameAggs ?? {})) {
      const t = walkAggExprType(spec, seed, fieldDef);
      if (!used.includes(`"_agg.${name}"`) || t === undefined || scope?.aggValue === undefined) {
        continue;
      }
      // The aggregate is a jsonb value; read it as the type the evaluator reads it as.
      const v = scope.aggValue(name);
      outputs.set(
        `_agg.${name}`,
        t === 'number'
          ? sql`substrate_num(${v})::float8`
          : t === 'date'
            ? sql`substrate_ts(${v})`
            : sql`(${v}) #>> '{}'`
      );
      aggTypes.set(`_agg.${name}`, t);
    }
    const fieldType = (name: string) => aggTypes.get(name) ?? exprTypeOfField(fieldDef(seed, name));
    for (const [name, expr] of selectEntries) {
      const { fragment, type: t } = compileExprTyped(sql, expr, {
        table,
        alias: 'r',
        outputs,
        fieldType
      });
      selectFragments.set(name, fragment);
      selectTypes.set(name, t ?? 'string');
    }
  }
  return { selectEntries, selectFragments, selectTypes };
}

/**
 * A page's records as the read's result: each row materialised, the page cut
 * to `limit`, and the cursor to the next one when there is more.
 */
async function pageResult({
  ctx,
  type,
  params,
  rows,
  table,
  walk,
  seed,
  fieldDef,
  select: { selectEntries, selectTypes },
  limit,
  orderBy,
  sortKeyAliases,
  extMeta
}: {
  ctx: PgContext;
  type: string;
  params: ReadParams;
  /** One past `limit` when there is a further page. */
  rows: TableRowRecord[];
  table: TypeTable;
  walk: ReturnType<typeof buildWalkColumns>;
  seed: TypeRef;
  fieldDef: FieldDefOf;
  select: CompiledSelect;
  limit: number | undefined;
  orderBy: ReturnType<typeof normalizeOrderBy>;
  sortKeyAliases: ReturnType<typeof buildSortKeyProjection>['aliases'];
  extMeta: ExtensionOpResultMeta | null;
}): Promise<ReadResult> {
  const frameAggs = params.agg;
  const fields = ctx.typeDefLookup?.(type, ctx.namespace)?.fields;
  const orders = new Map<string, string[]>();
  // An int64 `_agg` value or nested-row field is a decimal string in the jsonb; the row holds a bigint, as memory's.
  const int64 = int64Plan(frameAggs, params.nested, seed, fieldDef);
  const materialised: Row[] = new Array(rows.length);
  for (let i = 0; i < rows.length; i++) {
    // A large read yields between batches, so other requests are not held behind it.
    if (i > 0 && i % MATERIALIZE_BATCH_ROWS === 0)
      await new Promise<void>((resolve) => setImmediate(resolve));
    const r = rows[i] as TableRowRecord;
    const row = materialize(
      walk === null ? r : mergeWalkColumns(r, walk.columns, orders),
      fields,
      table,
      params.fields
    );
    if (int64 !== undefined) decodeInt64(row, int64);
    for (const [k, [name]] of selectEntries.entries()) {
      const v = (r as unknown as Record<string, unknown>)[`__sel_${k}`];
      row[name] =
        v === null || v === undefined
          ? null
          : selectTypes.get(name) === 'int64'
            ? BigInt(v as string)
            : v;
    }
    materialised[i] = row;
  }
  let hasMore = false;
  let sliced = materialised;
  if (limit !== undefined && materialised.length > limit) {
    hasMore = true;
    sliced = materialised.slice(0, limit);
  }

  const out: ReadResult = { rows: sliced, hasMore };
  const last = sliced[sliced.length - 1];
  // `materialised` is `rows.map(...)`, so index i of one is index i of the
  // other — the raw record is where the projected sort keys live.
  const lastRaw = rows[sliced.length - 1] as Record<string, unknown> | undefined;
  if (hasMore && last !== undefined) {
    out.nextCursor = encodeCursor({
      // Read from the projected `__sort_<n>` keys, never the materialized
      // row, which carries only what the caller projected.
      orderByValues: orderBy
        .filter(([f]) => f !== 'id')
        .map(([field]) => {
          const alias = sortKeyAliases.get(field);
          return alias === undefined ? null : (lastRaw?.[alias] ?? null);
        }),
      id: last.id,
      order: orderBy
    });
  }

  // Relevance reorder applies only when the caller gave no orderBy; test
  // params.orderBy, since the normalized one always has an id tiebreaker.
  if (extMeta !== null) {
    out.rows = applyExtensionResultMeta(out.rows, extMeta, {
      hasExplicitOrderBy: params.orderBy !== undefined && params.orderBy.length > 0,
      fields: params.fields
    });
  }
  return out;
}

export async function readOnce(
  ctx: PgContext,
  type: string,
  params: ReadParams,
  walks: boolean,
  resolveWhere: ResolveWhere
): Promise<ReadResult> {
  const sql = ctx.sql;
  const includeDeleted = params.includeDeleted === true;

  const limit =
    typeof params.limit === 'number' && Number.isFinite(params.limit) && params.limit >= 0
      ? Math.floor(params.limit)
      : undefined;

  params.signal?.throwIfAborted();
  // Fast path: limit === 0 returns empty without hitting the db. A count or
  // whole-result aggregate still answers, as memory's does.
  const wholeResult = params.count === true || params.aggregate !== undefined;
  if (limit === 0 && !wholeResult) return { rows: [], hasMore: false };

  const idList: string[] = [];
  let hasIdFilter = false;
  if (params.id !== undefined) {
    idList.push(idToText(params.id));
    hasIdFilter = true;
  }
  if (params.ids !== undefined) {
    for (const id of params.ids) idList.push(idToText(id));
    hasIdFilter = true;
  }

  // The compiler cannot await, so the seed's and every far type's table is
  // loaded first (F19), each from its own namespace. A type with no table
  // yet reads as an empty one.
  const lookup = ctx.fieldDefLookup;
  const seed = { ns: ctx.namespace, type };
  // A far namespace's fields by that namespace's definitions only, and none without them.
  const fieldDef = (t: TypeRef, f: string) =>
    t.ns === ctx.namespace ? lookup?.(t.type, f) : ctx.fieldDefLookupFor?.(t.ns)(t.type, f);
  const types = walks ? walkTypes(params, seed, fieldDef) : [seed];
  // Without far definitions a crossing walk would cast far fields blind: refuse it.
  const away =
    ctx.fieldDefLookupFor === null ? types.find((t) => t.ns !== ctx.namespace) : undefined;
  if (away !== undefined) {
    throw new UnsupportedFilterError(
      `${away.ns}/${away.type}`,
      '_walk',
      `crosses into namespace '${away.ns}', and this dataset has no fieldDefLookupFor to type its fields`
    );
  }
  const loaded = await Promise.all(types.map((t) => ctx.tableFor(t.type, t.ns, true)));
  const tableFor = tableLookup(types.map((t, i) => loaded[i] ?? absentTypeTable(t.ns, t.type)));
  const table = tableFor(seed);
  // Each statement checks every descriptor it decodes through (M3); an
  // unmigrated store has no catalog to check, and no table to read.
  const guard: ReadGuardEntry[] | null =
    (await ctx.layout()) === 'absent'
      ? null
      : types.map((t, i) => ({
          namespace: t.ns,
          type: t.type,
          version: loaded[i]?.version ?? null
        }));
  /** `statement`'s rows, but those of a stale read, which throw {@link StaleRead}; `key` is non-null on a real row. */
  const run = async <R extends object>(statement: Fragment, key: keyof R): Promise<R[]> => {
    try {
      if (guard === null) return (await cancellable(statement, params.signal)) as unknown as R[];
      const out = await cancellable(guardedRead(sql, guard, statement), params.signal);
      if (out[0]?.guard_ok !== true) throw new StaleRead(types, String(out[0]?.guard_iso));
      return out.filter((r) => r[key as string] !== null) as unknown as R[];
    } catch (err) {
      // 22003: an int64 sum or an expression left its type's range, as memory's RangeError.
      if ((err as { code?: unknown } | null)?.code === '22003') {
        throw new ResolverFrameError(VALUE_OUT_OF_RANGE, (err as Error).message);
      }
      throw err;
    }
  };

  // Build WHERE fragment incrementally. Use table alias `r` to avoid
  // ambiguity with the short_ids alias `s`.
  const clauses: Fragment[] = [];
  if (hasIdFilter) clauses.push(sql`r.id = ANY(${idList})`);
  if (!includeDeleted) clauses.push(sql`r.deleted_at IS NULL`);
  // Maps a body field's declared kind to the cast applied to its extraction,
  // for both sorting and WHERE. Null when no lookup is wired or the field is
  // undeclared; the builders then infer from the operand.
  const bodyCastFor = castFor(ctx, type);

  // Extension-operator side-channel (relevance order, score/vector), applied
  // to the final page below.
  let extMeta: ExtensionOpResultMeta | null = null;
  // One scope per statement, so walk aliases stay unique across where and projection.
  const scope = walks ? walkScope(ctx.namespace, type, 'r', fieldDef, tableFor) : undefined;
  if (scope !== undefined) {
    // As the plan advisor's `leads`: a full index, the crossRef first, `key` next.
    scope.indexDir = (t, crossRef, key) =>
      desiredIndexKeys(indexArgs(ctx, t.type, t.ns)).find(
        (i) => i.only === undefined && i.keys[0]?.[0] === crossRef && i.keys[1]?.[0] === key
      )?.keys[1]?.[1];
  }
  const frameAggs = params.agg;
  if (scope !== undefined && frameAggs !== undefined) {
    // shortcut: each `_agg.<name>` reference recomputes its subquery; a
    // LATERAL computed once per seed row would share it, if it ever costs.
    scope.aggValue = (name) => {
      const spec = Object.hasOwn(frameAggs, name) ? frameAggs[name] : undefined;
      if (spec === undefined) throw new Error(`internal: '_agg.${name}' names no frame _agg`);
      return buildWalkAgg(sql, spec, table, scope).value;
    };
  }
  // #1815: shared forms, registered once the where's extension operators
  // are resolved, so their seed filters compile. Joined to the page.
  let windowJoins = sql``;
  // The pick CTEs' LEFT JOINs, which the statement reading the where carries.
  let pickJoins = sql``;
  if (params.where !== undefined) {
    // Resolves extension operators (e.g. embeddingSimilar) to `id IN [...]`
    // clauses before the synchronous SQL builder runs.
    const detailed = await resolveWhere(params.where, {
      namespace: ctx.namespace,
      type,
      k: limit,
      ...(fieldRequested(params.fields, '_vector') ? { returnVector: true } : {})
    });
    extMeta = detailed.meta;
    if (scope !== undefined) {
      const resolved = { ...params, where: detailed.where };
      const base = { clauses: [...clauses], ids: hasIdFilter };
      // A frame `_agg` window read by every seed is one group-by pass.
      windowJoins = prepareWindows(sql, resolved, base, bodyCastFor, table, scope, (t, field) =>
        desiredIndexKeys(indexArgs(ctx, t.type, t.ns)).some(
          (i) => i.only === undefined && i.keys[0]?.[0] === field
        )
      );
      // A pick many seeds share through one hub is computed once per hub.
      pickJoins = prepareSharedPicks(sql, resolved, base, bodyCastFor, table, scope);
    }
    const whereFragment = buildWhere(sql, detailed.where, bodyCastFor, table, scope);
    if (whereFragment !== null) clauses.push(whereFragment);
  }

  // A count or whole-result aggregate returns no rows, and ignores any cursor.
  if (wholeResult && scope !== undefined) {
    return readWholeResult(
      sql,
      params,
      limit,
      combineAnd(sql, clauses),
      pickJoins,
      table,
      scope,
      (f) => fieldDef(seed, f),
      run
    );
  }

  const orderBy = normalizeOrderBy(params.orderBy);

  const orderByCastFor = bodyCastFor;
  // A filter or sort on shortId needs `s.short_id` per candidate, so it
  // joins before LIMIT (see `page` below).
  const joinShortIds =
    whereReferencesField(params.where, 'shortId') || orderBy.some(([f]) => f === 'shortId');

  // A leading select key, which every matched row needs, is computed once per
  // row as a column of a fenced subquery the page reads as `r`, so ORDER BY, the
  // cursor compare and the projected sort key share it. A later one is inlined:
  // an index on the lead then computes it only for the rows it reads.
  // shortcut: with the shortId join the where reads `s`, so there the
  // expression is inlined at each use; fence that join too if it ever costs.
  const select = compileSelect(sql, params, seed, fieldDef, table, scope);
  const { selectEntries, selectFragments, selectTypes } = select;
  const computedExpr = (field: string): Fragment | undefined => {
    const chosen = Object.hasOwn(params.select ?? {}, field)
      ? selectFragments.get(field)
      : undefined;
    if (chosen !== undefined) {
      return selectTypes.get(field) === 'string' ? sql`((${chosen}) COLLATE "C")` : chosen;
    }
    return undefined;
  };
  const lead = orderBy[0]?.[0] ?? 'id';
  const fenced = joinShortIds ? undefined : computedExpr(lead);
  const computedFor: ComputedLookup = Object.assign(
    (field: string): Fragment | undefined =>
      fenced !== undefined && field === lead ? sql`r.__computed_0` : computedExpr(field),
    { typeOf: (field: string) => selectTypes.get(field) }
  );
  // OFFSET 0 keeps the subquery from being flattened back into one evaluation per use.
  const rel = sql.unsafe(table.from);
  const from =
    fenced === undefined
      ? sql`${rel} r${pickJoins}${windowJoins}`
      : sql`(SELECT r.*, ${fenced} AS __computed_0 FROM ${rel} r${pickJoins} WHERE ${combineAnd(sql, clauses)} OFFSET 0) r${windowJoins}`;
  const ctes = withCtes(sql, scope);
  const base = fenced === undefined ? clauses : [];

  // Cursor: a tuple-compare clause so the page starts strictly after the
  // cursor's (orderBy-values, id) tuple. It matches only non-null leading
  // values when the cursor's is non-null; `tailSql` then selects the null
  // tail that sorts after them, read only if the first query falls short.
  let whereSql = combineAnd(sql, base);
  let tailSql: Fragment | null = null;
  if (params.cursor !== undefined && params.cursor !== '') {
    const cursor = decodeCursor(params.cursor, orderBy);
    const cursorFragment = buildCursorCompare(
      sql,
      orderBy,
      cursor.orderByValues,
      cursor.id,
      orderByCastFor,
      table,
      computedFor
    );
    const tail = buildCursorNullTail(
      sql,
      orderBy,
      cursor.orderByValues,
      orderByCastFor,
      table,
      computedFor
    );
    if (tail !== null) tailSql = combineAnd(sql, [...base, tail]);
    if (cursorFragment !== null) whereSql = combineAnd(sql, [...base, cursorFragment]);
  }
  const orderBySql = buildOrderBy(sql, orderBy, orderByCastFor, table, computedFor, 'r');

  // Fetch one extra row to determine hasMore without a count query.
  const fetchLimit = limit !== undefined ? limit + 1 : undefined;

  // Ships only the requested top-level body keys when `fields` is given,
  // else the full body.
  // Walk selections come back as their own columns, merged into the body before `materialize`.
  const walk =
    scope === undefined
      ? null
      : buildWalkColumns(sql, frameAggs, params.nested ?? {}, table, scope);
  const rowProjection = buildRowProjection(sql, table, params.fields, 'r', walk?.select ?? null);

  // Projects each sort key so the cursor value comes from the same
  // expression that sorted. A promoted field sorts on its column but
  // materializes from the body; if those disagree, a body-derived cursor
  // value repeats the same page forever.
  const { fragment: sortKeyProjection, aliases: sortKeyAliases } = buildSortKeyProjection(
    sql,
    orderBy,
    bodyCastFor,
    table,
    computedFor
  );

  // With `joinShortIds`, short_ids joins before LIMIT. Otherwise the page
  // query runs alone, with nothing parallel-restricted in it, and short_ids
  // is probed once per row it returns: the LIMIT keeps the lateral lookup
  // from being flattened into a join that a generic plan may hash over the
  // type's whole short_ids. short_ids_row_uniq_idx makes either form match
  // at most one row. The outer ORDER BY restores the page order over the
  // projected sort keys. A type table's row carries no namespace or type, so
  // its own are selected as literals.
  const owner = sql.unsafe(
    `${sqlStringLiteral(ctx.namespace)}::text AS namespace, ${sqlStringLiteral(type)}::text AS type`
  );
  const ownerOn = sql.unsafe(
    `s.namespace = ${sqlStringLiteral(ctx.namespace)} AND s.type = ${sqlStringLiteral(type)}`
  );
  // Inlined so a generic plan costs the page at its real size rather than
  // guessing 10% of the type, which favours a parallel full sort over an
  // index. Safe to inline: `n` derives from `limit`, which is validated and
  // floored above, and `BigInt()` throws on a non-integer.
  const inlineLimit = (n: number | undefined): Fragment =>
    n !== undefined ? sql.unsafe(`LIMIT ${BigInt(n)}`) : sql``;
  // One page query: phase 1 with the cursor compare, or the null tail.
  // A read that names its fields gets the metadata columns and short_ids
  // lookup only when it asks for them; the transport would drop them anyway.
  // Each `select` value is one column of the page, shipped as the text the evaluator's value reads from (a date as `utcTextSql(.., 'US')` prints it).
  const selectColumns = selectEntries.map(([name], i) => {
    const fragment =
      fenced !== undefined && name === lead
        ? sql`r.__computed_0`
        : (selectFragments.get(name) as Fragment);
    const alias = sql(`__sel_${i}`);
    switch (selectTypes.get(name)) {
      case 'date':
        return sql`, to_char((${fragment}) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS ${alias}`;
      case 'int64':
        return sql`, (${fragment})::text AS ${alias}`;
      default:
        return sql`, ${fragment} AS ${alias}`;
    }
  });
  const selectProjection =
    selectColumns.length === 0 ? sql`` : (selectColumns as unknown as Fragment);
  const withMeta = readsRowMetadata(params.fields);
  const withShortId = readsShortId(params.fields);
  const metaColumns = withMeta
    ? sql`, r.created_at, r.updated_at,
               r.created_by_kind, r.created_by_id,
               r.updated_by_kind, r.updated_by_id, r.seq`
    : sql``;
  const statement = (where: Fragment, n: number | undefined) =>
    joinShortIds
      ? sql`
        SELECT r.id, ${rowProjection}, r.deleted_at, s.short_id${metaColumns}${selectProjection}${sortKeyProjection}
        FROM ${from}
        LEFT JOIN short_ids s
          ON ${ownerOn}
         AND s.row_id = r.id
        WHERE ${where}
        ${orderBySql}
        ${n !== undefined ? sql`LIMIT ${n}` : sql``}
      `
      : sql`
        SELECT p.*${withShortId ? sql`, s.short_id` : sql``}
        FROM (
          SELECT r.id, ${rowProjection}, r.deleted_at${metaColumns},
                 ${owner}${selectProjection}${sortKeyProjection}
          FROM ${from}
          WHERE ${where}
          ${orderBySql}
          ${inlineLimit(n)}
        ) p
        ${
          withShortId
            ? sql`LEFT JOIN LATERAL (
          SELECT s.short_id FROM short_ids s
          WHERE s.namespace = p.namespace AND s.type = p.type AND s.row_id = p.id
          LIMIT 1
        ) s ON true`
            : sql``
        }
        ${buildProjectedOrderBy(sql, orderBy, sortKeyAliases, orderByCastFor, table, 'p', computedFor)}
      `;
  // The CTEs ride in front only when there are any, so a plain read's text
  // is exactly what it was (callers and tests key on its leading SELECT).
  const page = (where: Fragment, n: number | undefined) =>
    scope?.ctes === undefined || scope.ctes.length === 0
      ? statement(where, n)
      : sql`${ctes}${statement(where, n)}`;

  // Both queries read the same snapshot only inside a REPEATABLE READ or
  // SERIALIZABLE transaction; elsewhere each sees its own.
  let rows = await run<TableRowRecord>(page(whereSql, fetchLimit), 'id');
  if (tailSql !== null && (fetchLimit === undefined || rows.length < fetchLimit)) {
    // A row whose lead turned null after the first query would come back
    // twice; excluding it in SQL keeps the look-ahead row, and so `hasMore`.
    // The residual anomaly is a skip: a row that left the tail in between.
    const unseen = sql`r.id <> ALL(${rows.map((r) => r.id)})`;
    // The full `fetchLimit`, sliced here, so the tail has one statement text
    // per shape rather than one per remaining count.
    // It recomputes the read's CTEs (#1815): a CTE lives for one statement,
    // and the tail runs only when a cursor reaches the null-keyed rows.
    const tail = await run<TableRowRecord>(
      page(combineAnd(sql, [tailSql, unseen]), fetchLimit),
      'id'
    );
    // concat, not push(...): an unlimited tail can exceed the argument limit.
    rows = rows.concat(fetchLimit === undefined ? tail : tail.slice(0, fetchLimit - rows.length));
  }

  return pageResult({
    ctx,
    type,
    params,
    rows,
    table,
    walk,
    seed,
    fieldDef,
    select,
    limit,
    orderBy,
    sortKeyAliases,
    extMeta
  });
}

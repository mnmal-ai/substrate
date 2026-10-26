/**
 * PgDataset — PostgreSQL-backed reference implementation of Dataset.
 * Spec: §4.5, §5.2.
 *
 * One instance per namespace; rows live in a single `rows` table keyed
 * by (namespace, type, id). The caller owns the `postgres` Sql connection —
 * this class never opens or closes pools.
 *
 * Reserved field policy (mirrors MemoryDataset):
 *   - `_deletedAt` is managed exclusively by tombstone() / purge().
 *   - write() strips `_deletedAt` (including explicit null) from inputs before
 *     persisting; the column is the only source of truth on read.
 *   - updateField() with fieldName === '_deletedAt' throws ReservedField.
 *
 * Id-type preservation: `Id` is `string | number`. The PK column is `text`
 * (so we can coerce either shape through one column), but the *original*
 * runtime type is mirrored inside `body.id` during write() and read back out
 * of the body on read() — this keeps numeric ids round-tripping as numbers.
 *
 * Filter contract (§5.2): where / orderBy / cursor are translated to SQL via
 * postgres.js tagged templates — every caller-supplied value goes through
 * parameterised interpolation. Never string-concatenate user input into the
 * clause; that's the one SQL-injection surface in this file.
 */

import {
  applyExtensionResultMeta,
  decodeCursor,
  type ExtensionOpResultMeta,
  encodeCursor,
  fieldRequested,
  fullBuiltinOperators,
  preResolveExtensionOperatorsDetailed
} from '@mnmal-ai/substrate-filter';
import type {
  ActorIdentity,
  ConditionalUpdateResult,
  Dataset,
  DeleteResult,
  DropResult,
  FieldDef,
  FilterCapabilities,
  Id,
  IndexDecl,
  IndexPlan,
  OrderedBy,
  ReadParams,
  ReadResult,
  Row,
  RowMetadata,
  StorageReport,
  TxScopeHandles,
  TypeStats,
  TypeStorageReport,
  UpdateFieldRef,
  WriteOptions,
  WriteResult,
  WriteRow
} from '@mnmal-ai/substrate-types';
import { assertNoRepeatedIds, naturalOrderOf } from '@mnmal-ai/substrate-types';
import type { ReservedSql, Sql } from 'postgres';
import { withPgAdvisoryLock } from './advisory-lock.js';
import type { DiskGuard } from './disk-guard.js';
import { NamespaceMismatch, ReservedField } from './errors.js';
import {
  belongsToType,
  describeTypeIndexes,
  desiredIndexKeys,
  type HeldIndex,
  heldIndexes,
  IndexDropRefusedError,
  type IndexState,
  isEngineOwned,
  legacyLiveScope,
  legacyScope,
  pendingIndexBuilds,
  type ReconcileTypeIndexesArgs,
  reconcileTypeIndexes,
  typeIndexesOf,
  undeclaredIndexes
} from './index-reconciler.js';
import { detectLayout, type StorageLayout } from './layout.js';
import { IndexLockAborted, withTableIndexLock } from './migrate.js';
import type { PgEdgesStore } from './pg-edges-store.js';
import { PgShortIdStore } from './pg-short-id-store.js';
import { sqlStringLiteral } from './pg-sql/primitives.js';
import {
  asJsonValue,
  assembleRowMetadata,
  type BodyOrderByCast,
  buildBodyProjection,
  buildCursorCompare,
  buildCursorNullTail,
  buildOrderBy,
  buildProjectedOrderBy,
  buildSortKeyProjection,
  buildWhere,
  combineAnd,
  conditionalMatchFragment,
  type Fragment,
  idToText,
  normalizeOrderBy,
  type PromotedBodyColumnMap,
  type PromotedColumnLookup,
  resolveBodyOrderByCast,
  resolvePromotedColumns,
  whereReferencesField
} from './pg-sql.js';
import { type PgHandle, txScopeIdFor } from './tx-scope.js';
import {
  ensureTypeStorage,
  ident,
  storageWarnings,
  typePartition,
  typePartitions
} from './type-storage.js';

// The pool-owned instance holds `Sql`; tx-scoped instances hold the
// `TransactionSql` from `sql.begin(fn)`. Only `Sql` exposes `begin`, so that
// access is gated behind `#inTx`.

/**
 * Returns the declared FieldDef for a type's field, or undefined when unknown
 * (body-key sorts then fall back to text compare). Lets the SQL builders cast
 * body values by declared kind, so `count` sorts 2 before 10 — see
 * `resolveBodyOrderByCast`.
 */
export type FieldDefLookup = (type: string, field: string) => FieldDef | undefined;

/**
 * A type's declared fields and indexes, or undefined when the type is unknown.
 * Called with the asking dataset's namespace, so a `forNamespace` clone that
 * inherits the lookup resolves its own types.
 */
export type TypeDefLookup = (
  type: string,
  namespace: string
) =>
  | {
      fields: Record<string, FieldDef>;
      indexes?: IndexDecl[];
      orderedBy?: OrderedBy;
      ordering?: 'visible';
      expectedSize?: 'small' | 'large';
    }
  | undefined;

export interface PgDatasetOptions {
  namespace: string;
  sql: Sql;
  /**
   * Optional sibling `PgEdgesStore` to enlist into this dataset's substrate
   * transactions. When supplied, MUST share the same `Sql` pool (verified
   * via `txScopeId === txScopeIdFor(sql)`); the dataset throws on
   * construction otherwise.
   *
   * When supplied, `withScopedTransaction` yields a tx-bound edges store
   * on the same `TransactionSql` as the tx-bound datasets. When omitted, it
   * yields `edges: null` and the engine runs edge ops in a separate tx.
   */
  edgesStore?: PgEdgesStore;
  /**
   * Optional field-def lookup so orderBy + cursor compares on body fields can
   * cast to the declared scalar pg type (numeric / timestamptz / boolean)
   * instead of falling back to lexicographic text compare. When omitted, every
   * body-key orderBy compares as text.
   *
   * A cast sort cannot use an index on the uncast `(body ->> 'field')`
   * expression; it needs a matching cast expression index.
   */
  fieldDefLookup?: FieldDefLookup;
  /**
   * Body keys mirrored into dedicated columns on `rows`, so filters and
   * sorts on them use an index instead of extracting from JSONB.
   *
   * None by default. A namespace declares its own (`NamespaceDefinition`'s
   * `promotedColumns`), and the plugin that declares them adds the columns in
   * its kernel migrations: the engine creates none. Three things that bite:
   *
   *   - Filters and sorts route to the column and ONLY the column, so a column
   *     added over existing rows must be backfilled from the body first, or
   *     those rows miss every filter. Reads return the body.
   *   - `column` is a BARE name (`'severity'`, not `'r.severity'`) and is
   *     validated as an identifier at construction, because it is interpolated
   *     into SQL as an identifier.
   *   - Text columns compare `COLLATE "C"` in every operator, eq included,
   *     so an index meant to serve them must key `(column COLLATE "C")`, as
   *     declared `indexes` do.
   */
  promotedColumns?: PromotedBodyColumnMap;
  /**
   * The namespace's type definitions, which `ensureTypeStorage` builds the
   * type's indexes from. Without it only the engine's own indexes are built.
   */
  typeDefLookup?: TypeDefLookup;
  /**
   * Checked before each non-unique index build `ensureTypeStorage` runs; a
   * refused build stays `pending` (`insufficient_disk`) until a later pass.
   * Without one nothing is checked. With one that has no path, nothing is
   * checked either, and `storageReport` says so.
   */
  diskGuard?: DiskGuard;
}

interface InternalPgSubstrateDatasetOptions {
  namespace: string;
  sql: PgHandle;
  inTx: boolean;
  /**
   * Tx-bound instances reuse the root's txScopeId so one substrate never
   * advertises two ids. The public constructor derives it from the Sql.
   */
  txScopeId?: string;
  edgesStore?: PgEdgesStore;
  fieldDefLookup?: FieldDefLookup;
  /** See `PgDatasetOptions.promotedColumns`. */
  promotedColumns?: PromotedBodyColumnMap;
  /** Shared with the instance this one was derived from. */
  layoutCache?: LayoutCache;
  typeDefLookup?: TypeDefLookup;
  diskGuard?: DiskGuard;
}

/** An index whose build this process deferred, is running, or saw fail. */
interface DeferredBuild {
  state: 'pending' | 'building' | 'failed';
  /** `<namespace>/<type>`. */
  type: string;
  /** Why it failed: an error code, then a short reason. */
  error?: string;
  /** Why it is pending, when the disk guard refused it. */
  reason?: 'insufficient_disk';
}

/** The CHECKs the engine's own migrations put on `rows`; any other is plugin fan-out. */
const ENGINE_CHECKS = [
  'rows_created_by_kind_check',
  'rows_updated_by_kind_check',
  'rows_id_uuid_format'
];

/**
 * `N open index recommendation(s)` while the index advisor has any, else
 * nothing. Reads `_system/IndexRecommendation` from this schema's rows, so a
 * `_system` held elsewhere (memory) reports none.
 */
async function openRecommendations(sql: Sql): Promise<string[]> {
  const [row] = await sql<Array<{ n: number }>>`
    SELECT count(*)::int AS n FROM rows
    WHERE namespace = '_system' AND type = 'IndexRecommendation'
      AND deleted_at IS NULL AND body->>'state' = 'open'`;
  const n = row?.n ?? 0;
  return n === 0
    ? []
    : [
        `${n} open index recommendation${n === 1 ? '' : 's'}: query _system/IndexRecommendation, then apply or dismiss each with propose_index`
      ];
}

/** Per pool, so every dataset on it reports what the others deferred. */
const deferredBuilds = new WeakMap<object, Map<string, DeferredBuild>>();

/** The detected layout, shared by an instance and every clone of it. */
interface LayoutCache {
  layout?: StorageLayout;
}

const RESERVED_DELETED_AT = '_deletedAt';

interface SubstrateRowRecord {
  id: string;
  body: Record<string, unknown>;
  deleted_at: Date | null;
  /** From short_ids; null when no binding exists. */
  short_id: number | null;
  // Row-metadata columns. NULL for legacy rows.
  created_at: Date | null;
  updated_at: Date | null;
  created_by_kind: string | null;
  created_by_id: string | null;
  updated_by_kind: string | null;
  updated_by_id: string | null;
  /** bigint as a string; null off visible-order types. */
  seq: string | null;
}

/** Share of `rows` changed since ANALYZE past which its indexes' row counts are stale (autoanalyze's default). */
const INDEX_COUNT_STALE = 0.1;

/**
 * `dropEngineIndex`'s bound on each lock wait. A request transaction ends in
 * well under this; one still open after it is a long export or a caller
 * waiting on the drop itself, and the drop holds the table's index-build lock
 * and two connections while it waits, so it gives up and the caller retries.
 */
const DROP_LOCK_TIMEOUT_MS = 10_000;

/**
 * DROP INDEX CONCURRENTLY `name` (of `where`, for messages) on `conn`, each
 * lock wait bounded by `timeoutMs`; a wait over it throws `index_drop_timeout`.
 */
async function dropIndexBounded(
  conn: ReservedSql,
  name: string,
  where: string,
  timeoutMs: number
): Promise<void> {
  const timeout = Math.max(1, Math.trunc(timeoutMs));
  try {
    await conn.unsafe(`SET lock_timeout = ${timeout}`);
    await conn.unsafe(`DROP INDEX CONCURRENTLY IF EXISTS ${ident(name)}`);
  } catch (err) {
    if ((err as { code?: unknown }).code !== '55P03') throw err;
    throw new IndexDropRefusedError(
      'index_drop_timeout',
      `dropping index ${name} on ${where} waited over ${timeout} ms on another transaction; retry once it ends`
    );
  } finally {
    await conn.unsafe('RESET lock_timeout');
  }
}

/** Rows the legacy `typeStats` sample aims for. */
const SAMPLE_ROWS = 10_000;

/**
 * Engine-owned partial indexes on a legacy `rows` above which `storageReport`
 * warns: the planner checks every partial index's predicate on every query of
 * `rows`, about 4-5 ms of planning at 50 on PG 18, against ~1 ms to run a page.
 */
export const LEGACY_PARTIAL_INDEX_LIMIT = 50;

/** The value of a one-value LIST partition bound as `pg_get_expr` prints it. */
const listBound = (b: string | null): string | undefined =>
  b === null ? undefined : /^FOR VALUES IN \('(.*)'\)$/s.exec(b)?.[1]?.replace(/''/g, "'");

export class PgDataset implements Dataset {
  readonly namespace: string;
  // Full builtin operator set — everything the validator recognises.
  readonly capabilities: FilterCapabilities = {
    operators: fullBuiltinOperators(),
    orderBy: true,
    cursor: true
  };

  readonly txScopeId: string;

  readonly #sql: PgHandle;
  readonly #inTx: boolean;
  readonly #shortIds: PgShortIdStore;
  readonly #edgesStore: PgEdgesStore | null;
  /** Stored so tx-bound and forNamespace clones inherit it. */
  readonly #fieldDefLookup: FieldDefLookup | null;
  /**
   * Validated once at construction. The raw map is kept so clones inherit it
   * rather than reverting to the default.
   */
  readonly #promotedColumns: PromotedBodyColumnMap;
  readonly #promotedFor: PromotedColumnLookup;
  readonly #layoutCache: LayoutCache;
  readonly #typeDefLookup: TypeDefLookup | null;
  readonly #diskGuard: DiskGuard | undefined;

  constructor(options: PgDatasetOptions | InternalPgSubstrateDatasetOptions) {
    this.namespace = options.namespace;
    this.#sql = options.sql;
    // `inTx` is only set via the internal options shape; the public
    // constructor always produces a non-tx instance.
    this.#inTx = 'inTx' in options ? options.inTx : false;
    // Tx-bound datasets inherit their parent's txScopeId.
    const explicit = 'txScopeId' in options ? options.txScopeId : undefined;
    this.txScopeId = explicit ?? txScopeIdFor(options.sql);
    this.#shortIds = new PgShortIdStore(this.#sql);
    // An edges store from a different Sql pool cannot share a transaction.
    const edgesOpt = options.edgesStore;
    if (edgesOpt !== undefined && edgesOpt.txScopeId !== this.txScopeId) {
      throw new Error(
        `PgDataset: edgesStore txScopeId '${edgesOpt.txScopeId}' does not match dataset txScopeId '${this.txScopeId}' — both must wrap the same Sql pool`
      );
    }
    this.#edgesStore = edgesOpt ?? null;
    this.#fieldDefLookup = options.fieldDefLookup ?? null;
    this.#promotedColumns = options.promotedColumns ?? {};
    // Validates before any configured column name can reach `sql.unsafe`.
    this.#promotedFor = resolvePromotedColumns(this.#promotedColumns);
    this.#layoutCache = ('layoutCache' in options ? options.layoutCache : undefined) ?? {};
    this.#typeDefLookup = options.typeDefLookup ?? null;
    this.#diskGuard = options.diskGuard;
  }

  /**
   * Reads rows of `type` per the §5.2 filter contract (where / orderBy /
   * cursor / limit). Every value is bound through a parameterised slot.
   *
   * Body values extract as text and are cast for comparison only; the filter
   * validator has already rejected type mismatches.
   */
  /**
   * `namespace = '<ns>' [AND type = '<type>']` with both inlined as literals,
   * so plans prune partitions at plan time and a generic plan can still match
   * a legacy partial index's `namespace = … AND type = …` predicate.
   */
  #scope(type?: string, alias = ''): Fragment {
    const ns = `${alias}namespace = ${sqlStringLiteral(this.namespace)}`;
    return this.#sql.unsafe(
      type === undefined ? ns : `${ns} AND ${alias}type = ${sqlStringLiteral(type)}`
    );
  }

  async read(type: string, params: ReadParams): Promise<ReadResult> {
    const sql = this.#sql;
    const includeDeleted = params.includeDeleted === true;

    const limit =
      typeof params.limit === 'number' && Number.isFinite(params.limit) && params.limit >= 0
        ? Math.floor(params.limit)
        : undefined;

    // Fast path: limit === 0 returns empty without hitting the db.
    if (limit === 0) return { rows: [], hasMore: false };

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

    // Build WHERE fragment incrementally. Use table alias `r` to avoid
    // ambiguity with the short_ids alias `s`.
    const clauses: Fragment[] = [];
    clauses.push(this.#scope(type, 'r.'));
    if (hasIdFilter) clauses.push(sql`r.id = ANY(${idList})`);
    if (!includeDeleted) clauses.push(sql`r.deleted_at IS NULL`);
    // Maps a body field's declared kind to the cast applied to its extraction,
    // for both sorting and WHERE. Null when no lookup is wired or the field is
    // undeclared; the builders then infer from the operand.
    const bodyCastFor = (field: string): BodyOrderByCast | null => {
      if (this.#fieldDefLookup === null) return null;
      return resolveBodyOrderByCast(this.#fieldDefLookup(type, field));
    };

    // Extension-operator side-channel (relevance order, score/vector), applied
    // to the final page below.
    let extMeta: ExtensionOpResultMeta | null = null;
    if (params.where !== undefined) {
      // Resolves extension operators (e.g. embeddingSimilar) to `id IN [...]`
      // clauses before the synchronous SQL builder runs.
      const detailed = await preResolveExtensionOperatorsDetailed(params.where, {
        namespace: this.namespace,
        type,
        k: limit,
        ...(fieldRequested(params.fields, '_vector') ? { returnVector: true } : {})
      });
      extMeta = detailed.meta;
      const whereFragment = buildWhere(sql, detailed.where, bodyCastFor, this.#promotedFor);
      if (whereFragment !== null) clauses.push(whereFragment);
    }

    const orderBy = normalizeOrderBy(params.orderBy);

    const orderByCastFor = bodyCastFor;

    // Cursor: a tuple-compare clause so the page starts strictly after the
    // cursor's (orderBy-values, id) tuple. It matches only non-null leading
    // values when the cursor's is non-null; `tailSql` then selects the null
    // tail that sorts after them, read only if the first query falls short.
    let whereSql = combineAnd(sql, clauses);
    let tailSql: Fragment | null = null;
    if (params.cursor !== undefined && params.cursor !== '') {
      const cursor = decodeCursor(params.cursor, orderBy);
      const cursorFragment = buildCursorCompare(
        sql,
        orderBy,
        cursor.orderByValues,
        cursor.id,
        orderByCastFor,
        this.#promotedFor
      );
      const tail = buildCursorNullTail(
        sql,
        orderBy,
        cursor.orderByValues,
        orderByCastFor,
        this.#promotedFor
      );
      if (tail !== null) tailSql = combineAnd(sql, [...clauses, tail]);
      if (cursorFragment !== null) whereSql = combineAnd(sql, [...clauses, cursorFragment]);
    }
    const orderBySql = buildOrderBy(sql, orderBy, orderByCastFor, this.#promotedFor);

    // Fetch one extra row to determine hasMore without a count query.
    const fetchLimit = limit !== undefined ? limit + 1 : undefined;

    // Ships only the requested top-level body keys when `fields` is given,
    // else the full body.
    const bodyProjection = buildBodyProjection(sql, params.fields);

    // Projects each sort key so the cursor value comes from the same
    // expression that sorted. A promoted field sorts on its column but
    // materializes from the body; if those disagree, a body-derived cursor
    // value repeats the same page forever.
    const { fragment: sortKeyProjection, aliases: sortKeyAliases } = buildSortKeyProjection(
      sql,
      orderBy,
      bodyCastFor,
      this.#promotedFor
    );

    // A filter or sort on shortId needs `s.short_id` per candidate, so it
    // joins before LIMIT. Otherwise the page query runs alone, with nothing
    // parallel-restricted in it, and short_ids is probed once per row it
    // returns: the LIMIT keeps the lateral lookup from being flattened into a
    // join that a generic plan may hash over the type's whole short_ids.
    // short_ids_row_uniq_idx makes either form match at most one row. The
    // outer ORDER BY restores the page order over the projected sort keys.
    const joinShortIds =
      whereReferencesField(params.where, 'shortId') || orderBy.some(([f]) => f === 'shortId');
    // Inlined so a generic plan costs the page at its real size rather than
    // guessing 10% of the type, which favours a parallel full sort over an
    // index. Safe to inline: `n` derives from `limit`, which is validated and
    // floored above, and `BigInt()` throws on a non-integer.
    const inlineLimit = (n: number | undefined): Fragment =>
      n !== undefined ? sql.unsafe(`LIMIT ${BigInt(n)}`) : sql``;
    // One page query: phase 1 with the cursor compare, or the null tail.
    const page = (where: Fragment, n: number | undefined) =>
      joinShortIds
        ? sql<SubstrateRowRecord[]>`
          SELECT r.id, ${bodyProjection} AS body, r.deleted_at, s.short_id,
                 r.created_at, r.updated_at,
                 r.created_by_kind, r.created_by_id,
                 r.updated_by_kind, r.updated_by_id, r.seq${sortKeyProjection}
          FROM rows r
          LEFT JOIN short_ids s
            ON s.namespace = r.namespace
           AND s.type = r.type
           AND s.row_id = r.id
          WHERE ${where}
          ${orderBySql}
          ${n !== undefined ? sql`LIMIT ${n}` : sql``}
        `
        : sql<SubstrateRowRecord[]>`
          SELECT p.*, s.short_id
          FROM (
            SELECT r.id, ${bodyProjection} AS body, r.deleted_at,
                   r.created_at, r.updated_at,
                   r.created_by_kind, r.created_by_id,
                   r.updated_by_kind, r.updated_by_id, r.seq,
                   r.namespace, r.type${sortKeyProjection}
            FROM rows r
            WHERE ${where}
            ${orderBySql}
            ${inlineLimit(n)}
          ) p
          LEFT JOIN LATERAL (
            SELECT s.short_id FROM short_ids s
            WHERE s.namespace = p.namespace AND s.type = p.type AND s.row_id = p.id
            LIMIT 1
          ) s ON true
          ${buildProjectedOrderBy(sql, orderBy, sortKeyAliases, orderByCastFor, this.#promotedFor, 'p')}
        `;

    // Both queries read the same snapshot only inside a REPEATABLE READ or
    // SERIALIZABLE transaction; elsewhere each sees its own.
    let rows: SubstrateRowRecord[] = await page(whereSql, fetchLimit);
    if (tailSql !== null && (fetchLimit === undefined || rows.length < fetchLimit)) {
      // A row whose lead turned null after the first query would come back
      // twice; excluding it in SQL keeps the look-ahead row, and so `hasMore`.
      // The residual anomaly is a skip: a row that left the tail in between.
      const unseen = sql`r.id <> ALL(${rows.map((r) => r.id)})`;
      // The full `fetchLimit`, sliced here, so the tail has one statement text
      // per shape rather than one per remaining count.
      const tail = await page(combineAnd(sql, [tailSql, unseen]), fetchLimit);
      // concat, not push(...): an unlimited tail can exceed the argument limit.
      rows = rows.concat(fetchLimit === undefined ? tail : tail.slice(0, fetchLimit - rows.length));
    }

    const materialised = rows.map((r) => this.materialize(r));
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

  /**
   * Upsert `rows`. A row without an `id` gets one from the database's
   * `uuidv7()`, returned in `ids` in input order. Limits of a v7 id: it is
   * never a happened-before signal; ids sort in creation order only within one
   * connection (across connections within a millisecond, and for
   * client-supplied ids, order is arbitrary); it reveals its creation time;
   * and deciding who won (last-writer-wins, `conditionalUpdate`) uses the
   * database's transaction time or a per-row version, never the id.
   *
   * A supplied id repeated in one batch: under `insertOnly` the first
   * occurrence lands and the rest are skipped; otherwise the batch is refused.
   *
   * On an `ordering: 'visible'` type each inserted row gets the next `seq`,
   * consecutive in input order, under a per-type transaction lock held until
   * commit, so seq order is commit order. A row that already exists keeps its
   * seq, and one `insertOnly` skips gets none.
   */
  async write(type: string, rows: WriteRow[], options?: WriteOptions): Promise<WriteResult> {
    if (rows.length === 0) return { written: 0, ids: [], rows: [] };
    if (options?.insertOnly !== true) assertNoRepeatedIds(type, rows);

    const visible = this.#typeDefLookup?.(type, this.namespace)?.ordering === 'visible';
    // The seq lock must be held to commit, so it needs a transaction to live in.
    if (visible && !this.#inTx) {
      return this.withTransaction((tx) => tx.write(type, rows, options));
    }

    const sql = this.#sql;
    if (visible) {
      await sql`SELECT pg_advisory_xact_lock(hashtext('substrate-visible-seq:' || current_schema() || ':' || ${this.namespace} || '/' || ${type}))`;
    }

    const fallbackNow = (options?.now ?? new Date()).toISOString();
    const fallbackActor = options?.identity ?? null;

    // Per-column arrays, one UNNEST slot each. `_deletedAt` and `_metadata`
    // are stripped from the body: each lives only in its own column(s).
    const namespaces: string[] = [];
    const types: string[] = [];
    const idsCol: (string | null)[] = [];
    const bodies: string[] = [];
    const createdAts: (string | null)[] = [];
    const updatedAts: (string | null)[] = [];
    const createdByKinds: (string | null)[] = [];
    const createdByIds: (string | null)[] = [];
    const updatedByKinds: (string | null)[] = [];
    const updatedByIds: (string | null)[] = [];

    for (const row of rows) {
      // The engine always supplies _metadata; raw writes get it auto-filled.
      const meta: RowMetadata = (row._metadata as RowMetadata | undefined) ?? {
        createdAt: fallbackNow,
        updatedAt: fallbackNow,
        createdBy: fallbackActor,
        updatedBy: fallbackActor
      };
      const sanitised: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(row)) {
        if (k === RESERVED_DELETED_AT) continue;
        if (k === '_metadata') continue;
        if (k === 'id' && v == null) continue;
        sanitised[k] = v;
      }
      namespaces.push(this.namespace);
      types.push(type);
      idsCol.push(row.id == null ? null : idToText(row.id));
      // Bound as text and cast `::jsonb` in SQL: postgres.js's bulk path does
      // not reliably round-trip objects through jsonb.
      bodies.push(JSON.stringify(sanitised));
      // Identity columns can be null when no actor was supplied.
      createdAts.push(meta.createdAt);
      updatedAts.push(meta.updatedAt);
      createdByKinds.push(meta.createdBy?.kind ?? null);
      createdByIds.push(meta.createdBy?.id ?? null);
      updatedByKinds.push(meta.updatedBy?.kind ?? null);
      updatedByIds.push(meta.updatedBy?.id ?? null);
    }

    // Upsert with JSONB merge, matching memory-dataset: new keys win, absent
    // keys keep the existing value. `deleted_at` is not touched on conflict —
    // a tombstone is terminal. `created_*` keep the existing value; `updated_*`
    // take the new value unless it is null, so a raw write with no identity
    // keeps the prior updatedBy.
    //
    // UNNEST of typed arrays rather than postgres.js's `sql(rows, ...cols)`
    // helper, which mishandles `null` inside transactions.

    // Promoted body-to-column mirror. The INSERT column list, its SELECT
    // expressions and the ON CONFLICT SET list must agree, so one loop builds
    // all three. Column names are validated identifiers, which is what
    // licenses `sql.unsafe` here.
    //
    // A body-absent boolean writes false, so a boolean column can be NOT NULL;
    // a text column stays nullable, where an explicit JSONB null is distinct
    // from "key absent".
    //
    // ON CONFLICT mirrors the body concat-merge: a key present in EXCLUDED.body
    // overrides, an absent key leaves the existing column untouched.
    const insertColumnParts: Fragment[] = [];
    const insertValueParts: Fragment[] = [];
    const conflictParts: Fragment[] = [];
    for (const [field, meta] of Object.entries(this.#promotedColumns)) {
      const colRef = sql.unsafe(meta.column);
      const absentDefault = meta.kind === 'boolean' ? sql`false` : sql`NULL`;
      const cast = meta.kind === 'boolean' ? sql`::boolean` : sql``;
      insertColumnParts.push(sql`, ${colRef}`);
      insertValueParts.push(
        sql`, CASE WHEN bod::jsonb ? ${field} THEN (bod::jsonb->>${field})${cast} ELSE ${absentDefault} END`
      );
      conflictParts.push(
        sql`, ${colRef} = CASE WHEN EXCLUDED.body ? ${field} THEN (EXCLUDED.body->>${field})${cast} ELSE ${sql.unsafe(`rows.${meta.column}`)} END`
      );
    }
    const insertColumnList =
      insertColumnParts.length === 0 ? sql`` : (insertColumnParts as unknown as Fragment);
    const insertColumnValues =
      insertValueParts.length === 0 ? sql`` : (insertValueParts as unknown as Fragment);
    const conflictColumnUpdates =
      conflictParts.length === 0 ? sql`` : (conflictParts as unknown as Fragment);

    // insertOnly: a conflicting row returns nothing, so it drops out of the result.
    const onConflict =
      options?.insertOnly === true
        ? sql`ON CONFLICT (namespace, type, id) DO NOTHING`
        : sql`ON CONFLICT (namespace, type, id)
        DO UPDATE SET
          body            = rows.body || EXCLUDED.body,
          created_at      = COALESCE(rows.created_at, EXCLUDED.created_at),
          updated_at      = COALESCE(EXCLUDED.updated_at, rows.updated_at),
          created_by_kind = COALESCE(rows.created_by_kind, EXCLUDED.created_by_kind),
          created_by_id   = COALESCE(rows.created_by_id, EXCLUDED.created_by_id),
          updated_by_kind = COALESCE(EXCLUDED.updated_by_kind, rows.updated_by_kind),
          updated_by_id   = COALESCE(EXCLUDED.updated_by_id, rows.updated_by_id)${conflictColumnUpdates}`;

    // Visible order: `seqd` numbers the rows that will be inserted (the first
    // occurrence of an id with no row yet) on from the type's last seq, in
    // input order; `counted` advances that counter. Both read under the lock,
    // so no other writer of the type can interleave. Relies on READ COMMITTED:
    // this statement's snapshot, taken after the lock, sees every earlier
    // holder's commit.
    const seqCtes = visible
      ? sql`,
      seqd AS (
        SELECT f.*, CASE WHEN f.fresh THEN
            COALESCE((SELECT v.last_seq FROM visible_seqs v WHERE ${this.#scope(type, 'v.')}), 0)
            + count(*) FILTER (WHERE f.fresh) OVER (ORDER BY f.ord)
          END AS sq
        FROM (
          SELECT i.*, i.ord = min(i.ord) OVER (PARTITION BY i.rid) AS first,
                 i.ord = min(i.ord) OVER (PARTITION BY i.rid) AND NOT EXISTS (
                   SELECT 1 FROM rows r WHERE ${this.#scope(type, 'r.')} AND r.id = i.rid
                 ) AS fresh
          FROM input i
        ) f
      ),
      counted AS (
        INSERT INTO visible_seqs (namespace, type, last_seq)
        SELECT ns, ty, max(sq) FROM seqd WHERE sq IS NOT NULL GROUP BY ns, ty
        ON CONFLICT (namespace, type) DO UPDATE SET last_seq = EXCLUDED.last_seq
      )`
      : sql``;
    // A repeated id's later occurrences are skipped under insertOnly anyway;
    // leaving them out makes the first one the one that lands, with its seq.
    const insertSource = visible ? sql`seqd WHERE first` : sql`input`;
    const seqColumn = visible ? sql`, seq` : sql``;
    const seqValue = visible ? sql`, sq` : sql``;

    // Single round-trip upsert + merged-row read. The CTE pipeline:
    //   `input`     — UNNEST of caller arrays WITH ORDINALITY, to preserve
    //                 input order; a null id becomes `uuidv7()` here, once
    //                 per row, so the final join sees the assigned id.
    //   `upserted`  — the INSERT...ON CONFLICT...DO UPDATE, RETURNING the
    //                 post-merge row state.
    //   final SELECT joins back to `input.ord` and the short-id sidecar so
    //                 callers get the same shape `read()` emits.
    const records = await sql<SubstrateRowRecord[]>`
      WITH input AS (
        SELECT ns, ty, COALESCE(rid, uuidv7()::text) AS rid, bod,
               ca, ua, cbk, cbi, ubk, ubi, ord
        FROM UNNEST(
          ${namespaces}::text[],
          ${types}::text[],
          ${idsCol}::text[],
          ${bodies}::text[],
          ${createdAts}::text[],
          ${updatedAts}::text[],
          ${createdByKinds}::text[],
          ${createdByIds}::text[],
          ${updatedByKinds}::text[],
          ${updatedByIds}::text[]
        ) WITH ORDINALITY AS t(ns, ty, rid, bod, ca, ua, cbk, cbi, ubk, ubi, ord)
      )${seqCtes},
      upserted AS (
        INSERT INTO rows (namespace, type, id, body, deleted_at,
          created_at, updated_at, created_by_kind, created_by_id,
          updated_by_kind, updated_by_id${insertColumnList}${seqColumn})
        SELECT
          ns, ty, rid, bod::jsonb, NULL::timestamptz,
          ca::timestamptz, ua::timestamptz, cbk, cbi, ubk, ubi${insertColumnValues}${seqValue}
        FROM ${insertSource}
        ${onConflict}
        RETURNING namespace, type, id, body, deleted_at,
                  created_at, updated_at, created_by_kind, created_by_id,
                  updated_by_kind, updated_by_id, seq
      )
      SELECT u.id, u.body, u.deleted_at, s.short_id,
             u.created_at, u.updated_at,
             u.created_by_kind, u.created_by_id,
             u.updated_by_kind, u.updated_by_id, u.seq
      FROM upserted u
      JOIN (SELECT rid, min(ord) AS ord FROM input GROUP BY rid) i ON i.rid = u.id
      LEFT JOIN short_ids s
        ON s.namespace = u.namespace
       AND s.type = u.type
       AND s.row_id = u.id
      ORDER BY i.ord
    `;

    const merged = records.map((r) => this.materialize(r));
    return { written: merged.length, ids: merged.map((r) => r.id), rows: merged };
  }

  async tombstone(type: string, ids: Id[]): Promise<DeleteResult> {
    if (ids.length === 0) return { deleted: 0, ids: [] };

    const textIds = ids.map(idToText);

    // Only stamp rows that are not already tombstoned — tombstone is terminal
    // and must preserve the original timestamp on a second call.
    const rows = await this.#sql<{ id: string; body: Record<string, unknown> }[]>`
      UPDATE rows
      SET deleted_at = now()
      WHERE ${this.#scope(type)}
        AND id = ANY(${textIds})
        AND deleted_at IS NULL
      RETURNING id, body
    `;

    const stamped: Id[] = rows.map((r) => this.extractOriginalId(r.id, r.body));
    return { deleted: stamped.length, ids: stamped };
  }

  async purge(type: string, ids: Id[]): Promise<DeleteResult> {
    if (ids.length === 0) return { deleted: 0, ids: [] };

    const textIds = ids.map(idToText);

    const rows = await this.#sql<{ id: string; body: Record<string, unknown> }[]>`
      DELETE FROM rows
      WHERE ${this.#scope(type)}
        AND id = ANY(${textIds})
      RETURNING id, body
    `;

    const removed: Id[] = rows.map((r) => this.extractOriginalId(r.id, r.body));
    return { deleted: removed.length, ids: removed };
  }

  /**
   * Hard-deletes tombstoned rows whose `deleted_at` is older than `olderThan`,
   * across ALL namespaces (the table is substrate-shared). Called by the sweep
   * loop. Returns the number of rows deleted.
   *
   * Short-id mappings are left in place, as in `purge()`: a row id can
   * reappear after a tombstone + rewrite.
   */
  async purgeTombstonedRows(opts: { olderThan: Date }): Promise<{ deleted: number }> {
    const rows = await this.#sql<{ id: string }[]>`
      DELETE FROM rows
      WHERE deleted_at IS NOT NULL
        AND deleted_at < ${opts.olderThan}
      RETURNING id
    `;
    return { deleted: rows.length };
  }

  /**
   * Hard-delete every row for `type` in this namespace, including tombstoned
   * rows (`deleted_at IS NOT NULL`). Short-id mappings for that type are
   * removed in the same logical operation. Both deletes run through `this.#sql`
   * so they participate in any surrounding `withTransaction` boundary.
   */
  async dropType(type: string): Promise<DropResult> {
    const rows = await this.#sql<{ id: string }[]>`
      DELETE FROM rows
      WHERE ${this.#scope(type)}
      RETURNING id
    `;
    const rowsDeleted = rows.length;
    const shortIdsDeleted = await this.#shortIds.dropType(this.namespace, type);
    return { rowsDeleted, shortIdsDeleted };
  }

  /**
   * Hard-delete every row across all types in this namespace, including
   * tombstoned rows. Short-id mappings for all types are removed too.
   */
  async dropNamespace(): Promise<DropResult> {
    const rows = await this.#sql<{ id: string }[]>`
      DELETE FROM rows
      WHERE ${this.#scope()}
      RETURNING id
    `;
    const rowsDeleted = rows.length;
    const shortIdsDeleted = await this.#shortIds.dropNamespace(this.namespace);
    return { rowsDeleted, shortIdsDeleted };
  }

  /**
   * Compare-and-update (spec §5.12): merges `updates` into the live row only
   * if every `match` field equals its expected value. Returns `matched` and
   * the updated row.
   *
   * One `UPDATE ... WHERE <pk> AND <match>`, so the row lock makes exactly one
   * of N concurrent callers match. `_deletedAt` and `id` are dropped from
   * `updates`.
   */
  async conditionalUpdate(
    type: string,
    id: Id,
    match: Record<string, unknown>,
    updates: Record<string, unknown>,
    actor?: ActorIdentity,
    now?: Date
  ): Promise<ConditionalUpdateResult> {
    const sql = this.#sql;
    const sanitisedUpdates: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(updates)) {
      if (k === RESERVED_DELETED_AT) continue;
      if (k === 'id') continue;
      sanitisedUpdates[k] = v;
    }

    const matchClauses: Fragment[] = [];
    for (const [field, expected] of Object.entries(match)) {
      matchClauses.push(conditionalMatchFragment(sql, field, expected));
    }
    const matchSql = matchClauses.length === 0 ? sql`TRUE` : combineAnd(sql, matchClauses);

    // Nulls are deliberately kept: a caller-supplied `null` is a real value.
    const updatesJson = sql.json(asJsonValue(sanitisedUpdates));
    const deletedGuard = sql`deleted_at IS NULL`;

    // Stamps updated_at/updated_by_* (recency ranking reads them);
    // created_* are left alone.
    const updatedBy: ActorIdentity = actor ?? { kind: 'system', id: 'anonymous' };

    // Mirrors each promoted key in `updates` into its column, in the same UPDATE.
    const columnMirrors: Fragment[] = [];
    for (const field of Object.keys(this.#promotedColumns)) {
      if (!(field in sanitisedUpdates)) continue;
      const meta = this.#promotedFor(field);
      if (meta === undefined) continue;
      const raw = sanitisedUpdates[field];
      // Bare column name, validated at construction — `sql(name)` quotes it as
      // an identifier, so no caller string is ever concatenated into SQL.
      const colIdent = sql(meta.column);
      if (raw === null) {
        columnMirrors.push(sql`${colIdent} = NULL`);
      } else if (meta.kind === 'boolean') {
        // The same cast write() applies, so 'false' is false on every path.
        // Via text: a bare ::boolean types the parameter bool, and postgres.js
        // serialises any non-`true` value (the string 'true' too) as false.
        columnMirrors.push(sql`${colIdent} = ${String(raw)}::text::boolean`);
      } else {
        columnMirrors.push(sql`${colIdent} = ${String(raw)}::text`);
      }
    }

    const setFragments: Fragment[] = [
      sql`body = body || ${updatesJson}`,
      now === undefined ? sql`updated_at = now()` : sql`updated_at = ${now}`,
      sql`updated_by_kind = ${updatedBy.kind}`,
      sql`updated_by_id = ${updatedBy.id}`,
      ...columnMirrors
    ];
    const commaFrag = sql`,`;
    const interleaved: Fragment[] = [setFragments[0] as Fragment];
    for (let i = 1; i < setFragments.length; i++) {
      interleaved.push(commaFrag, setFragments[i] as Fragment);
    }

    // The short-id join gives the result the same shape write() returns.
    const rows = await sql<SubstrateRowRecord[]>`
      WITH updated AS (
        UPDATE rows
        SET ${interleaved}
        WHERE ${this.#scope(type)}
          AND id = ${idToText(id)}
          AND ${deletedGuard}
          AND ${matchSql}
        RETURNING namespace, type, id, body, deleted_at, created_at, updated_at,
                  created_by_kind, created_by_id, updated_by_kind, updated_by_id, seq
      )
      SELECT u.id, u.body, u.deleted_at, s.short_id,
             u.created_at, u.updated_at,
             u.created_by_kind, u.created_by_id,
             u.updated_by_kind, u.updated_by_id, u.seq
      FROM updated u
      LEFT JOIN short_ids s
        ON s.namespace = u.namespace
       AND s.type = u.type
       AND s.row_id = u.id
    `;

    const row = rows[0];
    if (row === undefined) return { matched: false, row: null };
    return { matched: true, row: this.materialize(row) };
  }

  async updateField(ref: UpdateFieldRef, fieldName: string, value: unknown): Promise<void> {
    // Validation order (spec §4.5): namespace → reserved → missing.
    if (ref.ns !== undefined && ref.ns !== this.namespace) {
      throw new NamespaceMismatch(this.namespace, ref.ns);
    }
    if (fieldName === RESERVED_DELETED_AT) {
      throw new ReservedField(fieldName);
    }

    // _metadata lives only in the dedicated columns, which is where
    // materialize() reads it; writing it to the body would never be read.
    if (fieldName === '_metadata') {
      const meta = value as RowMetadata | null | undefined;
      await this.#sql`
        UPDATE rows
        SET created_at      = ${meta?.createdAt ?? null},
            updated_at      = ${meta?.updatedAt ?? null},
            created_by_kind = ${meta?.createdBy?.kind ?? null},
            created_by_id   = ${meta?.createdBy?.id ?? null},
            updated_by_kind = ${meta?.updatedBy?.kind ?? null},
            updated_by_id   = ${meta?.updatedBy?.id ?? null}
        WHERE ${this.#scope(ref.type)}
          AND id = ${idToText(ref.id)}
      `;
      return; // skip body jsonb_set
    }

    // jsonb_set with a single-element path creates the key if absent; missing
    // row is a silent no-op (UPDATE ... affects 0 rows, no throw).
    //
    // Null uses the literal `'null'::jsonb`: `sql.json(null)` binds SQL NULL,
    // and jsonb_set with a SQL NULL value nulls the whole body.
    //
    // A promoted field also updates its column, in the same UPDATE.
    const bodyFragment =
      value === null || value === undefined
        ? this.#sql`body = jsonb_set(body, ${[fieldName]}, 'null'::jsonb, true)`
        : this
            .#sql`body = jsonb_set(body, ${[fieldName]}, ${this.#sql.json(asJsonValue(value))}, true)`;

    const setFragments: Fragment[] = [bodyFragment];
    const promotedMeta = this.#promotedFor(fieldName);
    if (promotedMeta !== undefined) {
      const meta = promotedMeta;
      const colIdent = this.#sql(meta.column);
      if (value === null || value === undefined) {
        setFragments.push(this.#sql`${colIdent} = NULL`);
      } else if (meta.kind === 'boolean') {
        setFragments.push(this.#sql`${colIdent} = ${String(value)}::text::boolean`);
      } else {
        setFragments.push(this.#sql`${colIdent} = ${String(value)}::text`);
      }
    }

    const commaFrag = this.#sql`,`;
    const interleaved: Fragment[] = [setFragments[0] as Fragment];
    for (let i = 1; i < setFragments.length; i++) {
      interleaved.push(commaFrag, setFragments[i] as Fragment);
    }

    await this.#sql`
      UPDATE rows
      SET ${interleaved}
      WHERE ${this.#scope(ref.type)}
        AND id = ${idToText(ref.id)}
    `;
  }

  /**
   * `sql.begin`-backed atomicity. Spec §5.3 / G1.
   *
   * Nested calls flatten: postgres.js's `begin` inside a `begin` would create
   * a savepoint (inner rolls back independently of outer), which is stricter
   * than the G1 contract promises. To match the memory impl — where an inner
   * throw tears down outer writes too — we detect the re-entry via `#inTx`
   * and skip the nested begin entirely. The inner throw then propagates to
   * the outer `sql.begin`, which rolls back the whole thing.
   */
  async withTransaction<T>(fn: (tx: Dataset) => Promise<T>): Promise<T> {
    if (this.#inTx) return fn(this);

    // Cast is sound: the public constructor accepts `Sql`, so `this.#sql`
    // outside a tx is always `Sql` — only the internal tx-scoped instance
    // holds a `TransactionSql`, and that path enters the `#inTx` branch.
    const rootSql = this.#sql as Sql;
    return rootSql.begin<T>(async (txSql) => {
      const txDataset = new PgDataset({
        namespace: this.namespace,
        sql: txSql,
        inTx: true,
        txScopeId: this.txScopeId,
        ...(this.#fieldDefLookup !== null ? { fieldDefLookup: this.#fieldDefLookup } : {}),
        promotedColumns: this.#promotedColumns,
        layoutCache: this.#layoutCache,
        ...(this.#typeDefLookup !== null ? { typeDefLookup: this.#typeDefLookup } : {})
      });
      return fn(txDataset);
      // postgres.js's begin<T> wraps the return in UnwrapPromiseArray; for
      // our `Promise<T>`-returning fn it collapses to `T`.
    }) as Promise<T>;
  }

  /**
   * Runs `fn` in one pg transaction with a tx-bound dataset per requested
   * namespace (and the edges store, when wired), all on one `TransactionSql`.
   * A throw rolls back every namespace. Spec §5.3.
   *
   * Nested calls flatten onto the current transaction rather than opening a
   * savepoint.
   */
  async withScopedTransaction<T>(
    namespaces: ReadonlyArray<string>,
    fn: (handles: TxScopeHandles) => Promise<T>
  ): Promise<T> {
    const buildHandles = (handle: PgHandle): TxScopeHandles => {
      const datasets = new Map<string, Dataset>();
      for (const ns of namespaces) {
        datasets.set(
          ns,
          new PgDataset({
            namespace: ns,
            sql: handle,
            inTx: true,
            txScopeId: this.txScopeId,
            // Propagate the edges store reference so nested withTransaction
            // calls (flattened) retain the same enlistment behaviour.
            ...(this.#edgesStore !== null ? { edgesStore: this.#edgesStore } : {}),
            ...(this.#fieldDefLookup !== null ? { fieldDefLookup: this.#fieldDefLookup } : {}),
            promotedColumns: this.#promotedColumns,
            layoutCache: this.#layoutCache,
            ...(this.#typeDefLookup !== null ? { typeDefLookup: this.#typeDefLookup } : {})
          })
        );
      }
      // Edge mutations during `fn` share this pg transaction.
      const edges = this.#edgesStore !== null ? this.#edgesStore._enlistInTx(handle) : null;
      return { datasets, edges };
    };

    if (this.#inTx) return fn(buildHandles(this.#sql));

    const rootSql = this.#sql as Sql;
    return rootSql.begin<T>(async (txSql) => {
      return fn(buildHandles(txSql));
    }) as Promise<T>;
  }

  /**
   * See `Dataset.withAdvisoryLock`. Excludes every session on the
   * same schema, across processes. On a tx-bound instance the lock is
   * `pg_advisory_xact_lock` on the transaction's own connection, held until
   * it commits or rolls back: a session lock would need a second connection
   * beside the open transaction.
   */
  async withAdvisoryLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    if (!this.#inTx) return withPgAdvisoryLock(this.#sql as Sql, key, fn);
    await this.#sql`SELECT pg_advisory_xact_lock(hashtext(current_schema() || ':' || ${key}))`;
    return fn();
  }

  async allocateShortId(type: string): Promise<number> {
    return this.#shortIds.allocateUnbound(this.namespace, type);
  }

  async bindShortId(type: string, shortId: number, rowId: string): Promise<void> {
    await this.#shortIds.bind(this.namespace, type, shortId, rowId);
  }

  async resolveShortId(type: string, shortId: number): Promise<string | null> {
    return this.#shortIds.resolveShortId(this.namespace, type, shortId);
  }

  async getShortIdForRow(type: string, rowId: string): Promise<number | null> {
    return this.#shortIds.getShortIdForRow(this.namespace, type, rowId);
  }

  forNamespace(namespace: string): Dataset {
    if (this.#inTx) {
      throw new Error('PgDataset.forNamespace cannot be called on a tx-bound instance');
    }
    return new PgDataset({
      namespace,
      sql: this.#sql as Sql,
      inTx: false,
      ...(this.#edgesStore !== null ? { edgesStore: this.#edgesStore } : {}),
      ...(this.#fieldDefLookup !== null ? { fieldDefLookup: this.#fieldDefLookup } : {}),
      promotedColumns: this.#promotedColumns,
      layoutCache: this.#layoutCache,
      ...(this.#typeDefLookup !== null ? { typeDefLookup: this.#typeDefLookup } : {}),
      ...(this.#diskGuard !== undefined ? { diskGuard: this.#diskGuard } : {})
    });
  }

  /** The storage layout of `rows`, detected once; `'absent'` is not cached. */
  async #layout(): Promise<StorageLayout | 'absent'> {
    if (this.#layoutCache.layout !== undefined) return this.#layoutCache.layout;
    const layout = await detectLayout(this.#sql as Sql);
    if (layout !== 'absent') this.#layoutCache.layout = layout;
    return layout;
  }

  /**
   * See `Dataset.ensureTypeStorage`. On the partitioned layout, creates this
   * namespace's partition and the type's, then reconciles the type's indexes
   * on it; on legacy, reconciles only its declared `indexes`. Index builds
   * run CONCURRENTLY, outside any transaction, so a tx-bound instance refuses.
   * Logs each index it created, adopted or swapped, and records each one
   * left pending, building or failed for `describeStorage` and `storageReport`.
   */
  async ensureTypeStorage(
    type: string,
    opts: { indexes?: 'all' | 'unique' | 'nonUnique'; signal?: AbortSignal } = {}
  ): Promise<void> {
    const layout = await this.#layout();
    if (layout === 'absent') return;
    if (this.#inTx) {
      throw new Error('PgDataset.ensureTypeStorage cannot be called on a tx-bound instance');
    }
    const sql = this.#sql as Sql;
    if (layout === 'partitioned') await ensureTypeStorage(sql, this.namespace, type);
    const builds = this.#deferredBuilds();
    const qualified = `${this.namespace}/${type}`;
    const record = (s: IndexState): void => {
      if (s.state === 'pending' || s.state === 'failed') {
        builds.set(s.name, {
          state: s.state,
          type: qualified,
          ...(s.error !== undefined ? { error: s.error } : {}),
          ...(s.reason !== undefined ? { reason: s.reason } : {})
        });
      } else {
        builds.delete(s.name);
      }
    };
    let states: IndexState[];
    try {
      states = await reconcileTypeIndexes(sql, this.#indexArgs(type, this.namespace, layout), {
        only: opts.indexes ?? 'all',
        onBuild: (name) => builds.set(name, { state: 'building', type: qualified }),
        onState: record,
        ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
        ...(this.#diskGuard !== undefined ? { diskGuard: this.#diskGuard } : {})
      });
    } catch (err) {
      // Only the indexes this pass had not settled; one it settled keeps its state.
      const code = (err as { code?: unknown }).code;
      const reason = `${typeof code === 'string' ? code : 'error'}: ${
        (err instanceof Error ? err.message : String(err)).split('\n')[0]
      }`;
      for (const b of builds.values()) {
        if (b.type === qualified && b.state !== 'failed') {
          b.state = 'failed';
          b.error = reason;
          delete b.reason;
        }
      }
      throw err;
    }
    for (const s of states) {
      record(s);
      if (s.outcome === 'unchanged') continue;
      process.stdout.write(
        `[substrate] index ${s.name} on ${this.namespace}/${type}: ${s.outcome} (${s.state})\n`
      );
    }
  }

  #deferredBuilds(): Map<string, DeferredBuild> {
    const builds = deferredBuilds.get(this.#sql) ?? new Map<string, DeferredBuild>();
    deferredBuilds.set(this.#sql, builds);
    return builds;
  }

  /** Each index's catalog state, overridden by what this process knows of its build. */
  #withBuilds(states: IndexState[]): IndexState[] {
    const builds = this.#deferredBuilds();
    return states.map((s) => {
      const build = builds.get(s.name);
      if (build === undefined) return s;
      // A catalog state carries no `error`.
      return {
        ...s,
        state: build.state,
        ...(build.error !== undefined ? { error: build.error } : {}),
        ...(build.reason !== undefined ? { reason: build.reason } : {})
      };
    });
  }

  #indexArgs(type: string, namespace: string, layout: StorageLayout): ReconcileTypeIndexesArgs {
    const def = this.#typeDefLookup?.(type, namespace);
    return {
      namespace,
      type,
      layout,
      fields: def?.fields ?? {},
      indexes: def?.indexes ?? [],
      orderedBy: naturalOrderOf(def ?? {}),
      ...(def?.ordering !== undefined ? { ordering: def.ordering } : {}),
      promotedColumns: this.#promotedColumns
    };
  }

  /**
   * The type's non-unique indexes the next build pass would build or swap,
   * each with the disk guard's estimate. Empty when the store or the type's
   * storage does not exist yet. Changes nothing.
   */
  async pendingIndexBuilds(type: string): Promise<Array<{ name: string; estimateBytes: number }>> {
    const layout = await this.#layout();
    if (layout === 'absent') return [];
    const args = this.#indexArgs(type, this.namespace, layout);
    if (
      layout === 'partitioned' &&
      (await typePartition(this.#sql as Sql, this.namespace, type)) === undefined
    ) {
      return [];
    }
    return pendingIndexBuilds(this.#sql as Sql, args);
  }

  /** See `Dataset.describeStorage`. Reads the catalog only, in a fixed number of queries. */
  async describeStorage(type: string): Promise<TypeStorageReport> {
    const layout = (await this.#layout()) === 'partitioned' ? 'partitioned' : 'legacy';
    const sql = this.#sql as Sql;
    const args = this.#indexArgs(type, this.namespace, layout);
    if (layout === 'legacy') {
      return {
        layout,
        indexes: this.#withBuilds(describeTypeIndexes(args, await heldIndexes(sql, ['rows'])))
      };
    }
    const partition = await typePartition(sql, this.namespace, type);
    if (partition === undefined) return { layout, indexes: [] };
    return {
      layout,
      partition,
      indexes: this.#withBuilds(describeTypeIndexes(args, await heldIndexes(sql, [partition])))
    };
  }

  /**
   * See `Dataset.storageReport`. Spans every namespace of the database. Reads
   * the partition tree and every index on it in one query each, so its cost
   * does not grow with the number of partitions.
   */
  async storageReport(opts: { partitionBudget: number }): Promise<StorageReport> {
    const layout = await this.#layout();
    const building = [...this.#deferredBuilds()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(
        ([name, b]) =>
          `index ${name} on ${b.type} is ${b.state}${b.error !== undefined ? ` (${b.error})` : ''}` +
          `${b.reason !== undefined ? ` (${b.reason})` : ''}: ` +
          'filters it would serve scan until it is valid'
      );
    if (this.#diskGuard !== undefined && this.#diskGuard.path === undefined) {
      building.push(
        'free-disk checks before index builds are off: set SUBSTRATE_INDEX_DISK_PATH to the database volume mount, or to off when the database has no local volume'
      );
    }
    if (layout === 'absent') return { layout: 'legacy', warnings: building };
    const sql = this.#sql as Sql;
    const info = await openRecommendations(sql);
    if (layout !== 'partitioned') {
      const warnings = [...building];
      const held = await heldIndexes(sql, ['rows']);
      const partial = held.filter((i) => isEngineOwned(i) && i.predicate !== null).length;
      if (partial > LEGACY_PARTIAL_INDEX_LIMIT) {
        warnings.push(
          `${partial} engine-owned partial indexes on the shared rows table, over ${LEGACY_PARTIAL_INDEX_LIMIT}: ` +
            'every query on rows pays planning time for each; the partitioned layout gives each type its own table and indexes'
        );
      }
      const types = new Map<string, { namespace: string; type: string }>();
      for (const i of held) {
        const scope = legacyScope(i.predicate);
        if (scope !== undefined) types.set(JSON.stringify([scope.namespace, scope.type]), scope);
      }
      for (const t of types.values()) {
        this.#undeclared(warnings, info, t.namespace, t.type, 'legacy', 'rows', held);
      }
      return { layout: 'legacy', warnings, info };
    }
    const warnings = [...(await storageWarnings(sql)), ...building];
    const tree = await sql<Array<{ name: string; parent: string | null; bound: string | null }>>`
      SELECT c.relname AS name, p.relname AS parent, pg_get_expr(c.relpartbound, c.oid) AS bound
      FROM pg_partition_tree('rows') t
      JOIN pg_class c ON c.oid = t.relid
      LEFT JOIN pg_class p ON p.oid = t.parentrelid`;
    const indexes = await sql<Array<{ table: string; name: string; primary: boolean }>>`
      SELECT t.relname AS "table", c.relname AS name, i.indisprimary AS "primary"
      FROM pg_partition_tree('rows') pt
      JOIN pg_index i ON i.indrelid = pt.relid
      JOIN pg_class c ON c.oid = i.indexrelid
      JOIN pg_class t ON t.oid = pt.relid`;
    const checks = await sql<Array<{ name: string }>>`
      SELECT conname AS name FROM pg_constraint
      WHERE contype = 'c' AND conrelid = 'rows'::regclass AND NOT (conname = ANY(${ENGINE_CHECKS}))
      ORDER BY conname`;
    for (const c of checks) {
      warnings.push(
        `check ${c.name} is on the rows parent: every partition carries it, and every write evaluates it`
      );
    }
    for (const i of indexes) {
      if (i.table === 'rows' && !i.primary) {
        warnings.push(
          `index ${i.name} is on the rows parent: every partition carries a copy of it`
        );
      }
    }
    const nsOf = new Map(tree.map((t) => [t.name, listBound(t.bound)]));
    const typeParts = tree.flatMap((part) => {
      const type = listBound(part.bound);
      const ns = part.parent === null || part.parent === 'rows' ? undefined : nsOf.get(part.parent);
      return type === undefined || ns === undefined ? [] : [{ ns, type, table: part.name }];
    });
    const held = await heldIndexes(
      sql,
      typeParts.map((t) => t.table)
    );
    for (const t of typeParts) {
      this.#undeclared(warnings, info, t.ns, t.type, 'partitioned', t.table, held);
    }
    const n = tree.length - 1;
    if (n > opts.partitionBudget) {
      warnings.push(
        `${n} partitions exceed the budget of ${opts.partitionBudget}: move a namespace to its own instance behind a bridge`
      );
    }
    return { layout: 'partitioned', warnings, info };
  }

  /**
   * Notes, as info, each engine-owned index of a known type that its
   * declaration no longer asks for: the index advisor recommends its removal
   * on evidence, so it is not a fault. A type that cannot be checked warns.
   */
  #undeclared(
    warnings: string[],
    info: string[],
    ns: string,
    type: string,
    layout: StorageLayout,
    table: string,
    held: HeldIndex[]
  ): void {
    if (this.#typeDefLookup === null) return;
    const own = held.filter((i) => belongsToType(i, ns, type, layout, table));
    if (this.#typeDefLookup(type, ns) === undefined) {
      for (const i of own) {
        if (!isEngineOwned(i)) continue;
        info.push(
          `orphaned index ${i.name} on ${ns}/${type}: no registered type owns it; ${i.unique ? 'it is unique, so drop it by hand' : 'a signed propose_index remove drops it'}`
        );
      }
      return;
    }
    try {
      for (const name of undeclaredIndexes(this.#indexArgs(type, ns, layout), own)) {
        info.push(
          `undeclared index ${name} on ${ns}/${type}: kept until a signed remove drops it (the index advisor recommends one when it goes unused)`
        );
      }
    } catch (err) {
      warnings.push(
        `indexes of ${ns}/${type} could not be checked: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  /** See `Dataset.indexPlan`. */
  async indexPlan(type: string, namespace: string): Promise<IndexPlan | undefined> {
    const def = this.#typeDefLookup?.(type, namespace);
    const layout = await this.#layout();
    if (def === undefined || layout === 'absent') return undefined;
    return {
      indexes: desiredIndexKeys(this.#indexArgs(type, namespace, layout)),
      ...(def.expectedSize !== undefined ? { expectedSize: def.expectedSize } : {})
    };
  }

  /**
   * See `Dataset.dropEngineIndex`. Checks and drops under the table's index
   * build lock, so a reconcile cannot rebuild or swap the index in between.
   * Ownership is the reconciler's marker and generated name on an index of
   * this type (`typeIndexesOf`); the wanted set is the reconciler's own
   * (`desiredIndexKeys`), so only a leftover or a retracted declaration goes.
   * Refuses with `IndexDropRefusedError`.
   *
   * The drop waits for every transaction holding a lock on the table, and pg
   * cannot see a cycle through a caller that waits on this call, so each wait
   * is bounded by `lockTimeoutMs` (default `DROP_LOCK_TIMEOUT_MS`).
   */
  async dropEngineIndex(
    type: string,
    name: string,
    opts: { beforeDrop?: () => Promise<void>; lockTimeoutMs?: number } = {}
  ): Promise<void> {
    const layout = await this.#layout();
    if (this.#inTx) {
      throw new Error('PgDataset.dropEngineIndex cannot be called on a tx-bound instance');
    }
    const where = `${this.namespace}/${type}`;
    if (layout === 'absent') {
      throw new IndexDropRefusedError('unknown_index', `no index ${name} on ${where}`);
    }
    const sql = this.#sql as Sql;
    const find = async () =>
      (await typeIndexesOf(sql, this.namespace, type, layout)).find((i) => i.name === name);
    const seen = await find();
    if (seen === undefined) {
      throw new IndexDropRefusedError('unknown_index', `no index ${name} on ${where}`);
    }
    const conn = await sql.reserve();
    try {
      await withTableIndexLock(sql, conn, seen.table, undefined, async () => {
        // Again under the lock: a reconcile may have swapped or rebuilt it.
        const index = await find();
        if (index === undefined) {
          throw new IndexDropRefusedError('unknown_index', `no index ${name} on ${where}`);
        }
        if (!index.engineOwned) {
          throw new IndexDropRefusedError(
            'not_engine_owned',
            `index ${name} on ${where} was not created by substrate; drop it by hand if it must go`
          );
        }
        if (index.unique) {
          throw new IndexDropRefusedError(
            'unique_index',
            `index ${name} on ${where} is unique; retract its declaration instead`
          );
        }
        // Without a lookup the wanted set is unknown, so nothing is a leftover;
        // a type the lookup does not know is registered nowhere, so all of its
        // indexes are orphans and none is wanted.
        const lookup = this.#typeDefLookup;
        const orphan = lookup !== null && lookup(type, this.namespace) === undefined;
        const desired =
          lookup === null ||
          (!orphan &&
            (name.endsWith('_base') ||
              desiredIndexKeys(this.#indexArgs(type, this.namespace, layout)).some(
                (d) => d.name === name
              )));
        if (desired) {
          throw new IndexDropRefusedError(
            'still_desired',
            `index ${name} on ${where} is one the engine builds for this type; dropping it would only rebuild it`
          );
        }
        await opts.beforeDrop?.();
        await dropIndexBounded(conn, name, where, opts.lockTimeoutMs ?? DROP_LOCK_TIMEOUT_MS);
      });
    } finally {
      conn.release();
    }
  }

  /**
   * See `Dataset.dropNamespaceIndexes`. On legacy, the engine-owned partial
   * indexes on `rows` scoped to this namespace; on partitioned, the
   * engine-owned indexes on its type partitions, which a namespace drop
   * empties but keeps. Unique ones only when `opts.unique`. Each table's under
   * its index-build lock, CONCURRENTLY; the wait for that lock and each lock
   * wait of a drop are bounded by `lockTimeoutMs` (default
   * `DROP_LOCK_TIMEOUT_MS`), past which it throws `index_drop_timeout`.
   */
  async dropNamespaceIndexes(
    opts: { unique?: boolean; lockTimeoutMs?: number } = {}
  ): Promise<string[]> {
    const layout = await this.#layout();
    if (layout === 'absent') return [];
    if (this.#inTx) {
      throw new Error('PgDataset.dropNamespaceIndexes cannot be called on a tx-bound instance');
    }
    const sql = this.#sql as Sql;
    const ns = this.namespace;
    const tables = layout === 'legacy' ? ['rows'] : await typePartitions(sql, ns);
    const timeout = opts.lockTimeoutMs ?? DROP_LOCK_TIMEOUT_MS;
    const dropped: string[] = [];
    const conn = await sql.reserve();
    try {
      for (const table of tables) {
        try {
          await withTableIndexLock(sql, conn, table, AbortSignal.timeout(timeout), async () => {
            for (const i of await heldIndexes(conn, [table])) {
              if (!isEngineOwned(i) || (i.unique && opts.unique !== true)) continue;
              if (layout === 'legacy' && legacyScope(i.predicate)?.namespace !== ns) continue;
              await dropIndexBounded(conn, i.name, ns, timeout);
              dropped.push(i.name);
            }
          });
        } catch (err) {
          if (!(err instanceof IndexLockAborted)) throw err;
          throw new IndexDropRefusedError(
            'index_drop_timeout',
            `the index-build lock of ${table} stayed held for over ${timeout} ms; indexes of ${ns} left in place`
          );
        }
      }
    } finally {
      conn.release();
    }
    return dropped;
  }

  /** See `Dataset.indexDeclarationOf`. */
  async indexDeclarationOf(type: string, name: string): Promise<IndexDecl | undefined> {
    const layout = await this.#layout();
    if (layout === 'absent') return undefined;
    const args = this.#indexArgs(type, this.namespace, layout);
    const others = new Set(desiredIndexKeys({ ...args, indexes: [] }).map((d) => d.name));
    return args.indexes.find((decl) =>
      desiredIndexKeys({ ...args, indexes: [decl] }).some(
        (d) => d.name === name && !others.has(d.name)
      )
    );
  }

  /**
   * See `Dataset.typeStats`. Spans every namespace of the database, in a fixed
   * number of queries. Partitioned: each type partition's own statistics;
   * `liveRows` is `reltuples` (or `n_live_tup` before the first ANALYZE) and
   * counts tombstoned rows too. Legacy: see the shortcut below.
   */
  async typeStats(): Promise<TypeStats[]> {
    const layout = await this.#layout();
    if (layout === 'absent') return [];
    const sql = this.#sql as Sql;
    const toStats = (
      t: {
        namespace: string;
        type: string;
        table: string;
        liveRows: number;
        insertsTotal: number;
        updatesTotal: number;
        deletesTotal: number;
      },
      held: Awaited<ReturnType<typeof heldIndexes>>
    ): TypeStats => ({
      namespace: t.namespace,
      type: t.type,
      liveRows: Math.round(t.liveRows),
      insertsTotal: Math.round(t.insertsTotal),
      updatesTotal: Math.round(t.updatesTotal),
      deletesTotal: Math.round(t.deletesTotal),
      indexes: held
        .filter((i) => belongsToType(i, t.namespace, t.type, layout, t.table))
        .map((i) => ({
          name: i.name,
          scans: i.scans,
          lastScanAt: i.lastScanAt,
          sizeBytes: i.sizeBytes,
          unique: i.unique,
          engineOwned: isEngineOwned(i)
        }))
    });
    if (layout === 'partitioned') {
      const parts = await sql<
        Array<{
          table: string;
          nsBound: string;
          bound: string;
          liveRows: number;
          insertsTotal: number;
          updatesTotal: number;
          deletesTotal: number;
        }>
      >`
        SELECT c.relname AS "table",
               pg_get_expr(p.relpartbound, p.oid) AS "nsBound",
               pg_get_expr(c.relpartbound, c.oid) AS bound,
               (CASE WHEN c.reltuples >= 0 THEN c.reltuples ELSE COALESCE(s.n_live_tup, 0) END)::float8
                 AS "liveRows",
               COALESCE(s.n_tup_ins, 0)::float8 AS "insertsTotal",
               COALESCE(s.n_tup_upd, 0)::float8 AS "updatesTotal",
               COALESCE(s.n_tup_del, 0)::float8 AS "deletesTotal"
        FROM pg_partition_tree('rows') t
        JOIN pg_class c ON c.oid = t.relid
        JOIN pg_class p ON p.oid = t.parentrelid
        LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid
        WHERE t.level = 2`;
      const types = parts.flatMap((p) => {
        const namespace = listBound(p.nsBound);
        const type = listBound(p.bound);
        return namespace === undefined || type === undefined ? [] : [{ ...p, namespace, type }];
      });
      const held = await heldIndexes(
        sql,
        types.map((t) => t.table)
      );
      return types.map((t) => toStats(t, held));
    }
    // shortcut: a per-type count(*) over a large shared `rows` costs a scan per
    // pass. Below SAMPLE_ROWS legacy counts exactly; above it a type with a live
    // partial index (every crossRef type has its derived one) takes that index's
    // reltuples (while fresh, below), and any other type its share of a ~SAMPLE_ROWS block sample,
    // so a small one may be missing or noisy. Inserts are split by live-row
    // share (writes too), not by each type's own rate: a type's share falls as
    // others grow, so its counters can drop and the advisor re-baselines it,
    // which only delays a `remove`. Partitioning is the upgrade.
    // `n_live_tup` sizes it before the first ANALYZE, when reltuples is -1, so
    // a never-analyzed large `rows` is still sampled rather than scanned.
    const [table] = await sql<
      Array<{ fresh: boolean; size: number; inserts: number; updates: number; deletes: number }>
    >`
      SELECT c.reltuples > 0
               AND COALESCE(s.n_mod_since_analyze, 0) <= ${INDEX_COUNT_STALE} * c.reltuples
               AS fresh,
             GREATEST(c.reltuples, COALESCE(s.n_live_tup, 0))::float8 AS size,
             COALESCE(s.n_tup_ins, 0)::float8 AS inserts,
             COALESCE(s.n_tup_upd, 0)::float8 AS updates,
             COALESCE(s.n_tup_del, 0)::float8 AS deletes
      FROM pg_class c LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid
      WHERE c.oid = 'rows'::regclass`;
    const size = table?.size ?? 0;
    const sampled = size > SAMPLE_ROWS;
    const sample = sql.unsafe(
      sampled ? `rows TABLESAMPLE SYSTEM (${(100 * SAMPLE_ROWS) / size})` : 'rows'
    );
    const counts = await sql<Array<{ namespace: string; type: string; all: number; live: number }>>`
      SELECT namespace, type, count(*)::float8 AS "all",
             (count(*) FILTER (WHERE deleted_at IS NULL))::float8 AS live
      FROM ${sample} GROUP BY namespace, type`;
    const total = counts.reduce((n, c) => n + c.all, 0);
    const held = await heldIndexes(sql, ['rows']);
    const live = new Map<string, { namespace: string; type: string; liveRows: number }>();
    for (const c of counts) {
      live.set(JSON.stringify([c.namespace, c.type]), {
        namespace: c.namespace,
        type: c.type,
        liveRows: sampled ? (c.live * size) / total : c.live
      });
    }
    // An index's count is as old as the last ANALYZE, VACUUM or build: one built
    // on a type's empty share reads 0 however many rows follow. So it is trusted
    // only while `rows` has changed by under INDEX_COUNT_STALE since its last
    // ANALYZE (`rows.reltuples >= 0` is not enough: that same build sets it to 0).
    if (sampled && table?.fresh === true) {
      const fromIndex = new Map<string, { namespace: string; type: string; liveRows: number }>();
      for (const i of held) {
        const scope = legacyLiveScope(i.predicate);
        // 0 is no evidence of an empty type: ANALYZE estimates a partial index's
        // count from its sample, which can miss a small type on a large `rows`.
        if (scope === undefined || i.reltuples <= 0) continue;
        const key = JSON.stringify([scope.namespace, scope.type]);
        const seen = fromIndex.get(key);
        if (seen === undefined || i.reltuples > seen.liveRows) {
          fromIndex.set(key, { ...scope, liveRows: i.reltuples });
        }
      }
      for (const [key, t] of fromIndex) live.set(key, t);
    }
    const liveTotal = Math.max(
      size,
      [...live.values()].reduce((n, t) => n + t.liveRows, 0)
    );
    const share = (n: number | undefined, rows: number): number =>
      liveTotal > 0 ? ((n ?? 0) * rows) / liveTotal : 0;
    return [...live.values()].map((t) =>
      toStats(
        {
          ...t,
          table: 'rows',
          insertsTotal: share(table?.inserts, t.liveRows),
          updatesTotal: share(table?.updates, t.liveRows),
          deletesTotal: share(table?.deletes, t.liveRows)
        },
        held
      )
    );
  }

  private materialize(record: SubstrateRowRecord): Row {
    const body = record.body ?? {};
    // Prefer the body.id (preserves number vs string at write time) over the
    // text PK column when present.
    const originalId = this.extractOriginalId(record.id, body);

    const out: Row = { id: originalId };
    for (const [k, v] of Object.entries(body)) {
      if (k === 'id') continue;
      if (k === RESERVED_DELETED_AT) continue; // defensive — should never appear in body
      if (k === '_metadata') continue; // defensive — stripped on write, but guard on read too
      out[k] = v;
    }
    if (record.deleted_at !== null) {
      out._deletedAt = record.deleted_at;
    }
    if (record.short_id !== null && record.short_id !== undefined) {
      // postgres.js returns bigint columns as strings; coerce to JS number.
      // shortId values fit safely in Number (52-bit integer range).
      out.shortId = Number(record.short_id);
    }

    const meta = assembleRowMetadata(record);
    if (meta !== undefined) out._metadata = meta;

    return out;
  }

  private extractOriginalId(textId: string, body: Record<string, unknown>): Id {
    const bodyId = body.id;
    if (typeof bodyId === 'number' || typeof bodyId === 'string') return bodyId;
    return textId;
  }
}

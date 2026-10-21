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
  ReadParams,
  ReadResult,
  Row,
  RowMetadata,
  TxScopeHandles,
  UpdateFieldRef,
  WriteOptions,
  WriteResult
} from '@mnmal-ai/substrate-types';
import type { Sql } from 'postgres';
import { withPgAdvisoryLock } from './advisory-lock.js';
import { NamespaceMismatch, ReservedField } from './errors.js';
import type { PgEdgesStore } from './pg-edges-store.js';
import { PgShortIdStore } from './pg-short-id-store.js';
import {
  asJsonValue,
  assembleRowMetadata,
  type BodyOrderByCast,
  buildBodyProjection,
  buildCursorCompare,
  buildOrderBy,
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
  resolvePromotedColumns
} from './pg-sql.js';
import { type PgHandle, txScopeIdFor } from './tx-scope.js';

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
   * its kernel migrations: the engine creates none. Two things that bite:
   *
   *   - Filters and sorts route to the column and ONLY the column, so a column
   *     added over existing rows must be backfilled from the body first, or
   *     those rows miss every filter. Reads return the body.
   *   - `column` is a BARE name (`'severity'`, not `'r.severity'`) and is
   *     validated as an identifier at construction, because it is interpolated
   *     into SQL as an identifier.
   */
  promotedColumns?: PromotedBodyColumnMap;
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
}

const RESERVED_DELETED_AT = '_deletedAt';

interface SubstrateRowRecord {
  id: string;
  body: Record<string, unknown>;
  deleted_at: Date | null;
  /** Populated by the LEFT JOIN on short_ids; null when no binding exists. */
  short_id: number | null;
  // Row-metadata columns. NULL for legacy rows.
  created_at: Date | null;
  updated_at: Date | null;
  created_by_kind: string | null;
  created_by_id: string | null;
  updated_by_kind: string | null;
  updated_by_id: string | null;
}

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
  }

  /**
   * Reads rows of `type` per the §5.2 filter contract (where / orderBy /
   * cursor / limit). Every value is bound through a parameterised slot.
   *
   * Body values extract as text and are cast for comparison only; the filter
   * validator has already rejected type mismatches.
   */
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
    // ambiguity with the LEFT-joined short_ids alias `s`.
    const clauses: Fragment[] = [];
    clauses.push(sql`r.namespace = ${this.namespace}`);
    clauses.push(sql`r.type = ${type}`);
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

    // Cursor: add a tuple-compare clause so the next page starts strictly
    // after the cursor's (orderBy-values, id) tuple.
    if (params.cursor !== undefined && params.cursor !== '') {
      const cursor = decodeCursor(params.cursor);
      const cursorFragment = buildCursorCompare(
        sql,
        orderBy,
        cursor.orderByValues,
        cursor.id,
        orderByCastFor,
        this.#promotedFor
      );
      if (cursorFragment !== null) clauses.push(cursorFragment);
    }

    const whereSql = combineAnd(sql, clauses);
    const orderBySql = buildOrderBy(sql, orderBy, orderByCastFor, this.#promotedFor);

    // Fetch one extra row to determine hasMore without a second query.
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

    const rows = await sql<SubstrateRowRecord[]>`
      SELECT r.id, ${bodyProjection} AS body, r.deleted_at, s.short_id,
             r.created_at, r.updated_at,
             r.created_by_kind, r.created_by_id,
             r.updated_by_kind, r.updated_by_id${sortKeyProjection}
      FROM rows r
      LEFT JOIN short_ids s
        ON s.namespace = r.namespace
       AND s.type = r.type
       AND s.row_id = r.id
      WHERE ${whereSql}
      ${orderBySql}
      ${fetchLimit !== undefined ? sql`LIMIT ${fetchLimit}` : sql``}
    `;

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
        id: last.id
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

  async write(type: string, rows: Row[], options?: WriteOptions): Promise<WriteResult> {
    const ids: Id[] = [];
    if (rows.length === 0) return { written: 0, ids, rows: [] };

    const sql = this.#sql;

    const fallbackNow = (options?.now ?? new Date()).toISOString();
    const fallbackActor = options?.identity ?? null;

    // Per-column arrays, one UNNEST slot each. `_deletedAt` and `_metadata`
    // are stripped from the body: each lives only in its own column(s).
    const namespaces: string[] = [];
    const types: string[] = [];
    const idsCol: string[] = [];
    const bodies: string[] = [];
    const createdAts: (string | null)[] = [];
    const updatedAts: (string | null)[] = [];
    const createdByKinds: (string | null)[] = [];
    const createdByIds: (string | null)[] = [];
    const updatedByKinds: (string | null)[] = [];
    const updatedByIds: (string | null)[] = [];

    for (const row of rows) {
      if (row.id === undefined || row.id === null) {
        throw new Error(`write: row.id is required (type='${type}')`);
      }
      // The engine always supplies _metadata; raw writes get it auto-filled.
      const meta: RowMetadata = (row._metadata as RowMetadata | undefined) ?? {
        createdAt: fallbackNow,
        updatedAt: fallbackNow,
        createdBy: fallbackActor,
        updatedBy: fallbackActor
      };
      const sanitised: Record<string, unknown> = { id: row.id };
      for (const [k, v] of Object.entries(row)) {
        if (k === RESERVED_DELETED_AT) continue;
        if (k === '_metadata') continue;
        if (k === 'id') continue;
        sanitised[k] = v;
      }
      ids.push(row.id);
      namespaces.push(this.namespace);
      types.push(type);
      idsCol.push(idToText(row.id));
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

    // Single round-trip upsert + merged-row read. The CTE pipeline:
    //   `input`     — UNNEST of caller arrays WITH ORDINALITY, to preserve
    //                 input order.
    //   `upserted`  — the INSERT...ON CONFLICT...DO UPDATE, RETURNING the
    //                 post-merge row state.
    //   final SELECT joins back to `input.ord` and the short-id sidecar so
    //                 callers get the same shape `read()` emits.
    const records = await sql<SubstrateRowRecord[]>`
      WITH input AS (
        SELECT *
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
      ),
      upserted AS (
        INSERT INTO rows (namespace, type, id, body, deleted_at,
          created_at, updated_at, created_by_kind, created_by_id,
          updated_by_kind, updated_by_id${insertColumnList})
        SELECT
          ns, ty, rid, bod::jsonb, NULL::timestamptz,
          ca::timestamptz, ua::timestamptz, cbk, cbi, ubk, ubi${insertColumnValues}
        FROM input
        ${onConflict}
        RETURNING namespace, type, id, body, deleted_at,
                  created_at, updated_at, created_by_kind, created_by_id,
                  updated_by_kind, updated_by_id
      )
      SELECT u.id, u.body, u.deleted_at, s.short_id,
             u.created_at, u.updated_at,
             u.created_by_kind, u.created_by_id,
             u.updated_by_kind, u.updated_by_id
      FROM upserted u
      JOIN input i ON i.rid = u.id
      LEFT JOIN short_ids s
        ON s.namespace = u.namespace
       AND s.type = u.type
       AND s.row_id = u.id
      ORDER BY i.ord
    `;

    const merged = records.map((r) => this.materialize(r));
    if (options?.insertOnly === true) {
      return { written: merged.length, ids: merged.map((r) => r.id), rows: merged };
    }
    return { written: ids.length, ids, rows: merged };
  }

  async tombstone(type: string, ids: Id[]): Promise<DeleteResult> {
    if (ids.length === 0) return { deleted: 0, ids: [] };

    const textIds = ids.map(idToText);

    // Only stamp rows that are not already tombstoned — tombstone is terminal
    // and must preserve the original timestamp on a second call.
    const rows = await this.#sql<{ id: string; body: Record<string, unknown> }[]>`
      UPDATE rows
      SET deleted_at = now()
      WHERE namespace = ${this.namespace}
        AND type = ${type}
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
      WHERE namespace = ${this.namespace}
        AND type = ${type}
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
      WHERE namespace = ${this.namespace} AND type = ${type}
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
      WHERE namespace = ${this.namespace}
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
        WHERE namespace = ${this.namespace}
          AND type = ${type}
          AND id = ${idToText(id)}
          AND ${deletedGuard}
          AND ${matchSql}
        RETURNING namespace, type, id, body, deleted_at, created_at, updated_at,
                  created_by_kind, created_by_id, updated_by_kind, updated_by_id
      )
      SELECT u.id, u.body, u.deleted_at, s.short_id,
             u.created_at, u.updated_at,
             u.created_by_kind, u.created_by_id,
             u.updated_by_kind, u.updated_by_id
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
        WHERE namespace = ${this.namespace}
          AND type = ${ref.type}
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
      WHERE namespace = ${this.namespace}
        AND type = ${ref.type}
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
        promotedColumns: this.#promotedColumns
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
            promotedColumns: this.#promotedColumns
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
   * database, across processes. On a tx-bound instance the lock is
   * `pg_advisory_xact_lock` on the transaction's own connection, held until
   * it commits or rolls back: a session lock would need a second connection
   * beside the open transaction.
   */
  async withAdvisoryLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    if (!this.#inTx) return withPgAdvisoryLock(this.#sql as Sql, key, fn);
    await this.#sql`SELECT pg_advisory_xact_lock(hashtext(${key}))`;
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
      ...(this.#edgesStore !== null ? { edgesStore: this.#edgesStore } : {}),
      ...(this.#fieldDefLookup !== null ? { fieldDefLookup: this.#fieldDefLookup } : {}),
      promotedColumns: this.#promotedColumns
    });
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

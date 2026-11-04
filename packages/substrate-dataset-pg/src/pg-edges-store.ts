/**
 * PgEdgesStore — PostgreSQL-backed reference implementation of EdgesStore.
 * Spec: §4.6, §6.2, §6.3.
 *
 * One table (`edges`) keyed by a text PK, no namespace scoping — edges
 * are engine-scoped (§4.6), not per-ns. The caller owns the `postgres` Sql
 * connection; this class never opens or closes pools.
 *
 * Edge ids are `crypto.randomUUID()`: unique, so cursor pagination works, but
 * not time-ordered. The sweep walks the whole table, so it doesn't need order.
 *
 * Edge.from/to .id is `string | number`, stored and read back as text (unlike
 * PgDataset, which preserves numeric ids).
 *
 * SQL safety: postgres.js tagged templates parameterise every value slot.
 * Never string-concat caller input — the `update` dynamic column list uses a
 * fixed allowlist of column names, not user-supplied keys.
 */

import { randomUUID } from 'node:crypto';
import type {
  CanDeleteResult,
  Edge,
  EdgePatch,
  EdgeRef,
  EdgesStore,
  EdgeWriteInput,
  OnDelete
} from '@mnmal-ai/substrate-types';
import type { PendingQuery, Row as PgRow, Sql } from 'postgres';
import { type PgHandle, txScopeIdFor } from './tx-scope.js';

type Fragment = PendingQuery<PgRow[]>;

const MUTABLE_PATCH_FIELDS = new Set(['id', 'lastSweptAt', 'blocked']);

/**
 * Batch size for chunked admin deletes (`dropEdgesByNamespace`,
 * `dropEdgesByType`): bounds per-statement lock hold on large tables.
 */
const DEFAULT_DROP_BATCH_SIZE = 5_000;

const VALID_POLICIES: ReadonlySet<OnDelete> = new Set([
  'set_null',
  'cascade',
  'restrict',
  'orphan'
]);

export interface PgEdgesStoreOptions {
  sql: Sql;
  /** Injected clock for tests. Defaults to `() => new Date()`. */
  now?: () => Date;
  /**
   * Per-statement batch size for chunked admin deletes. Defaults to
   * {@link DEFAULT_DROP_BATCH_SIZE}.
   */
  dropBatchSize?: number;
}

interface InternalPgEdgesStoreOptions {
  sql: PgHandle;
  now: () => Date;
  inTx: boolean;
  /**
   * Tx-bound instances inherit their parent's txScopeId. The public
   * constructor derives it from the Sql reference.
   */
  txScopeId?: string;
  dropBatchSize?: number;
}

interface EdgeRowRecord {
  id: string;
  from_ns: string;
  from_type: string;
  from_id: string;
  from_bridged: boolean;
  to_ns: string;
  to_type: string;
  to_id: string;
  to_bridged: boolean;
  field_name: string;
  policy: string;
  created_at: Date;
  deleted_at: Date | null;
  last_swept_at: Date | null;
  blocked: boolean;
}

const refToId = (id: EdgeRef['id']): string => (typeof id === 'number' ? String(id) : id);

export class PgEdgesStore implements EdgesStore {
  readonly #sql: PgHandle;
  readonly #now: () => Date;
  readonly #inTx: boolean;
  readonly #dropBatchSize: number;
  readonly txScopeId: string;

  get #edgeCols(): Fragment {
    return this
      .#sql`id, from_ns, from_type, from_id, from_bridged, to_ns, to_type, to_id, to_bridged, field_name, policy, created_at, deleted_at, last_swept_at, blocked`;
  }

  constructor(options: PgEdgesStoreOptions | InternalPgEdgesStoreOptions) {
    this.#sql = options.sql;
    this.#now = options.now ?? ((): Date => new Date());
    this.#inTx = 'inTx' in options ? options.inTx : false;
    const explicit = 'txScopeId' in options ? options.txScopeId : undefined;
    this.txScopeId = explicit ?? txScopeIdFor(options.sql);
    const batch = options.dropBatchSize;
    if (batch !== undefined && (!Number.isFinite(batch) || batch <= 0)) {
      throw new Error(`PgEdgesStore: dropBatchSize must be a positive finite number, got ${batch}`);
    }
    this.#dropBatchSize = batch ?? DEFAULT_DROP_BATCH_SIZE;
  }

  async write(input: EdgeWriteInput): Promise<Edge> {
    const id = randomUUID();
    const createdAt = this.#now();
    const fromBridged = input.from.bridged === true;
    const toBridged = input.to.bridged === true;

    await this.#sql`
      INSERT INTO edges (
        id, from_ns, from_type, from_id, from_bridged,
        to_ns, to_type, to_id, to_bridged,
        field_name, policy, created_at, deleted_at, last_swept_at, blocked
      )
      VALUES (
        ${id},
        ${input.from.ns}, ${input.from.type}, ${refToId(input.from.id)}, ${fromBridged},
        ${input.to.ns}, ${input.to.type}, ${refToId(input.to.id)}, ${toBridged},
        ${input.fieldName}, ${input.policy}, ${createdAt},
        NULL, NULL, false
      )
    `;

    return {
      id,
      from: buildRef(input.from.ns, input.from.type, refToId(input.from.id), fromBridged),
      to: buildRef(input.to.ns, input.to.type, refToId(input.to.id), toBridged),
      fieldName: input.fieldName,
      policy: input.policy,
      createdAt
    };
  }

  async writeMany(inputs: readonly EdgeWriteInput[]): Promise<Edge[]> {
    if (inputs.length === 0) return [];
    const edges = inputs.map((input): Edge => {
      return {
        id: randomUUID(),
        from: buildRef(
          input.from.ns,
          input.from.type,
          refToId(input.from.id),
          input.from.bridged === true
        ),
        to: buildRef(input.to.ns, input.to.type, refToId(input.to.id), input.to.bridged === true),
        fieldName: input.fieldName,
        policy: input.policy,
        createdAt: this.#now()
      };
    });
    // One INSERT whatever the count: a column per array, zipped by `unnest`,
    // so the statement text never grows with the batch. Booleans and
    // timestamps travel as text and are cast here, because postgres.js
    // serialises a bare ::boolean[] parameter unreliably.
    await this.#sql`
      INSERT INTO edges (
        id, from_ns, from_type, from_id, from_bridged,
        to_ns, to_type, to_id, to_bridged,
        field_name, policy, created_at, deleted_at, last_swept_at, blocked
      )
      SELECT t.id, t.from_ns, t.from_type, t.from_id, t.from_bridged::boolean,
             t.to_ns, t.to_type, t.to_id, t.to_bridged::boolean,
             t.field_name, t.policy, t.created_at::timestamptz, NULL, NULL, false
      FROM unnest(
        ${edges.map((e) => e.id)}::uuid[],
        ${edges.map((e) => e.from.ns)}::text[],
        ${edges.map((e) => e.from.type)}::text[],
        ${edges.map((e) => String(e.from.id))}::text[],
        ${edges.map((e) => String(e.from.bridged === true))}::text[],
        ${edges.map((e) => e.to.ns)}::text[],
        ${edges.map((e) => e.to.type)}::text[],
        ${edges.map((e) => String(e.to.id))}::text[],
        ${edges.map((e) => String(e.to.bridged === true))}::text[],
        ${edges.map((e) => e.fieldName)}::text[],
        ${edges.map((e) => e.policy)}::text[],
        ${edges.map((e) => e.createdAt.toISOString())}::text[]
      ) AS t(id, from_ns, from_type, from_id, from_bridged,
             to_ns, to_type, to_id, to_bridged, field_name, policy, created_at)
    `;
    return edges;
  }

  async tombstoneMany(ids: readonly string[], at?: Date): Promise<void> {
    if (ids.length === 0) return;
    // Same `deleted_at IS NULL` guard as `tombstone`: the first stamp stays.
    await this.#sql`
      UPDATE edges
      SET deleted_at = ${at ?? this.#now()}
      WHERE id = ANY(${ids as string[]}::uuid[])
        AND deleted_at IS NULL
    `;
  }

  async tombstone(id: string, at?: Date): Promise<void> {
    const stamp = at ?? this.#now();
    // `deleted_at IS NULL` guard keeps tombstone terminal — a second call
    // preserves the original stamp without us re-running the caller check.
    await this.#sql`
      UPDATE edges
      SET deleted_at = ${stamp}
      WHERE id = ${id}
        AND deleted_at IS NULL
    `;
  }

  /**
   * Hard-deletes tombstoned edges whose `deleted_at` is older than
   * `olderThan`. Called by the sweep loop. Returns the number deleted.
   */
  async purgeTombstonedEdges(opts: { olderThan: Date }): Promise<{ deleted: number }> {
    const rows = await this.#sql<{ id: string }[]>`
      DELETE FROM edges
      WHERE deleted_at IS NOT NULL
        AND deleted_at < ${opts.olderThan}
      RETURNING id
    `;
    return { deleted: rows.length };
  }

  async update(patch: EdgePatch): Promise<void> {
    for (const key of Object.keys(patch)) {
      if (!MUTABLE_PATCH_FIELDS.has(key)) {
        throw new Error(`EdgesStore.update: field '${key}' is immutable`);
      }
    }

    // Column names come from this fixed set, never from caller input.
    const hasLastSweptAt = Object.hasOwn(patch, 'lastSweptAt');
    const hasBlocked = Object.hasOwn(patch, 'blocked');
    if (!hasLastSweptAt && !hasBlocked) return;

    if (hasLastSweptAt && hasBlocked) {
      await this.#sql`
        UPDATE edges
        SET last_swept_at = ${patch.lastSweptAt ?? null},
            blocked = ${patch.blocked ?? false}
        WHERE id = ${patch.id}
      `;
      return;
    }
    if (hasLastSweptAt) {
      await this.#sql`
        UPDATE edges
        SET last_swept_at = ${patch.lastSweptAt ?? null}
        WHERE id = ${patch.id}
      `;
      return;
    }
    // hasBlocked only.
    await this.#sql`
      UPDATE edges
      SET blocked = ${patch.blocked ?? false}
      WHERE id = ${patch.id}
    `;
  }

  async readNextBatch(
    cursorId: string | null,
    size: number
  ): Promise<{ edges: Edge[]; lastId: string | null }> {
    // Includes tombstoned edges, as MemoryEdgesStore does; the sweep (§6.3)
    // skips them itself.
    const rows =
      cursorId === null
        ? await this.#sql<EdgeRowRecord[]>`
          SELECT ${this.#edgeCols}
          FROM edges
          ORDER BY id ASC
          LIMIT ${size}
        `
        : await this.#sql<EdgeRowRecord[]>`
          SELECT ${this.#edgeCols}
          FROM edges
          WHERE id > ${cursorId}
          ORDER BY id ASC
          LIMIT ${size}
        `;

    const edges = rows.map(rowToEdge);
    const last = edges[edges.length - 1];
    return { edges, lastId: last ? last.id : null };
  }

  async findEdgesTo(ref: EdgeRef): Promise<Edge[]> {
    const rows = await this.#sql<EdgeRowRecord[]>`
      SELECT ${this.#edgeCols}
      FROM edges
      WHERE to_ns = ${ref.ns}
        AND to_type = ${ref.type}
        AND to_id = ${refToId(ref.id)}
        AND deleted_at IS NULL
    `;
    return rows.map(rowToEdge);
  }

  async findEdgesToMany(refs: readonly EdgeRef[]): Promise<Edge[]> {
    return this.#findMany('to', refs);
  }

  async findEdgesFromMany(refs: readonly EdgeRef[]): Promise<Edge[]> {
    return this.#findMany('from', refs);
  }

  async #findMany(side: 'to' | 'from', refs: readonly EdgeRef[]): Promise<Edge[]> {
    if (refs.length === 0) return [];
    const sql = this.#sql;
    // Dedup so a repeated ref doesn't multiply matched edges through the join.
    const seenRef = new Set<string>();
    const seekNs: string[] = [];
    const seekType: string[] = [];
    const seekId: string[] = [];
    for (const r of refs) {
      const id = refToId(r.id);
      const k = `${r.ns}\u0000${r.type}\u0000${id}`;
      if (seenRef.has(k)) continue;
      seenRef.add(k);
      seekNs.push(r.ns);
      seekType.push(r.type);
      seekId.push(id);
    }
    // One round-trip via a zipped `unnest` of typed text arrays: postgres.js
    // cannot parameterise tuple `IN`/`VALUES` lists. Join columns are prefixed
    // so they don't collide with the edges columns in #edgeCols. The side picks
    // between two fixed identifier sets, never caller text.
    const [colNs, colType, colId] =
      side === 'to'
        ? [sql('to_ns'), sql('to_type'), sql('to_id')]
        : [sql('from_ns'), sql('from_type'), sql('from_id')];
    const rows = await sql<EdgeRowRecord[]>`
      SELECT ${this.#edgeCols}
      FROM edges
      JOIN unnest(${seekNs}::text[], ${seekType}::text[], ${seekId}::text[])
        AS seek(seek_ns, seek_type, seek_id)
        ON ${colNs} = seek.seek_ns AND ${colType} = seek.seek_type AND ${colId} = seek.seek_id
      WHERE deleted_at IS NULL
    `;
    return rows.map(rowToEdge);
  }

  async findEdgesFrom(ref: EdgeRef): Promise<Edge[]> {
    const rows = await this.#sql<EdgeRowRecord[]>`
      SELECT ${this.#edgeCols}
      FROM edges
      WHERE from_ns = ${ref.ns}
        AND from_type = ${ref.type}
        AND from_id = ${refToId(ref.id)}
        AND deleted_at IS NULL
    `;
    return rows.map(rowToEdge);
  }

  async findEdgesTouchingNamespace(namespace: string, limit: number): Promise<Edge[]> {
    // ORDER BY id (the PK, so no sort step) keeps repeated calls in agreement;
    // the refuse-cascade drop path calls this twice.
    const rows = await this.#sql<EdgeRowRecord[]>`
      SELECT ${this.#edgeCols}
      FROM edges
      WHERE deleted_at IS NULL
        AND (from_ns = ${namespace} OR to_ns = ${namespace})
      ORDER BY id ASC
      LIMIT ${limit}
    `;
    return rows.map(rowToEdge);
  }

  async findEdgesTouchingType(namespace: string, type: string, limit: number): Promise<Edge[]> {
    // ORDER BY id ASC — same rationale as findEdgesTouchingNamespace above.
    const rows = await this.#sql<EdgeRowRecord[]>`
      SELECT ${this.#edgeCols}
      FROM edges
      WHERE deleted_at IS NULL
        AND ((from_ns = ${namespace} AND from_type = ${type})
          OR (to_ns = ${namespace} AND to_type = ${type}))
      ORDER BY id ASC
      LIMIT ${limit}
    `;
    return rows.map(rowToEdge);
  }

  async namespacesLinkedTo(namespace: string, type?: string): Promise<string[]> {
    const fromMatch =
      type === undefined
        ? this.#sql`from_ns = ${namespace}`
        : this.#sql`(from_ns = ${namespace} AND from_type = ${type})`;
    const toMatch =
      type === undefined
        ? this.#sql`to_ns = ${namespace}`
        : this.#sql`(to_ns = ${namespace} AND to_type = ${type})`;
    const rows = await this.#sql<{ ns: string }[]>`
      SELECT ns FROM (
        SELECT to_ns AS ns FROM edges WHERE ${fromMatch}
        UNION
        SELECT from_ns AS ns FROM edges WHERE ${toMatch}
      ) linked
      WHERE ns <> ${namespace}
      ORDER BY ns
    `;
    return rows.map((r) => r.ns);
  }

  /**
   * Chunked physical delete of every edge touching `namespace`, at most
   * `dropBatchSize` rows per statement, so a large delete does not hold every
   * row lock at once. Returns the number deleted.
   *
   * Outside a tx each batch auto-commits. Inside a caller's tx the batches
   * stay in it, so a throw still rolls back the whole drop.
   */
  async dropEdgesByNamespace(namespace: string, within?: readonly string[]): Promise<number> {
    const batchSize = this.#dropBatchSize;
    const farEnd = this.#farEndWithin(
      namespace,
      within,
      this.#sql`from_ns = ${namespace}`,
      this.#sql`to_ns = ${namespace}`
    );
    let total = 0;
    while (true) {
      const rows = await this.#sql`
        DELETE FROM edges
        WHERE id IN (
          SELECT id FROM edges
          WHERE (from_ns = ${namespace} OR to_ns = ${namespace}) ${farEnd}
          LIMIT ${batchSize}
        )
        RETURNING id
      `;
      total += rows.length;
      if (rows.length < batchSize) return total;
      await this.#yieldBetweenBatches();
    }
  }

  /**
   * Chunked physical delete of every edge touching `(namespace, type)`.
   * See {@link dropEdgesByNamespace} for the lock-hold + tx semantics.
   */
  async dropEdgesByType(
    namespace: string,
    type: string,
    within?: readonly string[]
  ): Promise<number> {
    const batchSize = this.#dropBatchSize;
    const fromMatch = this.#sql`(from_ns = ${namespace} AND from_type = ${type})`;
    const toMatch = this.#sql`(to_ns = ${namespace} AND to_type = ${type})`;
    const farEnd = this.#farEndWithin(namespace, within, fromMatch, toMatch);
    let total = 0;
    while (true) {
      const rows = await this.#sql`
        DELETE FROM edges
        WHERE id IN (
          SELECT id FROM edges
          WHERE (${fromMatch} OR ${toMatch}) ${farEnd}
          LIMIT ${batchSize}
        )
        RETURNING id
      `;
      total += rows.length;
      if (rows.length < batchSize) return total;
      await this.#yieldBetweenBatches();
    }
  }

  /** `AND` clause keeping only edges whose far end is `namespace` or in `within`. */
  #farEndWithin(
    namespace: string,
    within: readonly string[] | undefined,
    fromMatch: PendingQuery<PgRow[]>,
    toMatch: PendingQuery<PgRow[]>
  ): PendingQuery<PgRow[]> {
    if (within === undefined) return this.#sql``;
    const allowed = this.#sql([namespace, ...within]);
    return this
      .#sql`AND ((${fromMatch} AND to_ns IN ${allowed}) OR (${toMatch} AND from_ns IN ${allowed}))`;
  }

  /**
   * Yields to the event loop between drop batches outside a tx; no-op inside one.
   */
  async #yieldBetweenBatches(): Promise<void> {
    if (!this.#inTx) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }

  async canDelete(ref: EdgeRef): Promise<CanDeleteResult> {
    const rows = await this.#sql<EdgeRowRecord[]>`
      SELECT ${this.#edgeCols}
      FROM edges
      WHERE to_ns = ${ref.ns}
        AND to_type = ${ref.type}
        AND to_id = ${refToId(ref.id)}
        AND policy = 'restrict'
        AND deleted_at IS NULL
    `;
    if (rows.length === 0) return { ok: true };
    return { ok: false, blockedBy: rows.map(rowToEdge) };
  }

  async findBlocked(): Promise<Edge[]> {
    const rows = await this.#sql<EdgeRowRecord[]>`
      SELECT ${this.#edgeCols}
      FROM edges
      WHERE blocked = true
        AND deleted_at IS NULL
    `;
    return rows.map(rowToEdge);
  }

  /**
   * `sql.begin`-backed atomicity. Same flattening pattern as PgDataset —
   * nested re-entry skips the inner begin and runs on the existing tx handle
   * so an inner throw propagates to the outer `sql.begin` for rollback.
   */
  async withTransaction<T>(fn: (tx: EdgesStore) => Promise<T>): Promise<T> {
    if (this.#inTx) return fn(this);

    // Cast is sound: the public constructor accepts `Sql`, so `this.#sql`
    // outside a tx is always `Sql`. Tx-scoped instances (#inTx === true) hold
    // a TransactionSql, but they short-circuit on the line above.
    const rootSql = this.#sql as Sql;
    return rootSql.begin<T>(async (txSql) => {
      const txStore = new PgEdgesStore({
        sql: txSql,
        now: this.#now,
        inTx: true,
        txScopeId: this.txScopeId,
        dropBatchSize: this.#dropBatchSize
      });
      return fn(txStore);
    }) as Promise<T>;
  }

  /**
   * Engine-only. Returns a tx-bound clone on the supplied `TransactionSql`,
   * for `PgDataset.withScopedTransaction`. The caller has verified
   * the txScopeIds match.
   */
  _enlistInTx(txSql: PgHandle): PgEdgesStore {
    return new PgEdgesStore({
      sql: txSql,
      now: this.#now,
      inTx: true,
      txScopeId: this.txScopeId,
      dropBatchSize: this.#dropBatchSize
    });
  }
}

function buildRef(ns: string, type: string, id: string, bridged: boolean): EdgeRef {
  const ref: EdgeRef = { ns, type, id };
  if (bridged) ref.bridged = true;
  return ref;
}

function rowToEdge(row: EdgeRowRecord): Edge {
  // `policy` is stored as text; an unknown value is a migration bug, so throw.
  if (!VALID_POLICIES.has(row.policy as OnDelete)) {
    throw new Error(`PgEdgesStore: unknown policy '${row.policy}' on edge id=${row.id}`);
  }
  const edge: Edge = {
    id: row.id,
    from: buildRef(row.from_ns, row.from_type, row.from_id, row.from_bridged),
    to: buildRef(row.to_ns, row.to_type, row.to_id, row.to_bridged),
    fieldName: row.field_name,
    policy: row.policy as OnDelete,
    createdAt: row.created_at
  };
  if (row.deleted_at !== null) edge.deletedAt = row.deleted_at;
  if (row.last_swept_at !== null) edge.lastSweptAt = row.last_swept_at;
  if (row.blocked) edge.blocked = true;
  return edge;
}

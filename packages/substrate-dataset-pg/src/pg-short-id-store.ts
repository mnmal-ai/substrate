/**
 * PgShortIdStore — pg-backed allocator + lookup for shortId, scoped per
 * (namespace, type). One postgres sequence per (ns, type), lazily created.
 * All methods accept a PG handle (Sql or TransactionSql) so the caller can
 * participate in the surrounding transaction.
 */

import type { Sql, TransactionSql } from 'postgres';

type PgHandle = Sql | TransactionSql;

/**
 * Derives a sequence name from (ns, type): lowercased, non-alphanumerics
 * replaced with `_`, joined with a `__` separator. Safe for double-quoted
 * identifier use.
 *
 * Distinct pairs can still share a sequence (`Foo` and `foo`, `a-` and `a_`,
 * ('foo_', 'bar') and ('foo', '_bar') through the separator, names past pg's
 * 63-byte limit). That only leaves gaps: numbers stay unique per (ns, type),
 * the `short_ids` primary key. The name is not changed to avoid it, because
 * renaming would restart existing sequences at 1. Underscore-led namespaces
 * such as `_system_proposals` are therefore fine.
 *
 * @internal Exported for unit testing. Not part of the public package API.
 */
export function seqName(ns: string, type: string): string {
  const sanitize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '_');
  return `${sanitize(ns)}__${sanitize(type)}_short_id_seq`;
}

/**
 * Parses a `bigint` column value (postgres.js returns a string) into a JS
 * number. Throws if it exceeds `Number.MAX_SAFE_INTEGER`, where parsing
 * would silently round into collisions. `undefined` (no row) returns `0`.
 *
 * @internal Exported for unit testing of the safe-integer assertion. Not
 * part of the public package API.
 */
export function parseShortId(raw: string | undefined): number {
  if (raw === undefined) return 0;
  const n = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(n)) {
    throw new Error(`PgShortIdStore: short_id ${raw} exceeds JS safe integer range`);
  }
  return n;
}

export class PgShortIdStore {
  readonly #ensuredSequences = new Set<string>();

  /** Wraps a single PG handle (Sql or TransactionSql); does not own the connection. */
  constructor(private readonly sql: PgHandle) {}

  private async ensureSequence(ns: string, type: string): Promise<string> {
    const name = seqName(ns, type);
    const cacheKey = `${ns}\0${type}`;
    if (this.#ensuredSequences.has(cacheKey)) return name;
    await this.sql.unsafe(`CREATE SEQUENCE IF NOT EXISTS "${name}"`);
    this.#ensuredSequences.add(cacheKey);
    return name;
  }

  /**
   * Allocate a new short-id without binding it to a row. The caller is
   * responsible for calling `bind` before the row is visible to consumers.
   * Used by the migrate backfill's preload path.
   */
  async allocateUnbound(ns: string, type: string): Promise<number> {
    const name = await this.ensureSequence(ns, type);
    const rows = await this.sql.unsafe<Array<{ nextval: string }>>(
      `SELECT nextval('"${name}"') AS nextval`
    );
    // postgres.js returns bigint as a string — parse + safe-integer-assert.
    return parseShortId(rows[0]?.nextval);
  }

  /**
   * Bind a previously-allocated short-id to a row. `ON CONFLICT DO NOTHING`
   * covers both the PK `(namespace, type, short_id)` and the UNIQUE index
   * `(namespace, type, row_id)` — idempotent for backfill re-runs.
   */
  async bind(ns: string, type: string, shortId: number, rowId: string): Promise<void> {
    await this.sql`
      INSERT INTO short_ids (namespace, type, short_id, row_id)
      VALUES (${ns}, ${type}, ${shortId}, ${rowId})
      ON CONFLICT DO NOTHING
    `;
  }

  /**
   * Resolve a numeric short-id to its row UUID. Returns `null` when no
   * binding exists for the given `(ns, type, shortId)` triple.
   */
  async resolveShortId(ns: string, type: string, shortId: number): Promise<string | null> {
    const rows = await this.sql<Array<{ row_id: string }>>`
      SELECT row_id FROM short_ids
      WHERE namespace = ${ns} AND type = ${type} AND short_id = ${shortId}
    `;
    return rows[0]?.row_id ?? null;
  }

  /**
   * Look up the short-id assigned to a row UUID. Returns `null` when the row
   * has no short-id binding yet.
   */
  async getShortIdForRow(ns: string, type: string, rowId: string): Promise<number | null> {
    const rows = await this.sql<Array<{ short_id: string }>>`
      SELECT short_id FROM short_ids
      WHERE namespace = ${ns} AND type = ${type} AND row_id = ${rowId}
    `;
    if (!rows[0]) return null;
    return parseShortId(rows[0].short_id);
  }

  /**
   * Hard-delete all short-id rows for a specific (ns, type). Returns the count
   * of rows deleted. The sequence for that type is left in place — sequences
   * are schema objects and the caller can recreate one if needed.
   */
  async dropType(ns: string, type: string): Promise<number> {
    const rows = await this.sql<Array<{ short_id: string }>>`
      DELETE FROM short_ids
      WHERE namespace = ${ns} AND type = ${type}
      RETURNING short_id
    `;
    return rows.length;
  }

  /**
   * Hard-delete all short-id rows for every type in a namespace. Returns the
   * total count of rows deleted across all types.
   */
  async dropNamespace(ns: string): Promise<number> {
    const rows = await this.sql<Array<{ short_id: string }>>`
      DELETE FROM short_ids
      WHERE namespace = ${ns}
      RETURNING short_id
    `;
    return rows.length;
  }

  /**
   * Bulk-insert pre-existing mappings and advance the sequence past the max
   * shortId seen. Used by substrate-migrate backfill. Idempotent — re-runs are
   * no-ops via ON CONFLICT DO NOTHING + GREATEST on setval.
   */
  async preload(
    ns: string,
    type: string,
    entries: Array<{ shortId: number; rowId: string }>
  ): Promise<void> {
    if (entries.length === 0) return;

    await this.sql`
      INSERT INTO short_ids ${this.sql(
        entries.map((e) => ({
          namespace: ns,
          type,
          short_id: e.shortId,
          row_id: e.rowId
        })),
        'namespace',
        'type',
        'short_id',
        'row_id'
      )}
      ON CONFLICT (namespace, type, short_id) DO NOTHING
    `;

    const max = entries.reduce((m, e) => (e.shortId > m ? e.shortId : m), 0);
    const name = await this.ensureSequence(ns, type);
    // Advance the sequence to max so that the next nextval returns max+1.
    // GREATEST guards against regressing the sequence when preloading partial data.
    await this.sql.unsafe(
      `SELECT setval('"${name}"', GREATEST((SELECT last_value FROM "${name}"), ${max}))`
    );
  }
}

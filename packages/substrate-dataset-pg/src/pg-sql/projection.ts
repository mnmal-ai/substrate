/**
 * Read-path shaping: which body keys to materialise, and how the native
 * metadata columns fold back into the `RowMetadata` shape callers see.
 */

import { randomUUID } from 'node:crypto';
import type { ActorIdentity, ReadParams, RowMetadata } from '@mnmal-ai/substrate-types';
import type { Sql, TransactionSql } from 'postgres';
import { type Fragment, NON_BODY_FIELD_KEYS } from './primitives.js';

/**
 * Returns the body SELECT expression for a read.
 *
 *   - `fields === undefined` → the full body.
 *   - `fields` supplied → `jsonb_build_object(...)` over `id` plus the
 *     requested top-level body keys; one the row lacks is the absent marker. `id` is
 *     always included because `materialize()` reads `body.id` to preserve
 *     numeric ids.
 *
 * Keys are bound as parameters, never concatenated.
 */
export function buildBodyProjection(
  sql: Sql | TransactionSql,
  fields: ReadParams['fields']
): Fragment {
  // The body is authoritative: every write path sets a promoted column from
  // the same value it writes to the body, so a read never needs the column.
  if (fields === undefined) return sql`r.body`;
  // Force-include `id`; filter out row-metadata-style keys that don't live
  // in body. Use a Set for stable de-dup if the caller passed `id` explicitly.
  const bodyKeys = new Set<string>(['id']);
  for (const key of Object.keys(fields)) {
    if (NON_BODY_FIELD_KEYS.has(key)) continue;
    bodyKeys.add(key);
  }
  // A key the row lacks projects as the marker, which `materialize` drops. A stored
  // json `null` comes through as itself. One extraction per key: testing presence in
  // SQL (`->` twice, or `?`) detoasts a large body once more per access, which
  // tripled the cost of a projected read on a TOASTed body.
  return buildObject(
    sql,
    Array.from(
      bodyKeys,
      (k) => sql`${k}::text, COALESCE(r.body->${k}, ${sql.unsafe(ABSENT_LITERAL)})`
    )
  );
}

/**
 * Stands in for a projected key the row lacks. The nonce is per process and never
 * stored or sent to a client (keep it so: never log it or a result row), which is
 * why no stored value can equal it. The literal is
 * built here from hex only, so it is safe to inline (a parameter would be cast
 * per row under a generic plan).
 */
const ABSENT_KEY = `$absent:${randomUUID()}`;
const ABSENT_LITERAL = `'{"${ABSENT_KEY}":1}'::jsonb`;

/** True for the value `buildBodyProjection` gives a key the row lacks. */
export function isAbsentMarker(v: unknown): boolean {
  return typeof v === 'object' && v !== null && Object.hasOwn(v, ABSENT_KEY);
}

/**
 * A jsonb object from `'k'::text, <value>` pairs (the output key needs
 * `::text`: jsonb_build_object's VARIADIC any cannot infer a parameter's
 * type). pg caps a call at 100 arguments, so each call takes at most 50 keys
 * and the objects are concatenated with `||`.
 */
export function buildObject(sql: Sql | TransactionSql, pairs: Fragment[]): Fragment {
  if (pairs.length === 0) return sql`'{}'::jsonb`;
  const objects: Fragment[] = [];
  for (let i = 0; i < pairs.length; i += MAX_KEYS_PER_CALL) {
    objects.push(sql`jsonb_build_object(${join(pairs.slice(i, i + MAX_KEYS_PER_CALL), sql`,`)})`);
  }
  return sql`${join(objects, sql` || `)}`;
}

const MAX_KEYS_PER_CALL = 50;

function join(parts: Fragment[], sep: Fragment): Fragment[] {
  const out: Fragment[] = [];
  for (const [i, p] of parts.entries()) {
    if (i > 0) out.push(sep);
    out.push(p);
  }
  return out;
}

export function assembleRowMetadata(record: {
  created_at: Date | null;
  updated_at: Date | null;
  created_by_kind: string | null;
  created_by_id: string | null;
  updated_by_kind: string | null;
  updated_by_id: string | null;
  /** bigint, which postgres.js returns as a string. */
  seq?: string | null;
}): RowMetadata | undefined {
  const seq = record.seq == null ? undefined : Number(record.seq);
  if (
    seq === undefined &&
    record.created_at === null &&
    record.updated_at === null &&
    record.created_by_kind === null &&
    record.created_by_id === null &&
    record.updated_by_kind === null &&
    record.updated_by_id === null
  ) {
    return undefined;
  }
  const createdBy: ActorIdentity | null =
    record.created_by_kind !== null && record.created_by_id !== null
      ? { kind: record.created_by_kind as ActorIdentity['kind'], id: record.created_by_id }
      : null;
  const updatedBy: ActorIdentity | null =
    record.updated_by_kind !== null && record.updated_by_id !== null
      ? { kind: record.updated_by_kind as ActorIdentity['kind'], id: record.updated_by_id }
      : null;
  return {
    createdAt: record.created_at !== null ? record.created_at.toISOString() : null,
    updatedAt: record.updated_at !== null ? record.updated_at.toISOString() : null,
    createdBy,
    updatedBy,
    ...(seq !== undefined ? { seq } : {})
  };
}

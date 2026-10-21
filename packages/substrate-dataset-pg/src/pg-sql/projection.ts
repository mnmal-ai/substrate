/**
 * Read-path shaping: which body keys to materialise, and how the native
 * metadata columns fold back into the `RowMetadata` shape callers see.
 */

import type { ActorIdentity, ReadParams, RowMetadata } from '@mnmal-ai/substrate-types';
import type { Sql, TransactionSql } from 'postgres';
import { type Fragment, NON_BODY_FIELD_KEYS } from './primitives.js';

/**
 * Returns the body SELECT expression for a read.
 *
 *   - `fields === undefined` → the full body.
 *   - `fields` supplied → `jsonb_build_object(...)` over `id` plus the
 *     requested top-level body keys. `id` is always included because
 *     `materialize()` reads `body.id` to preserve numeric ids.
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
  const keyArr = Array.from(bodyKeys);
  if (keyArr.length === 0) return sql`'{}'::jsonb`;
  // Comma-interleaved `'k', <value>` pairs. The output key needs `::text`:
  // jsonb_build_object's VARIADIC any cannot infer a parameter's type.
  const pairs: Fragment[] = keyArr.map((k) => sql`${k}::text, r.body->${k}`);
  const commaFrag = sql`,`;
  const interleaved: Fragment[] = [pairs[0] as Fragment];
  for (let i = 1; i < pairs.length; i++) {
    interleaved.push(commaFrag, pairs[i] as Fragment);
  }
  return sql`jsonb_build_object(${interleaved})`;
}

export function assembleRowMetadata(record: {
  created_at: Date | null;
  updated_at: Date | null;
  created_by_kind: string | null;
  created_by_id: string | null;
  updated_by_kind: string | null;
  updated_by_id: string | null;
}): RowMetadata | undefined {
  if (
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
    updatedBy
  };
}

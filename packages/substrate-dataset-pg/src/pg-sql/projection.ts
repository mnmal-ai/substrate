/**
 * Read-path shaping: which body keys to materialise, and how the native
 * metadata columns fold back into the `RowMetadata` shape callers see.
 */

import {
  type ActorIdentity,
  METADATA_FILTER_FIELDS,
  type ReadParams,
  type RowMetadata
} from '@mnmal-ai/substrate-types';
import type { ISql, Sql, TransactionSql } from 'postgres';
import { RAW_KEY } from '../row-codec.js';
import type { TypeTable } from '../type-table.js';
import {
  columnSql,
  type Fragment,
  NON_BODY_FIELD_KEYS,
  qualifier,
  utcTextSql
} from './primitives.js';

/**
 * The SELECT items carrying a read's row, then `walk` (its walk selections'
 * columns, from `buildWalkColumns`). The caller selects the metadata columns.
 *
 * For `decodeRow`: each column (of a requested field, when
 * `fields` is given), `orphaned` ones included (F35), a date column as UTC
 * text; then `extra AS extra`, whole, or its requested keys with `id` and
 * `$raw` kept.
 *
 * Keys are bound as parameters, never concatenated.
 */
export function buildRowProjection(
  sql: ISql,
  table: TypeTable,
  fields: ReadParams['fields'],
  alias = 'r',
  walk: Fragment | null = null
): Fragment {
  const q = qualifier(alias);
  // Force-include `id`; filter out row-metadata-style keys that don't live
  // in body. Use a Set for stable de-dup if the caller passed `id` explicitly.
  const keys = new Set<string>(['id']);
  for (const key of Object.keys(fields ?? {})) {
    if (!NON_BODY_FIELD_KEYS.has(key)) keys.add(key);
  }
  const columns = table
    .columns()
    .filter((c) => fields === undefined || Object.hasOwn(fields, c.field))
    .map((c) => {
      const col = columnSql(c, alias);
      // `decodeRow` reads a date column's text the same in any session TimeZone.
      return c.kind === 'date' ? `${utcTextSql(col, 'US')} AS ${c.column}` : col;
    });
  // One pass over `extra` (it may be TOASTed), not one extraction per key.
  const extra: Fragment =
    fields === undefined
      ? sql.unsafe(`${q}extra`)
      : sql`COALESCE((SELECT jsonb_object_agg(e.key, e.value) FROM jsonb_each(${sql.unsafe(`${q}extra`)}) e WHERE e.key = ANY(${[...keys, RAW_KEY]}::text[])), '{}'::jsonb)`;
  const head = columns.length === 0 ? '' : `${columns.join(', ')}, `;
  return sql`${sql.unsafe(head)}${extra} AS extra${walk === null ? sql`` : sql`, ${walk}`}`;
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

/** Projection keys that read row metadata: `_metadata`, the author names, and the metadata columns. */
const METADATA_KEYS = new Set([
  '_metadata',
  'createdBy',
  'updatedBy',
  ...Object.keys(METADATA_FILTER_FIELDS).filter((k) => k !== 'id')
]);

/** True unless `fields` lists its keys and none of them reads row metadata. */
export function readsRowMetadata(fields: ReadParams['fields']): boolean {
  return fields === undefined || Object.keys(fields).some((k) => METADATA_KEYS.has(k));
}

/** True unless `fields` lists its keys without `shortId`. */
export function readsShortId(fields: ReadParams['fields']): boolean {
  return fields === undefined || Object.hasOwn(fields, 'shortId');
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

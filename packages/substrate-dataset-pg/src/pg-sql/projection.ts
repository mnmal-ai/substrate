/**
 * Read-path shaping: which body keys to materialise, and how the native
 * metadata columns fold back into the `RowMetadata` shape callers see.
 */

import type { ActorIdentity, ReadParams, RowMetadata } from '@mnmal-ai/substrate-types';
import type { Sql, TransactionSql } from 'postgres';
import { extraWins, RAW_KEY } from '../row-codec.js';
import type { TypeTable } from '../type-table.js';
import {
  columnSql,
  type Fragment,
  NON_BODY_FIELD_KEYS,
  qualifier,
  utcTextSql
} from './primitives.js';

/**
 * The SELECT items carrying a read's row, `walk` (its walk selections, a jsonb
 * object) merged in. The caller selects the metadata columns.
 *
 * For `decodeRow`: each column (of a requested field, when
 * `fields` is given), `orphaned` ones included (F35), a date column as UTC
 * text; then `extra AS extra`, whole, or its requested keys with `id` and
 * `$raw` kept (less those only a `column` can hold). `walk` rides in `extra`,
 * which `decodeRow` copies to the row.
 *
 * Keys are bound as parameters, never concatenated.
 */
export function buildRowProjection(
  sql: Sql | TransactionSql,
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
  const merged = (doc: Fragment): Fragment => (walk === null ? doc : sql`(${doc} || ${walk})`);
  const columns = table
    .columns()
    .filter((c) => fields === undefined || Object.hasOwn(fields, c.field))
    .map((c) => {
      const col = columnSql(c, alias);
      // `decodeRow` reads a date column's text the same in any session TimeZone.
      return c.kind === 'date' ? `${utcTextSql(col, 'US')} AS ${c.column}` : col;
    });
  // Plain operators, not a jsonb_each subquery: a per-row SubPlan cost every
  // read and kept the statement out of parallel plans (#1863, #1864). A
  // `column`-state field's `extra` value is never read (`extraWins`), so it is
  // not extracted; `?` keeps an absent key absent and a JSON null a null.
  const extraOf: Fragment = sql`${sql.unsafe(`${q}extra`)}`;
  const wanted = [...keys, RAW_KEY].filter((k) => {
    const c = table.column(k);
    return c === undefined || extraWins(c);
  });
  const extra: Fragment =
    fields === undefined
      ? extraOf
      : buildConcat(
          sql,
          wanted.map(
            (k) =>
              sql`CASE WHEN ${extraOf} ? ${k}::text THEN jsonb_build_object(${k}::text, ${extraOf} -> ${k}::text) ELSE '{}'::jsonb END`
          )
        );
  const head = columns.length === 0 ? '' : `${columns.join(', ')}, `;
  return sql`${sql.unsafe(head)}${merged(extra)} AS extra`;
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

/** `parts` (jsonb objects) joined by `||`; `'{}'` when there are none. */
function buildConcat(sql: Sql | TransactionSql, parts: Fragment[]): Fragment {
  return parts.length === 0 ? sql`'{}'::jsonb` : sql`(${join(parts, sql` || `)})`;
}

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

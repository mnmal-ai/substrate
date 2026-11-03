/**
 * How rows are stored. `partitioned` is `rows` LIST(namespace) then LIST(type);
 * `legacy` is `rows` as one plain table; `tables` is one table per type, listed
 * in `substrate_type_tables`. A database keeps the layout it was created with.
 */

import { createHash } from 'node:crypto';
import type { Sql } from 'postgres';

export type StorageLayout = 'legacy' | 'partitioned' | 'tables';

/**
 * The layout of the current schema: that of `rows` when it exists, else
 * `tables` when `substrate_type_tables` does, else `'absent'`.
 */
export async function detectLayout(sql: Sql): Promise<StorageLayout | 'absent'> {
  const found = await sql<Array<{ relname: string; relkind: string }>>`
    SELECT c.relname::text AS relname, c.relkind::text AS relkind FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema() AND c.relname IN ('rows', 'substrate_type_tables')
  `;
  const rows = found.find((r) => r.relname === 'rows');
  if (rows !== undefined) return rows.relkind === 'p' ? 'partitioned' : 'legacy';
  return found.length > 0 ? 'tables' : 'absent';
}

/** Each handle's layout, once it has one: a store keeps the layout it was created with. */
const layouts = new WeakMap<object, StorageLayout>();

/**
 * {@link detectLayout}, cached per handle. `'absent'` is not cached, since a
 * handle may be made before the migrations run.
 */
export async function cachedLayout(sql: Sql): Promise<StorageLayout | 'absent'> {
  const known = layouts.get(sql);
  if (known !== undefined) return known;
  const layout = await detectLayout(sql);
  if (layout !== 'absent') layouts.set(sql, layout);
  return layout;
}

/** pg's identifier limit, in bytes. */
export const MAX_IDENTIFIER = 63;

/**
 * `rows__<ns>` or `rows__<ns>__<type>`, folded to `[a-z0-9_]`. When folding
 * changed a name, or the result is too long for pg, an 8-hex hash of the raw
 * names is appended so distinct names never share a partition.
 */
export function partitionName(namespace: string, type?: string): string {
  return foldedName('rows__', type === undefined ? [namespace] : [namespace, type]);
}

/** `t__<ns>__<type>`, folded and hashed as `partitionName` is: the `tables` layout's type table. */
export function typeTableName(namespace: string, type: string): string {
  return foldedName('t__', [namespace, type]);
}

/** `f_<field>`, folded and hashed as `partitionName` is, so it never clashes with a metadata column. */
export function columnName(field: string): string {
  return foldedName('f_', [field]);
}

function foldedName(prefix: string, raw: string[]): string {
  const readable = `${prefix}${raw.join('__')}`;
  const folded = readable.toLowerCase().replace(/[^a-z0-9_]/g, '_');
  if (folded === readable && folded.length <= MAX_IDENTIFIER) return folded;
  return hashedName(folded, raw);
}

/** `base` cut to fit `max` bytes with an 8-hex hash of `seed` appended. `base` must be ASCII. */
export function hashedName(base: string, seed: unknown, max = MAX_IDENTIFIER): string {
  const hash = createHash('sha256').update(JSON.stringify(seed)).digest('hex').slice(0, 8);
  return `${base.slice(0, max - hash.length - 1)}_${hash}`;
}

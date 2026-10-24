/**
 * How `rows` is stored. `partitioned` is LIST(namespace) then LIST(type);
 * `legacy` is one plain table. A database keeps the layout it was created with.
 */

import { createHash } from 'node:crypto';
import type { Sql } from 'postgres';

export type StorageLayout = 'legacy' | 'partitioned';

/** The layout of `rows` in the current schema, or `'absent'` when there is no `rows`. */
export async function detectLayout(sql: Sql): Promise<StorageLayout | 'absent'> {
  const [row] = await sql<Array<{ relkind: string }>>`
    SELECT c.relkind::text AS relkind FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema() AND c.relname = 'rows'
  `;
  if (row === undefined) return 'absent';
  return row.relkind === 'p' ? 'partitioned' : 'legacy';
}

/** pg's identifier limit, in bytes. */
export const MAX_IDENTIFIER = 63;

/**
 * `rows__<ns>` or `rows__<ns>__<type>`, folded to `[a-z0-9_]`. When folding
 * changed a name, or the result is too long for pg, an 8-hex hash of the raw
 * names is appended so distinct names never share a partition.
 */
export function partitionName(namespace: string, type?: string): string {
  const raw = type === undefined ? [namespace] : [namespace, type];
  const readable = `rows__${raw.join('__')}`;
  const folded = readable.toLowerCase().replace(/[^a-z0-9_]/g, '_');
  if (folded === readable && folded.length <= MAX_IDENTIFIER) return folded;
  return hashedName(folded, raw);
}

/** `base` cut to fit 63 bytes with an 8-hex hash of `seed` appended. `base` must be ASCII. */
export function hashedName(base: string, seed: unknown): string {
  const hash = createHash('sha256').update(JSON.stringify(seed)).digest('hex').slice(0, 8);
  return `${base.slice(0, MAX_IDENTIFIER - hash.length - 1)}_${hash}`;
}

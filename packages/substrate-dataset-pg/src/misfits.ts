/**
 * Misfits — values a column cannot hold, kept under `extra.$raw` — counted for
 * the storage report and `/health` (#1898).
 *
 * Counting scans every type table (`extra` has no index), and `/health` is
 * unauthenticated and polled. So `/health` never runs a scan on its request
 * path: it reads the last count it has, and at most once per
 * {@link MISFIT_COUNT_TTL_MS} starts one in the background. A failed scan is
 * kept for the same span as a back-off, so failures cannot turn every probe
 * into a scan.
 */

import type { Sql } from 'postgres';
import { ident } from './layout.js';
import { RAW_KEY } from './row-codec.js';

/** One field's live rows holding a value under `$raw`. */
export interface MisfitCount {
  namespace: string;
  type: string;
  field: string;
  count: number;
}

/** How long a count, or a failed scan, stands before `/health` starts another. */
export const MISFIT_COUNT_TTL_MS = 5 * 60_000;

interface Entry {
  /** When the scan started. */
  at: number;
  counts: Promise<MisfitCount[]>;
  /** The last finished count, carried over from the entry this one replaced. */
  value?: MisfitCount[];
}

/** Per pool (or any key): the latest scan. */
const entries = new WeakMap<object, Entry>();

function start(key: object, scan: () => Promise<MisfitCount[]>, now: number): Entry {
  const prior = entries.get(key);
  const counts = scan();
  const entry: Entry = {
    at: now,
    counts,
    ...(prior?.value !== undefined ? { value: prior.value } : {})
  };
  entries.set(key, entry);
  counts.then(
    (value) => {
      if (entries.get(key)?.counts === counts) entry.value = value;
    },
    // Kept, not deleted: the entry's `at` is the back-off.
    () => {}
  );
  return entry;
}

/** A fresh count for the storage report; it replaces the cached one. Rejects as the scan does. */
export function freshMisfitCount(
  key: object,
  scan: () => Promise<MisfitCount[]>,
  now = Date.now()
): Promise<MisfitCount[]> {
  return start(key, scan, now).counts;
}

/**
 * The cached count for `/health`, or undefined when none has finished. Never
 * waits on a scan; starts one in the background when the latest is older than
 * the TTL (or there is none).
 */
export function cachedMisfitCount(
  key: object,
  scan: () => Promise<MisfitCount[]>,
  now = Date.now()
): MisfitCount[] | undefined {
  const entry = entries.get(key);
  if (entry === undefined || now - entry.at >= MISFIT_COUNT_TTL_MS) {
    return start(key, scan, now).value;
  }
  return entry.value;
}

/**
 * Live rows holding each field under `$raw`, every type table of the store, in
 * one statement. Sorted by namespace, type and field.
 */
export async function countMisfits(sql: Sql): Promise<MisfitCount[]> {
  const tables = await sql<Array<{ namespace: string; type: string; table: string }>>`
    SELECT namespace, type, table_name AS "table" FROM substrate_type_tables
    ORDER BY namespace COLLATE "C", type COLLATE "C"`;
  if (tables.length === 0) return [];
  const parts = tables.map(
    (t, i) =>
      `SELECT ${i}::int AS t, k AS field, count(*)::int AS n FROM ${ident(t.table)},
        jsonb_object_keys(extra -> '${RAW_KEY}') AS k
      WHERE extra ? '${RAW_KEY}' AND jsonb_typeof(extra -> '${RAW_KEY}') = 'object'
        AND deleted_at IS NULL
      GROUP BY k`
  );
  const rows = await sql.unsafe<Array<{ t: number; field: string; n: number }>>(
    `SELECT * FROM (${parts.join(' UNION ALL ')}) m ORDER BY t, field COLLATE "C"`
  );
  return rows.map((r) => {
    const t = tables[r.t] as (typeof tables)[number];
    return { namespace: t.namespace, type: t.type, field: r.field, count: r.n };
  });
}

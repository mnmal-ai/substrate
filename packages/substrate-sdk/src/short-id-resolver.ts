/**
 * resolveEntityId — translate the public `id` parameter into a concrete
 * `rows.id` value. Implements the overloaded-id contract (spec §D1
 * + §Architecture/Resolver):
 *
 *   1. Try raw: look up (ns, type, id) in rows using the original value
 *      — handles UUID strings, legacy numeric ids, and numeric-string ids
 *      without an extra query.
 *   2. If raw misses AND the string form matches /^\d+$/ — fall back to sidecar
 *      lookup via `dataset.resolveShortId`.
 *   3. Else: null (caller translates to NotFound).
 *
 * Raw-first is deliberate: most calls reference the id they just received
 * from a create/list, so the common path is one lookup. Short-form callers
 * pay three. Tombstoned rows are treated as non-existent on both paths, so
 * resolveEntityId returns null for a deleted entity's id or short id —
 * propagates as NotFound upstream.
 *
 * Accepts `string | number` so callers can pass the original params value
 * without coercing first; the raw lookup uses the original type (preserving
 * numeric id equality in MemoryDataset) and the sidecar path works from
 * the string form.
 */

import type { Dataset, Id, Row } from '@mnmal-ai/substrate-types';

const INT_RE = /^\d+$/;

export async function resolveEntityId(
  dataset: Dataset,
  type: string,
  input: Id
): Promise<Id | null> {
  // Delegates so the short-form branch also refuses a tombstoned row.
  // The id is returned exactly as stored, so a numeric-id row keeps its
  // number type and MemoryDataset's Map-keyed storage still hits.
  const row = await resolveEntityRow(dataset, type, input);
  return row === null ? null : row.id;
}

/**
 * Like `resolveEntityId`, but returns the fetched row itself. The raw-lookup
 * branch already holds the row, so callers that need its content (e.g. a
 * status-transition resolver reading the current status) avoid an immediate
 * re-read of the same row; the short-form branch pays one extra
 * read to honour the same row-shaped contract.
 */
export async function resolveEntityRow(
  dataset: Dataset,
  type: string,
  input: Id
): Promise<Row | null> {
  const raw = await dataset.read(type, { id: input, limit: 1, includeDeleted: false });
  const hit = raw.rows[0];
  if (hit !== undefined) return hit;

  const shortId = parseShortForm(input);
  if (shortId === null) return null;
  const id = await dataset.resolveShortId(type, shortId);
  if (id === null) return null;
  const resolved = await dataset.read(type, { id, limit: 1, includeDeleted: false });
  return resolved.rows[0] ?? null;
}

/**
 * Short-form gate shared by both resolvers: numeric-string inputs only.
 * PostgreSQL bigint holds up to 2^63, but JS Number precision ends at
 * Number.MAX_SAFE_INTEGER (2^53 - 1). Values beyond that silently truncate
 * through parseInt, which would send a wrong short_id to the sidecar lookup
 * and return a spurious null under the caller's eye. Better to return null
 * explicitly for any out-of-range input — no real deployment will approach
 * 2^53 sequence values.
 */
function parseShortForm(input: Id): number | null {
  const inputStr = String(input);
  if (!INT_RE.test(inputStr)) return null;
  if (inputStr.length > 16) return null;
  const shortId = Number.parseInt(inputStr, 10);
  if (shortId > Number.MAX_SAFE_INTEGER) return null;
  return shortId;
}

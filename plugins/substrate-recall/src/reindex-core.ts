/**
 * Server-side re-embed of a stored type, one cursor page per call.
 *
 * Re-embeds each row through the registry's `entry.reembed`, i.e. the same
 * `embed.source` the write path uses, so a backfilled vector matches a written
 * one by construction.
 *
 * Archived rows are deliberately included: the write path embeds them too.
 * Per-row failures are reported in the result, never swallowed.
 */

import type { Dataset, Row } from '@mnmal-ai/substrate-types';
import type { EmbedSourceRegistry } from './embed-source-registry.js';

/** Rows per call when the caller does not say. */
export const REINDEX_DEFAULT_LIMIT = 100;
/**
 * Hard ceiling per call. Each row costs one embedder round-trip, so an
 * unbounded page is an unbounded request; the cursor is how a caller reaches
 * the rest of the corpus.
 */
export const REINDEX_MAX_LIMIT = 1000;

export interface ReindexInput {
  namespace: string;
  type: string;
  /** Opaque cursor from a prior call's `nextCursor`. */
  cursor?: string;
  limit?: number;
}

export interface ReindexFailure {
  id: string;
  error: string;
}

export interface ReindexResult {
  namespace: string;
  type: string;
  /** Rows read from the dataset this page. */
  scanned: number;
  embedded: number;
  /** Source returned the null sentinel; any existing vector was removed. */
  unindexable: number;
  failed: number;
  /**
   * One entry per failed row. Always emitted (`[]` when clean) so an empty
   * list means "nothing failed" rather than "this server does not say".
   */
  failures: ReindexFailure[];
  hasMore: boolean;
  nextCursor?: string;
}

export interface ReindexCoreDeps {
  registry: EmbedSourceRegistry;
  /**
   * Row source. Absent → the core answers `unavailable` rather than reporting
   * a clean run over zero rows: an embedded host with no dataset resolver must
   * not be able to conclude that a type has nothing to reindex.
   */
  resolveDataset?: (ns: string) => Dataset | null;
}

function fail(code: string, message: string): never {
  throw Object.assign(new Error(message), { code });
}

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    fail('bad_request', `${field} must be a non-empty string`);
  }
  return value as string;
}

/** Throws `{ code: 'bad_request' }` on any shape violation. */
export function validateReindexInput(raw: unknown): ReindexInput {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    fail('bad_request', 'body must be a JSON object');
  }
  const obj = raw as Record<string, unknown>;
  const namespace = nonEmptyString(obj.namespace, 'namespace');
  const type = nonEmptyString(obj.type, 'type');

  let limit = REINDEX_DEFAULT_LIMIT;
  if (obj.limit !== undefined) {
    if (typeof obj.limit !== 'number' || !Number.isInteger(obj.limit) || obj.limit < 1) {
      fail('bad_request', 'limit must be a positive integer');
    }
    if (obj.limit > REINDEX_MAX_LIMIT) {
      fail('bad_request', `limit exceeds the maximum of ${REINDEX_MAX_LIMIT}`);
    }
    limit = obj.limit;
  }

  if (obj.cursor !== undefined && typeof obj.cursor !== 'string') {
    fail('bad_request', 'cursor must be a string');
  }

  return {
    namespace,
    type,
    limit,
    ...(typeof obj.cursor === 'string' ? { cursor: obj.cursor } : {})
  };
}

export async function handleReindex(
  input: ReindexInput,
  deps: ReindexCoreDeps
): Promise<ReindexResult> {
  const entry = deps.registry.get(input.namespace, input.type);
  if (entry === undefined) {
    // Name what IS embedded. The registry is configuration-derived, so this
    // answer is complete even for a type that has written no rows yet.
    const known = deps.registry
      .types()
      .map((t) => `${t.namespace}/${t.type}`)
      .join(', ');
    fail(
      'unknown_type',
      `${input.namespace}/${input.type} declares no embed.source; embedded types are: ${known === '' ? '(none)' : known}`
    );
  }
  if (entry.reembed === undefined) {
    fail(
      'unavailable',
      `${input.namespace}/${input.type} was registered without a re-embed binding`
    );
  }
  if (deps.resolveDataset === undefined) {
    fail('unavailable', 'no dataset resolver is wired; cannot read rows to re-embed');
  }
  const dataset = deps.resolveDataset(input.namespace);
  if (dataset === null) {
    fail('unknown_type', `no dataset is registered for namespace ${input.namespace}`);
  }

  const limit = input.limit ?? REINDEX_DEFAULT_LIMIT;
  const page = await dataset.read(input.type, {
    limit,
    ...(input.cursor !== undefined ? { cursor: input.cursor } : {})
  });

  const failures: ReindexFailure[] = [];
  let embedded = 0;
  let unindexable = 0;

  for (const row of page.rows) {
    const outcome = await entry.reembed(row as Row);
    switch (outcome.status) {
      case 'embedded':
        embedded++;
        break;
      case 'unindexable':
        unindexable++;
        break;
      case 'no-id':
        // A stored row with no id should not exist. Counted as a
        // failure so the outcomes still add up to `scanned`.
        failures.push({ id: '<no-id>', error: 'row has no string or number id' });
        break;
      case 'failed':
        // The embedder itself is down, so every remaining row would fail the
        // same way, each after its own timeout.
        if (outcome.code === 'unavailable') {
          fail(
            'unavailable',
            `embedder unavailable after ${embedded} of ${page.rows.length} rows: ${outcome.error}`
          );
        }
        failures.push({
          id: typeof (row as Row).id === 'string' ? String((row as Row).id) : '<no-id>',
          error: outcome.error
        });
        break;
    }
  }

  return {
    namespace: input.namespace,
    type: input.type,
    scanned: page.rows.length,
    embedded,
    unindexable,
    failed: failures.length,
    failures,
    hasMore: page.hasMore,
    ...(page.nextCursor !== undefined ? { nextCursor: page.nextCursor } : {})
  };
}

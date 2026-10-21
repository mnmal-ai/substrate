/**
 * Server-side lexical backfill: indexes one page of a type's existing rows.
 *
 * The write path only indexes rows as they are written, so pre-existing rows
 * are invisible to the lexical arm until backfilled — and recall then returns
 * only recent rows without looking broken.
 *
 * It runs the registered `lexical.source`, never a copy of it, so a backfilled
 * row cannot drift from a written one. Paging rather than a job, and failures
 * reported rather than swallowed, as in `reindex-core.ts`.
 */

import type { Dataset, Row } from '@mnmal-ai/substrate-types';
import type { LexicalSourceRegistry } from './lexical-source-registry.js';

/** Rows per call when the caller does not say. */
export const LEXICAL_REINDEX_DEFAULT_LIMIT = 500;
/**
 * Hard ceiling per call. Higher than the embed reindex's because a lexical row
 * costs a database write rather than an embedder round-trip — but still
 * bounded, because an unbounded page is an unbounded request.
 */
export const LEXICAL_REINDEX_MAX_LIMIT = 5000;

export interface LexicalReindexInput {
  namespace: string;
  type: string;
  /** Opaque cursor from a prior call's `nextCursor`. */
  cursor?: string;
  limit?: number;
}

export interface LexicalReindexFailure {
  id: string;
  error: string;
}

export interface LexicalReindexResult {
  namespace: string;
  type: string;
  /** Rows read from the dataset this page. */
  scanned: number;
  indexed: number;
  /** Source returned the null sentinel; any indexed text was removed. */
  unindexable: number;
  failed: number;
  /**
   * One entry per failed row. Always emitted (`[]` when clean) so an empty
   * list means "nothing failed" rather than "this server does not say".
   */
  failures: LexicalReindexFailure[];
  hasMore: boolean;
  nextCursor?: string;
}

export interface LexicalReindexCoreDeps {
  registry: LexicalSourceRegistry;
  /**
   * Row source. Absent → the core refuses rather than reporting a clean run
   * over zero rows: an operator must not be able to conclude a type is
   * backfilled because nothing was wired to read it.
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
export function validateLexicalReindexInput(raw: unknown): LexicalReindexInput {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    fail('bad_request', 'body must be a JSON object');
  }
  const obj = raw as Record<string, unknown>;
  const namespace = nonEmptyString(obj.namespace, 'namespace');
  const type = nonEmptyString(obj.type, 'type');

  let limit = LEXICAL_REINDEX_DEFAULT_LIMIT;
  if (obj.limit !== undefined) {
    if (typeof obj.limit !== 'number' || !Number.isInteger(obj.limit) || obj.limit < 1) {
      fail('bad_request', 'limit must be a positive integer');
    }
    if (obj.limit > LEXICAL_REINDEX_MAX_LIMIT) {
      fail('bad_request', `limit exceeds the maximum of ${LEXICAL_REINDEX_MAX_LIMIT}`);
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

export async function handleLexicalReindex(
  input: LexicalReindexInput,
  deps: LexicalReindexCoreDeps
): Promise<LexicalReindexResult> {
  const entry = deps.registry.get(input.namespace, input.type);
  if (entry === undefined) {
    // Name what IS lexically indexed. The registry is configuration-derived,
    // so this includes types that have indexed no rows yet.
    const known = deps.registry
      .types()
      .map((t) => `${t.namespace}/${t.type}`)
      .join(', ');
    fail(
      'unknown_type',
      `${input.namespace}/${input.type} declares no lexical.source; lexically-indexed types are: ${known === '' ? '(none)' : known}`
    );
  }
  if (entry.reindex === undefined) {
    fail(
      'unavailable',
      `${input.namespace}/${input.type} was registered without a re-index binding`
    );
  }
  if (deps.resolveDataset === undefined) {
    fail('unavailable', 'no dataset resolver is wired; cannot read rows to re-index');
  }
  const dataset = deps.resolveDataset(input.namespace);
  if (dataset === null) {
    fail('unknown_type', `no dataset is registered for namespace ${input.namespace}`);
  }

  const limit = input.limit ?? LEXICAL_REINDEX_DEFAULT_LIMIT;
  const page = await dataset.read(input.type, {
    limit,
    ...(input.cursor !== undefined ? { cursor: input.cursor } : {})
  });

  const failures: LexicalReindexFailure[] = [];
  let indexed = 0;
  let unindexable = 0;

  for (const row of page.rows) {
    const outcome = await entry.reindex(row as Row);
    switch (outcome.status) {
      case 'indexed':
        indexed++;
        break;
      case 'unindexable':
        unindexable++;
        break;
      case 'no-id':
        // A stored row with no string id should not exist. Surfaced as a
        // failure rather than dropped, so outcomes always add up to `scanned`.
        failures.push({ id: '<no-id>', error: 'row has no string id' });
        break;
      case 'failed':
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
    indexed,
    unindexable,
    failed: failures.length,
    failures,
    hasMore: page.hasMore,
    ...(page.nextCursor !== undefined ? { nextCursor: page.nextCursor } : {})
  };
}

/**
 * Dry-run lexical coverage — the read-only twin of `lexical-reindex-core.ts`.
 *
 * For each lexically-indexed type, classifies every row with the registered
 * `lexical.source` WITHOUT writing, and pairs that with a live count of what
 * the index holds. Reading { scanned, indexed, unindexable, failed }:
 *
 *   backfill healthy   scanned == indexed + unindexable + failed, gap ~ 0
 *   narrow source      unindexable dominates, indexed small — by design
 *   backfill missing   scanned >> indexed + unindexable — rows never visited
 *
 * Throws coded errors: `bad_request`, `unavailable`, `unknown_type`. Costs one
 * full dataset scan per type, so it sits behind an opt-in query param.
 */

import type { Dataset, Row } from '@mnmal-ai/substrate-types';
import type { LexicalSourceRegistry } from './lexical-source-registry.js';
import type { LexicalStore } from './lexical-store.js';

/** Page size for the internal scan. Matches LEXICAL_REINDEX_DEFAULT_LIMIT. */
export const LEXICAL_COVERAGE_PAGE_LIMIT = 500;

export interface LexicalCoverageInput {
  /** Restrict to one type. Absent → every type in the registry. */
  namespace?: string;
  type?: string;
}

export interface LexicalTypeCoverage {
  namespace: string;
  type: string;
  /** Dataset rows examined. 0 when the type could not be classified (see unindexable). */
  scanned: number;
  /** Rows currently in the lexical index (live COUNT, same liveness as search). */
  indexed: number;
  /**
   * Rows whose source returned the null sentinel.
   *
   * `null` (not 0) means UNKNOWN: the entry has no classifier, so no scan ran
   * and `scanned` is 0. Do not collapse with `?? 0`.
   */
  unindexable: number | null;
  /** Source threw, or the row carried no string id. Detail lives in the reindex route. */
  failed: number;
}

export interface LexicalCoverageResult {
  types: LexicalTypeCoverage[];
}

export interface LexicalCoverageDeps {
  registry: LexicalSourceRegistry;
  /**
   * Row source. Absent → the core throws `unavailable` rather than reporting
   * zeros that would read as "uncovered".
   */
  resolveDataset?: (ns: string) => Dataset | null;
  lexicalStore: LexicalStore;
}

function fail(code: string, message: string): never {
  throw Object.assign(new Error(message), { code });
}

export function validateLexicalCoverageInput(raw: unknown): LexicalCoverageInput {
  if (raw === null || raw === undefined) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    fail('bad_request', 'coverage filter must be an object with optional namespace + type');
  }
  const obj = raw as Record<string, unknown>;
  const out: LexicalCoverageInput = {};
  if (obj.namespace !== undefined) {
    if (typeof obj.namespace !== 'string' || obj.namespace.length === 0) {
      fail('bad_request', 'coverage namespace must be a non-empty string');
    }
    out.namespace = obj.namespace;
  }
  if (obj.type !== undefined) {
    if (typeof obj.type !== 'string' || obj.type.length === 0) {
      fail('bad_request', 'coverage type must be a non-empty string');
    }
    out.type = obj.type;
  }
  if ((out.namespace === undefined) !== (out.type === undefined)) {
    fail('bad_request', 'coverage namespace and type must be given together');
  }
  return out;
}

export async function handleLexicalCoverage(
  input: LexicalCoverageInput,
  deps: LexicalCoverageDeps
): Promise<LexicalCoverageResult> {
  if (deps.resolveDataset === undefined) {
    fail('unavailable', 'no dataset resolver is wired; cannot scan rows for coverage');
  }
  const targets =
    input.namespace !== undefined && input.type !== undefined
      ? [{ namespace: input.namespace, type: input.type }]
      : deps.registry.types().map((t) => ({ namespace: t.namespace, type: t.type }));

  const types: LexicalTypeCoverage[] = [];
  for (const target of targets) {
    const entry = deps.registry.get(target.namespace, target.type);
    if (entry === undefined) {
      const known = deps.registry
        .types()
        .map((t) => `${t.namespace}/${t.type}`)
        .join(', ');
      fail(
        'unknown_type',
        `${target.namespace}/${target.type} declares no lexical.source; lexically-indexed types are: ${known === '' ? '(none)' : known}`
      );
    }
    const indexed = await deps.lexicalStore.countIndexed(target.namespace, target.type);
    if (entry.classify === undefined) {
      types.push({
        namespace: target.namespace,
        type: target.type,
        scanned: 0,
        indexed,
        unindexable: null,
        failed: 0
      });
      continue;
    }
    const dataset = deps.resolveDataset(target.namespace);
    if (dataset === null) {
      fail('unknown_type', `no dataset is registered for namespace ${target.namespace}`);
    }
    let scanned = 0;
    let unindexable = 0;
    let failed = 0;
    let cursor: string | undefined;
    for (;;) {
      const page = await dataset.read(target.type, {
        limit: LEXICAL_COVERAGE_PAGE_LIMIT,
        ...(cursor !== undefined ? { cursor } : {})
      });
      for (const row of page.rows) {
        scanned++;
        const outcome = await entry.classify(row as Row);
        switch (outcome.status) {
          case 'indexable':
            break;
          case 'unindexable':
            unindexable++;
            break;
          case 'no-id':
          case 'failed':
            // Counted as failed, not unindexable: a stored row with no string
            // id indicates corruption and must not hide in the refused bucket.
            failed++;
            break;
        }
      }
      if (!page.hasMore) break;
      cursor = page.nextCursor;
    }
    types.push({
      namespace: target.namespace,
      type: target.type,
      scanned,
      indexed,
      unindexable,
      failed
    });
  }
  return { types };
}

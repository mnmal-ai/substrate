/**
 * `GET /substrate/v1/embed-stats` — read the in-memory counter that observes
 * embed write outcomes.
 *
 * Returns the snapshot shape directly, plus an `enabled` flag so callers
 * can distinguish "recall wasn't configured" from "configured but no
 * failures yet" (both render as zero-count). Counts reset on plugin
 * restart.
 *
 * `handleEmbedStatsRequest` is the pure data handler; `embedStatsRouteHandler`
 * wraps it as an `HttpHandler` for a `KernelRouteClaim`.
 */

import { jsonResponse } from '@mnmal-ai/substrate-compose';
import type {
  Dataset,
  HttpHandler,
  SubstrateRequest,
  SubstrateResponse
} from '@mnmal-ai/substrate-types';
import type { EmbeddedTypeRef, EmbedSourceRegistry } from './embed-source-registry.js';
import type { EmbedStats, EmbedStatsSnapshot } from './embed-stats.js';
import {
  handleLexicalCoverage,
  type LexicalCoverageDeps,
  type LexicalTypeCoverage
} from './lexical-coverage-core.js';
import type { LexicalSourceRegistry, LexicalTypeRef } from './lexical-source-registry.js';
import type { LexicalStore } from './lexical-store.js';

/** Shape returned by the GET route. */
export interface EmbedStatsResponse extends EmbedStatsSnapshot {
  /** false when the plugin was composed without an embedder (recall off); counts will all be zero in that case. */
  readonly enabled: boolean;
  /**
   * Every type that declares an `embed.source`, sorted — the authoritative
   * answer to "what is embedded", including types with no rows yet.
   *
   * Optional because this is a wire response, and the two empty answers differ:
   *
   *   `undefined`  the server predates this field — it does not know
   *   `[]`         the server knows, and nothing is embedded
   *
   * Do not collapse them with `?? []`.
   */
  readonly embeddedTypes?: ReadonlyArray<EmbeddedTypeRef>;
  /**
   * Every type that declares a `lexical.source`, sorted, including types with
   * no rows yet.
   *
   * Same two-empty-answers rule as `embeddedTypes`; do not collapse with
   * `?? []`. Unlike `embeddedTypes`, an unwired registry yields `undefined`
   * here rather than `[]`.
   */
  readonly lexicalTypes?: ReadonlyArray<LexicalTypeRef>;
  /**
   * Did the plugin receive a `lexicalStore`? The lexical counterpart of
   * `enabled`. Distinguishes the two causes of `lexicalTypes: []`:
   *
   *   store wired, nothing declared  -> fix the CONSUMER's namespace definition
   *   no store wired                 -> fix the HOST's composition
   *
   * `undefined` means the server does not say; `false` means the arm is off.
   * Do not read `!body.lexicalEnabled` as "off".
   */
  readonly lexicalEnabled?: boolean;
  /**
   * Dry-run lexical coverage per (namespace, type) — `{ scanned, indexed,
   * unindexable, failed }`.
   *
   * Present only when the caller passes `?coverage=true`, since each type
   * costs a full dataset scan. Absent key = not asked (or server predates
   * the field).
   *
   * `unindexable: null` on a type means UNKNOWN (entry carries no pure
   * classifier), not zero. Do not collapse with `?? 0`.
   */
  readonly lexicalCoverage?: ReadonlyArray<LexicalTypeCoverage>;
}

/**
 * Facts about composition that the registries cannot supply: a registry knows
 * what was registered, not what was wired.
 */
export interface EmbedStatsComposition {
  /** Did the plugin receive a `lexicalStore`? Omit to say nothing. */
  lexicalEnabled?: boolean;
  /**
   * Store + row source for opt-in `?coverage=true`. Omit either and coverage
   * refuses `unavailable` rather than reporting zeros.
   */
  lexicalStore?: LexicalStore;
  resolveDataset?: (ns: string) => Dataset | null;
}

function emptySnapshot(): EmbedStatsSnapshot {
  return {
    since: new Date(0).toISOString(),
    writes: 0,
    successes: 0,
    failures: 0,
    skips: 0,
    lastFailure: null,
    expansionFailures: 0
  };
}

/**
 * Pure handler. Inputs are the optional stats instance, source registries and
 * composition facts; output is the JSON body shape (without coverage).
 */
export function handleEmbedStatsRequest(
  stats: EmbedStats | undefined,
  registry?: EmbedSourceRegistry,
  lexicalRegistry?: LexicalSourceRegistry,
  composition?: EmbedStatsComposition
): EmbedStatsResponse {
  const snap = stats?.snapshot() ?? emptySnapshot();
  return {
    ...snap,
    enabled: stats !== undefined,
    embeddedTypes: registry?.types() ?? [],
    // Spread-when-present: an absent registry must leave the key OFF the
    // response, which is what makes it indistinguishable from an older server
    // — the state the field's contract names.
    ...(lexicalRegistry !== undefined ? { lexicalTypes: lexicalRegistry.types() } : {}),
    // Spread-when-present for the same reason as lexicalTypes: an absent
    // opinion must leave the key OFF, which is what makes it indistinguishable
    // from an older server rather than from a disabled arm.
    ...(composition?.lexicalEnabled !== undefined
      ? { lexicalEnabled: composition.lexicalEnabled }
      : {})
  };
}

/**
 * KernelRouteClaim handler factory.
 *
 * Returns an `HttpHandler` that serialises the current embed stats snapshot
 * as JSON. Pass to `KernelRouteClaim.handler` when building the substrate
 * plugin's `kernelRoutes` array.
 *
 * @example
 * ```ts
 * kernelRoutes: [
 *   { path: 'embed-stats', method: 'GET', handler: embedStatsRouteHandler(stats) }
 * ]
 * ```
 */
export function embedStatsRouteHandler(
  stats: EmbedStats | undefined,
  registry?: EmbedSourceRegistry,
  lexicalRegistry?: LexicalSourceRegistry,
  composition?: EmbedStatsComposition
): HttpHandler {
  // Sync fast path, async only on the opt-in coverage scan: callers invoke it
  // synchronously and read `.body`. HttpHandler permits both shapes.
  return (req: SubstrateRequest): SubstrateResponse | Promise<SubstrateResponse> => {
    const base = handleEmbedStatsRequest(stats, registry, lexicalRegistry, composition);
    if (!wantsCoverage(req)) return jsonResponse(200, base);
    return coverageResponse(base, lexicalRegistry, composition);
  };
}

async function coverageResponse(
  base: EmbedStatsResponse,
  lexicalRegistry: LexicalSourceRegistry | undefined,
  composition: EmbedStatsComposition | undefined
): Promise<SubstrateResponse> {
  const coverageDeps = toCoverageDeps(lexicalRegistry, composition);
  if (coverageDeps === null) {
    return jsonResponse(503, {
      error: {
        code: 'unavailable',
        message: 'lexical coverage needs a lexical store and a dataset resolver; one is not wired'
      }
    });
  }
  try {
    const coverage = await handleLexicalCoverage({}, coverageDeps);
    return jsonResponse(200, { ...base, lexicalCoverage: coverage.types });
  } catch (err) {
    const code = (err as { code?: string } | null)?.code;
    const message = err instanceof Error ? err.message : String(err);
    if (code === 'unknown_type') {
      return jsonResponse(400, { error: { code, message } });
    }
    if (code === 'unavailable') {
      return jsonResponse(503, { error: { code, message } });
    }
    process.stderr.write(
      `embed-stats coverage failure: ${message}\n${err instanceof Error && err.stack ? err.stack : ''}\n`
    );
    return jsonResponse(500, { error: { code: 'internal', message: 'lexical coverage failed' } });
  }
}

/** `?coverage=true` (or `?coverage=1`) opts into the per-type dry-run scan. Absent/false → stats only. */
function wantsCoverage(req: SubstrateRequest): boolean {
  // Defensive `?.`: the type requires `query`, but in-process callers pass
  // partial reqs, and a coverage probe must never 500 a stats read.
  return req.query?.coverage === 'true' || req.query?.coverage === '1';
}

function toCoverageDeps(
  lexicalRegistry: LexicalSourceRegistry | undefined,
  composition: EmbedStatsComposition | undefined
): LexicalCoverageDeps | null {
  if (
    lexicalRegistry === undefined ||
    composition?.lexicalStore === undefined ||
    composition?.resolveDataset === undefined
  ) {
    return null;
  }
  return {
    registry: lexicalRegistry,
    lexicalStore: composition.lexicalStore,
    resolveDataset: composition.resolveDataset
  };
}

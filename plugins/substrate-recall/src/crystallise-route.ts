/**
 * POST /substrate/v1/crystallise — cluster embedded rows into first-class rows with
 * provenance.
 *
 * There is deliberately no schedule: the CALLER decides when to crystallise,
 * because *when* is policy and recall owns only the mechanism.
 *
 * READ-POLICY GATE: clustering reads row bodies and vectors across whole
 * scopes, so it uses the same `ReadPolicyCheck` as recall, fetch and boost.
 * Denial is LOUD: the caller named explicit scopes, so a denied scope fails
 * the whole request 403.
 *
 * CONCURRENCY: a second crystallise while one is in flight is refused with
 * 409 rather than queued, since concurrent passes would form duplicate
 * clusters. The exclusion lives in `crystallise-guard.ts`, not here, because
 * the `recall/crystallise` frame mutation reaches the same core and must share
 * the guard instance.
 */

import { jsonResponse } from '@mnmal-ai/substrate-compose';
import type { HttpHandler, SubstrateRequest, SubstrateResponse } from '@mnmal-ai/substrate-types';
import type { ClusterStore, MemberRef } from './cluster-store.js';
import type { CrystalliseConfig } from './crystallise-core.js';
import { handleCrystallise, validateCrystalliseInput } from './crystallise-core.js';
import {
  CRYSTALLISE_IN_FLIGHT_CODE,
  type CrystalliseGuard,
  createCrystalliseGuard
} from './crystallise-guard.js';
import type { EmbeddingsStore } from './embeddings-store.js';
import { bindPolicy, type ReadPolicyCheck } from './recall-route.js';
import { callerFromRequest } from './row-visibility.js';
import type { ClusterRunParams } from './run-clusterer.js';

export interface CrystalliseRouteConfig {
  embeddings: EmbeddingsStore;
  /** Absent = crystallisation is not wired; the route answers 503. */
  clusters?: ClusterStore;
  model: string;
  config: CrystalliseConfig;
  runClusterer?: (vectors: readonly Float32Array[], params: ClusterRunParams) => Promise<number[]>;
  rowsMissing?: (refs: readonly MemberRef[]) => Promise<Set<string>>;
  /** Unbound 3-arg check (the plugin config form) — the route binds identity. */
  checkReadPolicy?: ReadPolicyCheck;
  /**
   * Shared mutual-exclusion guard (see module doc); must be the instance the
   * frame surface holds. Omitted = a private guard scoped to this handler
   * only, which is NOT sufficient for production wiring.
   */
  guard?: CrystalliseGuard;
}

const UNAVAILABLE_MESSAGE =
  'crystallise unavailable: no ClusterStore is wired (recall was composed without one).';

type ParseResult = { ok: unknown } | { error: string };

function parseBody(req: SubstrateRequest): ParseResult {
  const raw = req.body;
  if (raw === null || (Buffer.isBuffer(raw) && raw.length === 0)) {
    return { error: 'request body is required' };
  }
  try {
    return { ok: JSON.parse(Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw)) };
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'invalid JSON' };
  }
}

export function crystalliseRouteHandler(cfg: CrystalliseRouteConfig): HttpHandler {
  // Private fallback guard: NOT sufficient for production wiring (see
  // CrystalliseRouteConfig.guard).
  const guard = cfg.guard ?? createCrystalliseGuard();

  return async (req: SubstrateRequest): Promise<SubstrateResponse> => {
    const clusters = cfg.clusters;
    if (clusters === undefined) {
      return jsonResponse(503, {
        error: { code: 'crystallise_unavailable', message: UNAVAILABLE_MESSAGE }
      });
    }

    const parsed = parseBody(req);
    if ('error' in parsed) {
      return jsonResponse(400, { code: 'bad_request', message: parsed.error });
    }

    let input: ReturnType<typeof validateCrystalliseInput>;
    try {
      input = validateCrystalliseInput(parsed.ok);
    } catch (err) {
      return jsonResponse(400, {
        code: 'bad_request',
        message: err instanceof Error ? err.message : String(err)
      });
    }

    const bound = bindPolicy(cfg.checkReadPolicy, callerFromRequest(req));

    try {
      const out = await guard.runExclusive(() =>
        handleCrystallise(input, {
          embeddings: cfg.embeddings,
          clusters,
          model: cfg.model,
          config: cfg.config,
          ...(cfg.runClusterer !== undefined ? { runClusterer: cfg.runClusterer } : {}),
          ...(cfg.rowsMissing !== undefined ? { rowsMissing: cfg.rowsMissing } : {}),
          ...(bound !== undefined ? { checkReadPolicy: bound } : {}),
          caller: callerFromRequest(req)
        })
      );
      return jsonResponse(200, out);
    } catch (err) {
      const code = (err as { code?: string } | null)?.code;
      const message = err instanceof Error ? err.message : String(err);
      if (code === 'policy_denied') {
        return jsonResponse(403, { error: { code: 'policy_denied', message } });
      }
      if (code === 'bad_request') {
        return jsonResponse(400, { code: 'bad_request', message });
      }
      if (code === CRYSTALLISE_IN_FLIGHT_CODE) {
        return jsonResponse(409, { error: { code: CRYSTALLISE_IN_FLIGHT_CODE, message } });
      }
      process.stderr.write(
        `crystallise route failure: ${message}\n${err instanceof Error && err.stack ? err.stack : ''}\n`
      );
      return jsonResponse(500, { error: { code: 'internal', message: 'crystallise failed' } });
    }
  };
}

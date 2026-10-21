/**
 * POST /substrate/v1/salience/boost — explicit, consumer-driven salience
 * reinforcement (the write-side mirror of /substrate/v1/recall).
 *
 * Callers name the rows they actually used and bump their salience; the
 * explicit counterpart to recall's auto-boost (opt out with `boost:false`).
 *
 * Gated on both read and write policy. Denial is LOUD: the caller named
 * explicit targets, so a denied (namespace, type) scope fails the whole
 * request 403 `policy_denied`.
 *
 * Unlike the recall route's fire-and-forget boost, this AWAITS the store so
 * the caller gets a confirmation it can sequence against.
 */

import { jsonResponse } from '@mnmal-ai/substrate-compose';
import type { HttpHandler, SubstrateRequest, SubstrateResponse } from '@mnmal-ai/substrate-types';
import type { EmbeddingsStore } from './embeddings-store.js';
import {
  bindPolicy,
  DEFAULT_SALIENCE_CONFIG,
  type ReadPolicyCheck,
  type SalienceConfig,
  type WritePolicyCheck
} from './recall-route.js';
import { callerFromRequest } from './row-visibility.js';
import { handleSalienceBoost, validateBoostInput } from './salience-boost-core.js';

// Re-exported for importers (index.ts, route tests) that take it from here.
export { SALIENCE_BOOST_MAX_TARGETS } from './salience-boost-core.js';

export interface SalienceBoostRouteConfig {
  store: EmbeddingsStore;
  /** Supplies the boost decay half-life. Defaults to DEFAULT_SALIENCE_CONFIG. */
  salience?: SalienceConfig;
  /** Unbound read-policy check — the route binds `req.identity`. */
  checkReadPolicy?: ReadPolicyCheck;
  /** Unbound write-policy check — the route binds `req.identity`. Absent → refused. */
  checkWritePolicy?: WritePolicyCheck;
  /** Embedding model whose stored bodies row filters are judged on. */
  model?: string;
}

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

/**
 * KernelRouteClaim handler factory for `POST /substrate/v1/salience/boost`.
 * Registered by `createRecallPlugin` alongside the recall route. Thin
 * transport adapter over `handleSalienceBoost` — JSON-parse + bind identity,
 * then map coded throws (bad_request → 400, policy_denied → 403) to envelopes.
 */
export function salienceBoostRouteHandler(cfg: SalienceBoostRouteConfig): HttpHandler {
  return async (req: SubstrateRequest): Promise<SubstrateResponse> => {
    const parsed = parseBody(req);
    if ('error' in parsed) {
      return jsonResponse(400, {
        code: 'bad_request',
        message: parsed.error
      });
    }

    let input: ReturnType<typeof validateBoostInput>;
    try {
      input = validateBoostInput(parsed.ok);
    } catch (err) {
      return jsonResponse(400, {
        code: 'bad_request',
        message: err instanceof Error ? err.message : String(err)
      });
    }

    // Bind the request's verified identity (absent = anonymous) into the
    // policy checks so the core stays transport-agnostic.
    const unbound = cfg.checkReadPolicy;
    const unboundWrite = cfg.checkWritePolicy;
    const caller = callerFromRequest(req);
    try {
      const out = await handleSalienceBoost(input, {
        store: cfg.store,
        halfLifeHours: (cfg.salience ?? DEFAULT_SALIENCE_CONFIG).halfLifeHours,
        ...(unbound !== undefined ? { checkReadPolicy: bindPolicy(unbound, caller) } : {}),
        ...(unboundWrite !== undefined
          ? { checkWritePolicy: bindPolicy(unboundWrite, caller) }
          : {}),
        caller,
        ...(cfg.model !== undefined ? { model: cfg.model } : {})
      });
      return jsonResponse(200, out);
    } catch (err) {
      const code = (err as { code?: string } | null)?.code;
      const message = err instanceof Error ? err.message : String(err);
      if (code === 'policy_denied') {
        return jsonResponse(403, { error: { code: 'policy_denied', message } });
      }
      process.stderr.write(
        `salience-boost route failure: ${message}\n${err instanceof Error && err.stack ? err.stack : ''}\n`
      );
      return jsonResponse(500, { error: { code: 'internal', message: 'salience boost failed' } });
    }
  };
}

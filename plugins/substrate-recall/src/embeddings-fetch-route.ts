/**
 * POST /substrate/v1/embeddings/fetch — thin HTTP exposure of
 * `EmbeddingsStore.fetchEmbeddings`: callers name explicit (namespace, type,
 * id) refs and get row bodies joined to stored vectors. Refs without an
 * embedding under the resolved model are silently absent.
 *
 * Raw vectors leak content geometry, so the route applies the same read
 * policy as /substrate/v1/recall. Any denied scope fails the whole request with 403
 * `policy_denied`: the caller named explicit refs, so a silent empty result
 * would hide an actionable error.
 *
 * With `boost: true`, the returned rows are reinforced, gated by write policy.
 */

import { jsonResponse } from '@mnmal-ai/substrate-compose';
import type { Embedder } from '@mnmal-ai/substrate-embedder';
import type { HttpHandler, SubstrateRequest, SubstrateResponse } from '@mnmal-ai/substrate-types';
import { handleEmbeddingsFetch, validateFetchInput } from './embeddings-fetch-core.js';
import type { EmbeddingsStore } from './embeddings-store.js';
import {
  bindPolicy,
  type ReadPolicyCheck,
  type SalienceConfig,
  type WritePolicyCheck
} from './recall-route.js';
import { callerFromRequest } from './row-visibility.js';

// Re-exported so existing importers keep importing the cap from here.
export { EMBEDDINGS_FETCH_MAX_REFS } from './embeddings-fetch-core.js';

export interface EmbeddingsFetchRouteConfig {
  store: EmbeddingsStore;
  /** Supplies the default model id when the request omits `model`. */
  embedder?: Embedder;
  /** Supplies the boost decay half-life. Defaults to DEFAULT_SALIENCE_CONFIG. */
  salience?: SalienceConfig;
  /** Unbound read-policy check — the route binds `req.identity`. */
  checkReadPolicy?: ReadPolicyCheck;
  /** Unbound write-policy check — the route binds `req.identity`. */
  checkWritePolicy?: WritePolicyCheck;
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
 * KernelRouteClaim handler factory for `POST /substrate/v1/embeddings/fetch`.
 * Registered by `createRecallPlugin` alongside the recall route. Thin
 * transport adapter over `handleEmbeddingsFetch` — JSON-parse + bind identity,
 * then map coded throws (bad_request → 400, policy_denied → 403) to envelopes.
 */
export function embeddingsFetchRouteHandler(cfg: EmbeddingsFetchRouteConfig): HttpHandler {
  return async (req: SubstrateRequest): Promise<SubstrateResponse> => {
    const parsed = parseBody(req);
    if ('error' in parsed) {
      return jsonResponse(400, {
        code: 'bad_request',
        message: parsed.error
      });
    }

    let input: ReturnType<typeof validateFetchInput>;
    try {
      input = validateFetchInput(parsed.ok);
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
      const out = await handleEmbeddingsFetch(input, {
        store: cfg.store,
        ...(cfg.embedder !== undefined ? { embedder: cfg.embedder } : {}),
        ...(cfg.salience !== undefined ? { salience: cfg.salience } : {}),
        ...(unbound !== undefined ? { checkReadPolicy: bindPolicy(unbound, caller) } : {}),
        ...(unboundWrite !== undefined
          ? { checkWritePolicy: bindPolicy(unboundWrite, caller) }
          : {}),
        caller
      });
      return jsonResponse(200, out);
    } catch (err) {
      const code = (err as { code?: string } | null)?.code;
      const message = err instanceof Error ? err.message : String(err);
      if (code === 'bad_request') {
        return jsonResponse(400, { code: 'bad_request', message });
      }
      if (code === 'policy_denied') {
        return jsonResponse(403, { error: { code: 'policy_denied', message } });
      }
      process.stderr.write(
        `embeddings-fetch route failure: ${message}\n${err instanceof Error && err.stack ? err.stack : ''}\n`
      );
      return jsonResponse(500, { error: { code: 'internal', message: 'embeddings fetch failed' } });
    }
  };
}

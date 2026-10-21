/**
 * POST /substrate/v1/embed/reindex — admin-gated server-side re-embed. Thin
 * transport adapter over `handleReindex`.
 *
 * Capability is `admin`, not `mutate`: `admin` is the only capability compose
 * enforces under `mode: 'attribute'`, so a `mutate` claim would leave the
 * route open to any caller there. See `KernelRouteClaim.capability`.
 */

import { jsonResponse } from '@mnmal-ai/substrate-compose';
import type { HttpHandler, SubstrateRequest, SubstrateResponse } from '@mnmal-ai/substrate-types';
import { handleReindex, type ReindexCoreDeps, validateReindexInput } from './reindex-core.js';

export type ReindexRouteConfig = ReindexCoreDeps;

export function reindexRouteHandler(cfg: ReindexRouteConfig): HttpHandler {
  return async (req: SubstrateRequest): Promise<SubstrateResponse> => {
    const raw = req.body;
    if (raw === null || (Buffer.isBuffer(raw) && raw.length === 0)) {
      return jsonResponse(400, { code: 'bad_request', message: 'request body is required' });
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw));
    } catch (err) {
      return jsonResponse(400, {
        code: 'bad_request',
        message: err instanceof Error ? err.message : 'invalid JSON'
      });
    }

    try {
      return jsonResponse(200, await handleReindex(validateReindexInput(parsed), cfg));
    } catch (err) {
      const code = (err as { code?: string } | null)?.code;
      const message = err instanceof Error ? err.message : String(err);
      if (code === 'bad_request' || code === 'unknown_type') {
        return jsonResponse(400, { error: { code, message } });
      }
      if (code === 'unavailable') {
        return jsonResponse(503, { error: { code, message } });
      }
      process.stderr.write(
        `reindex route failure: ${message}\n${err instanceof Error && err.stack ? err.stack : ''}\n`
      );
      return jsonResponse(500, { error: { code: 'internal', message: 'reindex failed' } });
    }
  };
}

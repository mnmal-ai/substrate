/**
 * POST /substrate/v1/lexical/reindex — admin-gated server-side lexical backfill.
 * Thin transport adapter over `handleLexicalReindex`.
 *
 * Capability is `admin`, not `mutate`: it rewrites indexed text across a
 * whole type, and `admin` is the only capability compose enforces under
 * `mode: 'attribute'` — a `mutate` claim would leave the route open there.
 */

import { jsonResponse } from '@mnmal-ai/substrate-compose';
import type { HttpHandler, SubstrateRequest, SubstrateResponse } from '@mnmal-ai/substrate-types';
import {
  handleLexicalReindex,
  type LexicalReindexCoreDeps,
  validateLexicalReindexInput
} from './lexical-reindex-core.js';

export type LexicalReindexRouteConfig = LexicalReindexCoreDeps;

export function lexicalReindexRouteHandler(cfg: LexicalReindexRouteConfig): HttpHandler {
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
      return jsonResponse(
        200,
        await handleLexicalReindex(validateLexicalReindexInput(parsed), cfg)
      );
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
        `lexical reindex route failure: ${message}\n${err instanceof Error && err.stack ? err.stack : ''}\n`
      );
      return jsonResponse(500, { error: { code: 'internal', message: 'lexical reindex failed' } });
    }
  };
}

/**
 * POST /substrate/v1/query — accept a frame, dispatch to the engine, return envelope.
 * Negotiates `application/vnd.substrate.pack` (§7.0) vs JSON on the Accept header.
 */

import type { Engine } from '@mnmal-ai/substrate-core';
import type { HttpHandler } from '@mnmal-ai/substrate-types';
import {
  buildContext,
  error400,
  parseJsonBody,
  serializeEnvelope,
  validateFrame
} from './helpers.js';

export function queryRoute(
  engine: Engine,
  trustedProxies: Set<string>,
  authEnabled?: boolean,
  pageLimits?: { defaultLimit: number; maxLimit: number }
): HttpHandler {
  return async (req) => {
    const parsed = parseJsonBody(req);
    if (!parsed.ok) return parsed.response;
    if (!validateFrame(parsed.value)) {
      return error400('frame must be an object of { params?, fields? } entries');
    }
    const frame = parsed.value;
    const envelope = await engine.query({
      frame,
      ctx: buildContext(req, trustedProxies, authEnabled),
      ...(req.signal !== undefined ? { signal: req.signal } : {}),
      ...(pageLimits !== undefined ? { pageLimits } : {})
    });
    return serializeEnvelope(req, envelope, engine, frame);
  };
}

/**
 * POST /substrate/v1/query — accept a frame, dispatch to the engine, return envelope.
 * Negotiates `application/vnd.substrate.pack` (§7.0) vs JSON on the Accept header.
 */

import type { Engine } from '@mnmal-ai/substrate-core';
import type { HttpHandler, QualifiedFrame } from '@mnmal-ai/substrate-types';
import {
  buildContext,
  error400,
  frameShapeError,
  parseJsonBody,
  serializeEnvelope
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
    const shapeError = frameShapeError(parsed.value);
    if (shapeError !== null) return error400(shapeError);
    const frame = parsed.value as QualifiedFrame;
    const envelope = await engine.query({
      frame,
      ctx: buildContext(req, trustedProxies, authEnabled),
      ...(req.signal !== undefined ? { signal: req.signal } : {}),
      ...(pageLimits !== undefined ? { pageLimits } : {})
    });
    return serializeEnvelope(req, envelope, engine, frame);
  };
}

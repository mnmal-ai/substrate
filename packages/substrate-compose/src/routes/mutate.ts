/**
 * POST /substrate/v1/mutate — accept a frame, dispatch to the engine, return envelope.
 *
 * Under `Accept: application/vnd.substrate.pack`, mutation responses are positionally
 * encoded using the per-mutation `MutationSchema.returns` metadata emitted
 * by the registry. The route pulls each mutation's registry entry via
 * `engine.registryFor(ns)` and threads the declared `returns` FieldDef into
 * the substrate-pack encoder (§5.2).
 */

import {
  type EncodeContext,
  type FieldDef,
  type HttpHandler,
  parseQualifiedKey
} from '@mnmal-ai/substrate-types';
import {
  buildContext,
  error400,
  parseJsonBody,
  serializeEnvelope,
  validateFrame
} from './helpers.js';

export function mutateRoute(
  engine: EncodeContext,
  trustedProxies: Set<string>,
  authEnabled?: boolean
): HttpHandler {
  return async (req) => {
    const parsed = parseJsonBody(req);
    if (!parsed.ok) return parsed.response;
    if (!validateFrame(parsed.value)) {
      return error400('frame must be an object of { params?, fields? } entries');
    }
    const frame = parsed.value;
    const envelope = await engine.mutate({
      frame,
      ctx: buildContext(req, trustedProxies, authEnabled),
      ...(req.signal !== undefined ? { signal: req.signal } : {})
    });

    // Build the per-key returns/ns map from the frame. Keys whose registry
    // entry carries no `returns` are omitted — they fall through to the
    // helpers' implicit JSON-passthrough path.
    const returnsByKey: Record<string, FieldDef> = {};
    const currentNsByKey: Record<string, string> = {};
    for (const key of Object.keys(frame)) {
      const parsed = parseQualifiedKey(key);
      if (parsed === null) continue;
      const { ns, name } = parsed;
      const registry = engine.registryFor(ns);
      const entry = registry?.get(name);
      if (entry?.returns !== undefined) {
        returnsByKey[key] = entry.returns;
        currentNsByKey[key] = ns;
      }
    }

    return serializeEnvelope(req, envelope, engine, frame, { returnsByKey, currentNsByKey });
  };
}

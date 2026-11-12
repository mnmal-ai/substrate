/**
 * POST /substrate/v1/mutate — accept a frame, dispatch to the engine, return envelope.
 *
 * Under `Accept: application/vnd.substrate.pack`, mutation responses are positionally
 * encoded using the per-mutation `MutationSchema.returns` metadata emitted
 * by the registry. The route pulls each mutation's registry entry via
 * `engine.registryFor(ns)` and threads the declared `returns` FieldDef into
 * the substrate-pack encoder (§5.2).
 *
 * On the JSON wire, a create or update that names no `fields` answers with
 * `{ id, shortId }` rather than the whole written row.
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
    // The frame the response is projected by: a row-writing mutation with no
    // `fields` answers ACK_FIELDS. Pack ignores `fields` on mutations, so this
    // shapes the JSON wire only.
    const projectBy: typeof frame = { ...frame };
    for (const [key, frameEntry] of Object.entries(frame)) {
      const parsed = parseQualifiedKey(key);
      if (parsed === null) continue;
      const { ns, name } = parsed;
      const registry = engine.registryFor(ns);
      const entry = registry?.get(name);
      if (entry?.returns !== undefined) {
        returnsByKey[key] = entry.returns;
        currentNsByKey[key] = ns;
      }
      if (entry !== undefined && writesRows(entry)) {
        projectBy[key] = Array.isArray(frameEntry)
          ? frameEntry.map(withAckFields)
          : withAckFields(frameEntry);
      }
    }

    return serializeEnvelope(req, envelope, engine, projectBy, { returnsByKey, currentNsByKey });
  };
}

/** What a row-writing mutation answers when the frame names no `fields`. */
const ACK_FIELDS = { id: true, shortId: true } as const;

/** A create or update that returns rows of a declared type, not a struct of its own (delete's `{ id, deleted }`). */
function writesRows(entry: {
  verb?: string;
  returns?: FieldDef;
  fields?: Record<string, FieldDef>;
}): boolean {
  return (
    (entry.verb === 'create' || entry.verb === 'update') &&
    entry.returns !== undefined &&
    entry.fields !== undefined &&
    Object.keys(entry.fields).length > 0
  );
}

function withAckFields<E extends { fields?: unknown }>(frameEntry: E): E {
  return frameEntry.fields === undefined ? { ...frameEntry, fields: ACK_FIELDS } : frameEntry;
}

/**
 * POST /substrate/v1/mutate — accept a frame, dispatch to the engine, return envelope.
 *
 * Under `Accept: application/vnd.substrate.pack`, mutation responses are positionally
 * encoded by each mutation's published `MutationSchema.returns` (§5.2).
 *
 * A mutation answers by the frame's `fields` on both wires, and a create or
 * update that names none answers `{ id, shortId }`: JSON projects the result,
 * pack encodes it by `returns` narrowed the same way (`mutationReturns`).
 */

import { MUTATION_ACK_FIELDS, mutationReturns } from '@mnmal-ai/substrate-pack';
import {
  type EncodeContext,
  type FieldDef,
  type FieldInput,
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

    // Each key's result shape comes from the published schema, the same source
    // the client decodes by, so a bridged or `returns`-less mutation agrees too.
    const schemas = engine.federatedSchema();
    const returnsByKey: Record<string, FieldDef | readonly FieldDef[]> = {};
    const currentNsByKey: Record<string, string> = {};
    // The frame the JSON response is projected by: a row-writing mutation
    // with no `fields` answers MUTATION_ACK_FIELDS.
    const projectBy: typeof frame = { ...frame };
    for (const [key, frameEntry] of Object.entries(frame)) {
      const parsed = parseQualifiedKey(key);
      if (parsed === null) continue;
      const mutation = schemas[parsed.ns]?.mutations[parsed.name];
      if (mutation === undefined) continue;
      currentNsByKey[key] = parsed.ns;
      const shapeOf = (f: { fields?: unknown }): FieldDef =>
        mutationReturns(mutation, f.fields as FieldInput | true | undefined);
      // Each frame of a batch answers by its own `fields`.
      returnsByKey[key] = Array.isArray(frameEntry) ? frameEntry.map(shapeOf) : shapeOf(frameEntry);
      if (mutation.writesRows === true) {
        projectBy[key] = Array.isArray(frameEntry)
          ? frameEntry.map(withAckFields)
          : withAckFields(frameEntry);
      }
    }

    return serializeEnvelope(req, envelope, engine, projectBy, { returnsByKey, currentNsByKey });
  };
}

function withAckFields<E extends { fields?: unknown }>(frameEntry: E): E {
  return frameEntry.fields === undefined
    ? { ...frameEntry, fields: MUTATION_ACK_FIELDS }
    : frameEntry;
}

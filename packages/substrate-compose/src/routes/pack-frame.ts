/** A response frame's wire payload per encoding, shared by WS and frame streams. */

import type { Engine } from '@mnmal-ai/substrate-core';
import { encodePositional, encodeWsFrame, type WireMode } from '@mnmal-ai/substrate-pack';
import {
  type FieldInput,
  parseQualifiedKey,
  type Schema,
  stringifyJson,
  type WsResponseFrame
} from '@mnmal-ai/substrate-types';
import { projectWsFrame } from './project-json.js';

/**
 * Produce a wire-ready frame object — for substrate-pack, positionally encode
 * `data` against the per-key FieldInput + the engine's federated schema. Remove
 * frames (no `data`) and error/end frames pass through untouched.
 */
export function encodeDataForPack(
  frame: WsResponseFrame,
  fieldsByKey: ReadonlyMap<string, FieldInput> | undefined,
  engine: Engine
): WsResponseFrame {
  if (frame.data === undefined || fieldsByKey === undefined) return frame;
  const schemas = engine.federatedSchema();
  const encoded: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(frame.data as Record<string, unknown>)) {
    const parsed = parseQualifiedKey(key);
    if (parsed === null) {
      encoded[key] = value;
      continue;
    }
    const { ns, name } = parsed;
    const fields = fieldsByKey.get(key);
    const schema: Schema | undefined = schemas[ns];
    if (fields === undefined || schema === undefined) {
      encoded[key] = value;
      continue;
    }
    const rawShape = frame.shapes?.[key];
    // Subscriptions + streams never emit batched (array-of-shapes) values —
    // the batched mutate surface is §5.13 and is rejected on subscribe/stream
    // entry. Narrow to the single-frame shape so the encoder can dispatch
    // cleanly; the array arm is unreachable here by contract.
    // Nor a count or groups map: subscriptions take no walk params.
    const shape = rawShape === 'single' || rawShape === 'list' ? rawShape : undefined;
    encoded[key] = encodeByShape(value, fields, schema, name, shape, {
      schemas,
      currentNs: ns
    });
  }
  return { ...frame, data: encoded };
}

function encodeByShape(
  value: unknown,
  fields: FieldInput,
  schema: Schema,
  typeName: string,
  shape: 'single' | 'list' | undefined,
  ctx: { schemas: Record<string, Schema>; currentNs: string }
): unknown {
  if (value === null || value === undefined) return null;
  if (shape === 'list') {
    if (!Array.isArray(value)) return value;
    return value.map((row) => encodePositional(row, fields, schema, typeName, ctx));
  }
  return encodePositional(value, fields, schema, typeName, ctx);
}

/** The WS message for `frame`; a frame stream carries the same bytes behind a length prefix. */
export function serializeFrame(
  frame: WsResponseFrame,
  mode: WireMode,
  fieldsByKey: ReadonlyMap<string, FieldInput> | undefined,
  engine: Engine
): Buffer | string {
  if (mode === 'json') return stringifyJson(projectWsFrame(frame, fieldsByKey));
  const encoded = encodeDataForPack(frame, fieldsByKey, engine);
  const wire = encodeWsFrame(encoded, mode);
  return typeof wire === 'string' ? wire : Buffer.from(wire);
}

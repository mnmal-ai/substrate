/**
 * Field projection for the JSON response path: trims each `envelope.data[key]`
 * to its frame entry's `fields`, matching the substrate-pack encoder:
 *
 *   - `fields = undefined`        → no projection (caller opted into raw shape)
 *   - `fields = { id: true }`      → only `id` retained
 *   - `fields = { meta: { x:1 } }` → `meta` retained, narrowed to `{ x }`
 *   - `selection === true` on any value → pass through as-is (matches pack's
 *      "whole-row" / "whole-list" / "whole-struct" leaf semantics)
 *
 * Batched mutate (§5.13) array op-keys carry no single `fields` selection, so
 * they pass through unmodified — the engine has already encoded the per-frame
 * results into the shape that ride on the wire.
 */

import type { FieldInput, PackEnvelope, WsResponseFrame } from '@mnmal-ai/substrate-types';
import type { Frame } from './helpers.js';

/**
 * Recursively project a value against a selection sub-tree. Leaf-true at any
 * point passes the underlying value through unchanged. Arrays are walked
 * element-wise so list-of-struct projections work naturally.
 */
export function projectValue(value: unknown, selection: true | FieldInput): unknown {
  if (selection === true) return value;
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) {
    return value.map((v) => projectValue(v, selection));
  }
  if (typeof value !== 'object') return value;
  const obj = value as Record<string, unknown>;
  // An `{ __orphan: true, reason }` degradation marker (§6.5) is not a row;
  // projecting it would strip it to `{}`, so pass it through whole.
  if (obj.__orphan === true) return value;
  const out: Record<string, unknown> = {};
  let walked = false;
  for (const [field, sub] of Object.entries(selection)) {
    if (!(field in obj)) continue;
    const nested = nestedFields(sub);
    if (nested !== undefined) walked = true;
    // `_agg` maps names to aggregate specs, not to sub-selections: the
    // values pass through. A nested `{ _walk }` list projects each row
    // against its own `fields`, keeping the `id` every nested row carries.
    out[field] =
      field === '_agg'
        ? obj[field]
        : projectValue(obj[field], nested === undefined ? sub : { id: true, ...nested });
  }
  if (walked && obj._truncated !== undefined) out._truncated = obj._truncated;
  return out;
}

/** A nested `{ _walk }` selection's own `fields`, or undefined for any other selection. */
function nestedFields(sel: true | FieldInput): FieldInput | undefined {
  if (typeof sel !== 'object' || !Object.hasOwn(sel, '_walk')) return undefined;
  const fields = sel.fields;
  return typeof fields === 'object' && fields !== null ? (fields as FieldInput) : {};
}

/**
 * Return a new envelope whose `data` map has each entry trimmed to its
 * frame entry's `fields` projection. `errors`, `shapes`, `_pagination`, and
 * `schemaVersion` are envelope metadata and pass through verbatim.
 */
export function projectEnvelope(envelope: PackEnvelope, frame: Frame): PackEnvelope {
  const data: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(envelope.data)) {
    const entry = frame[key];
    // Batched mutate (array op-keys) have no single `fields` selection — the
    // engine has already shaped the per-frame results that ride here.
    // Likewise an unknown key (engine-injected error) passes through.
    if (entry === undefined || Array.isArray(entry)) {
      data[key] = value;
      continue;
    }
    const fields = entry.fields as FieldInput | undefined;
    // `{ count }` and `{ groups }` are not rows; there is nothing to project.
    const shape = envelope.shapes[key];
    if (fields === undefined || shape === 'count' || shape === 'groups') {
      data[key] = value;
      continue;
    }
    data[key] = projectValue(value, fields);
  }
  return { ...envelope, data };
}

/**
 * WS analog of `projectEnvelope` — applies the same row-trimming to the
 * `data` payload of a `WsResponseFrame` using the per-key `fieldsByKey`
 * map the route layer captures at subscribe / stream time.
 *
 * Frames without `data` (`error`, `end`, `remove`) and frames where
 * `fieldsByKey` is undefined pass through by reference — no allocation.
 * For frames with `data`, the payload is rebuilt in a fresh object so the
 * original frame stays available to the caller (the bus may dispatch the
 * same source frame to multiple subscriptions).
 */
export function projectWsFrame(
  frame: WsResponseFrame,
  fieldsByKey: ReadonlyMap<string, FieldInput> | undefined
): WsResponseFrame {
  if (frame.data === undefined || fieldsByKey === undefined) return frame;
  const projected: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(frame.data as Record<string, unknown>)) {
    const fields = fieldsByKey.get(key);
    if (fields === undefined) {
      projected[key] = value;
      continue;
    }
    projected[key] = projectValue(value, fields);
  }
  return { ...frame, data: projected };
}

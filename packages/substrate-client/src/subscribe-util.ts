/**
 * Pure, transport-agnostic frame helpers for the single-key live surfaces
 * (`SubstrateClient.watch`).
 */

import type { QualifiedFrame } from './transport/http.js';

/**
 * Produce a copy of `frame` where every qualified key's `fields` selection has
 * `id: true` injected. `update` and `remove` subscribe events are correlated by
 * row id, so without an `id` in the selection a live consumer would have nothing
 * to patch against.
 *
 * The input frame is never mutated. Callers still use the original frame for
 * cache-key canonicalisation so query + subscribe on the same frame resolve to
 * the same cache entry.
 */
export function augmentFramesWithId(frame: QualifiedFrame): QualifiedFrame {
  const out: QualifiedFrame = {};
  for (const [key, entry] of Object.entries(frame)) {
    if (Array.isArray(entry)) {
      out[key] = entry.map((e) => ({
        params: e.params ?? {},
        fields: { id: true, ...(e.fields ?? {}) }
      }));
    } else if (entry !== undefined) {
      out[key] = {
        params: entry.params ?? {},
        fields: { id: true, ...(entry.fields ?? {}) }
      };
    }
  }
  return out;
}

/**
 * Validate that `frame` has exactly one qualified key and return it. Throws with
 * a descriptive error for zero- or multi-key frames.
 */
export function assertSingleKey(frame: QualifiedFrame): string {
  const keys = Object.keys(frame);
  if (keys.length !== 1) {
    if (keys.length === 0) {
      throw new Error('Live subscribe surfaces require exactly one key in the frame.');
    }
    throw new Error(
      `Live subscribe surfaces require a single qualified key. Got: ${keys.join(', ')}`
    );
  }
  return keys[0] as string;
}

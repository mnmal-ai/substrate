/**
 * SSE wire framing. Spec §5. Pure — no I/O, so every wire-format decision is
 * unit-testable without a server.
 *
 * Encoding is `json` ONLY. SSE `data:` is a text field; base64-ing msgpack
 * would cost ~33% to ship the format that is supposed to be the compact one.
 * The §7.4 pack codec stays reserved for a future binary transport.
 */

import type { FieldInput } from '@mnmal-ai/substrate-types';
import { projectWsFrame } from './project-json.js';
import type { SessionFrame } from './stream-session.js';

export const SSE_HEADERS: Record<string, string> = {
  'content-type': 'text/event-stream',
  'cache-control': 'no-store',
  // Defeats proxy buffering, which would otherwise defeat streaming entirely.
  'x-accel-buffering': 'no'
};

export const SSE_HEARTBEAT = ': keepalive\n\n';

/** Browser default is 3s — too eager when every reconnect costs a snapshot. */
export function sseRetry(ms: number): string {
  return `retry: ${ms}\n\n`;
}

/**
 * Render one frame.
 *
 * NOTE: deliberately emits NO `id:` field. An `id:` causes the browser to send
 * `Last-Event-ID` on reconnect, which advertises a resume capability Substrate does
 * not implement (subscriptions are state-convergent, not event-sourced — spec
 * §4). `sequence` travels inside `data` for client-side ordering instead.
 */
export function sseEvent(
  frame: SessionFrame,
  fieldsByKey: ReadonlyMap<string, FieldInput> | undefined
): string {
  return `event: ${frame.kind}\ndata: ${JSON.stringify(payloadFor(frame, fieldsByKey))}\n\n`;
}

function payloadFor(
  frame: SessionFrame,
  fieldsByKey: ReadonlyMap<string, FieldInput> | undefined
): Record<string, unknown> {
  if (frame.kind === 'end') {
    // Precedence matters: the engine sets `reason` explicitly for a token
    // termination (e.g. overload teardown) — pass that through unchanged. A
    // client-cancelled stream carries no `reason`, only `_meta.cancelled`; a
    // natural completion carries neither. Keeping the three distinct lets a
    // client tell "I cancelled this" from "it finished" from an eviction.
    // `_meta` itself stays off the wire.
    const reason = frame.reason ?? (frame._meta?.cancelled === true ? 'cancelled' : 'complete');
    return { reason };
  }
  if (frame.kind === 'error') {
    const first = frame.errors?.[0];
    return {
      code: first?.code ?? 'error',
      message: first?.message ?? 'stream error'
    };
  }
  if (frame.kind === 'remove') {
    // No `key` here: the engine never sets `data` on a remove frame, so there
    // is no key to report.
    return { removedId: frame.removedId };
  }

  // Data-bearing frames: project through the same JSON path the WS route uses
  // in `json` mode so both transports agree field-for-field.
  const projected = projectWsFrame(frame, fieldsByKey);
  const data = (projected.data ?? {}) as Record<string, unknown>;
  const key = Object.keys(data)[0];
  if (key === undefined) return {};
  const value = data[key];
  // Prefer the engine's own `shapes` map over the kind-based heuristic when
  // present — `shapes` is the authority on single-vs-list, and a list-shaped
  // non-snapshot frame would otherwise ship an array under the singular `row`.
  const shape = frame.shapes?.[key];
  const useRows = shape !== undefined ? shape === 'list' : frame.kind === 'snapshot';
  const base: Record<string, unknown> = useRows
    ? { key, rows: Array.isArray(value) ? value : [value] }
    : { key, row: value };
  return frame.sequence !== undefined ? { ...base, sequence: frame.sequence } : base;
}

/**
 * WS-frame wire codec. Spec §8.5.
 *
 * Centralizes JSON-vs-pack envelope handling for WebSocket transports plus the
 * precomputed decode plan that turns positional `data` tuples back into named
 * objects. The plan is built once per subscription, so per-frame work is
 * O(plan entries). Shared by substrate-client and the perf harness so both
 * measure the same codepath.
 */

import { type FieldInput, parseQualifiedKey, type Schema } from '@mnmal-ai/substrate-types';
import { pack, Unpackr } from 'msgpackr';

import { decodePositional } from './decoder.js';

export type WireMode = 'json' | 'pack';

/**
 * Encode an outbound WS frame. Pack mode returns msgpack bytes; JSON mode
 * returns stringified text. The `mode` argument is the wire-format discriminant
 * — call sites can route the result to the right `WebSocket.send` overload via
 * a typed `typeof wire === 'string'` branch.
 */
export function encodeWsFrame(value: unknown, mode: WireMode): string | Uint8Array {
  return mode === 'pack' ? pack(value) : JSON.stringify(value);
}

/**
 * Decode an inbound WS message envelope (the outer `{ id, kind, data?, ... }`
 * shape — positional `data` reconstruction is a separate concern handled by
 * `applyDecodePlanInPlace`).
 *
 * The `mode` discriminant determines how `raw` is interpreted: pack-mode
 * messages arrive as `ArrayBuffer | Uint8Array | Buffer` and are msgpack-
 * decoded; JSON-mode messages arrive as `string` (or, when node-ws hands the
 * payload across as binary, as bytes that we coerce back to text before
 * `JSON.parse`).
 *
 * The runtime narrowing is centralized here so callers don't reach for
 * `raw as string` casts at every call site.
 */
export function decodeWsEnvelope<T = unknown>(raw: unknown, mode: WireMode): T {
  if (mode === 'pack') return inbound.unpack(toBytes(raw)) as T;
  if (typeof raw === 'string') return JSON.parse(raw) as T;
  return JSON.parse(Buffer.from(toBytes(raw)).toString('utf8')) as T;
}

/**
 * Inbound frames come from untrusted peers: structured-clone references (and
 * so cyclic values) are refused. `mapsAsObjects` keeps the default `unpack`'s
 * plain-object maps. msgpackr's other built-in extensions are process-global
 * and still decode, so a server checks a request with `isPlainRequestData`.
 */
const inbound = new Unpackr({ structuredClone: false, mapsAsObjects: true });

const MAX_REQUEST_DEPTH = 64;

/**
 * Whether a decoded request holds only JSON-shaped data (plus `Date`, which
 * msgpack timestamps decode to), no deeper than 64 levels. A server refuses
 * anything else: RegExp, Set, Map, BigInt, typed arrays and the like.
 */
export function isPlainRequestData(value: unknown, depth = 0): boolean {
  if (depth > MAX_REQUEST_DEPTH) return false;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (value instanceof Date) return true;
  if (Array.isArray(value)) return value.every((v) => isPlainRequestData(v, depth + 1));
  if (typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return false;
  return Object.values(value).every((v) => isPlainRequestData(v, depth + 1));
}

function toBytes(raw: unknown): Uint8Array {
  if (raw instanceof Uint8Array) return raw;
  if (raw instanceof ArrayBuffer) return new Uint8Array(raw);
  return Buffer.from(raw as ArrayBufferLike);
}

// ---------------------------------------------------------------------------
// WS pack-decode plan
// ---------------------------------------------------------------------------

/**
 * A single precomputed entry in a WS pack-decode plan. All per-key lookups
 * (parseQualifiedKey, schema probe, fields narrow) happen once at plan-build
 * time; per-frame decoding then iterates the plan directly.
 *
 * `opts` is captured at plan-build time and shared across every frame for the
 * same qkey — the `{ schemas, currentNs }` pair is invariant for the
 * subscription lifetime.
 */
export type DecodePlanEntry = {
  qkey: string;
  name: string;
  schema: Schema;
  fields: FieldInput;
  opts: { schemas: Record<string, Schema>; currentNs: string };
};

/** Frame-spec input shape — duck-typed so multiple call-site frame types fit. */
export interface FrameSpecEntry {
  params?: unknown;
  fields?: unknown;
}

/**
 * Build the decode plan from a frame spec map + federated schemas. Called
 * once per subscription, before the first frame arrives. Keys that are
 * unqualified, have no matching schema, or have no field selection are
 * skipped.
 */
export function buildDecodePlan(
  frameSpec: Record<string, FrameSpecEntry>,
  schemas: Record<string, Schema>
): DecodePlanEntry[] {
  const plan: DecodePlanEntry[] = [];
  for (const qkey of Object.keys(frameSpec)) {
    const parsed = parseQualifiedKey(qkey);
    if (parsed === null) continue;
    const { ns, name } = parsed;
    const schema = schemas[ns];
    if (schema === undefined) continue;
    const spec = frameSpec[qkey];
    if (spec === undefined) continue;
    const fields = spec.fields;
    if (fields === undefined) continue;
    plan.push({
      qkey,
      name,
      schema,
      fields: fields as FieldInput,
      opts: { schemas, currentNs: ns }
    });
  }
  return plan;
}

/**
 * Apply a precomputed decode plan to an envelope's `data` map in place.
 * Mutates `envelope.data[qkey]` from positional tuple to named object/list
 * for each plan entry whose qkey is present.
 *
 * Accepts `unknown` so both `WsResponseFrame` and the data-bearing
 * `SubscribeEvent` variants flow through without a parameter-type cast at the
 * call site; remove/end/error frames lack a `data` property and short-circuit
 * here.
 */
export function applyDecodePlanInPlace(envelope: unknown, plan: DecodePlanEntry[]): void {
  if (envelope === null || typeof envelope !== 'object') return;
  const data = (envelope as { data?: unknown }).data;
  if (data === null || data === undefined || typeof data !== 'object') return;
  const map = data as Record<string, unknown>;
  for (const entry of plan) {
    const value = map[entry.qkey];
    if (value === undefined) continue;
    map[entry.qkey] = decodePositional(value, entry.fields, entry.schema, entry.name, entry.opts);
  }
}

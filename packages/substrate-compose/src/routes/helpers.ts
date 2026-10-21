/**
 * Shared route utilities. HTTP boundary parsing/serialisation the engine-free
 * layer needs — keep the per-route handlers shallow.
 */

import { isIP, isIPv6 } from 'node:net';
import {
  acceptsPack,
  type EncodeEnvelopeCtx,
  encodeEnvelope,
  PACK_MIME
} from '@mnmal-ai/substrate-pack';
import {
  type EncodeContext,
  type FieldDef,
  type FieldInput,
  type HttpHandler,
  type PackEnvelope,
  parseQualifiedKey,
  type RequestContext,
  type SubstrateRequest,
  type SubstrateResponse
} from '@mnmal-ai/substrate-types';
import { projectEnvelope } from './project-json.js';

// Frozen because response builders return this shared reference directly
// rather than allocating per request; handlers must not mutate it.
export const JSON_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'content-type': 'application/json'
});
const PACK_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'content-type': PACK_MIME
});

export function jsonResponse(
  status: number,
  value: unknown,
  extraHeaders?: Record<string, string>
): SubstrateResponse {
  return {
    status,
    headers: extraHeaders === undefined ? JSON_HEADERS : { ...JSON_HEADERS, ...extraHeaders },
    body: Buffer.from(JSON.stringify(value), 'utf8')
  };
}

export function error400(message: string): SubstrateResponse {
  return jsonResponse(400, { error: message });
}

export type ParseBodyResult =
  | { ok: true; value: unknown }
  | { ok: false; response: SubstrateResponse };

export function parseJsonBody(req: SubstrateRequest): ParseBodyResult {
  const body = req.body;
  if (body === null || body.length === 0) {
    return { ok: false, response: error400('empty body') };
  }
  try {
    return { ok: true, value: JSON.parse(body.toString('utf8')) };
  } catch {
    return { ok: false, response: error400('invalid JSON') };
  }
}

/**
 * Resolves the post-trust client IP for a request (spec §5.12).
 * `x-forwarded-for` is honoured only when the peer IP is in `trustedProxies`;
 * otherwise the peer IP is the client. Returns `undefined` when the transport
 * exposed no peer IP.
 *
 * Behind a trusted peer, returns the rightmost XFF hop that is not itself a
 * trusted proxy: the leftmost entry is client-supplied and forgeable. Falls
 * back to the peer IP when every hop is trusted.
 *
 * Single source of truth for trust gating — interceptors and audit emits read
 * the resolved value from `ctx.clientIp` without re-applying the gate.
 */
export function extractClientIp(
  req: SubstrateRequest,
  trustedProxies: Set<string>
): string | undefined {
  const peerIp = req.peerIp;
  // Untrusted (or unknown) peer: XFF is never honoured — the peer IS the client.
  if (peerIp === undefined) return undefined;
  if (!trustedProxies.has(peerIp)) return peerIp;

  // Trusted peer: resolve the client as the rightmost non-trusted XFF entry.
  const fwd = req.headers['x-forwarded-for'] ?? req.headers['X-Forwarded-For'];
  if (typeof fwd === 'string' && fwd.length > 0) {
    const hops = fwd.split(',');
    for (let i = hops.length - 1; i >= 0; i--) {
      const hop = forwardedHopIp(hops[i] ?? '');
      // A hop that is not an address ends the walk: skipping it would hand the
      // decision to the client-written entries further left.
      if (hop === undefined) break;
      if (!trustedProxies.has(hop)) return hop;
    }
  }
  // Trusted peer but no usable XFF, or every hop is trusted infra — fall back
  // to the peer itself.
  return peerIp;
}

/** A forwarded-for entry as a bare IP (`1.2.3.4:5555` and `[::1]:80` lose the port), or undefined. */
function forwardedHopIp(raw: string): string | undefined {
  const hop = raw.trim();
  const ip = /^\[([^\]]+)\](?::\d+)?$/.exec(hop)?.[1] ?? /^([\d.]+):\d+$/.exec(hop)?.[1] ?? hop;
  return isIP(ip) === 0 ? undefined : ip;
}

/**
 * The key a per-IP cap counts a client address under. One IPv6 subscriber
 * typically holds a whole /64, so IPv6 is keyed by that prefix; an
 * IPv4-mapped IPv6 address is keyed as its IPv4. Anything else is unchanged.
 */
export function ipCapKey(ip: string): string {
  if (!isIPv6(ip)) return ip;
  let s = ip.toLowerCase().split('%')[0] ?? '';
  const v4 = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(s);
  if (v4 !== null) {
    const [a, b, c, d] = v4.slice(1).map(Number) as [number, number, number, number];
    s = `${s.slice(0, v4.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head = '', tail] = s.split('::');
  const split = (part: string): string[] => (part === '' ? [] : part.split(':'));
  const h = split(head);
  const t = tail === undefined ? [] : split(tail);
  const groups = [...h, ...Array<string>(8 - h.length - t.length).fill('0'), ...t].map((g) =>
    Number.parseInt(g, 16)
  );
  const [g6 = 0, g7 = 0] = groups.slice(6);
  // IPv4-mapped (::ffff:a.b.c.d) and the deprecated IPv4-compatible form (::a.b.c.d).
  if (
    groups.slice(0, 5).every((g) => g === 0) &&
    (groups[5] === 0xffff || (v4 !== null && groups[5] === 0))
  ) {
    return `${g6 >> 8}.${g6 & 255}.${g7 >> 8}.${g7 & 255}`;
  }
  return `${groups
    .slice(0, 4)
    .map((g) => g.toString(16))
    .join(':')}::/64`;
}

/**
 * Build the partial request context the engine accepts. `namespace` and
 * `operation` are engine-owned (set per-entry from the qualified frame key
 * and the dispatch verb), so route handlers only pass identity + headers +
 * the post-trust `clientIp` (when transport exposed a peer).
 *
 * Trust gating lives HERE — interceptors downstream read `ctx.clientIp`
 * verbatim and must never re-apply the XFF vs peerIp rule themselves.
 */
export function buildContext(
  req: SubstrateRequest,
  trustedProxies: Set<string>,
  authEnabled?: boolean
): Partial<RequestContext> {
  const ctx: Partial<RequestContext> = {
    identity: req.identity ?? null,
    headers: req.headers,
    meta: {}
  };
  const clientIp = req.clientIp ?? extractClientIp(req, trustedProxies);
  if (clientIp !== undefined) ctx.clientIp = clientIp;
  // Omitted when undefined rather than written as `false`, so a policy can
  // tell "auth is off" from "not stated".
  const authOn = authEnabled ?? req.authEnabled;
  if (authOn !== undefined) ctx.authEnabled = authOn;
  return ctx;
}

/**
 * Stamp the post-trust `clientIp` and `authEnabled` on every request before
 * `handler` runs, for routes mounted outside compose's own handlers (plugin and
 * kernel routes), so the context they build matches dispatch.
 */
export function withRequestContext(
  handler: HttpHandler,
  trustedProxies: Set<string>,
  authEnabled: boolean
): HttpHandler {
  return (req) => {
    const { clientIp: _ignored, ...rest } = req;
    const clientIp = extractClientIp(rest, trustedProxies);
    return handler({ ...rest, ...(clientIp !== undefined ? { clientIp } : {}), authEnabled });
  };
}

/**
 * Narrow an unknown JSON value to the engine's frame shape. We validate the
 * outer shape (`Record<string, FrameEntry | FrameEntry[]>`) but leave inner
 * params / fields bags opaque — resolvers are responsible for their own input
 * validation. Anything that doesn't look like an object of objects (or arrays
 * of objects, for batched mutate §5.13) is rejected.
 */
export function validateFrame(
  value: unknown
): value is Record<
  string,
  | { params?: Record<string, unknown>; fields?: Record<string, unknown> }
  | Array<{ params?: Record<string, unknown>; fields?: Record<string, unknown> }>
> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  for (const entry of Object.values(value as Record<string, unknown>)) {
    if (entry === null || typeof entry !== 'object') return false;
    if (Array.isArray(entry)) {
      // Batched mutate array: every element must look like a FrameEntry
      // object. An empty array is accepted at the boundary; the engine
      // rejects it with a clearer `empty_frame_array` error so callers
      // get a consistent diagnostic surface.
      for (const sub of entry) {
        if (sub === null || typeof sub !== 'object' || Array.isArray(sub)) return false;
      }
    }
  }
  return true;
}

export function readAcceptHeader(req: SubstrateRequest): string | undefined {
  return req.headers.accept ?? req.headers.Accept;
}

export type FrameBody = { params?: Record<string, unknown>; fields?: Record<string, unknown> };
export type Frame = Record<string, FrameBody | Array<FrameBody>>;

interface SerializeOpts {
  /**
   * Per-key mutation return descriptors — the mutate route populates this from
   * the engine's registry entries so substrate-pack can positionally encode
   * mutation responses against their declared `returns` FieldDef.
   */
  returnsByKey?: Record<string, FieldDef>;
  /**
   * Per-key namespace map for entries in `returnsByKey`. Must be supplied
   * alongside `returnsByKey`; the encoder needs the namespace to locate the
   * relevant federated schema for crossRef targets.
   */
  currentNsByKey?: Record<string, string>;
}

/**
 * Return the envelope serialised per the request's Accept header. JSON by
 * default; substrate-pack (msgpack + positional) when the client asks for it
 * (§7.0, §7.2). Positional encoding is driven by the frame's per-key `fields`
 * selection plus the engine's federated schema — keys without a resolvable
 * `(fields, type, ns)` triple fall back to pass-through under the envelope's
 * msgpack wrapper. This handles error-only envelopes (unqualified/unknown_name)
 * without a schema lookup.
 */
export function serializeEnvelope(
  req: SubstrateRequest,
  envelope: PackEnvelope,
  engine: EncodeContext,
  frame: Frame,
  opts: SerializeOpts = {}
): SubstrateResponse {
  if (!acceptsPack(readAcceptHeader(req))) {
    // Project envelope.data through each frame entry's `fields` selection to
    // match the pack path's strict projection. A frame entry with
    // `fields: undefined` opts out of projection — full row passes through.
    const projected = projectEnvelope(envelope, frame);
    return {
      status: 200,
      headers: JSON_HEADERS,
      body: Buffer.from(JSON.stringify(projected), 'utf8')
    };
  }

  const ctx = buildEncodeCtx(engine, frame, opts);
  return {
    status: 200,
    headers: PACK_HEADERS,
    body: encodeEnvelope(envelope, ctx)
  };
}

function buildEncodeCtx(
  engine: EncodeContext,
  frame: Frame,
  opts: SerializeOpts
): EncodeEnvelopeCtx {
  const fieldsByKey: Record<string, FieldInput> = {};
  const typeByKey: Record<string, string> = {};
  const currentNsByKey: Record<string, string> = { ...(opts.currentNsByKey ?? {}) };

  for (const [key, entry] of Object.entries(frame)) {
    const parsed = parseQualifiedKey(key);
    if (parsed === null) continue;
    const { ns, name } = parsed;
    // Batched mutate (§5.13): an array op-key's substrate-pack encoding is
    // driven by the mutation's declared `returns` descriptor (resolved
    // upstream in `returnsByKey`). Array op-keys don't have a single
    // `fields` selection; the FieldInput path below is skipped for them.
    // Left unresolved, the encoder falls back to msgpack pass-through for
    // that slot, preserving the per-frame-result array verbatim.
    if (Array.isArray(entry)) continue;
    const fields = entry.fields;
    if (fields === undefined) continue;
    // Skip keys that already resolved to a mutation return descriptor —
    // mutation encoding is FieldDef-driven, not FieldInput-driven.
    if (opts.returnsByKey?.[key] !== undefined) continue;
    fieldsByKey[key] = fields as FieldInput;
    typeByKey[key] = name;
    currentNsByKey[key] = ns;
  }

  const out: EncodeEnvelopeCtx = {
    fieldsByKey,
    typeByKey,
    schemas: engine.federatedSchema(),
    currentNsByKey
  };
  if (opts.returnsByKey !== undefined) out.returnsByKey = opts.returnsByKey;
  return out;
}

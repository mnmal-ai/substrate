/**
 * Fastify <-> Substrate translators. The only file (along with
 * fastify-substrate-server.ts) that may import from `fastify`. Nothing from
 * `fastify` leaks out of this module.
 *
 * Body rule:
 *   - No Content-Length AND no buffered body -> `null`
 *   - Content-Length: 0 or empty buffered body -> `Buffer.alloc(0)`
 *   - Otherwise -> Buffer with the bytes the parser produced
 *
 * Header rule:
 *   - Fastify normalizes header names to lowercase; we preserve that.
 *   - Array-valued headers (e.g. set-cookie on inbound, rare) are joined with
 *     ", " which matches the RFC 7230 field-value folding rule the rest of the
 *     ecosystem assumes. `set-cookie` on responses is a known exception, but
 *     inbound requests never carry multiple set-cookie headers so the join is
 *     safe for the SubstrateRequest direction.
 */

import { Readable } from 'node:stream';
import type { HttpMethod, SubstrateRequest, SubstrateResponse } from '@mnmal-ai/substrate-types';
import type { FastifyReply, FastifyRequest } from 'fastify';

const HTTP_METHODS: ReadonlySet<HttpMethod> = new Set<HttpMethod>([
  'GET',
  'POST',
  'PUT',
  'DELETE',
  'PATCH',
  'HEAD',
  'OPTIONS'
]);

function coerceMethod(raw: string): HttpMethod {
  const upper = raw.toUpperCase();
  if (!HTTP_METHODS.has(upper as HttpMethod)) {
    throw new Error(`Unsupported HTTP method: ${raw}`);
  }
  return upper as HttpMethod;
}

function stripQuery(url: string): string {
  const q = url.indexOf('?');
  return q === -1 ? url : url.slice(0, q);
}

function flattenHeaders(raw: FastifyRequest['headers']): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) {
      out[k] = v.join(', ');
    } else if (typeof v === 'number') {
      out[k] = String(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function flattenQuery(raw: unknown): Record<string, string> {
  if (raw === null || typeof raw !== 'object') return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) {
      const first = v[0];
      if (first === undefined || first === null) continue;
      out[k] = String(first);
    } else {
      out[k] = String(v);
    }
  }
  return out;
}

function flattenParams(raw: unknown): Record<string, string> {
  if (raw === null || typeof raw !== 'object') return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (v === undefined || v === null) continue;
    out[k] = String(v);
  }
  return out;
}

function coerceBody(req: FastifyRequest): Buffer | null {
  const body = (req as { body?: unknown }).body;
  const cl = req.headers['content-length'];
  const hasContentLength = typeof cl === 'string' && cl.length > 0;

  // A body-less request (GET, DELETE, etc.): Fastify leaves body undefined.
  if (body === undefined || body === null) {
    return hasContentLength ? Buffer.alloc(0) : null;
  }
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof Uint8Array) return Buffer.from(body);
  if (typeof body === 'string') return Buffer.from(body, 'utf8');
  // JSON/object parser case: re-serialise so downstream sees raw bytes.
  return Buffer.from(JSON.stringify(body), 'utf8');
}

export function toSubstrateRequest(req: FastifyRequest, signal?: AbortSignal): SubstrateRequest {
  // Fastify's `request.ip` is the socket peer IP by default, or the first
  // entry from a trusted `x-forwarded-for` chain when `trustProxy` is set on
  // the Fastify instance. We take whatever Fastify gives us — CIDR / trusted-
  // proxy configuration belongs at the Fastify layer, not here.
  return {
    method: coerceMethod(req.method),
    path: stripQuery(req.url),
    headers: flattenHeaders(req.headers),
    query: flattenQuery(req.query),
    params: flattenParams(req.params),
    body: coerceBody(req),
    ...(typeof req.ip === 'string' && req.ip.length > 0 ? { peerIp: req.ip } : {}),
    ...(signal !== undefined ? { signal } : {})
  };
}

export async function applySubstrateResponse(
  reply: FastifyReply,
  res: SubstrateResponse
): Promise<void> {
  reply.status(res.status);
  if (res.headers) {
    for (const [k, v] of Object.entries(res.headers)) {
      reply.header(k, v);
    }
  }
  const body = res.body;
  if (body === undefined) {
    await reply.send();
    return;
  }
  if (typeof body === 'string') {
    await reply.send(body);
    return;
  }
  if (Buffer.isBuffer(body)) {
    await reply.send(body);
    return;
  }
  if (body instanceof Uint8Array) {
    await reply.send(Buffer.from(body));
    return;
  }
  // ReadableStream: Fastify only auto-detects Node streams, so convert and let
  // it pipe chunked. Do not buffer the stream first — SSE needs each chunk on
  // the wire as it is produced.
  await reply.send(Readable.fromWeb(body as Parameters<typeof Readable.fromWeb>[0]));
}

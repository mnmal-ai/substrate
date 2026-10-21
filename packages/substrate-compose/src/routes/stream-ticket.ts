/**
 * Stateless stream tickets. Spec §3.
 *
 * `EventSource` cannot set request headers, so Substrate's signed-request auth
 * can't reach the browser SSE path. A ticket is minted by a NORMALLY-SIGNED
 * POST and then carried in the query string.
 *
 * Stateless by design: no store, no TTL sweeper, and therefore no
 * mint-on-instance-A/connect-to-instance-B failure the moment a second
 * instance exists. Signed with a SERVER-held secret (symmetric HMAC is
 * sufficient — only the issuing server verifies) so the Key registry
 * stays out of a request-path hot loop. Rotating the secret invalidates
 * outstanding tickets, which is the revocation escape hatch statelessness
 * otherwise gives up; immaterial at a ~60s TTL.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Identity } from '@mnmal-ai/substrate-types';

/** Chosen so an EventSource reconnect lands inside the window. */
export const TICKET_TTL_MS = 60_000;

export interface StreamTicketPayload {
  identity: Identity | null;
  capabilities: string[];
  frameHash: string;
  /** Epoch ms. Set by `mintStreamTicket`; callers never supply it. */
  exp?: number;
}

export type TicketVerdict =
  | { ok: true; payload: Required<Pick<StreamTicketPayload, 'exp'>> & StreamTicketPayload }
  | { ok: false; code: 'ticket_invalid' | 'ticket_expired' | 'ticket_frame_mismatch' };

type FrameShape = Record<string, unknown>;

/**
 * Order-independent hash of a frame. Binding the ticket to this prevents
 * replaying a ticket minted for one frame onto a different (e.g. broader) one.
 *
 * HMAC rather than a plain `createHash('sha256')` — but `'substrate-frame-hash'`
 * is a DOMAIN-SEPARATION constant, not a secret, and doesn't need protecting.
 * The frame hash only needs collision resistance (plain SHA-256 gives that
 * too); its integrity against tampering is already covered by the outer
 * ticket signature in `sign`, which is keyed on the real server secret.
 */
export function hashFrame(frame: FrameShape): string {
  return createHmac('sha256', 'substrate-frame-hash')
    .update(canonicalJson(frame))
    .digest('base64url');
}

/** Deterministic JSON with lexicographically sorted keys at every depth. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0
  );
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

function sign(secret: string, body: string): string {
  return createHmac('sha256', secret).update(body).digest('base64url');
}

export function mintStreamTicket(
  secret: string,
  payload: StreamTicketPayload,
  nowMs: number
): string {
  const full = { ...payload, exp: nowMs + TICKET_TTL_MS };
  const body = Buffer.from(JSON.stringify(full)).toString('base64url');
  return `${body}.${sign(secret, body)}`;
}

type VerifiedTicketPayload = Required<Pick<StreamTicketPayload, 'exp'>> & StreamTicketPayload;

/** Full structural check of a decoded ticket body. See `verifyStreamTicket`. */
function isTicketPayload(value: unknown): value is VerifiedTicketPayload {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  if (!('exp' in value) || typeof value.exp !== 'number') return false;
  if (!('frameHash' in value) || typeof value.frameHash !== 'string') return false;
  if (!('capabilities' in value)) return false;
  const caps: unknown = value.capabilities;
  if (!Array.isArray(caps) || caps.some((c) => typeof c !== 'string')) return false;
  if (!('identity' in value)) return false;
  const identity: unknown = value.identity;
  if (identity === null) return true;
  // `Identity.id` is the one field consumers and audit trails rely on.
  return (
    typeof identity === 'object' &&
    !Array.isArray(identity) &&
    'id' in identity &&
    typeof identity.id === 'string'
  );
}

export function verifyStreamTicket(
  secret: string,
  ticket: string,
  frame: FrameShape,
  nowMs: number
): TicketVerdict {
  const dot = ticket.indexOf('.');
  if (dot <= 0) return { ok: false, code: 'ticket_invalid' };
  const body = ticket.slice(0, dot);
  const provided = ticket.slice(dot + 1);

  const expected = sign(secret, body);
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  // Length check first: timingSafeEqual throws on a length mismatch.
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, code: 'ticket_invalid' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return { ok: false, code: 'ticket_invalid' };
  }
  // Signature-valid does not mean shape-valid: a ticket from an older or buggy
  // issuer can carry any JSON. Validate the whole payload here so consumers
  // can't hit a TypeError (a 500 where a 401 belongs).
  if (!isTicketPayload(parsed)) return { ok: false, code: 'ticket_invalid' };
  const payload = parsed;
  if (nowMs > payload.exp) return { ok: false, code: 'ticket_expired' };

  // A circular reference or BigInt in the caller-supplied frame throws inside
  // `hashFrame`; fail closed as a verdict rather than a 500.
  let expectedFrameHash: string;
  try {
    expectedFrameHash = hashFrame(frame);
  } catch {
    return { ok: false, code: 'ticket_invalid' };
  }
  if (payload.frameHash !== expectedFrameHash) {
    return { ok: false, code: 'ticket_frame_mismatch' };
  }
  return { ok: true, payload };
}

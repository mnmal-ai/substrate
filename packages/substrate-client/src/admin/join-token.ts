/**
 * The `substrate federate` join-token envelope.
 *
 *   substrate-join-v1.<base64url(JSON)>      payload: { origin, code }
 *
 * Origin and code only. Namespaces and capabilities are deliberately absent:
 * redemption returns them from the invite row, which is authoritative, and a
 * second copy in the token would be the one the operator reads while not
 * being the one that binds.
 *
 * The versioned prefix makes a pasted token self-identifying, greppable by
 * secret scanners, and safe to change later. `.` cannot collide with the
 * base64url alphabet (which contains `-` and `_`).
 */

const TOKEN_PREFIX = 'substrate-join-v1.';

/** base64url alphabet, unpadded. Checked explicitly so a decoder's leniency never applies. */
const BASE64URL = /^[A-Za-z0-9_-]+$/;

export interface JoinTokenPayload {
  /** Callee origin, normalised to `scheme://host[:port]`. */
  origin: string;
  /** The 32-byte base64url Invite code (that row's `id`). */
  code: string;
}

export class JoinTokenError extends Error {
  override readonly name = 'JoinTokenError';
  readonly exitCode: number;

  constructor(message: string, exitCode = 2) {
    super(message);
    this.exitCode = exitCode;
  }
}

export function encodeJoinToken(payload: JoinTokenPayload): string {
  const json = JSON.stringify({ origin: payload.origin, code: payload.code });
  // btoa and atob, not Buffer: the browser build carries this module too.
  const bytes = new TextEncoder().encode(json);
  const b64 = btoa(String.fromCharCode(...bytes));
  return TOKEN_PREFIX + b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function decodeJoinToken(token: string): JoinTokenPayload {
  const trimmed = token.trim();
  if (!trimmed.startsWith(TOKEN_PREFIX)) {
    throw new JoinTokenError(
      `not a substrate join token — expected a value starting with '${TOKEN_PREFIX}'`
    );
  }
  const encoded = trimmed.slice(TOKEN_PREFIX.length);
  if (encoded.length === 0) {
    throw new JoinTokenError('join token has an empty payload');
  }
  if (!BASE64URL.test(encoded)) {
    throw new JoinTokenError('join token payload is not valid base64url');
  }

  let parsed: unknown;
  try {
    const binary = atob(encoded.replace(/-/g, '+').replace(/_/g, '/'));
    parsed = JSON.parse(new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0))));
  } catch {
    throw new JoinTokenError('join token payload is not valid JSON');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new JoinTokenError('join token payload must be a JSON object');
  }
  const p = parsed as Record<string, unknown>;

  if (typeof p.code !== 'string' || p.code.length === 0) {
    throw new JoinTokenError("join token payload is missing a non-empty 'code'");
  }
  if (typeof p.origin !== 'string' || p.origin.length === 0) {
    throw new JoinTokenError("join token payload is missing a non-empty 'origin'");
  }

  let url: URL;
  try {
    url = new URL(p.origin);
  } catch {
    throw new JoinTokenError(`join token origin '${p.origin}' is not a valid URL`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new JoinTokenError(`join token origin '${p.origin}' must be http(s)`);
  }

  // Normalise here, once. Everything downstream — the printed
  // SUBSTRATE_BRIDGE_CREDENTIALS entry, the redeem URL, check's comparison — uses this
  // value, so it is identical to what parseEnv derives from the bridge url.
  return { origin: url.origin, code: p.code };
}

/**
 * EdDSA agent-token minter: one signer and one set of claims for the MCP
 * client and bridges alike.
 *
 * The key is read and parsed at construction, so an unreadable credential fails
 * at startup rather than surfacing as a remote outage on the first request.
 * {@link TokenProviderOpts.lazyKey} defers the read for callers built inside an
 * event handler, where a throw becomes an unhandled rejection.
 */

import { createPrivateKey, sign as cryptoSign, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { BridgeCredential } from '@mnmal-ai/substrate-types';

const TTL_SECONDS = 3600;
const REFRESH_SKEW = 60;

/**
 * What a token claims when the caller says nothing. Least privilege: `admin` is
 * opt-in, never a default. Exported so consumers name it rather than copy it.
 */
export const DEFAULT_CAPABILITIES: ReadonlyArray<string> = ['read', 'mutate'];
const DEFAULT_NAMESPACES: ReadonlyArray<string> = ['*'];

/**
 * What an ADMIN caller should claim.
 *
 * The claim is narrowed by the registry row it is checked against
 * (`substrate-compose/src/auth.ts`, via `intersectGrants(claim, row)`), so
 * claiming a superset is safe — the row is the authority and the token only
 * asks. What is NOT safe is claiming a SUBSET: anything the row grants and the
 * claim omits is intersected away. That is the whole defect this constant
 * exists for, so it lists every capability an admin row might carry rather than
 * `admin` alone. A capability the ROW does not grant stays unreachable; no
 * claim fixes that.
 *
 * Deliberately an enumeration, not `['*']`: the capability gates (`withAuth`,
 * `requireCapability`) do a bare membership test with no wildcard case, so a
 * `'*'` claim is refused everything. `substrate-compose`'s
 * `agent-token-capability-intersection` suite pins this list against the
 * `Capability` union.
 */
export const ADMIN_CAPABILITIES: ReadonlyArray<string> = ['read', 'mutate', 'admin'];

/**
 * What an admin flow CLAIMS on a deployment: {@link ADMIN_CAPABILITIES} plus
 * `SUBSTRATE_ADMIN_CAPABILITY` when that names something else.
 *
 * A deployment whose admin capability is not `admin` seeds its admin row with
 * that name, so a claim of {@link ADMIN_CAPABILITIES} alone intersects it away
 * and the admin gate answers no. Unset or empty means the default, as every
 * other reader of the variable treats it.
 */
export function adminClaimCapabilities(env: {
  SUBSTRATE_ADMIN_CAPABILITY?: string;
}): ReadonlyArray<string> {
  const custom = env.SUBSTRATE_ADMIN_CAPABILITY;
  return custom === undefined || custom.length === 0 || ADMIN_CAPABILITIES.includes(custom)
    ? ADMIN_CAPABILITIES
    : [...ADMIN_CAPABILITIES, custom];
}

function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function sign(
  kid: string,
  key: KeyObject,
  ns: ReadonlyArray<string>,
  capabilities: ReadonlyArray<string>,
  aud: string | undefined
): { jwt: string; exp: number } {
  const now = Math.floor(Date.now() / 1000);
  const exp = now + TTL_SECONDS;
  const header = b64url(Buffer.from(JSON.stringify({ alg: 'EdDSA', typ: 'JWT', kid }), 'utf8'));
  const payload = b64url(
    Buffer.from(
      JSON.stringify({
        sub: kid,
        iat: now,
        exp,
        ns,
        capabilities,
        ...(aud !== undefined ? { aud } : {})
      }),
      'utf8'
    )
  );
  const signingInput = `${header}.${payload}`;
  const sig = cryptoSign(null, Buffer.from(signingInput, 'utf8'), key);
  return { jwt: `${signingInput}.${b64url(sig)}`, exp };
}

export interface TokenProviderOpts {
  /**
   * Defer reading and parsing the key to the first mint instead of doing it at
   * construction.
   *
   * For callers constructed inside an event handler or a discovery callback,
   * where a throw becomes an unhandled rejection rather than a startup failure
   * a supervisor can see.
   */
  lazyKey?: boolean;

  /**
   * Capabilities to CLAIM. Defaults to `['read', 'mutate']`.
   *
   * A dataset-backed key's registry row narrows this by intersection, so the
   * claim is a request and the row is the authority — a token can never widen
   * itself. The hazard runs the other way: a claim that omits what the row
   * grants intersects it AWAY: an `admin` identity claiming only the default
   * ends up with no capabilities. Pass {@link adminClaimCapabilities} for admin flows.
   */
  capabilities?: ReadonlyArray<string>;

  /** Namespaces to CLAIM. Defaults to `['*']`. Narrowed by the row the same way. */
  namespaces?: ReadonlyArray<string>;

  /**
   * Passphrase for an encrypted PKCS#8 PEM (`substrate-admin bootstrap --encrypt`). Without it an
   * encrypted key cannot be read at all. Held only inside the provider.
   */
  passphrase?: string;

  /** The `aud` claim: the origin the token is minted for. Omitted when unset. */
  audience?: string;
}

function readPrivateKey(keyPath: string, passphrase: string | undefined): KeyObject {
  return createPrivateKey({
    key: readFileSync(keyPath, 'utf8'),
    format: 'pem',
    ...(passphrase !== undefined ? { passphrase } : {})
  });
}

/**
 * Returns a provider yielding the BARE JWT. Re-signs once the cached token is
 * within {@link REFRESH_SKEW} of expiry.
 *
 * Bare, not `Bearer <jwt>`: the prefix is a transport concern. Callers that
 * want the header value use {@link makeAuthorizationProvider}.
 *
 * Throws at construction on an unreadable or malformed key unless
 * {@link TokenProviderOpts.lazyKey} is set. Signing itself stays lazy either
 * way — only the read moves.
 *
 * Takes only the signing half of a {@link BridgeCredential}: `origin` binds a
 * credential to a destination, which is the caller's gate to enforce before it
 * ever reaches a signer, and the MCP env wrapper has no origin to supply.
 */
export function makeTokenProvider(
  cred: Pick<BridgeCredential, 'keyPath' | 'kid'>,
  opts: TokenProviderOpts = {}
): () => string {
  // Eager: the returned closure captures only the parsed key, never the passphrase or `opts`.
  // Lazy: the passphrase is held until the first mint has to read the key, then dropped.
  let loadKey: (() => KeyObject) | null = null;
  let key: KeyObject | null = null;
  if (opts.lazyKey === true) {
    const { keyPath } = cred;
    let passphrase = opts.passphrase;
    loadKey = () => {
      const k = readPrivateKey(keyPath, passphrase);
      passphrase = undefined;
      return k;
    };
  } else {
    key = readPrivateKey(cred.keyPath, opts.passphrase);
  }
  const ns = opts.namespaces ?? DEFAULT_NAMESPACES;
  const capabilities = opts.capabilities ?? DEFAULT_CAPABILITIES;
  const kid = cred.kid;
  let cached: { jwt: string; exp: number } | null = null;
  return () => {
    if (key === null) {
      // `key` is null only in the lazy branch, which always sets `loadKey`.
      key = loadKey!();
      loadKey = null;
    }
    const now = Math.floor(Date.now() / 1000);
    if (cached === null || cached.exp - REFRESH_SKEW <= now) {
      cached = sign(kid, key, ns, capabilities, opts.audience);
    }
    return cached.jwt;
  };
}

/** Is the PEM at `keyPath` an encrypted PKCS#8 key, which needs a passphrase to read? */
export function isEncryptedKey(keyPath: string): boolean {
  return readFileSync(keyPath, 'utf8').includes('-----BEGIN ENCRYPTED PRIVATE KEY-----');
}

/**
 * Returns a provider yielding the full `Authorization` header value,
 * `Bearer <jwt>`, over {@link makeTokenProvider}.
 *
 * Keeps the `Bearer ` literal in one place.
 */
export function makeAuthorizationProvider(
  cred: Pick<BridgeCredential, 'keyPath' | 'kid'>,
  opts: TokenProviderOpts = {}
): () => string {
  const token = makeTokenProvider(cred, opts);
  return () => `Bearer ${token()}`;
}

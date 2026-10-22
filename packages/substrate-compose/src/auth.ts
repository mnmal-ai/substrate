/**
 * Minimal JWT verification for the binary.
 *
 * Keys come from a JSON file of key descriptors `{ kid?, alg, publicKey }`
 * and, when wired, the dataset-backed Key registry. Public-key verification
 * uses Node's built-in crypto (RS256 / ES256 / EdDSA); symmetric verification
 * uses `createHmac` (HS256). No external JWT library — the binary stays
 * dep-light.
 *
 * Narrow surface:
 *   - `parseAuthConfig(env)` returns `null` when auth is unset.
 *   - `authenticateBearer(token, cfg)` verifies once and returns the identity
 *     or the rejection reason. The reason is `null` wherever naming it would
 *     leak (unknown kid, bad signature).
 *   - `verifyBearerToken` / `diagnoseBearerToken` are its two halves.
 *   - `credentialLapse(identity, cfg)` answers whether an identity verified
 *     earlier has since expired, been revoked, or had its Key row changed,
 *     for long-lived streams.
 *
 * Not supported: JWKS URL fetch/rotation, audience/issuer constraints.
 */

import {
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  createVerify,
  sign as cryptoSign,
  verify as cryptoVerify,
  type KeyObject,
  timingSafeEqual
} from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  expandFlat,
  type Grant,
  intersectGrants,
  parseGrantEntries
} from '@mnmal-ai/substrate-policy';
import type { Identity } from '@mnmal-ai/substrate-types';
import type { IdentityDirectoryConfig, KeyRegistry } from './_system/index.js';

export type JwtAlg = 'RS256' | 'ES256' | 'HS256' | 'EdDSA';

export interface AuthKey {
  kid?: string;
  alg: JwtAlg;
  /** PEM for RS256/ES256/EdDSA, HMAC secret (utf8) for HS256. */
  publicKey: string;
  /** Provenance: 'agent' attributes writes as kind:'agent'; default 'user'. */
  kind?: 'user' | 'agent';
}

export interface AuthConfig {
  keys: Array<AuthKey>;
  /** JWT claim value that, when present in `capabilities`, grants admin. */
  adminCapability?: string;
  /**
   * Dataset-backed key registry (§5.12). When set, `verifyBearerToken`
   * consults it after the file-based `keys` array for tokens signed with an
   * asymmetric alg. Rows looked up via the registry also enforce a
   * claim-vs-row intersection on `ns` / `capabilities` — the JWT payload
   * cannot inflate its scope beyond what the Key row authorises.
   * File-based keys trust their token claims verbatim.
   */
  keyRegistry?: KeyRegistry;
  /**
   * `'required'` (default): a missing or invalid token → 401.
   *
   * `'attribute'`: a missing token is admitted to READS — routes gated `read`
   * or gated on nothing — and refused everywhere else. An invalid token is
   * still 401 in BOTH modes. Anonymous writes are refused even against a
   * namespace whose policy declares `writes: 'open'`: writes carry provenance.
   *
   * The two refusals name themselves differently, because they need different
   * fixes: a tokenless caller gets `detail`, a rejected credential gets
   * `reason` where there is a safe signal.
   */
  mode?: 'required' | 'attribute';
  /**
   * Clock-skew tolerance in seconds applied to `exp` / `nbf`.
   * `exp` rejects only when the token is more than `leewaySeconds` past expiry;
   * `nbf` rejects only when it is more than `leewaySeconds` before validity.
   * Absent / `0` is strict.
   */
  leewaySeconds?: number;
  /**
   * Longest a token may still have to run, in seconds: `exp` more than this
   * (plus leeway) in the future is refused, so a stolen token cannot be a
   * permanent credential. Default {@link DEFAULT_MAX_TOKEN_LIFETIME_SECONDS};
   * `0` disables the bound.
   */
  maxTokenLifetimeSeconds?: number;
  /**
   * The origins this server answers as (`SUBSTRATE_PUBLIC_ORIGIN`). When set, a
   * token carrying `aud` must name one of them; a token with no `aud` is still
   * accepted. Absent → `aud` is not checked.
   */
  audiences?: ReadonlyArray<string>;
  /**
   * Where the deployment's agent DIRECTORY lives, so `POST /substrate/v1/_system/keys` can
   * write a credential and its directory row atomically. Absent →
   * the route registers the credential alone and reports `directory.created:
   * false, reason: 'not_configured'` rather than staying quiet about it.
   */
  identityDirectory?: IdentityDirectoryConfig;
}

const SUPPORTED_ALGS: ReadonlySet<JwtAlg> = new Set<JwtAlg>(['RS256', 'ES256', 'HS256', 'EdDSA']);

/**
 * Two hours: twice the lifetime `substrate-policy`'s agent-token minter issues,
 * so a minter whose clock runs ahead of this server's is never refused.
 */
export const DEFAULT_MAX_TOKEN_LIFETIME_SECONDS = 7200;

/** HS256 secrets shorter than this are brute-forceable from one observed token. */
const MIN_HS256_SECRET_BYTES = 32;

export class AuthConfigError extends Error {
  override readonly name = 'AuthConfigError';
}

export function parseAuthConfig(env: NodeJS.ProcessEnv): AuthConfig | null {
  const registry = env.SUBSTRATE_AUTH_KEY_REGISTRY;
  const adminCap = env.SUBSTRATE_ADMIN_CAPABILITY;
  const modeRaw = env.SUBSTRATE_AUTH_MODE;
  const hasRegistry = registry !== undefined && registry !== '';
  const hasMode = modeRaw !== undefined && modeRaw !== '';

  // Auth is on if EITHER variable is set. A union, never an intersection:
  // `SUBSTRATE_AUTH_KEY_REGISTRY` alone is how every existing deployment enables
  // auth, so narrowing this could only ever turn auth OFF for someone who has
  // it on — a silent security downgrade.
  if (!hasRegistry && !hasMode) {
    return null;
  }

  // Auth requested with no file registry leans entirely on the database-backed
  // Key registry, which exists only for a postgres store. Without either,
  // the stack would boot "authenticated" and be unable to verify anyone.
  if (!hasRegistry && !isPostgresStore(env.SUBSTRATE_DATABASE_URL)) {
    throw new AuthConfigError(
      'SUBSTRATE_AUTH_MODE is set but there is no key source: configure ' +
        'SUBSTRATE_AUTH_KEY_REGISTRY, or use a postgres SUBSTRATE_DATABASE_URL so keys ' +
        'registered with `substrate-admin register` can be read'
    );
  }

  if (!hasRegistry) {
    // Database-only: no file keys at all. `compose()` attaches the dataset
    // registry because auth config is now present, which is the whole point.
    const dbOnly: AuthConfig = { keys: [] };
    if (adminCap !== undefined && adminCap !== '') dbOnly.adminCapability = adminCap;
    applyMode(dbOnly, modeRaw);
    applyLeeway(dbOnly, env.SUBSTRATE_JWT_LEEWAY_SECONDS);
    applyMaxLifetime(dbOnly, env.SUBSTRATE_JWT_MAX_TTL_SECONDS);
    applyIdentityDirectory(dbOnly, env.SUBSTRATE_AGENT_DIRECTORY_TYPE);
    return dbOnly;
  }

  let raw: string;
  try {
    raw = readFileSync(registry, 'utf8');
  } catch (err) {
    throw new AuthConfigError(
      `SUBSTRATE_AUTH_KEY_REGISTRY: cannot read '${registry}': ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new AuthConfigError(
      `SUBSTRATE_AUTH_KEY_REGISTRY: '${registry}' is not valid JSON: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new AuthConfigError(
      `SUBSTRATE_AUTH_KEY_REGISTRY: '${registry}' must contain a non-empty JSON array of key descriptors`
    );
  }
  const keys: Array<AuthKey> = [];
  for (const [i, entry] of parsed.entries()) {
    keys.push(normaliseKey(registry, i, entry));
  }
  const cfg: AuthConfig = { keys };
  if (adminCap !== undefined && adminCap !== '') cfg.adminCapability = adminCap;
  applyMode(cfg, modeRaw);
  applyLeeway(cfg, env.SUBSTRATE_JWT_LEEWAY_SECONDS);
  applyMaxLifetime(cfg, env.SUBSTRATE_JWT_MAX_TTL_SECONDS);
  applyIdentityDirectory(cfg, env.SUBSTRATE_AGENT_DIRECTORY_TYPE);
  return cfg;
}

/** True for a postgres `SUBSTRATE_DATABASE_URL`, which is what makes the DB key registry available. */
function isPostgresStore(store: string | undefined): boolean {
  return (store?.startsWith('postgres://') || store?.startsWith('postgresql://')) ?? false;
}

/** Mode defaults to `required` — the safe end — when unset. */
function applyMode(cfg: AuthConfig, mode: string | undefined): void {
  if (mode !== undefined && mode !== '') {
    if (mode !== 'required' && mode !== 'attribute') {
      throw new AuthConfigError(
        `SUBSTRATE_AUTH_MODE: invalid value '${mode}' (expected 'required' | 'attribute')`
      );
    }
    cfg.mode = mode;
    return;
  }
  cfg.mode = 'required';
}

/**
 * Parse `SUBSTRATE_AGENT_DIRECTORY_TYPE` — where `POST /substrate/v1/_system/keys` writes the
 * directory half of an identity. Throws `AuthConfigError` on a malformed value.
 *
 * Two accepted spellings, because the common case should not require JSON:
 *
 *     SUBSTRATE_AGENT_DIRECTORY_TYPE='acme/AgentIdentity'
 *     SUBSTRATE_AGENT_DIRECTORY_TYPE='{"frame":"acme/AgentIdentity","defaults":{"active":true}}'
 *
 * Unset is valid: the route then registers credentials alone and reports
 * `directory.created: false, reason: 'not_configured'`.
 */
function applyIdentityDirectory(cfg: AuthConfig, raw: string | undefined): void {
  if (raw === undefined || raw.trim() === '') return;
  const value = raw.trim();
  if (!value.startsWith('{')) {
    cfg.identityDirectory = { frame: assertQualifiedFrame(value) };
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (err) {
    throw new AuthConfigError(
      `SUBSTRATE_AGENT_DIRECTORY_TYPE: not valid JSON (${err instanceof Error ? err.message : String(err)}). ` +
        "Pass a bare '<namespace>/<Type>' key, or a JSON object with a 'frame' field."
    );
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new AuthConfigError('SUBSTRATE_AGENT_DIRECTORY_TYPE: JSON form must be an object');
  }
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.frame !== 'string' || obj.frame.length === 0) {
    throw new AuthConfigError(
      "SUBSTRATE_AGENT_DIRECTORY_TYPE: JSON form requires a non-empty 'frame'"
    );
  }
  assertQualifiedFrame(obj.frame);
  cfg.identityDirectory = obj as unknown as IdentityDirectoryConfig;
}

/**
 * Throws unless `frame` is a qualified `<namespace>/<Type>` key. Both spellings
 * validate here so a malformed frame fails at boot, not at first registration.
 */
function assertQualifiedFrame(frame: string): string {
  const slash = frame.indexOf('/');
  if (slash <= 0 || slash === frame.length - 1 || frame.indexOf('/', slash + 1) !== -1) {
    throw new AuthConfigError(
      `SUBSTRATE_AGENT_DIRECTORY_TYPE: frame '${frame}' must be a qualified '<namespace>/<Type>' key (e.g. 'acme/AgentIdentity')`
    );
  }
  return frame;
}

function applyLeeway(cfg: AuthConfig, leewayRaw: string | undefined): void {
  if (leewayRaw === undefined || leewayRaw === '') return;
  const n = Number(leewayRaw);
  if (!Number.isInteger(n) || n < 0) {
    throw new AuthConfigError(
      `SUBSTRATE_JWT_LEEWAY_SECONDS: must be a non-negative integer (got '${leewayRaw}')`
    );
  }
  cfg.leewaySeconds = n;
}

function applyMaxLifetime(cfg: AuthConfig, raw: string | undefined): void {
  if (raw === undefined || raw === '') return;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    throw new AuthConfigError(
      `SUBSTRATE_JWT_MAX_TTL_SECONDS: must be a non-negative integer (got '${raw}'; 0 disables the bound)`
    );
  }
  cfg.maxTokenLifetimeSeconds = n;
}

function normaliseKey(registry: string, index: number, entry: unknown): AuthKey {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new AuthConfigError(
      `SUBSTRATE_AUTH_KEY_REGISTRY: '${registry}' entry ${index} must be an object`
    );
  }
  const obj = entry as Record<string, unknown>;
  const alg = obj.alg;
  if (typeof alg !== 'string' || !SUPPORTED_ALGS.has(alg as JwtAlg)) {
    throw new AuthConfigError(
      `SUBSTRATE_AUTH_KEY_REGISTRY: '${registry}' entry ${index} has unsupported alg '${String(alg)}'`
    );
  }
  const publicKey = obj.publicKey;
  if (typeof publicKey !== 'string' || publicKey.length === 0) {
    throw new AuthConfigError(
      `SUBSTRATE_AUTH_KEY_REGISTRY: '${registry}' entry ${index} missing string 'publicKey'`
    );
  }
  if (alg === 'HS256' && Buffer.byteLength(publicKey, 'utf8') < MIN_HS256_SECRET_BYTES) {
    throw new AuthConfigError(
      `SUBSTRATE_AUTH_KEY_REGISTRY: '${registry}' entry ${index} has an HS256 secret shorter than ${MIN_HS256_SECRET_BYTES} bytes`
    );
  }
  const kid = obj.kid;
  const out: AuthKey = { alg: alg as JwtAlg, publicKey, kind: 'user' };
  if (typeof kid === 'string' && kid.length > 0) out.kid = kid;
  const kind = obj.kind;
  if (kind !== undefined) {
    if (kind !== 'user' && kind !== 'agent') {
      throw new AuthConfigError(
        `SUBSTRATE_AUTH_KEY_REGISTRY: '${registry}' entry ${index} has invalid kind '${String(kind)}' (expected 'user' | 'agent')`
      );
    }
    out.kind = kind;
  }
  return out;
}

interface JwtHeader {
  alg: string;
  kid?: string;
  typ?: string;
}

interface JwtPayload {
  sub?: string;
  exp?: number;
  nbf?: number;
  capabilities?: Array<string>;
  ns?: unknown;
  [claim: string]: unknown;
}

function base64UrlDecode(segment: string): Buffer {
  const pad = (4 - (segment.length % 4)) % 4;
  const b64 = segment.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat(pad);
  return Buffer.from(b64, 'base64');
}

function base64UrlEncode(buf: Buffer): string {
  return buf.toString('base64url');
}

function parseSegments(token: string): {
  header: JwtHeader;
  payload: JwtPayload;
  signingInput: Buffer;
  signature: Buffer;
} | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [h, p, s] = parts;
  if (h === undefined || p === undefined || s === undefined) return null;
  if (h.length === 0 || p.length === 0 || s.length === 0) return null;
  try {
    const header = JSON.parse(base64UrlDecode(h).toString('utf8')) as JwtHeader;
    const payload = JSON.parse(base64UrlDecode(p).toString('utf8')) as JwtPayload;
    const signingInput = Buffer.from(`${h}.${p}`, 'utf8');
    const signature = base64UrlDecode(s);
    return { header, payload, signingInput, signature };
  } catch {
    return null;
  }
}

/**
 * A candidate verifier key. `source` distinguishes file-registry entries
 * (static) from dataset-backed Key rows so the verifier can apply the
 * claim-vs-row intersection only on the latter.
 */
interface Candidate {
  key: AuthKey;
  source: 'file' | 'dataset';
  /** Set only for `source: 'dataset'`. */
  allowedNamespaces?: readonly string[];
  allowedCapabilities?: readonly string[];
  /**
   * The row's grant, parsed; drives the intersection. The row's `capabilities`
   * list is the default for any namespace entry that names none, so a flat row
   * expands to the cross product.
   */
  allowedGrant?: Grant;
}

function selectCandidates(cfg: AuthConfig, header: JwtHeader): Array<Candidate> {
  const out: Array<Candidate> = [];

  // File registry first, so file keys keep verifying (and win) even when a
  // dataset registry is wired.
  const byAlg = cfg.keys.filter((k) => k.alg === header.alg);
  let filtered: Array<AuthKey>;
  if (header.kid !== undefined) {
    const matching = byAlg.filter((k) => k.kid === header.kid);
    filtered = matching.length > 0 ? matching : byAlg;
  } else {
    filtered = byAlg;
  }
  for (const key of filtered) {
    out.push({ key, source: 'file' });
  }

  // Dataset registry — consulted only for asymmetric algs with an explicit
  // kid. HS256 symmetric secrets never live in the dataset, and asymmetric
  // tokens without a kid carry no lookup handle.
  if (
    cfg.keyRegistry !== undefined &&
    typeof header.kid === 'string' &&
    header.kid.length > 0 &&
    (header.alg === 'EdDSA' || header.alg === 'RS256' || header.alg === 'ES256')
  ) {
    const record = cfg.keyRegistry.lookup(header.kid);
    if (record !== null && record.algorithm === header.alg) {
      const key: AuthKey = { kid: record.kid, alg: record.algorithm, publicKey: record.publicKey };
      out.push({
        key,
        source: 'dataset',
        allowedNamespaces: record.namespaces,
        allowedCapabilities: record.capabilities,
        allowedGrant: parseGrantEntries(record.namespaces, record.capabilities)
      });
    }
  }

  return out;
}

function verifyHmac(key: AuthKey, signingInput: Buffer, signature: Buffer): boolean {
  const expected = createHmac('sha256', key.publicKey).update(signingInput).digest();
  if (expected.length !== signature.length) return false;
  return timingSafeEqual(expected, signature);
}

/**
 * Parsed public keys by PEM. Keys come only from the file registry and the
 * Key registry, never from a token, so this is bounded by what is registered.
 */
const publicKeyCache = new Map<string, KeyObject | null>();

function publicKeyFor(pem: string): KeyObject | null {
  let key = publicKeyCache.get(pem);
  if (key === undefined) {
    try {
      key = createPublicKey(pem);
    } catch {
      key = null;
    }
    publicKeyCache.set(pem, key);
  }
  return key;
}

function verifyAsymmetric(key: AuthKey, signingInput: Buffer, signature: Buffer): boolean {
  const pubKey = publicKeyFor(key.publicKey);
  if (pubKey === null) return false;
  if (key.alg === 'EdDSA') {
    // RFC 8037: Ed25519 JWS signatures use `sign(null, msg, key)` — the
    // digest is fixed by the curve, and `createVerify('sha256')` would
    // double-hash. The sync one-shot API is the only supported path.
    try {
      return cryptoVerify(null, signingInput, pubKey, signature);
    } catch {
      return false;
    }
  }
  const algoName = key.alg === 'RS256' ? 'RSA-SHA256' : 'sha256';
  const verifier = createVerify(algoName);
  verifier.update(signingInput);
  try {
    if (key.alg === 'ES256') {
      // JWT ES256 signatures are IEEE P1363 r||s (64 bytes). Node's verifier
      // defaults to DER; force ieee-p1363 to match the JWT contract.
      return verifier.verify({ key: pubKey, dsaEncoding: 'ieee-p1363' }, signature);
    }
    return verifier.verify(pubKey, signature);
  } catch {
    return false;
  }
}

/**
 * Why a bearer token was rejected, for the 401 body. Named ONLY where naming
 * it leaks nothing:
 *
 * - `malformed_token` / `unsupported_alg` are read off the token alone, before
 *   any key is touched. `expired` / `not_yet_valid` / `lifetime_exceeds_max` /
 *   `wrong_audience` / `malformed_claim:*` are only named once the signature verified, so they
 *   describe a token its holder could already read.
 * - `null` (no further signal) covers unknown kid, bad signature, and revoked
 *   keys — collapsed, so a 401 never says more than the caller sent. This
 *   is not a secret-kid guarantee: `_system/SigningKey` is public and answers
 *   exactly when a kid is registered and live, so verifiers can fetch keys.
 *   "Valid signature but insufficient claim" needs no code because it never
 *   reaches here: narrowing yields an identity with narrowed caps, and the
 *   route gate 403s with `{ required, have }`.
 */
export type BearerRejectionReason =
  | 'malformed_token'
  | 'unsupported_alg'
  | 'expired'
  | 'not_yet_valid'
  | 'lifetime_exceeds_max'
  | 'wrong_audience'
  | 'malformed_claim:exp'
  | 'malformed_claim:ns';

export type BearerVerdict =
  | { ok: true; identity: Identity }
  | { ok: false; reason: BearerRejectionReason | null };

const reject = (reason: BearerRejectionReason | null): BearerVerdict => ({ ok: false, reason });

/**
 * Verify a bearer token once and say why it failed. One pass, so a rejected
 * token costs one round of signature checks, not one to reject and another
 * to explain.
 *
 * A verified identity carries `expiresAt` (the token's `exp`, epoch seconds)
 * when the token had one, so a long-lived stream can tell when it lapses.
 */
export function authenticateBearer(token: string, cfg: AuthConfig): BearerVerdict {
  const parsed = parseSegments(token);
  if (parsed === null) return reject('malformed_token');
  const { header, payload, signingInput, signature } = parsed;
  if (typeof header.alg !== 'string') return reject('unsupported_alg');
  if (header.alg === 'none') return reject('unsupported_alg');
  if (!SUPPORTED_ALGS.has(header.alg as JwtAlg)) return reject('unsupported_alg');

  // Oracle boundary: everything from here touches keys.
  const candidates = selectCandidates(cfg, header);
  let matched: Candidate | null = null;
  for (const candidate of candidates) {
    const ok =
      candidate.key.alg === 'HS256'
        ? verifyHmac(candidate.key, signingInput, signature)
        : verifyAsymmetric(candidate.key, signingInput, signature);
    if (ok) {
      matched = candidate;
      break;
    }
  }
  if (matched === null) return reject(null);

  const nowSeconds = Math.floor(Date.now() / 1000);
  const leeway = cfg.leewaySeconds ?? 0;
  // `exp` and `ns` are MANDATORY for every asymmetric (RS256/ES256) token,
  // whichever registry the key came from, and for any dataset key — by design.
  // Those keys are long-lived, so an expiry-less token would be a
  // forever-credential, and a missing `ns` is never read as an implicit `*`
  // scope: a third-party issuer must emit `ns`. Only HS256 tokens against a
  // file-registry secret keep both optional. A present-but-malformed `exp`
  // always rejects.
  const strictClaims = header.alg !== 'HS256' || matched.source === 'dataset';
  if (payload.exp === undefined) {
    if (strictClaims) return reject('malformed_claim:exp');
  } else if (typeof payload.exp !== 'number' || payload.exp <= nowSeconds - leeway) {
    return reject('expired');
  } else {
    const maxLifetime = cfg.maxTokenLifetimeSeconds ?? DEFAULT_MAX_TOKEN_LIFETIME_SECONDS;
    if (maxLifetime > 0 && payload.exp > nowSeconds + maxLifetime + leeway) {
      return reject('lifetime_exceeds_max');
    }
  }
  if (typeof payload.nbf === 'number' && payload.nbf > nowSeconds + leeway) {
    return reject('not_yet_valid');
  }
  // A token without `aud` still passes, so minters that predate it keep working.
  if (cfg.audiences !== undefined && payload.aud !== undefined) {
    const aud: unknown[] = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!aud.some((a) => cfg.audiences?.includes(a as string))) return reject('wrong_audience');
  }

  const claimedCapabilities = Array.isArray(payload.capabilities)
    ? payload.capabilities.filter((c): c is string => typeof c === 'string')
    : [];
  const sub = typeof payload.sub === 'string' && payload.sub.length > 0 ? payload.sub : 'anonymous';

  // Namespace scoping. Tokens under `strictClaims` MUST carry `ns`; others
  // without the claim default to the wildcard. Malformed claims (non-array, empty
  // array, non-string members) always reject — the wildcard default only
  // applies when the claim is *absent*.
  const rawNs = payload.ns;
  let claimedNamespaces: Array<string>;
  if (rawNs === undefined) {
    if (strictClaims) return reject('malformed_claim:ns');
    claimedNamespaces = ['*'];
  } else {
    if (!Array.isArray(rawNs) || rawNs.length === 0) return reject('malformed_claim:ns');
    const coerced: Array<string> = [];
    for (const n of rawNs) {
      if (typeof n !== 'string' || n.length === 0) return reject('malformed_claim:ns');
      coerced.push(n);
    }
    claimedNamespaces = coerced;
  }

  // When verification succeeded against a dataset-backed Key, intersect
  // the JWT's ns/capabilities per namespace against the row's grant — the
  // token cannot claim more than the row grants. The claim stays flat: a
  // wildcard claim inherits the row verbatim. File-registry verifications
  // bypass the intersection.
  let grant: Grant;
  if (matched.source === 'dataset') {
    grant = intersectGrants(
      expandFlat(claimedNamespaces, claimedCapabilities),
      matched.allowedGrant ?? expandFlat([], [])
    );
  } else {
    // File-registry keys are trusted to carry authoritative claims and have no
    // per-namespace grant to intersect against; the flat claim expands to its
    // cross product.
    grant = expandFlat(claimedNamespaces, claimedCapabilities);
  }

  // The verified key's `kid` is stashed on the identity so audit events can
  // record the actor. File-registry candidates may have no kid; downstream
  // audit emits then fall back to `sub`. Never set an empty kid.
  // An agent key's identity is the key itself: `sub` is the caller's claim,
  // and trusting it would let any registered agent act under another's id.
  // Only an issuer-style key (a user token) is trusted to assert the subject.
  const verifiedKid =
    (matched.source === 'dataset' || matched.key.kind === 'agent') &&
    typeof matched.key.kid === 'string' &&
    matched.key.kid.length > 0
      ? matched.key.kid
      : undefined;
  const identity: Identity = {
    id: verifiedKid ?? sub,
    grants: Object.fromEntries([...grant].map(([ns, caps]) => [ns, [...caps].sort()]))
  };
  if (typeof matched.key.kid === 'string' && matched.key.kid.length > 0) {
    identity.kid = matched.key.kid;
  }
  // Provenance for resolveIdentity: dataset-backed verifications (and file keys
  // declared `kind: 'agent'`) attribute as an agent via `agentKeyId`; others as
  // a user via `tokenId`. Without either, resolveIdentity falls back to
  // `system/unknown` and `_metadata.createdBy` lands generic.
  const isAgent =
    (matched.source === 'dataset' || matched.key.kind === 'agent') && identity.kid !== undefined;
  if (isAgent) {
    identity.agentKeyId = identity.kid;
  } else {
    identity.tokenId = sub;
  }
  if (typeof payload.exp === 'number') identity.expiresAt = payload.exp;
  if (matched.source === 'dataset') {
    identity.keyDigest = keyRecordDigest(
      matched.key.alg,
      matched.key.publicKey,
      matched.allowedNamespaces ?? [],
      matched.allowedCapabilities ?? []
    );
  }
  return { ok: true, identity };
}

export async function verifyBearerToken(token: string, cfg: AuthConfig): Promise<Identity | null> {
  const verdict = authenticateBearer(token, cfg);
  return verdict.ok ? verdict.identity : null;
}

export function diagnoseBearerToken(token: string, cfg: AuthConfig): BearerRejectionReason | null {
  const verdict = authenticateBearer(token, cfg);
  return verdict.ok ? null : verdict.reason;
}

/** What a 401 should add for a reason whose fix is a server knob, not the token. */
export function rejectionDetail(reason: BearerRejectionReason | null): string | undefined {
  if (reason === 'lifetime_exceeds_max') {
    return 'the token expires further ahead than this server accepts; mint a shorter-lived token or raise SUBSTRATE_JWT_MAX_TTL_SECONDS';
  }
  if (reason === 'wrong_audience') {
    return "the token's aud is not one of this server's origins; connect through an origin listed in SUBSTRATE_PUBLIC_ORIGIN, or add this one there";
  }
  return undefined;
}

export type CredentialLapse = 'credential_expired' | 'credential_revoked' | 'credential_changed';

/**
 * The parts of a Key row a verification relied on. A string, so it survives
 * the SSE ticket's JSON round trip on the identity.
 */
function keyRecordDigest(
  alg: string,
  publicKey: string,
  namespaces: readonly string[],
  capabilities: readonly string[]
): string {
  return createHash('sha256')
    .update(JSON.stringify([alg, publicKey, namespaces, capabilities]))
    .digest('base64url');
}

/**
 * Whether an identity verified earlier still stands. A stream outlives the
 * request that opened it, so a token that has since expired, or a Key row
 * since revoked or changed (a new key under the same kid, a narrowed grant),
 * must end it rather than keep it live.
 *
 * Revocation is visible only for Key-registry identities; a file-registry key
 * is revoked by editing the file and restarting.
 */
export function credentialLapse(
  identity: Identity | null | undefined,
  cfg: AuthConfig,
  nowSeconds: number = Math.floor(Date.now() / 1000)
): CredentialLapse | null {
  if (identity === null || identity === undefined) return null;
  const exp = identity.expiresAt;
  if (typeof exp === 'number' && exp <= nowSeconds - (cfg.leewaySeconds ?? 0)) {
    return 'credential_expired';
  }
  const kid = identity.agentKeyId;
  if (
    typeof kid === 'string' &&
    cfg.keyRegistry !== undefined &&
    !cfg.keys.some((k) => k.kid === kid)
  ) {
    const record = cfg.keyRegistry.lookup(kid);
    if (record === null) return 'credential_revoked';
    if (
      typeof identity.keyDigest === 'string' &&
      identity.keyDigest !==
        keyRecordDigest(record.algorithm, record.publicKey, record.namespaces, record.capabilities)
    ) {
      return 'credential_changed';
    }
  }
  return null;
}

/** How often a live stream re-checks its credential. */
export const CREDENTIAL_RECHECK_MS = 15_000;

/**
 * Call `onLapse` once, the first time {@link credentialLapse} answers, polling
 * every {@link CREDENTIAL_RECHECK_MS}. Returns the stop function. No timer is
 * armed for an anonymous caller.
 */
export function watchCredential(
  identity: Identity | null | undefined,
  cfg: AuthConfig | undefined,
  onLapse: (lapse: CredentialLapse) => void
): () => void {
  if (cfg === undefined || identity === null || identity === undefined) return () => {};
  const timer = setInterval(() => {
    const lapse = credentialLapse(identity, cfg);
    if (lapse === null) return;
    clearInterval(timer);
    onLapse(lapse);
  }, CREDENTIAL_RECHECK_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}

export function extractBearer(authorization: string | undefined): string | null {
  if (authorization === undefined) return null;
  // `\S` after `\s+` keeps the two from sharing characters, so a long
  // whitespace run cannot backtrack quadratically; the capture is unchanged.
  const match = /^Bearer\s+(\S.*)$/i.exec(authorization.trim());
  if (match === null) return null;
  const token = match[1]?.trim();
  if (token === undefined || token.length === 0) return null;
  return token;
}

/**
 * Sign an HS256 JWT. Test-only helper — hand-rolling both sides means auth
 * round-trip tests depend on nothing outside node:crypto.
 */
export function signHs256(
  payload: Record<string, unknown>,
  secret: string,
  header: { kid?: string } = {}
): string {
  const hdr: JwtHeader = { alg: 'HS256', typ: 'JWT' };
  if (header.kid !== undefined) hdr.kid = header.kid;
  const encodedHeader = base64UrlEncode(Buffer.from(JSON.stringify(hdr), 'utf8'));
  const encodedPayload = base64UrlEncode(Buffer.from(JSON.stringify(payload), 'utf8'));
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const sig = createHmac('sha256', secret).update(signingInput).digest();
  return `${signingInput}.${base64UrlEncode(sig)}`;
}

/**
 * Sign an EdDSA (Ed25519) JWT. Test-only helper, so verify-path tests can
 * produce tokens against generated keypairs without static fixtures.
 *
 * `privateKey` accepts a PEM-encoded Ed25519 key (PKCS#8) or a `KeyObject`.
 * The RFC 8037 signing contract is `sign(null, data, key)` — no digest alg,
 * no DSA encoding, signature is raw 64-byte `r || s`.
 */
export function signEdDSA(
  payload: Record<string, unknown>,
  privateKey: KeyObject | string,
  header: { kid?: string } = {}
): string {
  const hdr: JwtHeader = { alg: 'EdDSA', typ: 'JWT' };
  if (header.kid !== undefined) hdr.kid = header.kid;
  const encodedHeader = base64UrlEncode(Buffer.from(JSON.stringify(hdr), 'utf8'));
  const encodedPayload = base64UrlEncode(Buffer.from(JSON.stringify(payload), 'utf8'));
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const key = typeof privateKey === 'string' ? createPrivateKey(privateKey) : privateKey;
  const sig = cryptoSign(null, Buffer.from(signingInput, 'utf8'), key);
  return `${signingInput}.${base64UrlEncode(sig)}`;
}

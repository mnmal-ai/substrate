/**
 * Shared helpers for the `_system` admin + registration routes: small
 * validators, the `_system` wire-shape `badRequest`, key-material checks and
 * the hosted-namespace guard. `../routes.ts` re-exports the public surface.
 */

import { createPublicKey } from 'node:crypto';
import type { Engine } from '@mnmal-ai/substrate-core';
import { grantEntriesConfer, grantEntryError } from '@mnmal-ai/substrate-policy';
import type { HttpHandler, SubstrateResponse } from '@mnmal-ai/substrate-types';
import { jsonResponse, parseJsonBody } from '../../routes/helpers.js';
import type { IdentityDirectoryConfig } from '../types.js';

// Re-exported for the `_system/index.ts` barrel; defined in `routes/helpers.ts`.
export { extractClientIp } from '../../routes/helpers.js';

export const MAX_TTL_MS = 30 * 86_400_000;
export const DEFAULT_TTL_MS = 86_400_000;
export const MAX_KEY_NAME = 128;

export type RegisterAlgorithm = 'EdDSA' | 'RS256' | 'ES256';

// `_system` routes return `{ code, message }` rather than helpers.ts's
// `{ error }` shape.
export function badRequest(code: string, message: string): SubstrateResponse {
  return jsonResponse(400, { code, message });
}

export function parseBody(
  req: Parameters<HttpHandler>[0]
): { ok: true; value: unknown } | SubstrateResponse {
  const result = parseJsonBody(req);
  if (result.ok) return { ok: true, value: result.value };
  // helpers.ts surfaces { error: '<message>' }; map to the _system wire shape.
  return badRequest('invalid_body', 'request body must be valid JSON');
}

export function asStringArray(value: unknown): Array<string> | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const out: Array<string> = [];
  for (const v of value) {
    if (typeof v !== 'string' || v.length === 0) return null;
    out.push(v);
  }
  return out;
}

export function base64Url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export interface AsymmetricKeyInfo {
  kind: 'rsa' | 'ec' | 'ed25519';
  namedCurve?: string;
  modulusLength?: number;
}

/** RSA keys below this are factorable; NIST retired 1024-bit RSA in 2013. */
export const MIN_RSA_MODULUS_BITS = 2048;

/** A refusal for key material too weak to register, or null when it is fine. */
export function weakKeyResponse(info: AsymmetricKeyInfo): SubstrateResponse | null {
  if (info.kind !== 'rsa' || (info.modulusLength ?? 0) >= MIN_RSA_MODULUS_BITS) return null;
  return badRequest(
    'weak_public_key',
    `RSA publicKey is ${info.modulusLength ?? 'unknown'} bits; at least ${MIN_RSA_MODULUS_BITS} are required`
  );
}

export function parsePublicKeyInfo(pem: string): AsymmetricKeyInfo | null {
  // `createPublicKey` accepts a PRIVATE key PEM and silently derives the public
  // half, so a caller who pastes the wrong file would publish their signing
  // key and get a working credential. Refuse any private-key PEM header.
  if (/-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/.test(pem)) return null;
  try {
    const key = createPublicKey(pem);
    const kind = key.asymmetricKeyType;
    if (kind === 'rsa' || kind === 'ec' || kind === 'ed25519') {
      const info: AsymmetricKeyInfo = { kind };
      const namedCurve = key.asymmetricKeyDetails?.namedCurve;
      if (namedCurve !== undefined) info.namedCurve = namedCurve;
      const modulusLength = key.asymmetricKeyDetails?.modulusLength;
      if (modulusLength !== undefined) info.modulusLength = modulusLength;
      return info;
    }
    return null;
  } catch {
    return null;
  }
}

export function algorithmMatchesKey(alg: RegisterAlgorithm, info: AsymmetricKeyInfo): boolean {
  if (alg === 'EdDSA') return info.kind === 'ed25519';
  if (alg === 'RS256') return info.kind === 'rsa';
  if (alg === 'ES256') return info.kind === 'ec' && info.namedCurve === 'prime256v1';
  return false;
}

/**
 * Namespaces in `requested` that this deployment does not host, with any
 * `:capability` suffix stripped. The wildcard `*` is never unhosted.
 *
 * The frame-time namespace gate is a bare string equality, so a misspelt grant
 * would otherwise be stored, reported by `whoami`, and refuse every frame.
 */
export function unhostedNamespaces(
  engine: Engine,
  requested: ReadonlyArray<string>
): Array<string> {
  const hosted = new Set(Object.keys(engine.federatedSchema()));
  // Entries may carry a per-namespace capability suffix: `tasks:read` names
  // the namespace `tasks`.
  const names = requested.map((entry) => {
    const colon = entry.indexOf(':');
    return colon === -1 ? entry : entry.slice(0, colon);
  });
  return [...new Set(names.filter((ns) => ns !== '*' && !hosted.has(ns)))];
}

/** The hosted set, for a refusal that tells the operator the correct spelling. */
export function hostedNamespaces(engine: Engine): Array<string> {
  return Object.keys(engine.federatedSchema()).sort();
}

/**
 * A refusal the caller can lift by saying they meant it — 422, the same
 * confirmable class as `--widen` and `--allow-admin`. A HARD refusal would make
 * this guard the thing operators route around, and registering a kid for a
 * plugin that is about to be installed is legitimate.
 */
export function refuseUnhosted(engine: Engine, unknown: Array<string>): SubstrateResponse {
  return jsonResponse(422, {
    code: 'unknown_namespaces',
    message:
      `this deployment does not host namespace(s): ${unknown.join(', ')}. ` +
      'A grant naming a namespace nobody hosts is accepted by the store and ' +
      'refused at every frame, so it reads as granted and reaches nothing. ' +
      'Fix the spelling, or pass allowUnknownNs to register ahead of a plugin ' +
      'that is not installed yet.',
    unknownNamespaces: unknown,
    hosted: hostedNamespaces(engine)
  });
}

/**
 * Refuse a grant that would store but not parse, or that confers admin
 * without `allowAdmin`. `null` when the grant is acceptable.
 */
export function grantRefusal(
  namespaces: Array<string>,
  capabilities: Array<string>,
  adminCapability: string,
  allowAdmin: boolean
): SubstrateResponse | null {
  // An unparseable grant would store, then make `parseGrantEntries` throw in
  // `candidatesFor` (auth.ts) on every request bearing that kid.
  const entryError = grantEntryError(namespaces, capabilities);
  if (entryError !== null) {
    return badRequest(
      'invalid_grant_entry',
      `${entryError} — each entry is '<namespace>' or '<namespace>:<cap>[+<cap>...]'.`
    );
  }
  // Asked of the resolved grant, not the flat list: `namespaces: ['_system:admin']`
  // with `capabilities: ['read']` confers admin.
  if (grantEntriesConfer(namespaces, capabilities, adminCapability) && !allowAdmin) {
    return badRequest(
      'admin_requires_opt_in',
      `granting the '${adminCapability}' capability requires allowAdmin: true (substrate-admin bootstrap is the deliberate admin path)`
    );
  }
  return null;
}

export interface KeysRouteOptions {
  trustedProxies: Set<string>;
  /**
   * Whether the deployment verifies credentials, so a refusal for want of an
   * identity can say auth is off rather than blame the key.
   */
  authEnabled?: boolean;
  /** Absent → credential-only registration, reported as such in the response. */
  identityDirectory?: IdentityDirectoryConfig;
  /**
   * Capability that counts as admin. Mirrors `SUBSTRATE_ADMIN_CAPABILITY`;
   * defaults to `'admin'`. The POST route's `allowAdmin` opt-in and the PATCH
   * route's guards both ask it, so the two cannot disagree on what is admin.
   */
  adminCapability?: string;
}

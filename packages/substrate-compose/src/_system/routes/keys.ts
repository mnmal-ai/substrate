/**
 * POST /substrate/v1/_system/keys — admin-gated key registration.
 *
 * Writes the `_system/Key` credential and, when an identity directory is
 * configured, its directory row through `engine.mutate`, so both land in one
 * substrate transaction and the `createKey` interceptor refreshes the key
 * registry post-commit.
 *
 * The pre-flight is the load-bearing part, not the transaction: `policy_denied`
 * / `unknown_namespace` / `unknown_name` record into the envelope rather than
 * throw, so the credential would commit beside a failed directory write. A
 * configured directory is therefore probed with `engine.evaluateWritePolicy`
 * before anything is written; the post-dispatch check is the backstop for what
 * the probe cannot see, and reports a partial landing rather than a 201.
 */

import { createHash } from 'node:crypto';
import type { Engine } from '@mnmal-ai/substrate-core';
import { encodeList } from '@mnmal-ai/substrate-policy';
import type { HttpHandler, SubstrateResponse } from '@mnmal-ai/substrate-types';
import { buildContext, jsonResponse } from '../../routes/helpers.js';
import { KEY_ALGORITHMS, KEY_TYPE, SYSTEM_NAMESPACE } from '../types.js';
import {
  algorithmMatchesKey,
  asStringArray,
  badRequest,
  base64Url,
  grantRefusal,
  type KeysRouteOptions,
  MAX_KEY_NAME,
  parseBody,
  parsePublicKeyInfo,
  type RegisterAlgorithm,
  refuseUnhosted,
  unhostedNamespaces,
  weakKeyResponse
} from './shared.js';

/**
 * What the caller may say about the directory row. Everything here is
 * optional — an omitted block still creates the row when a directory is
 * configured, so a credential is never left without a directory entry by
 * default.
 */
interface KeysDirectoryRequest {
  /** `false` opts out — the deliberate posture for a bootstrap-style credential. */
  create?: boolean;
  /** Merged over the derived fields. `kid` is NOT overridable. */
  params?: Record<string, unknown>;
}

interface KeysBody {
  kid: string;
  publicKey: string;
  name: string;
  algorithm: RegisterAlgorithm;
  namespaces: Array<string>;
  capabilities: Array<string>;
  allowAdmin: boolean;
  /** Confirms a grant naming a namespace this deployment does not host. */
  allowUnknownNs: boolean;
  directory: KeysDirectoryRequest;
}

function validateKeysBody(raw: unknown, adminCapability: string): KeysBody | SubstrateResponse {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return badRequest('invalid_body', 'request body must be a JSON object');
  }
  const b = raw as Record<string, unknown>;

  if (typeof b.kid !== 'string' || b.kid.length === 0) {
    return badRequest('invalid_kid', 'kid must be a non-empty string');
  }
  if (typeof b.publicKey !== 'string' || b.publicKey.length === 0) {
    return badRequest('invalid_public_key', 'publicKey must be a non-empty PEM string');
  }
  const name = b.name === undefined ? b.kid : b.name;
  if (typeof name !== 'string' || name.length === 0) {
    return badRequest('invalid_key_name', 'name must be a non-empty string');
  }
  if (name.length > MAX_KEY_NAME) {
    return badRequest('invalid_key_name', `name must be ${MAX_KEY_NAME} characters or fewer`);
  }

  // Defaults to EdDSA, the algorithm `substrate-admin register` mints.
  const algorithm = b.algorithm === undefined ? 'EdDSA' : b.algorithm;
  if (typeof algorithm !== 'string') {
    return badRequest('invalid_algorithm', 'algorithm must be one of EdDSA / RS256 / ES256');
  }
  if (algorithm === 'HS256') {
    return badRequest(
      'hmac_not_allowed',
      'symmetric algorithms (e.g. HS256) are rejected at the key-registration boundary; use EdDSA / RS256 / ES256'
    );
  }
  if (!KEY_ALGORITHMS.has(algorithm as RegisterAlgorithm)) {
    return badRequest(
      'invalid_algorithm',
      `algorithm must be one of ${[...KEY_ALGORITHMS].join(', ')}`
    );
  }

  // No default namespaces: an identity's authority must appear where the
  // operator typed it, so `['*']` must be written out.
  const namespaces = asStringArray(b.namespaces);
  if (namespaces === null) {
    return badRequest(
      'invalid_namespaces',
      'namespaces must be a non-empty array of strings (pass ["*"] to grant every namespace)'
    );
  }
  const capabilities = asStringArray(b.capabilities);
  if (capabilities === null) {
    return badRequest('invalid_capabilities', 'capabilities must be a non-empty array of strings');
  }

  const allowAdmin = b.allowAdmin === true;
  const grantError = grantRefusal(namespaces, capabilities, adminCapability, allowAdmin);
  if (grantError !== null) return grantError;

  let directory: KeysDirectoryRequest = {};
  if (b.directory !== undefined) {
    const d = b.directory;
    if (d === null || typeof d !== 'object' || Array.isArray(d)) {
      return badRequest('invalid_directory', 'directory must be a JSON object');
    }
    const dd = d as Record<string, unknown>;
    if (dd.create !== undefined && typeof dd.create !== 'boolean') {
      return badRequest('invalid_directory', 'directory.create must be a boolean');
    }
    if (dd.params !== undefined) {
      if (dd.params === null || typeof dd.params !== 'object' || Array.isArray(dd.params)) {
        return badRequest('invalid_directory', 'directory.params must be a JSON object');
      }
    }
    directory = {
      ...(dd.create !== undefined ? { create: dd.create as boolean } : {}),
      ...(dd.params !== undefined ? { params: dd.params as Record<string, unknown> } : {})
    };
  }

  return {
    kid: b.kid,
    publicKey: b.publicKey,
    name,
    algorithm: algorithm as RegisterAlgorithm,
    namespaces,
    capabilities,
    allowAdmin,
    allowUnknownNs: b.allowUnknownNs === true,
    directory
  };
}

/** `agent@Host` → `Host`. `null` when the kid carries no `@` suffix. */
function hostFromKid(kid: string): string | null {
  const at = kid.lastIndexOf('@');
  if (at < 0 || at === kid.length - 1) return null;
  return kid.slice(at + 1);
}

/** Split `'acme/AgentIdentity'` into its parts. */
function parseDirectoryFrame(frame: string): { ns: string; type: string } | null {
  const slash = frame.indexOf('/');
  if (slash <= 0 || slash === frame.length - 1) return null;
  const ns = frame.slice(0, slash);
  const type = frame.slice(slash + 1);
  if (ns.includes('/') || type.includes('/')) return null;
  return { ns, type };
}

export function keysRoute(engine: Engine, opts: KeysRouteOptions): HttpHandler {
  return async (req) => {
    const parsed = parseBody(req);
    if (!('ok' in parsed)) return parsed;
    const body = validateKeysBody(parsed.value, opts.adminCapability ?? 'admin');
    if ('kid' in body === false) return body as SubstrateResponse;
    const b = body as KeysBody;

    // Algorithm/key agreement, same check `/register` applies. A PEM that
    // parses but disagrees with the declared alg is a caller error worth
    // naming precisely — it is nearly always a private key pasted by mistake.
    const keyInfo = parsePublicKeyInfo(b.publicKey);
    if (keyInfo === null) {
      return badRequest(
        'invalid_public_key',
        'publicKey is not a readable asymmetric public-key PEM — if you pasted a PRIVATE key, it is now in your shell history: rotate it'
      );
    }
    if (!algorithmMatchesKey(b.algorithm, keyInfo)) {
      return badRequest(
        'algorithm_key_mismatch',
        `publicKey is ${keyInfo.kind}${keyInfo.namedCurve !== undefined ? ` (${keyInfo.namedCurve})` : ''}, which does not match algorithm '${b.algorithm}'`
      );
    }
    const weak = weakKeyResponse(keyInfo);
    if (weak !== null) return weak;

    const unknownNs = unhostedNamespaces(engine, b.namespaces);
    if (unknownNs.length > 0 && b.allowUnknownNs !== true) {
      return refuseUnhosted(engine, unknownNs);
    }

    const ctx = buildContext(req, opts.trustedProxies, opts.authEnabled);
    const identity = ctx.identity ?? null;

    // --- directory pre-flight ------------------------------------------------
    const wantsDirectory = b.directory.create !== false;
    const dirConfig = opts.identityDirectory;
    let dirPlan: { ns: string; type: string; params: Record<string, unknown> } | null = null;

    if (dirConfig !== undefined && wantsDirectory) {
      const split = parseDirectoryFrame(dirConfig.frame);
      if (split === null) {
        // Operator misconfiguration. Refuse rather than silently registering a
        // credential-only identity — a stack configured for a directory and
        // quietly not writing one is the failure mode, not the fix.
        return jsonResponse(500, {
          code: 'directory_misconfigured',
          message: `identityDirectory.frame '${dirConfig.frame}' is not a qualified '<namespace>/<Type>' key`
        });
      }
      const decision = engine.evaluateWritePolicy(split.ns, split.type, identity, ctx);
      if (!decision.allow) {
        return jsonResponse(403, {
          code: 'directory_denied',
          message: `refusing to register '${b.kid}': the directory row in '${dirConfig.frame}' cannot be written (${decision.reason ?? 'policy denied'}). Registering the credential alone would leave a half identity — grant the caller write access to '${split.ns}', or pass directory.create=false to accept a credential with no directory entry.`
        });
      }

      const kidField = dirConfig.kidField ?? 'kid';
      const hostField = dirConfig.hostField === undefined ? 'host' : dirConfig.hostField;
      const displayNameField =
        dirConfig.displayNameField === undefined ? 'displayName' : dirConfig.displayNameField;

      const derived: Record<string, unknown> = {};
      if (hostField !== null) {
        const host = hostFromKid(b.kid);
        if (host !== null) derived[hostField] = host;
      }
      if (displayNameField !== null) derived[displayNameField] = b.name;

      dirPlan = {
        ns: split.ns,
        type: split.type,
        params: {
          ...(dirConfig.defaults ?? {}),
          ...derived,
          ...(b.directory.params ?? {}),
          // Forced last: the directory row's whole purpose is to name the kid
          // the credential was issued for. A caller-supplied mismatch here
          // would produce a directory entry pointing at nobody.
          [kidField]: b.kid
        }
      };
    }

    // --- liveness pre-check --------------------------------------------------
    // A live same-kid row means rotate/revoke, not a second row. A concurrent
    // registration can pass this check; the createKey interceptor refuses it
    // with the same code.
    const existing = await engine.query({
      frame: {
        [`${SYSTEM_NAMESPACE}/${KEY_TYPE}`]: {
          params: { where: { kid: { eq: b.kid } } },
          fields: { id: true, kid: true, revokedAt: true }
        }
      },
      ctx,
      ...(req.signal !== undefined ? { signal: req.signal } : {})
    });
    if (existing.errors !== undefined && existing.errors.length > 0) {
      const first = existing.errors[0];
      const code = first?.code ?? 'internal_error';
      return jsonResponse(code === 'policy_denied' ? 403 : 500, {
        code,
        message: first?.message ?? 'could not check for an existing key'
      });
    }
    const existingRows = existing.data?.[`${SYSTEM_NAMESPACE}/${KEY_TYPE}`];
    // A rotated kid has revoked rows beside its live one, so the live row decides.
    const sameKid = (Array.isArray(existingRows) ? existingRows : []) as Array<
      Record<string, unknown>
    >;
    const existingRow = sameKid.find((r) => r.revokedAt == null) ?? sameKid[0];
    if (existingRow !== undefined && existingRow.revokedAt == null) {
      return jsonResponse(409, {
        code: 'kid_already_live',
        message: `kid '${b.kid}' is already registered and live — rotate or revoke it before re-registering`
      });
    }

    // --- the write -----------------------------------------------------------
    const keyFrameKey = `${SYSTEM_NAMESPACE}/create${KEY_TYPE}`;
    const dirFrameKey = dirPlan === null ? null : `${dirPlan.ns}/create${dirPlan.type}`;
    const frame: Record<string, unknown> = {
      [keyFrameKey]: {
        params: {
          // No id: always a fresh row, so a revoked one stays behind as the
          // audit record, as `rotate` leaves it.
          kid: b.kid,
          name: b.name,
          algorithm: b.algorithm,
          publicKey: b.publicKey,
          namespaces: encodeList(b.namespaces),
          capabilities: encodeList(b.capabilities),
          revokedAt: null
        },
        fields: { id: true, kid: true }
      }
    };
    if (dirFrameKey !== null && dirPlan !== null) {
      frame[dirFrameKey] = { params: dirPlan.params, fields: { id: true } };
    }

    const envelope = await engine.mutate({
      frame: frame as Parameters<Engine['mutate']>[0]['frame'],
      ctx,
      ...(req.signal !== undefined ? { signal: req.signal } : {})
    });

    const errors = envelope.errors ?? [];
    const errorFor = (key: string): { code?: string; message?: string } | undefined =>
      errors.find((e) => Array.isArray(e.path) && e.path[0] === key);

    const keyErr = errorFor(keyFrameKey);
    if (keyErr !== undefined) {
      const code = keyErr.code ?? 'internal_error';
      const status = code === 'policy_denied' ? 403 : code === 'kid_already_live' ? 409 : 500;
      return jsonResponse(status, {
        code,
        message: keyErr.message ?? 'key registration failed'
      });
    }

    // The backstop the pre-flight cannot cover: the type is writable but the
    // autoCRUD create mutation is absent (`unknown_name`). The credential has
    // committed by now, so this reports the partial landing in the words an
    // operator needs rather than dressing it as success.
    if (dirFrameKey !== null) {
      const dirErr = errorFor(dirFrameKey);
      if (dirErr !== undefined) {
        return jsonResponse(500, {
          code: 'directory_write_failed',
          message: `credential for '${b.kid}' was registered but its directory row in '${dirFrameKey}' was NOT: ${dirErr.message ?? 'unknown error'}. This identity is HALF registered — create the directory row by hand, or revoke the key and retry.`,
          kid: b.kid,
          directory: { created: false, reason: dirErr.code ?? 'error' }
        });
      }
    }

    // A top-level error (no `path`) means the whole frame was refused — e.g.
    // `cross_tx_scope_refused` when the directory namespace lives on another
    // substrate. Nothing committed, so this is a clean refusal.
    const topLevel = errors.find((e) => e.path === undefined || e.path.length === 0);
    if (topLevel !== undefined) {
      return jsonResponse(500, {
        code: topLevel.code ?? 'internal_error',
        message: topLevel.message ?? 'key registration failed'
      });
    }

    const fingerprint = `sha256:${base64Url(createHash('sha256').update(b.publicKey).digest()).slice(0, 8)}`;
    return jsonResponse(201, {
      kid: b.kid,
      name: b.name,
      fingerprint,
      algorithm: b.algorithm,
      namespaces: b.namespaces,
      capabilities: b.capabilities,
      replacedRevoked: existingRow !== undefined,
      directory:
        dirFrameKey !== null
          ? { created: true, frame: dirFrameKey }
          : {
              created: false,
              reason: dirConfig === undefined ? 'not_configured' : 'opted_out'
            }
    });
  };
}

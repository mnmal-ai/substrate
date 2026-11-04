/**
 * POST /substrate/v1/_system/register — public, rate-limited invite redemption.
 *
 * Consumes an invite and issues a Key. Implemented against the raw dataset
 * inside a `withTransaction` so the invite consumption and the key insertion
 * either both land or both don't. The admin gate on `createKey` is
 * intentionally bypassed here — access control IS the invite. Race-safety comes
 * from `dataset.conditionalUpdate` which enforces "consumedAt IS NULL"
 * atomically against concurrent registers.
 */

import { randomBytes } from 'node:crypto';
import type { Dataset, HttpHandler, SubstrateResponse } from '@mnmal-ai/substrate-types';
import { extractClientIp, ipCapKey, jsonResponse } from '../../routes/helpers.js';
import { buildAuditRow } from '../install.js';
import type { RateLimiter } from '../rate-limit.js';
import type { KeyRegistry } from '../registry.js';
import { AUDIT_EVENT_TYPE, INVITE_TYPE, KEY_ALGORITHMS, KEY_TYPE } from '../types.js';
import {
  algorithmMatchesKey,
  badRequest,
  base64Url,
  MAX_KEY_NAME,
  parseBody,
  parsePublicKeyInfo,
  type RegisterAlgorithm,
  weakKeyResponse
} from './shared.js';

interface RegisterBody {
  code: string;
  publicKey: string;
  keyName: string;
  algorithm: RegisterAlgorithm;
}

function validateRegisterBody(raw: unknown): RegisterBody | SubstrateResponse {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return badRequest('invalid_body', 'request body must be a JSON object');
  }
  const b = raw as Record<string, unknown>;
  if (typeof b.code !== 'string' || b.code.length === 0) {
    return badRequest('invalid_code', 'code must be a non-empty string');
  }
  if (typeof b.publicKey !== 'string' || b.publicKey.length === 0) {
    return badRequest('invalid_public_key', 'publicKey must be a non-empty PEM string');
  }
  if (typeof b.keyName !== 'string' || b.keyName.length === 0) {
    return badRequest('invalid_key_name', 'keyName must be a non-empty string');
  }
  if (b.keyName.length > MAX_KEY_NAME) {
    return badRequest('invalid_key_name', `keyName must be ${MAX_KEY_NAME} characters or fewer`);
  }
  if (typeof b.algorithm !== 'string') {
    return badRequest('invalid_algorithm', 'algorithm must be one of EdDSA / RS256 / ES256');
  }
  // Invariant: HS256 (and every other symmetric alg) is rejected at the
  // register surface. The error code matches the dataset-boundary code so
  // clients can branch on one identifier regardless of the rejection path.
  if (b.algorithm === 'HS256') {
    return badRequest(
      'hmac_not_allowed',
      'symmetric algorithms (e.g. HS256) are rejected at the register boundary; use EdDSA / RS256 / ES256'
    );
  }
  if (!KEY_ALGORITHMS.has(b.algorithm as RegisterAlgorithm)) {
    return badRequest(
      'invalid_algorithm',
      `algorithm must be one of ${[...KEY_ALGORITHMS].join(', ')}`
    );
  }
  return {
    code: b.code,
    publicKey: b.publicKey,
    keyName: b.keyName,
    algorithm: b.algorithm as RegisterAlgorithm
  };
}

export function registerRoute(
  dataset: Dataset,
  registry: KeyRegistry,
  rateLimiter: RateLimiter,
  opts: { now?: () => Date; trustedProxies: Set<string> }
): HttpHandler {
  const now = opts.now ?? ((): Date => new Date());
  const trustedProxies = opts.trustedProxies;
  return async (req) => {
    // The audit row keeps the raw `string | undefined`; the rate limiter needs
    // a string bucket key, so peer-less requests share an `'unknown'` bucket.
    const clientIp = extractClientIp(req, trustedProxies);
    const ip = clientIp ?? 'unknown';
    const gate = rateLimiter.check(ipCapKey(ip));
    if (!gate.allowed) {
      const retrySeconds = Math.max(1, Math.ceil(gate.retryAfterMs / 1000));
      // Fresh headers object: helpers.ts's shared JSON_HEADERS is frozen.
      return {
        status: 429,
        headers: {
          'content-type': 'application/json',
          'retry-after': String(retrySeconds)
        },
        body: Buffer.from(
          JSON.stringify({ code: 'rate_limited', retryAfterMs: gate.retryAfterMs }),
          'utf8'
        )
      };
    }

    const parsed = parseBody(req);
    if (!('ok' in parsed)) return parsed;
    const validated = validateRegisterBody(parsed.value);
    if ('status' in validated) return validated;
    const body = validated;

    const keyInfo = parsePublicKeyInfo(body.publicKey);
    if (keyInfo === null) {
      return badRequest('invalid_public_key', 'publicKey failed to parse as a PEM public key');
    }
    if (!algorithmMatchesKey(body.algorithm, keyInfo)) {
      return badRequest(
        'key_algorithm_mismatch',
        `publicKey type '${keyInfo.kind}${keyInfo.namedCurve ? `:${keyInfo.namedCurve}` : ''}' does not match declared algorithm '${body.algorithm}'`
      );
    }
    const weak = weakKeyResponse(keyInfo);
    if (weak !== null) return weak;

    // Early checks give distinct status codes (400 / 409 / 410) for a missing,
    // consumed or expired invite; the conditional update below re-asserts
    // `consumedAt IS NULL` atomically.
    const inviteRead = await dataset.read(INVITE_TYPE, { id: body.code, limit: 1 });
    const invite = inviteRead.rows[0];
    if (invite === undefined) {
      return jsonResponse(400, {
        code: 'invite_not_found',
        message: 'invite code not recognised'
      });
    }
    if (invite.consumedAt != null) {
      return jsonResponse(409, {
        code: 'invite_already_consumed',
        message: 'invite has already been consumed'
      });
    }
    const expiresAt = invite.expiresAt;
    const expiresDate =
      expiresAt instanceof Date
        ? expiresAt
        : typeof expiresAt === 'string'
          ? new Date(expiresAt)
          : null;
    if (expiresDate === null || expiresDate.getTime() <= now().getTime()) {
      return jsonResponse(410, {
        code: 'invite_expired',
        message: 'invite has expired'
      });
    }

    // 16 random bytes → a 22-char base64url kid; collisions are negligible.
    const kid = base64Url(randomBytes(16));
    const createdAt = now();

    const inviteNamespacesRaw = invite.namespaces;
    const inviteCapabilitiesRaw = invite.capabilities;
    const inviteNamespaces = typeof inviteNamespacesRaw === 'string' ? inviteNamespacesRaw : '';
    const inviteCapabilities =
      typeof inviteCapabilitiesRaw === 'string' ? inviteCapabilitiesRaw : '';

    try {
      await dataset.withTransaction(async (tx) => {
        // Consume the invite first — the conditional predicate is the
        // double-spend guard. A lost race aborts the tx and maps to 409.
        const consumed = await tx.conditionalUpdate(
          INVITE_TYPE,
          body.code,
          { consumedAt: null },
          { consumedAt: createdAt.toISOString(), consumedBy: kid },
          { kind: 'agent', id: kid }
        );
        if (!consumed.matched) {
          throw new RegisterRaceError();
        }

        // Raw dataset write, bypassing the admin policy on `createKey`
        // by design: the invite is the access control. `{ identity, now }`
        // lets the substrate auto-fill `_metadata`.
        await tx.write(
          KEY_TYPE,
          [
            {
              kid,
              name: body.keyName,
              algorithm: body.algorithm,
              publicKey: body.publicKey,
              namespaces: inviteNamespaces,
              capabilities: inviteCapabilities,
              revokedAt: null
            }
          ],
          { identity: { kind: 'agent', id: kid }, now: createdAt }
        );

        // Audit in the same tx — if this throws, invite consumption and key
        // creation both roll back. The actor is the new kid itself.
        await tx.write(
          AUDIT_EVENT_TYPE,
          [
            buildAuditRow({
              actorKid: kid,
              kind: 'invite_consumed',
              targetKid: body.code,
              clientIp,
              details: { consumedBy: kid },
              now: createdAt
            })
          ],
          { identity: { kind: 'agent', id: kid }, now: createdAt }
        );
      });
    } catch (err) {
      if (err instanceof RegisterRaceError) {
        return jsonResponse(409, {
          code: 'invite_already_consumed',
          message: 'invite has already been consumed'
        });
      }
      throw err;
    }

    // Post-commit: prime the in-memory key registry so the new kid is
    // immediately verifiable on subsequent requests.
    await registry.refresh(kid);

    const responseNamespaces = inviteNamespaces.length > 0 ? inviteNamespaces.split(',') : [];
    const responseCapabilities = inviteCapabilities.length > 0 ? inviteCapabilities.split(',') : [];
    return jsonResponse(201, {
      kid,
      namespaces: responseNamespaces,
      capabilities: responseCapabilities
    });
  };
}

/** Sentinel that aborts the register tx on a lost race; surfaces as a 409. */
class RegisterRaceError extends Error {
  override readonly name = 'RegisterRaceError';
  constructor() {
    super('invite already consumed (race)');
  }
}

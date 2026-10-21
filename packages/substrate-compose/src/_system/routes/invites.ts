/**
 * POST /substrate/v1/_system/invites — admin-gated invite mint.
 *
 * Mints a Invite row with a server-generated 32-byte base64url code.
 * Dispatched through the engine's `createInvite` mutation so the
 * resolver-level admin policy applies on top of the route-level `admin` gate.
 */

import { randomBytes } from 'node:crypto';
import type { Engine } from '@mnmal-ai/substrate-core';
import { encodeList } from '@mnmal-ai/substrate-policy';
import type { HttpHandler } from '@mnmal-ai/substrate-types';
import { buildContext, jsonResponse } from '../../routes/helpers.js';
import { SYSTEM_NAMESPACE } from '../types.js';
import {
  asStringArray,
  badRequest,
  base64Url,
  DEFAULT_TTL_MS,
  grantRefusal,
  type KeysRouteOptions,
  MAX_TTL_MS,
  parseBody,
  refuseUnhosted,
  unhostedNamespaces
} from './shared.js';

export function invitesRoute(engine: Engine, opts: KeysRouteOptions): HttpHandler {
  return async (req) => {
    const parsed = parseBody(req);
    if (!('ok' in parsed)) return parsed;
    const body = parsed.value;
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      return badRequest('invalid_body', 'request body must be a JSON object');
    }
    const b = body as Record<string, unknown>;

    const namespaces = asStringArray(b.namespaces);
    if (namespaces === null) {
      return badRequest('invalid_namespaces', 'namespaces must be a non-empty array of strings');
    }
    const capabilities = asStringArray(b.capabilities);
    if (capabilities === null) {
      return badRequest(
        'invalid_capabilities',
        'capabilities must be a non-empty array of strings'
      );
    }
    // A redeemed invite becomes a key, so it passes the checks POST /keys runs.
    const grantError = grantRefusal(
      namespaces,
      capabilities,
      opts.adminCapability ?? 'admin',
      b.allowAdmin === true
    );
    if (grantError !== null) return grantError;
    const unknownNs = unhostedNamespaces(engine, namespaces);
    if (unknownNs.length > 0 && b.allowUnknownNs !== true) {
      return refuseUnhosted(engine, unknownNs);
    }
    let ttlMs = DEFAULT_TTL_MS;
    if (b.ttlMs !== undefined) {
      const raw = b.ttlMs;
      if (typeof raw !== 'number' || !Number.isInteger(raw) || raw <= 0 || raw > MAX_TTL_MS) {
        return badRequest(
          'invalid_ttl',
          `ttlMs must be a positive integer <= ${MAX_TTL_MS}ms (30 days)`
        );
      }
      ttlMs = raw;
    }

    // crypto.randomBytes, not Math.random: the code is a bearer secret.
    const code = base64Url(randomBytes(32));
    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttlMs);

    // Encode namespaces / capabilities via the shared comma-separated helper —
    // the autoCRUD surface stores them as scalar strings (see types.ts).
    const params: Record<string, unknown> = {
      id: code,
      namespaces: encodeList(namespaces),
      capabilities: encodeList(capabilities),
      expiresAt: expiresAt.toISOString()
    };

    // Dispatch through the engine so the admin-gate policy on the mutation
    // still applies — the route-cap map adds an extra `admin` layer upstream
    // but the resolver policy is the hard invariant.
    const envelope = await engine.mutate({
      frame: {
        [`${SYSTEM_NAMESPACE}/createInvite`]: {
          params,
          fields: { id: true }
        }
      },
      ctx: buildContext(req, opts.trustedProxies, opts.authEnabled),
      ...(req.signal !== undefined ? { signal: req.signal } : {})
    });

    if (envelope.errors !== undefined && envelope.errors.length > 0) {
      const first = envelope.errors[0];
      const code = first?.code ?? 'internal_error';
      const status = code === 'policy_denied' ? 403 : 500;
      return jsonResponse(status, {
        code,
        message: first?.message ?? 'invite creation failed'
      });
    }

    return jsonResponse(201, {
      code,
      expiresAt: expiresAt.toISOString(),
      namespaces,
      capabilities
    });
  };
}

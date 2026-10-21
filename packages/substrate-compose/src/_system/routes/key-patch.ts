/**
 * PATCH /substrate/v1/_system/keys — revoke or re-grant a LIVE key, through the engine.
 *
 * Dispatching through `engine.mutate` is the whole point: the registry
 * interceptor fires and `lookup` reflects the change on the very next request.
 * A direct-to-postgres write leaves a revoked credential authenticating on the
 * running server until restart.
 *
 * Refusal rules — including the order they apply in — come from
 * `@mnmal-ai/substrate-policy`, shared with the CLI. This route supplies the facts and
 * words its own errors; it does not restate the rules.
 */

import type { Engine } from '@mnmal-ai/substrate-core';
import {
  checkRevocable,
  checkUpdatable,
  decodeList,
  encodeList,
  isActiveAdminKeyRow
} from '@mnmal-ai/substrate-policy';
import type { HttpHandler, Row } from '@mnmal-ai/substrate-types';
import { buildContext, jsonResponse } from '../../routes/helpers.js';
import { KEY_TYPE, SYSTEM_NAMESPACE } from '../types.js';
import { type KeysRouteOptions, parseBody, refuseUnhosted, unhostedNamespaces } from './shared.js';

export function keyPatchRoute(engine: Engine, opts: KeysRouteOptions): HttpHandler {
  const keyFrame = `${SYSTEM_NAMESPACE}/${KEY_TYPE}`;
  return async (req) => {
    const parsed = parseBody(req);
    if (!('ok' in parsed)) return parsed;
    const body = parsed.value;
    if (typeof body !== 'object' || body === null) {
      return jsonResponse(400, { code: 'invalid_body', message: 'body must be a JSON object' });
    }
    const b = body as Record<string, unknown>;
    const kid = b.kid;
    if (typeof kid !== 'string' || kid.length === 0) {
      return jsonResponse(400, { code: 'invalid_kid', message: 'kid must be a non-empty string' });
    }
    const revoke = b.revoke === true;
    const adminCapability = opts.adminCapability ?? 'admin';
    const ctx = buildContext(req, opts.trustedProxies, opts.authEnabled);

    const asList = (v: unknown): Array<string> | undefined =>
      Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : undefined;

    // --- facts ---------------------------------------------------------------
    // The WHOLE key table, deliberately unpaged: `activeAdminKids` feeds the
    // lockout guard, and a partial list silently weakens it.
    const all = await engine.query({
      frame: {
        [keyFrame]: {
          params: {},
          fields: {
            id: true,
            kid: true,
            name: true,
            revokedAt: true,
            namespaces: true,
            capabilities: true
          }
        }
      },
      ctx,
      ...(req.signal !== undefined ? { signal: req.signal } : {})
    });
    if (all.errors !== undefined && all.errors.length > 0) {
      const first = all.errors[0];
      const code = first?.code ?? 'internal_error';
      return jsonResponse(code === 'policy_denied' ? 403 : 500, {
        code,
        message: first?.message ?? 'could not read the key table'
      });
    }
    const rows = (Array.isArray(all.data?.[keyFrame]) ? all.data[keyFrame] : []) as Array<Row>;
    // A rotated kid has revoked rows beside its live one; the live row is the target.
    const sameKid = rows.filter((r) => r.kid === kid);
    const target = sameKid.find((r) => r.revokedAt == null) ?? sameKid[0];
    const activeAdminKids = rows
      .filter((r) => isActiveAdminKeyRow(r, adminCapability))
      .map((r) => String(r.kid));

    const prevNs = decodeList(target?.namespaces);
    const prevCaps = decodeList(target?.capabilities);
    const nextNs = asList(b.namespaces) ?? prevNs;
    const nextCaps = asList(b.capabilities) ?? prevCaps;

    // Refuse unhosted namespaces only when the caller SUPPLIES a list — an
    // update that leaves namespaces alone must not start failing because some
    // plugin was unloaded since the key was registered.
    if (!revoke && asList(b.namespaces) !== undefined) {
      const unknownNs = unhostedNamespaces(engine, nextNs);
      if (unknownNs.length > 0 && b.allowUnknownNs !== true) {
        return refuseUnhosted(engine, unknownNs);
      }
    }

    // --- the verdict ---------------------------------------------------------
    const refusal = revoke
      ? checkRevocable({
          kid,
          exists: target !== undefined,
          existingRevokedAt: target?.revokedAt,
          activeAdminKids
        })
      : checkUpdatable({
          kid,
          exists: target !== undefined,
          existingRevokedAt: target?.revokedAt,
          prevNamespaces: prevNs,
          prevCapabilities: prevCaps,
          nextNamespaces: nextNs,
          nextCapabilities: nextCaps,
          activeAdminKids,
          adminCapability,
          widen: b.widen === true,
          allowAdmin: b.allowAdmin === true
        });
    if (refusal !== null) {
      // Same reasons the CLI maps to exit codes, mapped here to statuses.
      // 409 for "the store's state forbids this", 404 for "no such thing",
      // 422 for "say you meant it" — a refusal the caller can lift by asking
      // again with confirmation, which is not the same as being forbidden.
      // `invalid_grant` is 400 rather than the 409 default: the request is
      // unreadable, not in conflict with the store's state.
      const status =
        refusal.code === 'unknown_kid'
          ? 404
          : refusal.code === 'invalid_grant'
            ? 400
            : refusal.code === 'requires_widen' || refusal.code === 'requires_allow_admin'
              ? 422
              : 409;
      return jsonResponse(status, { ...refusal });
    }

    // --- the write -----------------------------------------------------------
    const params: Record<string, unknown> = { id: target?.id as string };
    if (revoke) {
      params.revokedAt = new Date().toISOString();
    } else {
      if (typeof b.name === 'string') params.name = b.name;
      if (asList(b.namespaces) !== undefined) params.namespaces = encodeList(nextNs);
      if (asList(b.capabilities) !== undefined) params.capabilities = encodeList(nextCaps);
    }

    const opKey = `${SYSTEM_NAMESPACE}/update${KEY_TYPE}`;
    const envelope = await engine.mutate({
      frame: {
        [opKey]: { params, fields: { id: true, kid: true, revokedAt: true } }
      } as Parameters<Engine['mutate']>[0]['frame'],
      ctx,
      ...(req.signal !== undefined ? { signal: req.signal } : {})
    });
    const errs = envelope.errors ?? [];
    const err = errs[0];
    if (err !== undefined) {
      const code = err.code ?? 'internal_error';
      return jsonResponse(code === 'policy_denied' ? 403 : 500, {
        code,
        message: err.message ?? 'key update failed'
      });
    }

    return jsonResponse(200, {
      kid,
      revoked: revoke,
      ...(revoke ? { revokedAt: params.revokedAt } : { namespaces: nextNs, capabilities: nextCaps })
    });
  };
}

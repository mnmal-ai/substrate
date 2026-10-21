/**
 * GET /substrate/v1/_system/keys — the authenticated read of the active key table.
 *
 * Goes through the engine and the `admin` gate, unlike `substrate-admin list`,
 * which reads postgres unauthenticated; a 403 here is the deployment's real
 * answer about the caller.
 *
 * Returns the columns `substrate-admin list` renders plus `id`; `publicKey` is
 * omitted. `hasMore`/`nextCursor` pass through so a truncated read is never
 * silent. Revoked rows are excluded, and `filter: 'active'` says so.
 */

import type { Engine } from '@mnmal-ai/substrate-core';
import type { HttpHandler, RowMetadata } from '@mnmal-ai/substrate-types';
import { buildContext, jsonResponse } from '../../routes/helpers.js';
import { KEY_TYPE, SYSTEM_NAMESPACE } from '../types.js';
import { badRequest, type KeysRouteOptions } from './shared.js';

/** Default page size for the key read. Generous — an admin set is small. */
const KEYS_READ_DEFAULT_LIMIT = 200;
const KEYS_READ_MAX_LIMIT = 1000;

export function keysListRoute(engine: Engine, opts: KeysRouteOptions): HttpHandler {
  return async (req) => {
    const ctx = buildContext(req, opts.trustedProxies, opts.authEnabled);

    let limit = KEYS_READ_DEFAULT_LIMIT;
    const rawLimit = req.query.limit;
    if (rawLimit !== undefined && rawLimit !== '') {
      const n = Number(rawLimit);
      if (!Number.isInteger(n) || n <= 0 || n > KEYS_READ_MAX_LIMIT) {
        return badRequest(
          'invalid_limit',
          `limit must be a positive integer <= ${KEYS_READ_MAX_LIMIT}`
        );
      }
      limit = n;
    }

    const keyFrame = `${SYSTEM_NAMESPACE}/${KEY_TYPE}`;
    const params: Record<string, unknown> = {
      where: { revokedAt: { eq: null } },
      limit
    };
    const cursor = req.query.cursor;
    if (cursor !== undefined && cursor !== '') params.cursor = cursor;

    const envelope = await engine.query({
      frame: {
        [keyFrame]: {
          params,
          fields: {
            id: true,
            kid: true,
            name: true,
            algorithm: true,
            namespaces: true,
            capabilities: true,
            _metadata: true
          }
        }
      },
      ctx,
      ...(req.signal !== undefined ? { signal: req.signal } : {})
    });

    if (envelope.errors !== undefined && envelope.errors.length > 0) {
      const first = envelope.errors[0];
      const code = first?.code ?? 'internal_error';
      return jsonResponse(code === 'policy_denied' ? 403 : 500, {
        code,
        message: first?.message ?? 'could not read the key table'
      });
    }

    // Frame presence, not `?? []`: a rejected frame must not read as
    // "no keys exist".
    const rows = envelope.data?.[keyFrame];
    if (!Array.isArray(rows)) {
      return jsonResponse(500, {
        code: 'frame_absent',
        message: `the engine returned no '${keyFrame}' frame, and no error explaining why`
      });
    }

    const page = envelope._pagination?.[keyFrame];
    return jsonResponse(200, {
      filter: 'active',
      keys: rows.map((row) => {
        const meta = row._metadata as RowMetadata | undefined;
        return {
          id: typeof row.id === 'string' ? row.id : '',
          kid: typeof row.kid === 'string' ? row.kid : '',
          name: typeof row.name === 'string' ? row.name : '',
          algorithm: typeof row.algorithm === 'string' ? row.algorithm : '',
          namespaces: typeof row.namespaces === 'string' ? row.namespaces : '',
          capabilities: typeof row.capabilities === 'string' ? row.capabilities : '',
          createdAt: meta?.createdAt ?? ''
        };
      }),
      hasMore: page?.hasMore ?? false,
      ...(page?.nextCursor !== undefined ? { nextCursor: page.nextCursor } : {})
    });
  };
}

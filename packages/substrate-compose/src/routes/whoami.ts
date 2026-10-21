/**
 * `GET /substrate/v1/whoami` — the supported answer to "am I authenticated, and as
 * whom?"
 *
 * On a reads-open stack an authenticated read and an anonymous one return
 * byte-identical results, so only the server can say which a caller is.
 *
 * Authenticates itself rather than sitting behind `gate`, because an anonymous
 * caller must get an answer even under `mode: 'required'`. A present-but-invalid
 * token still 401s, since its fix differs from sending none:
 *
 *   no token    -> 200 { authEnabled: true, identity: null }
 *   bad token   -> 401
 *
 * `authEnabled` disambiguates `identity: null`: "auth is on and you are
 * anonymous" versus "this deployment verifies nothing".
 *
 * Returns the grant as recorded (a `*` is never expanded), describes only the
 * caller, and never echoes the token.
 */

import type { HttpHandler, Identity } from '@mnmal-ai/substrate-types';
import { grantOf } from '@mnmal-ai/substrate-types';
import { type AuthConfig, authenticateBearer, extractBearer, rejectionDetail } from '../auth.js';
import { jsonResponse } from './helpers.js';

/**
 * The caller-facing projection of an `Identity`: `{ id, grants }`. Shared with
 * the WS `whoami` frame.
 */
export function describeIdentity(identity: Identity): Record<string, unknown> {
  return {
    id: identity.id,
    grants: grantOf(identity) ?? {}
  };
}

export function whoamiRoute(auth?: AuthConfig): HttpHandler {
  return async (req) => {
    // Auth disabled entirely. Distinct from "you are anonymous": nobody is
    // authenticated here and presenting a credential would change nothing.
    if (auth === undefined) {
      return jsonResponse(200, { authEnabled: false, identity: null });
    }

    const token = extractBearer(req.headers.authorization);
    if (token === null) {
      return jsonResponse(200, { authEnabled: true, identity: null });
    }

    const verdict = authenticateBearer(token, auth);
    if (!verdict.ok) {
      // 401 rather than `identity: null`, so a broken credential never reads
      // as anonymous. `reason` names only expired / malformed-claim tokens;
      // unknown-kid and bad-signature stay bare to avoid an oracle.
      const { reason } = verdict;
      return jsonResponse(
        401,
        reason === null
          ? {
              code: 'unauthorized',
              authEnabled: true,
              identity: null,
              detail:
                'a token was presented and rejected — this is not the same as sending no token, which answers 200 with identity: null'
            }
          : {
              code: 'unauthorized',
              reason,
              authEnabled: true,
              identity: null,
              detail:
                rejectionDetail(reason) ??
                'a token was presented and rejected — this is not the same as sending no token, which answers 200 with identity: null'
            }
      );
    }

    return jsonResponse(200, {
      authEnabled: true,
      identity: describeIdentity(verdict.identity)
    });
  };
}

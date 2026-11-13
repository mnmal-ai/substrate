/**
 * Auth middleware for composed routes.
 *
 * `compose()` orchestrates; this module owns the per-request gate:
 * bearer-token + capability check (`withAuth`), the no-auth attribution
 * (`withSystemActor`), and the plugin-router wrappers. One implementation
 * so in-compose routes and substrate kernel routes cannot drift into
 * differently-enforced versions of the same rule.
 */

import type {
  HttpHandler,
  HttpMethod,
  Identity,
  PluginRouter,
  SubstrateRequest,
  SubstrateResponse
} from '@mnmal-ai/substrate-types';
import { allCapabilities, confersAnywhere, grantedIn, grantOf } from '@mnmal-ai/substrate-types';
import {
  type AuthConfig,
  authenticateBearer,
  type BearerRejectionReason,
  extractBearer,
  rejectionDetail
} from '../auth.js';

/**
 * §5.12 route capabilities. No admin bypass — admin is a capability like any
 * other, and does not imply `read` or `mutate`. `'admin'` here is the role:
 * `withAuth` checks it as the deployment's `adminCapability`.
 */
export type Capability = 'read' | 'mutate' | 'admin';

function unauthorizedResponse(reason: BearerRejectionReason | null = null): SubstrateResponse {
  const detail = rejectionDetail(reason);
  return {
    status: 401,
    headers: { 'content-type': 'application/json' },
    // `reason` is present only when there is a safe signal:
    // claim-shape and expiry failures name themselves; unknown-kid and
    // bad-signature collapse to the bare body — distinguishing them would be
    // a kid-existence oracle.
    body: Buffer.from(
      JSON.stringify(
        reason === null
          ? { code: 'unauthorized' }
          : { code: 'unauthorized', reason, ...(detail !== undefined ? { detail } : {}) }
      ),
      'utf8'
    )
  };
}

/**
 * What a tokenless caller is told. Separate from `unauthorizedResponse()`
 * because "you sent nothing" and "what you sent is broken" have different
 * fixes. It names `/substrate/v1/whoami`, which answers without a credential.
 *
 * Deliberately `detail`, not `reason`: `reason` is the rejected-credential
 * diagnosis, kept bare for unknown-kid / bad-signature to avoid a kid oracle.
 */
const NO_CREDENTIAL_DETAIL =
  'no Authorization header was sent. This is not the same as a credential being ' +
  'rejected, which answers 401 with a `reason`. Set SUBSTRATE_AGENT_KEY_ID + ' +
  'SUBSTRATE_AGENT_KEY_PATH (or SUBSTRATE_AGENT_TOKEN) and retry. GET /substrate/v1/whoami ' +
  'reports what this server sees for your credential, and answers without one.';

function noCredentialResponse(): SubstrateResponse {
  return {
    status: 401,
    headers: { 'content-type': 'application/json' },
    body: Buffer.from(
      JSON.stringify({ code: 'unauthorized', detail: NO_CREDENTIAL_DETAIL }),
      'utf8'
    )
  };
}

function forbiddenResponse(required: string, have: Array<string>): SubstrateResponse {
  return {
    status: 403,
    headers: { 'content-type': 'application/json' },
    body: Buffer.from(JSON.stringify({ code: 'forbidden', required, have }), 'utf8')
  };
}

/** Cap on a body this will parse purely to observe it. */
const FRAME_KEY_PARSE_LIMIT = 64 * 1024;

/** Most a single request should need; a longer list is noise, not identity. */
const MAX_FRAME_KEYS = 20;

/**
 * The TOP-LEVEL frame keys of a request body, for the anonymous-read
 * observation.
 *
 * Never params: a `where` clause carries content (filter values, search text,
 * ids), so only `Object.keys` is taken and values are never touched — that is
 * what makes this safe to log.
 *
 * Returns `undefined` on no body, non-JSON, a non-object, or a body over
 * `FRAME_KEY_PARSE_LIMIT`. An observation must never break or slow the request.
 */
function frameKeysOf(body: Buffer | null): string[] | undefined {
  if (body === null || body.length === 0 || body.length > FRAME_KEY_PARSE_LIMIT) return undefined;
  try {
    const parsed: unknown = JSON.parse(body.toString('utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    const keys = Object.keys(parsed);
    return keys.length === 0 ? undefined : keys.slice(0, MAX_FRAME_KEYS);
  } catch {
    return undefined;
  }
}

/**
 * Stamp the deployment's declared actor onto every request when auth is off,
 * so an unauthenticated deployment's writes are distinguishable from anonymous
 * callers and from internal writes that omitted an identity. A `null` actor
 * returns `handler` unchanged.
 *
 * Any caller-supplied `identity` is DISCARDED rather than trusted: it arrives
 * on an unauthenticated request, so it is a claim with nothing behind it. Same
 * defence `withAuth` applies on its own anonymous path.
 */
export function withSystemActor(handler: HttpHandler, actor: Identity | null): HttpHandler {
  if (actor === null) return handler;
  return async (req: SubstrateRequest): Promise<SubstrateResponse> =>
    handler({ ...req, identity: actor });
}

/**
 * Wrap a `PluginRouter` so every route carries the deployment's declared actor
 * when auth is off. Plugin routes mount outside `gate`, so without this they
 * would be the one surface still reaching the engine unattributed.
 */
export function wrapPluginRouterWithSystemActor(
  router: PluginRouter,
  actor: Identity | null
): PluginRouter {
  if (actor === null) return router;
  const w = (h: HttpHandler): HttpHandler => withSystemActor(h, actor);
  return {
    get: (path, h) => router.get(path, w(h)),
    post: (path, h) => router.post(path, w(h)),
    put: (path, h) => router.put(path, w(h)),
    delete: (path, h) => router.delete(path, w(h)),
    patch: (path, h) => router.patch(path, w(h))
  };
}

/**
 * Wrap a handler in the bearer-token + capability check.
 *
 * Exported because kernel routes claimed by substrate plugins mount through the
 * host's raw `server.route`, outside `compose()` and therefore outside its
 * `gate` closure. A plugin that declares `KernelRouteClaim.capability`
 * needs the host to apply the same check the in-compose routes get, and this is
 * that check — one implementation, so the two paths cannot drift into
 * differently-enforced versions of the same rule.
 */
export function withAuth(
  handler: HttpHandler,
  cfg: AuthConfig,
  required: Capability | null,
  /**
   * Called when a TOKENLESS caller is admitted to a read, so anonymous readers
   * can be identified before anonymous reads are closed. Not called for
   * authenticated reads, which are already attributable.
   */
  onAnonymousRead?: (info: {
    method: string;
    path: string;
    peerIp: string | undefined;
    userAgent: string | undefined;
    frameKeys: string[] | undefined;
  }) => void
): HttpHandler {
  return async (req: SubstrateRequest): Promise<SubstrateResponse> => {
    const token = extractBearer(req.headers.authorization);
    if (token === null) {
      // `attribute` means ANONYMOUS READS, never anonymous writes. A tokenless
      // caller is admitted only to routes that require nothing or `read`.
      // Many namespaces declare no write policy of their own, so this is the
      // write gate; a per-namespace policy is defence in depth.
      if (cfg.mode === 'attribute' && (required === null || required === 'read')) {
        onAnonymousRead?.({
          method: req.method,
          path: req.path,
          peerIp: req.peerIp,
          userAgent: req.headers['user-agent'],
          frameKeys: frameKeysOf(req.body)
        });
        // exactOptionalPropertyTypes: omit identity key rather than setting it to undefined.
        const { identity: _identity, ...anonReq } = req;
        return handler(anonReq);
      }
      return noCredentialResponse();
    }
    const verdict = authenticateBearer(token, cfg);
    // Present-but-invalid always 401, with the safe signal attached where
    // there is one.
    if (!verdict.ok) return unauthorizedResponse(verdict.reason);
    const { identity } = verdict;
    if (required !== null) {
      // This gate runs BEFORE any frame is parsed, so it has no namespace in
      // hand — `confersAnywhere`, not `grantedIn`. Passing here means "you hold
      // this capability SOMEWHERE"; the engine's per-frame gate still has to run.
      //
      // `null` is refused, unlike at the engine gate. A caller that presented a
      // token conferring nothing gets nothing — the opposite reading of the
      // same no-claim state, and deliberate on both sides.
      //
      // `'admin'` names the ROLE; the deployment names the capability that
      // confers it (`SUBSTRATE_ADMIN_CAPABILITY`), as the `_system` policy does.
      const capability = required === 'admin' ? (cfg.adminCapability ?? 'admin') : required;
      const resolved = grantOf(identity);
      if (!confersAnywhere(resolved, capability)) {
        return forbiddenResponse(capability, allCapabilities(resolved));
      }
    }
    return handler({ ...req, identity });
  };
}

/**
 * Wrap a `PluginRouter` so every registered route runs through `withAuth`
 * with a capability inferred from the HTTP method — GET reads, everything
 * else mutates. An authenticated caller must hold that capability in one of
 * `namespaces` (the plugin's declared namespaces); a plugin that declares
 * none accepts the capability held in any namespace.
 */
export function wrapPluginRouter(
  router: PluginRouter,
  cfg: AuthConfig,
  namespaces: readonly string[] = []
): PluginRouter {
  const gate = (method: HttpMethod, h: HttpHandler): HttpHandler => {
    const capability: Capability = method === 'GET' ? 'read' : 'mutate';
    if (namespaces.length === 0) return withAuth(h, cfg, capability);
    return withAuth(
      async (req) => {
        // No identity here means `withAuth` admitted an anonymous read.
        if (req.identity === undefined) return h(req);
        const resolved = grantOf(req.identity);
        if (namespaces.some((ns) => grantedIn(resolved, ns).includes(capability))) return h(req);
        return forbiddenResponse(capability, allCapabilities(resolved));
      },
      cfg,
      capability
    );
  };
  return {
    get: (path, h) => router.get(path, gate('GET', h)),
    post: (path, h) => router.post(path, gate('POST', h)),
    put: (path, h) => router.put(path, gate('PUT', h)),
    delete: (path, h) => router.delete(path, gate('DELETE', h)),
    patch: (path, h) => router.patch(path, gate('PATCH', h))
  };
}

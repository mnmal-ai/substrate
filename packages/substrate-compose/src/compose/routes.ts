/**
 * compose/routes.ts — core HTTP route registration.
 *
 * Fire order (spec §5.11): core /substrate/v1/* routes → plugin routes → onStart.
 * Plugin routes mount under `/substrate/v1/plugins/<name>` via the server's
 * `createPluginRouter`, gated by method: GET → read, everything else → mutate.
 */

import type { Engine, NamespaceConfig, RuntimeStats } from '@mnmal-ai/substrate-core';
import type { MemoryDatasetRegistry } from '@mnmal-ai/substrate-dataset-memory';
import type {
  BridgeRegistry,
  CoordinatorPlugin,
  Dataset,
  EdgesStore,
  HttpHandler,
  Identity,
  PluginRouter,
  SubstrateServer
} from '@mnmal-ai/substrate-types';
import { grantedIn, grantOf } from '@mnmal-ai/substrate-types';
import { backfillFieldRoute } from '../_system/backfill-field.js';
import { dropNamespaceRoute, dropTypeRoute } from '../_system/drop.js';
import type { KeyRegistry } from '../_system/index.js';
import { normaliseVocabRoute } from '../_system/normalise-vocab.js';
import { createRateLimiter, type RateLimiter } from '../_system/rate-limit.js';
import {
  invitesRoute,
  keyPatchRoute,
  keysListRoute,
  keysRoute,
  registerRoute
} from '../_system/routes.js';
import type { IdentityDirectoryConfig } from '../_system/types.js';
import type { AuthConfig } from '../auth.js';
import { type ConfigReport, configRouteHandler } from '../routes/config-echo.js';
import { createConnectionLimiter, MAX_SESSIONS_PER_CLIENT } from '../routes/connection-limit.js';
import { federatedSchemaRoute } from '../routes/federated-schema.js';
import { healthRoute } from '../routes/health.js';
import { withRequestContext } from '../routes/helpers.js';
import { mutateRoute } from '../routes/mutate.js';
import { onboardRoute } from '../routes/onboard.js';
import { queryRoute } from '../routes/query.js';
import { errorsRouteHandler } from '../routes/runtime-errors.js';
import { metricsRouteHandler } from '../routes/runtime-stats.js';
import { schemaForNamespaceRoute, schemaForTypeRoute, schemaRoute } from '../routes/schema.js';
import { registerSseRoutes } from '../routes/sse.js';
import { whoamiRoute } from '../routes/whoami.js';
import { registerWsRoute } from '../routes/ws.js';
import {
  type Capability,
  wrapPluginRouter,
  wrapPluginRouterWithSystemActor
} from './auth-middleware.js';

export interface CoreRoutesArgs {
  server: SubstrateServer;
  engine: Engine;
  gate: (handler: HttpHandler, required: Capability | null) => HttpHandler;
  trustedProxies: Set<string>;
  pageLimits: { defaultLimit: number; maxLimit: number };
  auth: AuthConfig | undefined;
  streamTicketSecret: string | undefined;
  version: string | undefined;
  stats: RuntimeStats;
  routeEventMetric: (name: string, payload?: unknown) => void;
  substrateDataset: Dataset;
  substrateKeyRegistry: KeyRegistry;
  datasets: MemoryDatasetRegistry;
  edges: EdgesStore;
  namespaces: Map<string, NamespaceConfig>;
  coordinatorPlugins: Array<CoordinatorPlugin>;
  systemIdentity: Identity | null;
  routeMetric: (name: string, payload?: unknown) => void;
  bridges: BridgeRegistry;
  registerRateLimiter?: RateLimiter;
  identityDirectory?: IdentityDirectoryConfig;
  adminCapability?: string;
  /**
   * Knob provenance from the binary's env parser. Present → `GET /substrate/v1/config`
   * is mounted admin-gated. Absent → the route is not mounted, since an empty
   * echo would read as "nothing is configured" rather than "nothing reported".
   */
  configReport?: ConfigReport;
}

export async function registerCoreRoutes(args: CoreRoutesArgs): Promise<{
  rateLimiter: RateLimiter;
  ownsRateLimiter: boolean;
}> {
  const {
    server,
    engine,
    gate,
    trustedProxies,
    auth,
    streamTicketSecret,
    version,
    stats,
    routeEventMetric,
    substrateDataset,
    substrateKeyRegistry,
    datasets,
    edges,
    namespaces,
    coordinatorPlugins,
    systemIdentity,
    routeMetric,
    bridges,
    registerRateLimiter,
    identityDirectory,
    adminCapability,
    configReport
  } = args;

  server.route(
    'GET',
    '/health',
    healthRoute({ version: version ?? '0.0.0', startedAt: Date.now() })
  );
  // Schema discovery and onboarding sit behind `read`, like /substrate/v1/query: the
  // schema is the whole type map of every namespace. Open without a key:
  // /health, /substrate/v1/whoami and /substrate/v1/_system/register.
  server.route('GET', '/substrate/v1/schema', gate(schemaRoute(engine, 'default'), 'read'));
  // Scoped discovery — cheap shape lookups for agents to mine before a write,
  // without pulling the whole federated schema. Registered before the static
  // route is fine: segment count disambiguates (2 vs 3 vs 4).
  server.route(
    'GET',
    '/substrate/v1/schema/:namespace',
    gate(schemaForNamespaceRoute(engine), 'read')
  );
  server.route(
    'GET',
    '/substrate/v1/schema/:namespace/:type',
    gate(schemaForTypeRoute(engine), 'read')
  );
  server.route(
    'GET',
    '/substrate/v1/federated-schema',
    gate(federatedSchemaRoute(engine, trustedProxies, auth !== undefined), 'read')
  );
  server.route(
    'GET',
    '/substrate/v1/onboard',
    gate(
      onboardRoute({
        version: version ?? '0.0.0',
        coordinators: coordinatorPlugins,
        bridges,
        authEnabled: auth !== undefined,
        filterOperators: engine.listFilterOperators(),
        virtualNamespaces: Array.from(namespaces.entries())
          .filter(([, c]) => c.virtual === true)
          .map(([ns]) => ns)
          .sort()
      }),
      'read'
    )
  );
  server.route(
    'POST',
    '/substrate/v1/query',
    gate(queryRoute(engine, trustedProxies, auth !== undefined, args.pageLimits), 'read')
  );
  server.route(
    'POST',
    '/substrate/v1/mutate',
    gate(mutateRoute(engine, trustedProxies, auth !== undefined), 'mutate')
  );
  // One count across WS and SSE, so switching transport does not reset it.
  const connections = createConnectionLimiter();
  const sessionCap = createConnectionLimiter(MAX_SESSIONS_PER_CLIENT);
  registerSseRoutes(
    server,
    engine,
    trustedProxies,
    // The dev fallback is reachable only with auth disabled — the guard at the
    // top of `compose` refuses an absent/short/whitespace secret otherwise. A
    // whitespace-only value trims to `''` and takes the fallback rather than
    // becoming an empty HMAC key.
    streamTicketSecret !== undefined && streamTicketSecret.length > 0
      ? streamTicketSecret
      : 'substrate-dev-insecure-stream-secret',
    gate,
    routeEventMetric,
    auth,
    connections,
    sessionCap
  );

  server.observeRequests?.((o) => stats.recordRequest(o.op, o.ok, o.durationMs));
  server.route('GET', '/substrate/v1/metrics', gate(metricsRouteHandler(stats), 'read'));
  // Admin-gated: error text names other callers' rows and values (spec §3).
  server.route(
    'GET',
    '/substrate/v1/errors',
    gate(
      errorsRouteHandler(stats, {
        authOff: auth === undefined,
        ...(adminCapability !== undefined ? { adminCapability } : {})
      }),
      'admin'
    )
  );
  // Admin-gated, unlike /substrate/v1/metrics: this says how the deployment is built
  // — store kind, auth mode, proxy allowlist.
  if (configReport !== undefined) {
    server.route('GET', '/substrate/v1/config', gate(configRouteHandler(configReport), 'admin'));
  }

  // §5.12: admin-gated invite mint + public rate-limited register.
  // `/register` bypasses auth entirely — access control IS the invite. The
  // rate limiter lives until `stop()`; tests may inject their own.
  const rateLimiter =
    registerRateLimiter ??
    createRateLimiter({
      maxRequests: 10,
      windowMs: 60_000
    });
  const ownsRateLimiter = registerRateLimiter === undefined;
  server.route(
    'POST',
    '/substrate/v1/_system/invites',
    gate(
      invitesRoute(engine, {
        authEnabled: auth !== undefined,
        trustedProxies,
        ...(adminCapability !== undefined ? { adminCapability } : {})
      }),
      'admin'
    )
  );
  // Admin-gated key list / registration / revoke-update. Registration writes
  // the credential and the directory row in one substrate tx.
  server.route(
    'GET',
    '/substrate/v1/_system/keys',
    gate(
      keysListRoute(engine, {
        authEnabled: auth !== undefined,
        trustedProxies
      }),
      'admin'
    )
  );
  server.route(
    'POST',
    '/substrate/v1/_system/keys',
    gate(
      keysRoute(engine, {
        authEnabled: auth !== undefined,
        trustedProxies,
        ...(identityDirectory !== undefined ? { identityDirectory } : {}),
        ...(adminCapability !== undefined ? { adminCapability } : {})
      }),
      'admin'
    )
  );
  // Dispatches through the engine like the POST above: a key mutation that
  // bypasses the engine never reaches the running registry, so a revoked
  // credential would keep authenticating.
  server.route(
    'PATCH',
    '/substrate/v1/_system/keys',
    gate(
      keyPatchRoute(engine, {
        authEnabled: auth !== undefined,
        trustedProxies,
        ...(adminCapability !== undefined ? { adminCapability } : {})
      }),
      'admin'
    )
  );
  // The `'admin'` gate asks whether admin is held ANYWHERE; these four act on
  // the namespace named in the body, so admin must be held in THAT namespace.
  const adminCap = adminCapability ?? 'admin';
  const adminInTarget =
    (handler: HttpHandler): HttpHandler =>
    async (req) => {
      if (auth === undefined) return handler(req);
      let ns: unknown;
      try {
        ns = (JSON.parse(req.body?.toString('utf8') ?? '') as { namespace?: unknown }).namespace;
      } catch {
        return handler(req); // the handler owns the malformed-body answer
      }
      if (typeof ns !== 'string') return handler(req);
      const held = grantedIn(grantOf(req.identity ?? null), ns);
      if (held.includes(adminCap)) return handler(req);
      return {
        status: 403,
        headers: { 'content-type': 'application/json' },
        body: Buffer.from(
          JSON.stringify({ code: 'forbidden', required: `${ns}:${adminCap}` }),
          'utf8'
        )
      };
    };
  // A drop's edges can reach other namespaces; the routes ask about those here.
  const dropGrants =
    auth === undefined
      ? {}
      : {
          holds: (req: Parameters<HttpHandler>[0], ns: string, cap: string) =>
            grantedIn(grantOf(req.identity ?? null), ns).includes(cap),
          adminCapability: adminCap
        };
  // Drop-namespace + drop-type admin ops. Both emit AuditEvent inside the
  // dataset withTransaction. `refuse` default cascade (409 on dangling edges);
  // explicit `cascade: "delete"` opts into edge teardown.
  server.route(
    'POST',
    '/substrate/v1/_system/drop-namespace',
    gate(
      adminInTarget(
        dropNamespaceRoute({
          resolveDataset: (ns) => datasets.get(ns) ?? null,
          edges,
          now: () => new Date(),
          trustedProxies,
          engine,
          ...dropGrants
        })
      ),
      'admin'
    )
  );
  server.route(
    'POST',
    '/substrate/v1/_system/drop-type',
    gate(
      adminInTarget(
        dropTypeRoute({
          resolveDataset: (ns) => datasets.get(ns) ?? null,
          edges,
          now: () => new Date(),
          trustedProxies,
          ...dropGrants
        })
      ),
      'admin'
    )
  );
  // Vocabulary backfill: rewrite stored aliases of a governed vocabulary to
  // their canonical value. Dry run unless `apply: true`; preserves row metadata.
  server.route(
    'POST',
    '/substrate/v1/_system/normalise-vocab',
    gate(
      adminInTarget(
        normaliseVocabRoute({
          resolveDataset: (ns) => datasets.get(ns) ?? null,
          schemaFor: (ns) => {
            try {
              return engine.schemaFor(ns);
            } catch {
              return null;
            }
          },
          now: () => new Date(),
          trustedProxies
        })
      ),
      'admin'
    )
  );
  server.route(
    'POST',
    '/substrate/v1/_system/backfill-field',
    gate(
      adminInTarget(
        backfillFieldRoute({
          resolveDataset: (ns) => datasets.get(ns) ?? null,
          schemaFor: (ns) => {
            try {
              return engine.schemaFor(ns);
            } catch {
              return null;
            }
          },
          now: () => new Date(),
          trustedProxies
        })
      ),
      'admin'
    )
  );
  server.route(
    'POST',
    '/substrate/v1/_system/register',
    registerRoute(substrateDataset, substrateKeyRegistry, rateLimiter, {
      trustedProxies
    })
  );
  // Identity echo. Not behind `gate`, on purpose: an anonymous caller must get
  // an answer even under `mode: 'required'`. The handler does its own bearer
  // handling (see `whoamiRoute`).
  server.route('GET', '/substrate/v1/whoami', whoamiRoute(auth));

  registerWsRoute(
    server,
    engine,
    trustedProxies,
    routeEventMetric,
    auth,
    systemIdentity,
    connections,
    sessionCap
  );

  for (const plugin of coordinatorPlugins) {
    if (plugin.routes === undefined) continue;
    const rawRouter = withRouterRequestContext(
      server.createPluginRouter({ name: plugin.name }),
      trustedProxies,
      auth !== undefined
    );
    const router: PluginRouter =
      auth === undefined
        ? wrapPluginRouterWithSystemActor(rawRouter, systemIdentity)
        : wrapPluginRouter(
            rawRouter,
            auth,
            plugin.namespaces.map((n) => n.namespace)
          );
    await plugin.routes(router, {
      pluginName: plugin.name,
      engine,
      metric: routeMetric
    });
  }

  return { rateLimiter, ownsRateLimiter };
}

/** Every HTTP route on `router` gets the stamped request context (`withRequestContext`). */
function withRouterRequestContext(
  router: PluginRouter,
  trustedProxies: Set<string>,
  authEnabled: boolean
): PluginRouter {
  const w = (h: HttpHandler): HttpHandler => withRequestContext(h, trustedProxies, authEnabled);
  return {
    get: (path, h) => router.get(path, w(h)),
    post: (path, h) => router.post(path, w(h)),
    put: (path, h) => router.put(path, w(h)),
    delete: (path, h) => router.delete(path, w(h)),
    patch: (path, h) => router.patch(path, w(h)),
    websocket: (path, h) => router.websocket(path, h)
  };
}

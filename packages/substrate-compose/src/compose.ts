/**
 * Composition root — pure function that builds the engine, publishes the
 * federated schema, and registers HTTP routes on the supplied `SubstrateServer`.
 * Does not call `start()`: that's `main.ts`'s job. Tests compose against a
 * `MemorySubstrateServer` and drive via `inject()`.
 *
 * Namespaces come from the supplied coordinator and substrate plugins, plus
 * the always-mounted `_system` admin namespace; with no coordinators, an empty
 * `'default'` namespace is served.
 *
 * `SweepDeps` (§6.3) is constructed alongside the engine. The sweep loop is
 * started by `main.ts` on an interval; tests drive `runSweepNow` instead.
 */

import {
  createRuntimeStats,
  Engine,
  loadPlugins,
  MemoryEdgesStore,
  type NamespaceConfig,
  Registry,
  type RuntimeStats,
  runSweep,
  ShapeRecorder,
  setCursorSealSecret,
  TaskScheduler
} from '@mnmal-ai/substrate-core';
import { MemoryDataset, MemoryDatasetRegistry } from '@mnmal-ai/substrate-dataset-memory';
import type {
  BridgeClient,
  BridgeRegistry,
  CoordinatorPlugin,
  Dataset,
  EdgesStore,
  HttpHandler,
  IdempotencyStore,
  KernelPlugin,
  Registry as RegistryInterface,
  StorageReport,
  SubstrateServer,
  SweepDeps,
  SweepState
} from '@mnmal-ai/substrate-types';
import { installSystemNamespace, type KeyRegistry, SYSTEM_NAMESPACE } from './_system/index.js';
import type { RateLimiter } from './_system/rate-limit.js';
import { runAdvisorPass } from './advisor/advisor.js';
import type { StoreProfileName } from './advisor/profiles.js';
import type { AuthConfig } from './auth.js';
import { type Capability, withAuth, withSystemActor } from './compose/auth-middleware.js';
import { resolveBootGuards } from './compose/guards.js';
import { registerCoreRoutes } from './compose/routes.js';
import { installVirtualNamespaces } from './compose/virtual-namespaces.js';
import { createProcessSampler } from './process-sampler.js';
import type { ConfigReport } from './routes/config-echo.js';

export const DEFAULT_NAMESPACE = 'default';

const DEFAULT_PAGE_LIMITS = { defaultLimit: 100, maxLimit: 1000 };

export interface ComposeOpts {
  server: SubstrateServer;
  dataset: Dataset;
  /**
   * Who this deployment writes AS when auth is disabled. Required in that case
   * and refused at boot when absent.
   *
   * With no auth there is no bearer, so nothing identifies a caller; an
   * unauthenticated deployment declares its actor rather than getting a silent
   * default.
   *
   * Ignored when `auth` is set — a real caller's identity is better than a
   * deployment-level stand-in, and using one would mask an auth misconfig.
   */
  systemActor?: string;
  /**
   * EdgesStore instance. Omit to use an in-process `MemoryEdgesStore`. Pg-backed
   * binaries pass a `PgEdgesStore` so edges persist across restarts and
   * participate in the engine's cross-store transaction nesting (§6.2).
   */
  edges?: EdgesStore;
  /**
   * Coordinator plugins (§5.11). When supplied, each plugin's `install()`
   * contributes its own registry and namespace. Absent → the binary still
   * boots (with `_system` admin routes and `/health`), but the `default`
   * namespace is empty — no user types are served. Tests that need a
   * populated namespace pass a coordinator.
   */
  coordinators?: Array<CoordinatorPlugin>;
  /**
   * Composed substrate plugins (§5.11 substrate tier). When supplied AND
   * coordinators are also supplied, each substrate's `contributePostWrites`
   * (if defined) is invoked per coordinator namespace at install time, so
   * substrate-driven postWrite hooks chain into the engine's per-(ns,type)
   * postWrite flow. When absent, no substrate contributions run — the binary
   * still boots, but no embedding side-effects fire.
   */
  kernelPlugins?: Array<KernelPlugin>;
  /**
   * Per-namespace dataset overrides. When `coordinators` claim namespaces
   * other than `'default'`, map them here; `loadPlugins` consults this map
   * first and falls back to `opts.dataset` when a namespace is not listed.
   * Ignored when `coordinators` is omitted.
   */
  datasets?: Record<string, Dataset>;
  /**
   * Bridge registry (§5.8). When supplied, the engine routes frame entries
   * whose namespace is bridged through the bridge's query/mutate surface, and
   * the sweep `resolveTarget` consults bridges for row lookups. When absent,
   * a no-op stub is used — every namespace is treated as local/reachable.
   */
  bridges?: BridgeRegistry;
  /**
   * JWT auth config (§5.12). When supplied, route handlers for
   * `/substrate/v1/query`, `/substrate/v1/mutate`, and the `/substrate/v1/ws` upgrade require a
   * valid `Authorization: Bearer <token>` header; missing / invalid tokens
   * return 401 with `{ code: 'unauthorized' }`. When absent, every request
   * passes through unauthenticated, attributed to `systemActor`.
   *
   * Open routes (no key needed even with auth enabled): `GET /health`,
   * `GET /substrate/v1/whoami` and `POST /substrate/v1/_system/register`. Schema discovery
   * and `/substrate/v1/onboard` sit behind `read` like `/substrate/v1/query`.
   */
  auth?: AuthConfig;
  /**
   * Override for the `/substrate/v1/_system/register` rate limiter.
   * When absent, the composer allocates a limiter with the
   * default 10-requests-per-60s-per-IP cap. Tests supply a spoofable instance
   * (and control the `now` clock) so they can exercise the 429 path
   * deterministically.
   */
  registerRateLimiter?: RateLimiter;
  /**
   * Binary semver — surfaced by `GET /substrate/v1/onboard` so agents know which
   * binary they're talking to. Defaults to `'0.0.0'` when omitted.
   */
  version?: string;
  /**
   * §5.13 idempotency store. When supplied, the engine dedups mutate frames
   * whose `FrameEntry.idempotencyKey` is present — cached envelopes are
   * replayed byte-identically, transparently to callers. Absent → no dedup; the key is silently ignored. `defaultTtlMs` defaults
   * to 24h per spec.
   */
  idempotency?: {
    store: IdempotencyStore;
    defaultTtlMs?: number;
  };
  /**
   * §5.13 subscription back-pressure override. Threads straight into
   * `EngineOptions.subscriptions`. Default (absent): engine default
   * queueLimit of 256. Conformance tests set a tiny limit to trigger the
   * teardown contract deterministically (docs/ws-subscription-contract.md).
   */
  subscriptions?: {
    queueLimit?: number;
    /** Most rows a subscription snapshot may return; defaults to `pageLimits.maxLimit`. */
    snapshotLimit?: number;
  };
  /**
   * Allowlist of peer IPs whose `x-forwarded-for`
   * header is trusted for `/substrate/v1/_system/register` rate-limit bucketing.
   * Exact IP strings only — no CIDR. An empty set (the default) means XFF is
   * always ignored; the route buckets on `req.peerIp` (or `'unknown'`).
   * Callers that need CIDR should terminate XFF parsing at their reverse
   * proxy.
   */
  trustedProxies?: Set<string>;
  /**
   * Page bounds for remote list reads on `/substrate/v1/query`: a type read
   * with no `limit` gets `defaultLimit`, one above `maxLimit` is refused.
   * Defaults to 100 and 1000. In-process callers are not bounded, except that
   * `maxLimit` also caps every subscription snapshot.
   */
  pageLimits?: { defaultLimit: number; maxLimit: number };
  /**
   * Opt-in periodic re-prime interval (ms) for the
   * `KeyRegistry` public-key cache. Bounds cross-instance revocation
   * staleness: when multiple binaries share one store, a key revoked by one
   * instance is honoured by the others within one tick instead of only after
   * a restart. Only takes effect when auth is enabled (the cache is otherwise
   * never consulted). Omit / non-positive → disabled (the single-instance
   * default; write-through invalidation already keeps one process consistent).
   */
  keyReprimeIntervalMs?: number;
  /**
   * HMAC secret for browser SSE stream tickets. REQUIRED when `auth` is set,
   * and at least `MIN_STREAM_TICKET_SECRET_LEN` characters after trimming —
   * `compose` throws otherwise, because the ungated `GET` stream routes
   * authenticate on this signature alone, the dev default is a published
   * constant, and `''` / `'   '` are HMAC keys Node accepts. Omit it only with
   * auth disabled, where `gate` is the identity function and there is nothing
   * to bypass. Trimmed before use.
   */
  streamTicketSecret?: string;
  /**
   * Effective value + provenance for every defaulted knob, as the caller's
   * env parser resolved them. When present, compose mounts
   * `GET /substrate/v1/config` admin-gated to echo it.
   *
   * Passed in rather than derived here: compose does not read the
   * environment, and the echo must report what the parser resolved, not a
   * second reading of the environment. Omitted by programmatic embedders.
   */
  configReport?: ConfigReport;
  /** Reported beside `configReport`; ignored without it. */
  storageReport?: () => Promise<StorageReport>;
  /**
   * The index advisor. Every `intervalMs` (`SUBSTRATE_ADVISOR_INTERVAL_MS`)
   * it turns the reads the engine recorded and the store's statistics into
   * `_system/IndexRecommendation` rows. Omitted or `intervalMs: 0`: off, and
   * no read is recorded. `storeProfile` seeds `_system/StoreProfile` when it
   * has no row yet.
   */
  advisor?: { intervalMs: number; storeProfile?: StoreProfileName; writeHeavy?: boolean };
}

export interface ComposeResult {
  engine: Engine;
  /**
   * The primed `KeyRegistry` this composition built, or `null` when auth
   * is off.
   *
   * Routes mounted outside compose (e.g. substrate kernel routes) must put
   * this registry in their `AuthConfig`: `opts.auth` alone has none, so
   * agent-key bearers would fail to verify there.
   */
  keyRegistry: KeyRegistry | null;
  registry: RegistryInterface;
  datasets: MemoryDatasetRegistry;
  edges: EdgesStore;
  sweepDeps: SweepDeps;
  /**
   * Run one sweep cycle from a null cursor. Exposed for tests that need to
   * drive the reconciler deterministically — production uses the `setInterval`
   * loop in `main.ts`.
   */
  runSweepNow: () => Promise<SweepState>;
  /** Run one index-advisor pass now, for tests; null while the advisor is off. */
  runAdvisorNow: (() => Promise<{ upserted: number }>) | null;
  /**
   * Non-null when any coordinator plugin contributed a `schedule`. The
   * composition root constructs the scheduler, registers every plugin's
   * tasks, and returns it unstarted. `main.ts` calls `scheduler.start()`
   * after the server's `start()` resolves; `stop()` below awaits its teardown.
   */
  scheduler: TaskScheduler | null;
  /** Live runtime-stats counter. Read via `stats.snapshot()` or via `GET /substrate/v1/metrics`. */
  stats: RuntimeStats;
  stop: (opts?: { grace?: number; abortInFlight?: boolean }) => Promise<void>;
}

// No-op `BridgeRegistry` — every surface returns false/undefined/[]. Used
// when the caller omits `opts.bridges`; every namespace routes locally. §5.8.
const NO_BRIDGES: BridgeRegistry = {
  has: (): boolean => false,
  get: (): BridgeClient | undefined => undefined,
  isUnreachable: (): boolean => false,
  entries: (): Array<[string, BridgeClient]> => []
};

export async function compose(opts: ComposeOpts): Promise<ComposeResult> {
  // The sampler owns a timer and an event-loop monitor; if wiring throws after
  // it exists, nothing else would ever stop it.
  const cleanup = { stopSampler: (): void => {} };
  try {
    return await composeInner(opts, cleanup);
  } catch (err) {
    cleanup.stopSampler();
    throw err;
  }
}

async function composeInner(
  opts: ComposeOpts,
  cleanup: { stopSampler: () => void }
): Promise<ComposeResult> {
  // Fail-closed: throw before anything is allocated on a misconfigured deployment.
  const { streamTicketSecret, systemIdentity } = resolveBootGuards(opts);
  if (streamTicketSecret !== undefined && streamTicketSecret.length > 0) {
    setCursorSealSecret(streamTicketSecret);
  }

  const edges: EdgesStore = opts.edges ?? new MemoryEdgesStore({ now: () => new Date() });
  // Resolved before the dataset registry so its factory can gate on them.
  // Bridged namespaces MUST NOT auto-allocate a local dataset: sweep's
  // `resolveTarget` relies on `datasets.get(bridgedNs)` returning undefined to
  // fall through to the bridge.
  const bridges: BridgeRegistry = opts.bridges ?? NO_BRIDGES;

  // Factory fallback: a get-miss for a namespace hot-added at runtime
  // (engine.addNamespace) auto-allocates a sibling dataset off the substrate
  // root, so `engine.datasetFor` resolves for it. Pre-set datasets
  // (opts.datasets overrides, statically loaded plugins) take precedence.
  // Bridged namespaces are gated out (see above).
  const datasets = new MemoryDatasetRegistry({
    factory: (ns): Dataset | undefined => {
      if (bridges.has(ns)) return undefined;
      return opts.dataset.forNamespace(ns);
    }
  });

  let primaryRegistry: RegistryInterface;
  let namespaces: Map<string, NamespaceConfig>;
  let runCoordinatorOnStart: ((engine: Engine) => Promise<void>) | null = null;
  let runCoordinatorOnStop: ((engine: Engine) => Promise<void>) | null = null;
  let coordinatorPlugins: Array<CoordinatorPlugin> = [];
  let scheduleEntries: Array<{
    pluginName: string;
    tasks: Parameters<TaskScheduler['register']>[1];
  }> = [];

  // Silent in tests. One sink shared by plugin lifecycle hooks, routes and
  // installSystemNamespace — otherwise ctx.metric calls from a plugin's onStart land on
  // loadPlugins' no-op fallback.
  const isTest = process.env.NODE_ENV === 'test';
  const routeMetric = (name: string, payload?: unknown): void => {
    if (isTest) return;
    process.stdout.write(`plugin.${name} ${JSON.stringify(payload ?? null)}\n`);
  };

  if (opts.coordinators !== undefined) {
    const overrides = opts.datasets ?? {};
    const loadPluginsOpts: Parameters<typeof loadPlugins>[0] = {
      plugins: opts.coordinators,
      edges,
      metric: routeMetric,
      datasetFor: (ns): Dataset | undefined => {
        const override = overrides[ns];
        if (override !== undefined) return override;
        if (ns === DEFAULT_NAMESPACE) return opts.dataset;
        // Auto-allocate a sibling dataset bound to the same substrate.
        // pg: shared sql + edgesStore (same txScopeId). memory: fresh
        // backing per namespace (new txScopeId). Operators that need
        // namespace-specific overrides (multi-pg, custom backings) supply
        // them via `opts.datasets`.
        return opts.dataset.forNamespace(ns);
      }
    };
    if (opts.kernelPlugins !== undefined) {
      loadPluginsOpts.kernelPlugins = opts.kernelPlugins;
    }
    const loaded = await loadPlugins(loadPluginsOpts);

    namespaces = loaded.namespaces;
    for (const [ns, dataset] of loaded.datasets) {
      datasets.set(ns, dataset);
    }

    const defaultCfg = loaded.namespaces.get(DEFAULT_NAMESPACE);
    primaryRegistry = defaultCfg?.registry ?? new Registry();
    runCoordinatorOnStart = loaded.runOnStart;
    runCoordinatorOnStop = loaded.runOnStop;
    coordinatorPlugins = loaded.plugins;
    scheduleEntries = loaded.schedule;
  } else {
    // No coordinators → empty default namespace. The binary boots with
    // `_system` admin routes and `/health`, but serves no user types until a
    // coordinator is loaded (via SUBSTRATE_PLUGIN_DIR in the apps/substrate binary,
    // or passed in directly to compose() by embed harnesses). Callers that
    // want a populated namespace for testing pass a coordinator.
    primaryRegistry = new Registry();
    datasets.set(DEFAULT_NAMESPACE, opts.dataset);
    namespaces = new Map<string, NamespaceConfig>([
      [DEFAULT_NAMESPACE, { registry: primaryRegistry }]
    ]);
  }

  installVirtualNamespaces(namespaces, opts.kernelPlugins, routeMetric);

  const sweepDeps: SweepDeps = {
    datasets,
    bridges,
    edges,
    now: (): Date => new Date(),
    metric: (name, payload): void => {
      if (isTest) return;
      process.stdout.write(`sweep.${name} ${JSON.stringify(payload ?? null)}\n`);
    }
  };

  // The `_system` namespace is ALWAYS mounted. It holds the
  // binary's admin-gated `Key` / `Invite` types. The dataset is
  // `opts.datasets['_system']` when present (a pg deployment wires one there),
  // otherwise a fresh `MemoryDataset`.
  const substrateOverride = opts.datasets?.[SYSTEM_NAMESPACE];
  const substrateDataset: Dataset =
    substrateOverride ?? new MemoryDataset({ namespace: SYSTEM_NAMESPACE });
  const substrateRegistry = new Registry();
  const installSubstrateOpts: Parameters<typeof installSystemNamespace>[0] = {
    registry: substrateRegistry,
    dataset: substrateDataset,
    edges
  };
  // Thread the binary's admin-capability claim name through to the `_system`
  // admin gate. Default (`'admin'`) applies when auth is disabled or the
  // deployment didn't override it.
  if (opts.auth?.adminCapability !== undefined) {
    installSubstrateOpts.adminCapability = opts.auth.adminCapability;
  }
  // Periodic re-prime only matters when the cache is actually consulted, i.e.
  // when auth is enabled (see the priming gate below). Gate it here so a
  // no-auth deployment never spins a pointless table-read timer.
  if (opts.auth !== undefined && opts.keyReprimeIntervalMs !== undefined) {
    installSubstrateOpts.reprimeIntervalMs = opts.keyReprimeIntervalMs;
  }
  if (opts.advisor?.storeProfile !== undefined) {
    installSubstrateOpts.storeProfile = opts.advisor.storeProfile;
  }
  const { keyRegistry: substrateKeyRegistry } = await installSystemNamespace(installSubstrateOpts);
  datasets.set(SYSTEM_NAMESPACE, substrateDataset);
  namespaces.set(SYSTEM_NAMESPACE, { registry: substrateRegistry });

  // A crossRef declaring onMissing:'reject' requires its target namespace to
  // be locally resolvable; write-time existence checks against bridged/remote
  // targets are unsupported, so fail at boot rather than at write time.
  // Use `has()`, not `get()`: `get()` auto-allocates via the factory above.
  // By now every local dataset has been `set()`, so `has()` is false only for
  // bridged/unknown/virtual targets.
  for (const [ns, cfg] of namespaces) {
    for (const [typeName, entry] of cfg.registry.all()) {
      if (entry.kind !== 'type') continue;
      for (const [fieldName, def] of Object.entries(entry.fields)) {
        if (def.kind !== 'crossRef' || def.onMissing !== 'reject') continue;
        if (!datasets.has(def.ns)) {
          throw new Error(
            `onmissing_reject_requires_local_target: ${ns}/${typeName}.${fieldName} ` +
              `declares onMissing:'reject' but its target namespace '${def.ns}' has no ` +
              `local dataset (bridged/unknown targets are unsupported in v1)`
          );
        }
      }
    }
  }

  // Runtime-metrics counter. Created before the engine so
  // engineOpts.metric can fan into it; the subscription gauge is late-bound
  // because `engine` is constructed just below.
  let engineForStats: Engine | undefined;
  const sampler = createProcessSampler();
  cleanup.stopSampler = () => sampler.stop();
  let inFlight = 0;
  const stats: RuntimeStats = createRuntimeStats({
    processStats: () => ({ ...sampler.sample(), inFlight: Math.max(0, inFlight) }),
    activeSubscriptions: () => engineForStats?.activeSubscriptionCount() ?? 0,
    subscriptionStats: () =>
      engineForStats?.subscriptionStats() ?? { count: 0, maxQueueDepth: 0, entries: [] }
  });

  /**
   * Route-layer observability sink. Transports answer opaque errors on the
   * wire (e.g. `stream_start_failed`), so this is where an operator sees the
   * failure. Also feeds `stats`, so events show on `GET /substrate/v1/metrics`.
   */
  const routeEventMetric = (name: string, payload?: unknown): void => {
    stats.recordEvent(name);
    if (!isTest) {
      process.stdout.write(`route.${name} ${JSON.stringify(payload ?? null)}\n`);
    }
  };

  const engineOpts: ConstructorParameters<typeof Engine>[0] = {
    namespaces,
    datasets,
    edges,
    sweepHooks: { bridges },
    onResolve: (o) => stats.recordResolve(o),
    metric: (name, payload): void => {
      stats.recordEvent(name);
      if (!isTest) {
        process.stdout.write(`engine.${name} ${JSON.stringify(payload ?? null)}\n`);
      }
    }
  };
  opts.server.observeInFlight?.((_op, d) => {
    inFlight += d;
  });
  if (opts.idempotency !== undefined) {
    const idempotencyOpt: { store: IdempotencyStore; defaultTtlMs?: number } = {
      store: opts.idempotency.store
    };
    if (opts.idempotency.defaultTtlMs !== undefined) {
      idempotencyOpt.defaultTtlMs = opts.idempotency.defaultTtlMs;
    }
    engineOpts.idempotency = idempotencyOpt;
  }
  // A remote subscriber's snapshot is bounded like a remote list read.
  engineOpts.subscriptions = {
    ...opts.subscriptions,
    snapshotLimit:
      opts.subscriptions?.snapshotLimit ?? (opts.pageLimits ?? DEFAULT_PAGE_LIMITS).maxLimit
  };
  const advisorIntervalMs = opts.advisor?.intervalMs ?? 0;
  const shapeRecorder = advisorIntervalMs > 0 ? new ShapeRecorder() : undefined;
  if (shapeRecorder !== undefined) engineOpts.shapeRecorder = shapeRecorder;
  const engine = new Engine(engineOpts);
  engineForStats = engine;

  // When auth is enabled, prime the
  // `KeyRegistry` from the dataset and inject it into the AuthConfig
  // BEFORE any route handler is registered. Primed cache + live registry is
  // the security invariant — a request arriving before priming finished
  // would see an empty registry and silently fail-open via the file path.
  // Derived-config so we don't mutate the caller's `AuthConfig`.
  let auth: AuthConfig | undefined;
  if (opts.auth !== undefined) {
    await substrateKeyRegistry.primeFromDataset();
    auth = { ...opts.auth, keyRegistry: substrateKeyRegistry };
  }

  // Anonymous reads are reported, not refused: the set of anonymous consumers
  // is not yet known, and refusing blind would break them silently.
  const anonymousReadSink = (info: {
    method: string;
    path: string;
    peerIp: string | undefined;
    userAgent: string | undefined;
    frameKeys: string[] | undefined;
  }): void => {
    routeEventMetric('anonymous_read', info);
  };

  // §5.12 route-capability gate. With auth, gated routes enforce both
  // authentication and the required capability; without auth, every gated
  // route runs as the declared system actor.
  const gate = (handler: HttpHandler, required: Capability | null): HttpHandler =>
    auth === undefined
      ? withSystemActor(handler, systemIdentity)
      : withAuth(handler, auth, required, anonymousReadSink);

  // §5.12 trust model: one `trustedProxies` set threads through every route
  // factory that consults peerIp — `buildContext` + `/register`'s rate-limiter
  // bucket + the WS upgrade's clientIp snapshot all read from this set. An
  // empty set means XFF is never honoured; the default when callers don't opt
  // into proxy-awareness.
  const trustedProxies = opts.trustedProxies ?? new Set<string>();

  // Spec §5.11 fire order: core /substrate/v1/* routes → plugin routes.
  const { rateLimiter, ownsRateLimiter } = await registerCoreRoutes({
    server: opts.server,
    engine,
    gate,
    trustedProxies,
    pageLimits: opts.pageLimits ?? DEFAULT_PAGE_LIMITS,
    auth,
    streamTicketSecret,
    version: opts.version,
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
    ...(opts.registerRateLimiter !== undefined
      ? { registerRateLimiter: opts.registerRateLimiter }
      : {}),
    ...(opts.auth?.identityDirectory !== undefined
      ? { identityDirectory: opts.auth.identityDirectory }
      : {}),
    ...(opts.auth?.adminCapability !== undefined
      ? { adminCapability: opts.auth.adminCapability }
      : {}),
    ...(opts.configReport !== undefined ? { configReport: opts.configReport } : {}),
    ...(opts.storageReport !== undefined ? { storageReport: opts.storageReport } : {})
  });

  let scheduler: TaskScheduler | null = null;
  if (scheduleEntries.length > 0) {
    scheduler = new TaskScheduler({ engine, metric: routeMetric });
    for (const entry of scheduleEntries) {
      scheduler.register(entry.pluginName, entry.tasks);
    }
  }

  if (opts.bridges !== undefined) {
    await engine.refreshBridgeSchemas();
  }

  if (runCoordinatorOnStart !== null) {
    await runCoordinatorOnStart(engine);
  }

  // One pass at a time; a pass still running when the next is due is skipped.
  let advisorPass: Promise<void> | null = null;
  let advisorTimer: ReturnType<typeof setInterval> | undefined;
  let runAdvisorNow: ComposeResult['runAdvisorNow'] = null;
  if (shapeRecorder !== undefined) {
    const deps = {
      dataset: opts.dataset,
      system: substrateDataset,
      recorder: shapeRecorder,
      registry: (ns: string) => namespaces.get(ns)?.registry,
      now: Date.now,
      writeHeavy: opts.advisor?.writeHeavy === true
    };
    const pass = (): Promise<{ upserted: number }> => runAdvisorPass(deps);
    runAdvisorNow = pass;
    advisorTimer = setInterval(() => {
      if (advisorPass !== null) return;
      advisorPass = pass()
        .then(() => undefined)
        .catch((err: unknown) => {
          process.stderr.write(
            `[substrate] index advisor pass failed and will run again: ${err instanceof Error ? err.message : String(err)}\n`
          );
        })
        .finally(() => {
          advisorPass = null;
        });
    }, advisorIntervalMs);
    advisorTimer.unref?.();
  }

  return {
    engine,
    // null when auth is off — the caller must not be able to tell "no registry
    // yet" from "auth disabled" by looking at a maybe-undefined field.
    keyRegistry: opts.auth === undefined ? null : substrateKeyRegistry,
    registry: primaryRegistry,
    datasets,
    edges,
    sweepDeps,
    runSweepNow: (): Promise<SweepState> => runSweep(sweepDeps, { lastSweptCursor: null }),
    runAdvisorNow,
    scheduler,
    stats,
    stop: async (stopOpts?: { grace?: number; abortInFlight?: boolean }): Promise<void> => {
      sampler.stop();
      clearInterval(advisorTimer);
      await advisorPass;
      if (scheduler !== null) await scheduler.stop();
      // Plugin onStop hooks run BEFORE server.stop() — the engine is still
      // alive so plugins can do final writes (e.g. an audit row recording
      // the shutdown), and HTTP requests are still being served if a
      // teardown happens to need them. Order is reverse-registration.
      if (runCoordinatorOnStop !== null) {
        await runCoordinatorOnStop(engine);
      }
      if (ownsRateLimiter) rateLimiter.dispose();
      // Stop the key-registry re-prime timer (no-op when disabled).
      substrateKeyRegistry.dispose();
      await opts.server.stop(stopOpts);
    }
  };
}

/**
 * Auth middleware, shared by in-compose routes and substrate kernel routes.
 */
export {
  type Capability,
  withAuth,
  withSystemActor,
  wrapWsHandler
} from './compose/auth-middleware.js';

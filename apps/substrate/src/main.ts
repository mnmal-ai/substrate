/**
 * @mnmal-ai/substrate — §5.12 binary entry point.
 *
 * Wires SubstrateServer + Dataset + EdgesStore + optional coordinator plugins
 * + optional bridges + optional JWT auth into a running process. The entry
 * surface is env-var driven:
 *
 *   SUBSTRATE_DATABASE_URL              memory | postgres://...       (default: memory)
 *   SUBSTRATE_PLUGIN_DIR         abs path to plugin install root (optional). The
 *                            manifest-driven loader scans
 *                            <dir>/node_modules/{*,@*\/*} for packages
 *                            declaring a `substrate` manifest, merges each
 *                            plugin's default-config.json with the colocated
 *                            operator override at <dir>/<basename>.config.json,
 *                            and bootstraps substrate plugins (alphabetical)
 *                            before coordinators (alphabetical). Unset = no
 *                            plugins; binary boots with `_system` admin
 *                            namespace + /health only.
 *   SUBSTRATE_BRIDGES            JSON array of { ns, name, url } bridge defs (optional)
 *   SUBSTRATE_BRIDGE_CREDENTIALS       JSON map bridgeName -> { keyPath, kid, origin }.
 *                            REQUIRED for every entry in SUBSTRATE_BRIDGES — a
 *                            bridge without one refuses to boot rather than
 *                            connecting unauthenticated.
 *   SUBSTRATE_SENTINEL_CREDENTIAL      JSON { keyPath, kid } the sentinel-client signs its
 *                            WS upgrade with. REQUIRED whenever
 *                            SUBSTRATE_SENTINEL_URL is set.
 *   SUBSTRATE_AUTH_KEY_REGISTRY  path to JSON key file (optional — auth opt-in)
 *   SUBSTRATE_ADMIN_CAPABILITY   JWT claim value granting admin (optional)
 *   SUBSTRATE_JWT_LEEWAY_SECONDS clock-skew tolerance for JWT exp/nbf (optional;
 *                            default 0 = strict). 30 absorbs typical NTP drift.
 *   SUBSTRATE_KEY_REFRESH_INTERVAL_MS  periodic full re-prime of the public-key
 *                            cache in ms (default 30000; `off` disables). Bounds
 *                            revocation staleness. Auth-gated.
 *   SUBSTRATE_TLS_KEY_PATH       path to TLS private key PEM (optional — TLS opt-in)
 *   SUBSTRATE_TLS_CERT_PATH      path to TLS certificate PEM (optional — TLS opt-in)
 *   SUBSTRATE_TLS_CA_PATH        path to CA chain PEM (optional)
 *   SUBSTRATE_BODY_LIMIT_BYTES         max request body size in bytes (optional). Unset =
 *                            Fastify's 1 MiB default. Raise for bulk batched
 *                            mutation frames that exceed 1 MiB.
 *   SUBSTRATE_SWEEP_INTERVAL_MS  sweep cadence in ms (default 300000)
 *   SUBSTRATE_INVITE_SWEEP_INTERVAL_MS  invite reaper cadence in ms (default 3600000 = 1h)
 *   SUBSTRATE_TOMBSTONE_RETENTION_DAYS  retention window for tombstoned rows /
 *                            edges before they're hard-deleted by the
 *                            sweep loop. Default 30. Pg-backed only — memory
 *                            mode tombstones vanish on restart anyway.
 *   SUBSTRATE_IDEMPOTENCY_TTL_MS override §5.13 dedup TTL (default: engine 24h)
 *   SUBSTRATE_IDEMPOTENCY_DISABLED  truthy (1/true) disables mutation dedup
 *   SUBSTRATE_TRUSTED_PROXIES    CSV of exact peer-IP strings whose x-forwarded-for
 *                            header is honoured by `/substrate/v1/_system/register`.
 *                            Exact IP strings only — no CIDR. Callers needing
 *                            CIDR should terminate XFF parsing at their reverse
 *                            proxy. See §13 for the scope limit.
 *   SUBSTRATE_CORS_ORIGINS       comma-separated list of allowed CORS origins for
 *                            browser clients, or '*' to allow any origin.
 *                            Unset (default) = no CORS plugin registered —
 *                            agent-only deployments don't need it.
 *                            Example: SUBSTRATE_CORS_ORIGINS=https://app.example.com
 *                            Example: SUBSTRATE_CORS_ORIGINS=* (allow any origin;
 *                              pairs with credentials:false — anonymous only)
 *   PORT / HOST              listen args (default 3100; 0.0.0.0 with auth, 127.0.0.1 without)
 *
 * Env parsing is the pure `parseEnv(env)`; `runServe()` sequences the I/O.
 */

import { validateHardDeleteEnv } from '@mnmal-ai/substrate-core';
import { startBackground } from './serve/background.js';
import { reportBoot } from './serve/boot-report.js';
import { bootStore } from './serve/boot-store.js';
import {
  BINARY_CONTRACT_VERSION,
  type BridgeSpec,
  DEFAULT_KEY_REPRIME_INTERVAL_MS,
  EnvConfigError,
  type ParsedConfig,
  parseBridgeCreds,
  parseBridges,
  parseEnv,
  refuseContractViolation
} from './serve/config.js';
import { resolvePluginDir } from './serve/plugins.js';
import { installShutdown } from './serve/shutdown.js';
import {
  buildBridgeRegistry,
  buildPluginDatasetMap,
  extractIndexedListFields,
  makeFieldDefLookupFactory,
  redactStoreSpec,
  reportUnguardedIndexBuilds,
  runDeferredIndexBuilds
} from './serve/wiring.js';

/** Re-exported: tests import the serve surface from main.js. */
export { listeningBanner, memoryStoreBanner, noPluginsBanner } from './serve/banners.js';
/** Re-exported: tests import the serve surface from main.js. */
export {
  BINARY_CONTRACT_VERSION,
  type BridgeSpec,
  buildBridgeRegistry,
  buildPluginDatasetMap,
  DEFAULT_KEY_REPRIME_INTERVAL_MS,
  EnvConfigError,
  extractIndexedListFields,
  makeFieldDefLookupFactory,
  type ParsedConfig,
  parseBridgeCreds,
  parseBridges,
  parseEnv,
  redactStoreSpec,
  refuseContractViolation
};

/**
 * Boot the Substrate HTTP/WS server. Reads env, wires substrate + coordinators,
 * starts Fastify, registers signal handlers for graceful shutdown. Invoked
 * through the `substrate serve` subcommand.
 */
export async function runServe(): Promise<void> {
  // Fail loud at startup on an invalid SUBSTRATE_HARD_DELETE value so the binary
  // never boots with ambiguous destructive-op behaviour.
  validateHardDeleteEnv();
  const config = parseEnv(process.env);

  const pluginDir = resolvePluginDir();
  const {
    engine,
    datasets: composedDatasets,
    sql: storeSql,
    server,
    dataset,
    edges,
    substrateNamespaceDataset,
    closeStore,
    kernel,
    coordinators,
    recallStore,
    lexicalStore,
    idempotencyStore,
    sentinelClientConfig,
    bridgeRegistry,
    disposeBridges,
    sweepDeps,
    scheduler,
    stop
  } = await bootStore({ config, pluginDir });

  if (config.indexDiskPath === null) await reportUnguardedIndexBuilds(engine, composedDatasets);

  const info = await server.start({ host: config.host, port: config.port });
  const indexBuilds = new AbortController();
  const deferredIndexes = runDeferredIndexBuilds(
    engine,
    composedDatasets,
    config.indexRetryIntervalMs,
    indexBuilds.signal
  );
  if (scheduler !== null) scheduler.start();
  reportBoot({
    config,
    info,
    storeSql,
    substrateNamespaceDataset,
    coordinators,
    kernel,
    pluginDir
  });

  const { sweepTimer, inviteSweepTimer, sentinelClient } = startBackground({
    config,
    sweepDeps,
    idempotencyStore,
    dataset,
    edges,
    storeSql,
    stores: { recallStore, lexicalStore },
    composedDatasets,
    sentinelClientConfig,
    bridgeRegistry,
    engine
  });

  installShutdown({
    config,
    sweepTimer,
    inviteSweepTimer,
    sentinelClient,
    disposeBridges,
    stop,
    closeStore,
    stopIndexBuilds: () => {
      indexBuilds.abort();
      return deferredIndexes;
    }
  });
}

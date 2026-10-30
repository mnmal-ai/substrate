/**
 * serve/compose-opts.ts — `compose()` options assembly.
 *
 * Pure assembly over already-built pieces: datasets, bridges, auth, ticket
 * secret, idempotency. No I/O except the sentinel-client env read; the
 * substrate-migrations table ensure runs here too so it lands before any
 * substrate plugin migration.
 */

import { statfs as fsStatfs } from 'node:fs/promises';
import { type ComposeOpts, SYSTEM_NAMESPACE } from '@mnmal-ai/substrate-compose';
import type { MemoryBridgeRegistry } from '@mnmal-ai/substrate-core';
import { MemoryIdempotencyStore } from '@mnmal-ai/substrate-core';
import type {
  DiskGuard,
  FieldDefLookup,
  PgEdgesStore,
  TypeDefLookup
} from '@mnmal-ai/substrate-dataset-pg';
import { makeDiskGuard, PgIdempotencyStore } from '@mnmal-ai/substrate-dataset-pg';
import {
  loadConfig as loadSentinelClientConfig,
  type SentinelClientConfig
} from '@mnmal-ai/substrate-sentinel-client';
import type {
  CoordinatorPlugin,
  Dataset,
  EdgesStore,
  IdempotencyStore,
  KernelPlugin,
  SubstrateServer
} from '@mnmal-ai/substrate-types';
import type { Sql } from 'postgres';
import { EnvConfigError, type ParsedConfig, readPackageVersion } from './config.js';
import { buildBridgeRegistry, buildPluginDatasetMap, ensureMigrationsTable } from './wiring.js';

export interface ComposedOpts {
  composeOpts: ComposeOpts;
  /**
   * §5.13 store, returned so the sweep loop can call reapExpired() on the
   * same instance the engine uses. Non-null unless the operator disabled dedup.
   */
  idempotencyStore: IdempotencyStore | null;
  sentinelClientConfig: SentinelClientConfig | null;
  bridgeRegistry: MemoryBridgeRegistry;
  disposeBridges: () => void;
}

/**
 * The free-disk check every pg dataset runs before a background index build,
 * or none when `SUBSTRATE_INDEX_DISK_PATH=off`. A configured path is statted
 * once here, so a typo fails the boot rather than every build.
 */
export async function indexDiskGuard(
  config: Pick<ParsedConfig, 'indexDiskPath' | 'indexDiskMarginMb'>,
  statfs: (p: string) => Promise<unknown> = (p) => fsStatfs(p)
): Promise<DiskGuard | undefined> {
  const path = config.indexDiskPath;
  if (path === 'off') return undefined;
  if (path !== null) {
    try {
      await statfs(path);
    } catch (err) {
      throw new EnvConfigError(
        `SUBSTRATE_INDEX_DISK_PATH: ${path} is not readable: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
  return makeDiskGuard({
    ...(path !== null ? { path } : {}),
    marginBytes: config.indexDiskMarginMb * 1024 * 1024
  });
}

export async function buildComposeOpts(args: {
  config: ParsedConfig;
  server: SubstrateServer;
  dataset: Dataset;
  edges: EdgesStore;
  coordinators: CoordinatorPlugin[];
  storeSql: Sql | null;
  substrateNamespaceDataset: Dataset | null;
  fieldDefLookupFor: (namespace: string) => FieldDefLookup;
  typeDefLookup: TypeDefLookup;
  kernel: KernelPlugin[];
  diskGuard?: DiskGuard | undefined;
}): Promise<ComposedOpts> {
  const {
    config,
    server,
    dataset,
    edges,
    coordinators,
    storeSql,
    substrateNamespaceDataset,
    fieldDefLookupFor,
    typeDefLookup,
    kernel,
    diskGuard
  } = args;

  const composeOpts: ComposeOpts = {
    server,
    dataset,
    edges,
    trustedProxies: config.trustedProxies,
    pageLimits: config.pageLimits,
    subscriptions: { snapshotLimit: config.snapshotLimit },
    // Mounts the admin-gated `GET /substrate/v1/config`.
    configReport: config.knobs,
    walksEnabled: config.walksEnabled,
    advisor: {
      intervalMs: config.advisorIntervalMs,
      ...(config.storeProfile !== null ? { storeProfile: config.storeProfile } : {}),
      writeHeavy: config.storeWriteHeavy
    }
  };
  if (dataset.storageReport !== undefined) {
    const report = dataset.storageReport.bind(dataset);
    composeOpts.storageReport = () => report({ partitionBudget: config.partitionBudget });
  }
  if (coordinators.length > 0) {
    composeOpts.coordinators = coordinators;
    composeOpts.datasets = buildPluginDatasetMap(
      coordinators,
      dataset,
      storeSql,
      storeSql !== null ? (edges as PgEdgesStore) : null,
      fieldDefLookupFor,
      typeDefLookup,
      diskGuard
    );
  }
  // When pg-backed, thread the `_system` namespace dataset into compose so
  // Key / Invite rows persist (§5.12). If a plugin claims `_system`,
  // this wiring wins and the collision is logged.
  if (substrateNamespaceDataset !== null) {
    if (composeOpts.datasets === undefined) composeOpts.datasets = {};
    const existing = composeOpts.datasets[SYSTEM_NAMESPACE];
    if (existing !== undefined) {
      process.stdout.write(
        `warning: coordinator-contributed '${SYSTEM_NAMESPACE}' dataset overridden by main.ts pg wiring\n`
      );
    }
    composeOpts.datasets[SYSTEM_NAMESPACE] = substrateNamespaceDataset;
  }
  // Wire bridgeRegistry into compose when EITHER static bridges are configured
  // OR the sentinel client is enabled. Missing either half defeats sentinel-
  // discovered bridges — the engine would bind to compose's NO_BRIDGES stub
  // instead of the registry the client is about to mutate.
  const { registry: bridgeRegistry, dispose: disposeBridges } = buildBridgeRegistry(
    config.bridges,
    config.bridgeCreds
  );
  // The bridge clients are live from here; a later failure must not leak them.
  try {
    const sentinelClientConfig = loadSentinelClientConfig(process.env);
    if (config.bridges.length > 0 || sentinelClientConfig !== null) {
      composeOpts.bridges = bridgeRegistry;
    }
    if (config.auth !== null) {
      composeOpts.auth = config.auth;
    }
    // Public-key-cache re-prime. compose() gates this on auth being enabled, so
    // passing it through unconditionally is safe.
    if (config.keyReprimeIntervalMs !== null) {
      composeOpts.keyReprimeIntervalMs = config.keyReprimeIntervalMs;
    }
    // compose() refuses to boot an auth-enabled instance without this — the
    // ungated browser stream routes authenticate on the ticket signature alone.
    if (config.systemActor !== null) {
      composeOpts.systemActor = config.systemActor;
    }
    if (config.streamTicketSecret !== null) {
      composeOpts.streamTicketSecret = config.streamTicketSecret;
    }
    // §5.13 mutation idempotency, dedup on unless SUBSTRATE_IDEMPOTENCY_DISABLED.
    // Pg-backed when storeSql is present, memory otherwise.
    let idempotencyStore: IdempotencyStore | null = null;
    if (!config.idempotency.disabled) {
      idempotencyStore =
        storeSql !== null
          ? new PgIdempotencyStore({ sql: storeSql })
          : new MemoryIdempotencyStore();
      const idempotencyOpt: { store: IdempotencyStore; defaultTtlMs?: number } = {
        store: idempotencyStore
      };
      if (config.idempotency.defaultTtlMs !== null) {
        idempotencyOpt.defaultTtlMs = config.idempotency.defaultTtlMs;
      }
      composeOpts.idempotency = idempotencyOpt;
    }

    composeOpts.version = readPackageVersion();
    if (kernel.length > 0) {
      composeOpts.kernelPlugins = kernel;
    }

    // Ensure kernel_migrations tracking table exists before any substrate
    // plugin migration runs. Idempotent (CREATE TABLE IF NOT EXISTS); no-op on memory.
    // Distinct from migrations (dataset-pg framework's own table).
    await ensureMigrationsTable(storeSql);

    return { composeOpts, idempotencyStore, sentinelClientConfig, bridgeRegistry, disposeBridges };
  } catch (err) {
    disposeBridges();
    throw err;
  }
}

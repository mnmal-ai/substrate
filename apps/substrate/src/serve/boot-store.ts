/**
 * serve/boot-store.ts — every step of `substrate serve`'s boot before the
 * server listens: open and migrate the store, load plugins, compose the kernel
 * and coordinators, and reconcile registered storage. `runServe` listens on
 * the result; `substrate-admin migrate-store` prepares a target with it.
 */

import { type ComposeResult, compose, DEFAULT_NAMESPACE } from '@mnmal-ai/substrate-compose';
import type { Engine } from '@mnmal-ai/substrate-core';
import { assertNotMigrating, type StorageLayout } from '@mnmal-ai/substrate-dataset-pg';
import { FastifySubstrateServer } from '@mnmal-ai/substrate-server-fastify';
import type { NamespaceDefinition } from '@mnmal-ai/substrate-types';
import type { Sql } from 'postgres';
import { buildComposeOpts, type ComposedOpts, indexDiskGuard } from './compose-opts.js';
import { BINARY_CONTRACT_VERSION, type ParsedConfig, refuseContractViolation } from './config.js';
import { createLateRefs, populateLateRefs } from './late-refs.js';
import { nlEngineAccess } from './nl-engine.js';
import { composeKernelPhase, loadServePlugins, type ServePlugins } from './plugins.js';
import { buildRecallStores, type RecallStores } from './stores.js';
import {
  makeFieldDefLookupFactory,
  makeTypeDefLookupFactory,
  reconcileRegisteredStorage,
  type StoreWiring,
  wireStore
} from './wiring.js';

export interface BootStoreOptions {
  config: ParsedConfig;
  /** `SUBSTRATE_PLUGIN_DIR`, as `resolvePluginDir()` reads it. */
  pluginDir: string | null;
  /** The layout a store with no `rows` yet is created with; see `runMigrations`. */
  layout?: StorageLayout;
  /** Boot a store that carries the migrate-store marker. Only migrate-store passes it. */
  allowMigrating?: boolean;
  /**
   * False starts no background writers: the index advisor is off and kernel
   * plugins see `background: false`, so recall starts no embed backfill.
   * migrate-store passes false. Default true.
   */
  background?: boolean;
}

export interface BootedStore {
  engine: Engine;
  datasets: ComposeResult['datasets'];
  nsDefs: Map<string, NamespaceDefinition>;
  sql: Sql | null;
  /** Composed, never started. */
  server: FastifySubstrateServer;
  /** Releases what the boot opened: bridges, the composed engine and the store. */
  close: () => Promise<void>;
  // What runServe needs once it listens.
  dataset: StoreWiring['dataset'];
  edges: StoreWiring['edges'];
  substrateNamespaceDataset: StoreWiring['substrateNamespaceDataset'];
  closeStore: StoreWiring['close'];
  kernel: ServePlugins['kernel'];
  coordinators: ServePlugins['coordinators'];
  recallStore: RecallStores['recallStore'];
  lexicalStore: RecallStores['lexicalStore'];
  idempotencyStore: ComposedOpts['idempotencyStore'];
  sentinelClientConfig: ComposedOpts['sentinelClientConfig'];
  bridgeRegistry: ComposedOpts['bridgeRegistry'];
  disposeBridges: ComposedOpts['disposeBridges'];
  sweepDeps: ComposeResult['sweepDeps'];
  scheduler: ComposeResult['scheduler'];
  stop: ComposeResult['stop'];
}

export async function bootStore(opts: BootStoreOptions): Promise<BootedStore> {
  const { pluginDir } = opts;
  const background = opts.background ?? true;
  // advisorIntervalMs 0 composes no advisor: no shape recorder, no timer.
  const config = background ? opts.config : { ...opts.config, advisorIntervalMs: 0 };

  // Namespace-def registry backing the per-namespace FieldDefLookup, populated
  // once plugins load. Without it, pg orderBy/range/cursor on numeric/date
  // body fields compares lexicographically ('10' < '2').
  const nsDefs = new Map<string, NamespaceDefinition>();
  const fieldDefLookupFor = makeFieldDefLookupFactory(nsDefs);

  const diskGuard = await indexDiskGuard(config);
  const refs = createLateRefs(config.auth);
  // Types no definition declares resolve from the engine's registry once it exists.
  const typeDefLookupFor = makeTypeDefLookupFactory(nsDefs, (ns) =>
    refs.engineRef.current?.registryFor(ns)
  );

  const {
    dataset,
    edges,
    substrateNamespaceDataset,
    sql: storeSql,
    close: closeStore
  } = await wireStore(
    config.storeSpec,
    fieldDefLookupFor,
    typeDefLookupFor,
    diskGuard,
    opts.layout
  );

  // Released in reverse order if a later step throws.
  const opened: Array<() => Promise<void> | void> = [];
  if (closeStore !== null) opened.push(closeStore);
  try {
    // The in-memory store has no marker.
    if (storeSql !== null && opts.allowMigrating !== true) await assertNotMigrating(storeSql);

    const { datasetRegistryRef, resolveDataset, engineRef, checkReadPolicy, checkWritePolicy } =
      refs;

    const { recallStore, lexicalStore, clusterStore, rowsMissing } = buildRecallStores(
      storeSql,
      datasetRegistryRef,
      resolveDataset
    );

    const { kernel, coordinators } = await loadServePlugins({
      pluginDir,
      kernelHostDeps: {
        store: recallStore,
        lexicalStore,
        resolveDataset,
        // substrate-recall activation spreading needs an EdgesStore for backward
        // (inbound) edge lookups.
        edges,
        checkReadPolicy,
        checkWritePolicy,
        clusters: clusterStore,
        rowsMissing,
        nlEngine: nlEngineAccess(engineRef, config.trustedProxies, config.pageLimits)
      },
      contractCheck: {
        hostVersion: BINARY_CONTRACT_VERSION,
        onViolation: refuseContractViolation
      },
      nsDefs,
      storeSql
    });
    // Before the store closes: a plugin timer must not outlive the pool it writes through.
    const stopKernel = async () => {
      for (const plugin of kernel) await plugin.onKernelStop?.();
    };
    opened.push(stopKernel);

    // TLS must be supplied at FastifySubstrateServer construction — Fastify requires
    // the https options when the instance is created, not at listen().
    const server = new FastifySubstrateServer({
      logger: false,
      onWarn: (message) => process.stderr.write(`${message}\n`),
      ...(config.tls !== null ? { tls: config.tls } : {}),
      ...(config.cors !== null ? { cors: config.cors } : {}),
      ...(config.bodyLimit !== null ? { bodyLimit: config.bodyLimit } : {})
    });

    const { composeOpts, idempotencyStore, sentinelClientConfig, bridgeRegistry, disposeBridges } =
      await buildComposeOpts({
        config,
        server,
        dataset,
        edges,
        coordinators,
        storeSql,
        substrateNamespaceDataset,
        fieldDefLookupFor,
        typeDefLookup: typeDefLookupFor(DEFAULT_NAMESPACE),
        kernel,
        diskGuard
      });
    opened.push(disposeBridges);

    await composeKernelPhase({
      kernel,
      server,
      storeSql,
      coordinators,
      kernelAuth: refs.kernelAuth,
      trustedProxies: config.trustedProxies,
      datasetFor: (ns) => composeOpts.datasets?.[ns],
      nsDefs,
      background
    });

    const {
      engine,
      keyRegistry,
      sweepDeps,
      scheduler,
      datasets: composedDatasets,
      stop
    } = await compose(composeOpts);
    opened.push(() => stop());

    // Late-bound holders populate from the composed engine.
    populateLateRefs(refs, composedDatasets, engine, keyRegistry);

    // Types compose registered (`_system`, install-time, replayed proposals),
    // after the engine ref is set so their fields resolve from its registry.
    await reconcileRegisteredStorage(engine, composedDatasets, nsDefs);

    return {
      engine,
      datasets: composedDatasets,
      nsDefs,
      sql: storeSql,
      server,
      close: () => release(opened),
      dataset,
      edges,
      substrateNamespaceDataset,
      // serve's shutdown closes the store directly, so stop the kernel plugins first there too.
      closeStore:
        closeStore === null
          ? null
          : async () => {
              try {
                await stopKernel();
              } finally {
                await closeStore();
              }
            },
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
    };
  } catch (err) {
    await release(opened).catch(() => undefined);
    throw err;
  }
}

/** Runs each release step, last opened first, then throws the first failure. */
async function release(opened: Array<() => Promise<void> | void>): Promise<void> {
  let failure: unknown;
  for (const step of [...opened].reverse()) {
    try {
      await step();
    } catch (err) {
      failure ??= err;
    }
  }
  if (failure !== undefined) throw failure;
}

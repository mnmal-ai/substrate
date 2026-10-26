/**
 * serve/plugins.ts — plugin discovery + namespace-def registration.
 *
 * When `SUBSTRATE_PLUGIN_DIR` is set, plugins
 * load via the manifest-driven loader (`<dir>/node_modules/<pkg>/`, operator
 * overrides at `<dir>/<basename>.config.json`). Unset = no plugins (binary
 * boots with just the `_system` admin namespace; useful for local dev).
 *
 * Substrate plugins receive a typed bag of host-built deps (store, ...);
 * coordinator plugins receive operator config only. Cross-plugin wiring uses
 * the substrate-driven postWrite registry — the binary does not post-attach
 * code-shaped deps to coordinators.
 */

import type { AuthConfig, ContractCheck } from '@mnmal-ai/substrate-compose';
import { deriveListIndexMigration, runDerivedMigrations } from '@mnmal-ai/substrate-dataset-pg';
import type {
  CoordinatorPlugin,
  Dataset,
  KernelPlugin,
  NamespaceDefinition,
  SubstrateServer
} from '@mnmal-ai/substrate-types';
import type { Sql } from 'postgres';
import { composeKernelPlugins, mountKernelRoute } from '../_kernel.js';
import { type KernelHostDeps, loadPluginsFromDir } from '../plugin-dir-loader.js';
import {
  extractIndexedListFields,
  filterRegistry,
  getAppliedMigrationIds,
  pendingMcpTools,
  reconcileDeclaredStorage,
  recordMigrationApplied
} from './wiring.js';

export interface ServePlugins {
  kernel: KernelPlugin[];
  coordinators: CoordinatorPlugin[];
}

export function resolvePluginDir(): string | null {
  const pluginDirRaw = process.env.SUBSTRATE_PLUGIN_DIR?.trim();
  return pluginDirRaw !== undefined && pluginDirRaw.length > 0 ? pluginDirRaw : null;
}

export async function loadServePlugins(opts: {
  pluginDir: string | null;
  kernelHostDeps: KernelHostDeps;
  contractCheck: ContractCheck;
  nsDefs: Map<string, NamespaceDefinition>;
  storeSql: Sql | null;
}): Promise<ServePlugins> {
  let kernel: KernelPlugin[] = [];
  let coordinators: CoordinatorPlugin[] = [];

  if (opts.pluginDir !== null) {
    const result = await loadPluginsFromDir({
      pluginDir: opts.pluginDir,
      kernelHostDeps: opts.kernelHostDeps,
      contractCheck: opts.contractCheck
    });
    kernel = result.kernel;
    coordinators = [...result.coordinators];
  }

  // Register loaded coordinator namespace defs so the per-namespace
  // FieldDefLookup (closed over `nsDefs`) resolves declared field types.
  // First writer wins on a namespace collision, mirroring
  // buildPluginDatasetMap.
  for (const plugin of coordinators) {
    for (const nsDef of plugin.namespaces) {
      if (!opts.nsDefs.has(nsDef.namespace)) opts.nsDefs.set(nsDef.namespace, nsDef);
    }
  }

  // Auto-derive a GIN migration for every indexed list / json field so the
  // `indexed` flag can't drift from the physical index. Runs AFTER plugins
  // load, since field defs are only known then. Pg only.
  if (opts.storeSql !== null) {
    const indexedListFields = extractIndexedListFields(opts.nsDefs);
    if (indexedListFields.length > 0) {
      await runDerivedMigrations(opts.storeSql, indexedListFields.map(deriveListIndexMigration));
    }
  }

  return { kernel, coordinators };
}

/**
 * Compose substrate-tier plugins BEFORE coordinator compose, wiring each
 * KernelPlugin slot (filterOperators, kernelRoutes, mcpTools, migrations,
 * onKernelReady) into the host's registries. Declared storage is reconciled
 * first, so kernel migrations run against it.
 */
export async function composeKernelPhase(args: {
  kernel: KernelPlugin[];
  server: SubstrateServer;
  storeSql: Sql | null;
  coordinators: CoordinatorPlugin[];
  kernelAuth: AuthConfig | null;
  trustedProxies: Set<string>;
  datasetFor: (ns: string) => Dataset | undefined;
  nsDefs: Map<string, NamespaceDefinition>;
}): Promise<void> {
  const { kernel, server, storeSql, coordinators, kernelAuth, trustedProxies } = args;
  await reconcileDeclaredStorage(args.datasetFor, args.nsDefs);
  await composeKernelPlugins(kernel, {
    sql: storeSql,
    // Coordinators are LOADED above but compose below, so their declared
    // namespaces are known here while the engine has not yet registered them.
    // That is what a substrate reconciler wants: the configured intent, before
    // anything has been installed against it.
    coordinatorNamespaces: coordinators.flatMap((p) => p.namespaces.map((n) => n.namespace)),
    // Attributed form, so a reconciler can tell which coordinator declared
    // each namespace.
    coordinatorNamespacesByPlugin: coordinators.flatMap((p) =>
      p.namespaces.map((n) => ({ plugin: p.name, namespace: n.namespace }))
    ),
    metric: (name, payload) => {
      process.stdout.write(
        `[substrate/metric] ${name} ${payload === undefined ? '' : JSON.stringify(payload)}\n`
      );
    },
    registerKernelRoute: (claim) => {
      mountKernelRoute(server, claim, kernelAuth, trustedProxies);
    },
    registerMcpTool: (tool) => {
      // Recorded, not exposed — see `pendingMcpTools` in `./wiring.js`.
      pendingMcpTools.push(tool);
    },
    registerFilterOperator: (name, op) => {
      filterRegistry.register(name, op);
    },
    getAppliedMigrationIds: (pluginName) => getAppliedMigrationIds(storeSql, pluginName),
    applyMigration: async (pluginName, migrationId) => {
      await recordMigrationApplied(storeSql, pluginName, migrationId);
      process.stdout.write(`[substrate] kernel migration applied: ${pluginName}:${migrationId}\n`);
    }
  });
}

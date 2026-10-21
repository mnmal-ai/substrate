/**
 * Coordinator plugin loader. Spec: §5.11.
 *
 * Accepts a list of `CoordinatorPlugin`s, resolves each namespace to a
 * dataset via a caller-supplied lookup, and invokes every namespace's
 * `install()` against a fresh per-namespace `Registry`. Returns the plumbing
 * the composition root hands to `Engine`:
 *   - `namespaces` — `Map<ns, NamespaceConfig>` keyed by namespace id
 *   - `datasets`   — `Map<ns, Dataset>` for the caller to replay into the
 *                    engine's `DatasetRegistry`
 *   - `runOnStart` — idempotent-on-caller-side hook that fires every plugin's
 *                    `onStart` handler in registration order
 *
 * Fail-fast invariants per §5.11:
 *   - Two plugins claiming the same namespace throw `PluginNamespaceCollision`
 *     (no silent override).
 *   - A namespace without a resolved dataset throws; a plugin cannot claim a
 *     namespace with no substrate.
 */

import { and } from '@mnmal-ai/substrate-policy';
import type {
  CoordinatorPlugin,
  Dataset,
  EdgesStore,
  EngineHandle,
  KernelPlugin,
  NamespaceConfig,
  NamespaceDefinition,
  Policy,
  PostWriteHook,
  ScheduledTask
} from '@mnmal-ai/substrate-types';
import { Registry } from './registry.js';

export class PluginNamespaceCollision extends Error {
  override readonly name = 'PluginNamespaceCollision';
  readonly namespace: string;
  readonly firstPlugin: string;
  readonly secondPlugin: string;

  constructor(namespace: string, firstPlugin: string, secondPlugin: string) {
    super(
      `namespace '${namespace}' is claimed by both plugin '${firstPlugin}' and plugin '${secondPlugin}'`
    );
    this.namespace = namespace;
    this.firstPlugin = firstPlugin;
    this.secondPlugin = secondPlugin;
  }
}

export class MissingPluginDataset extends Error {
  override readonly name = 'MissingPluginDataset';
  readonly namespace: string;
  readonly plugin: string;

  constructor(namespace: string, plugin: string) {
    super(`plugin '${plugin}' claims namespace '${namespace}' but no dataset was resolved for it`);
    this.namespace = namespace;
    this.plugin = plugin;
  }
}

export interface LoadPluginsOptions {
  plugins: CoordinatorPlugin[];
  /** Resolve the dataset to use for a given namespace. Returns undefined if unknown. */
  datasetFor(namespace: string): Dataset | undefined;
  edges: EdgesStore;
  /** Metric sink threaded into every `onStart` hook. No-op when omitted. */
  metric?(name: string, payload?: unknown): void;
  /**
   * Composed substrate plugins. Walked per coordinator namespace at install
   * time — each substrate's `contributePostWrites(nsDef)` is called and
   * merged into the install context's `postWriteContributions` map.
   * Substrates without `contributePostWrites` are skipped.
   */
  kernelPlugins?: KernelPlugin[];
}

export interface LoadedPluginSchedule {
  pluginName: string;
  tasks: ScheduledTask[];
}

export interface LoadedPlugin {
  plugin: CoordinatorPlugin;
}

export interface LoadedPlugins {
  namespaces: Map<string, NamespaceConfig>;
  datasets: Map<string, Dataset>;
  /**
   * Scheduled tasks contributed by plugins. The binary installs these into a
   * `TaskScheduler` and calls `.start()` after the server's `start()` resolves.
   */
  schedule: LoadedPluginSchedule[];
  /**
   * Every plugin in registration order. The composition root uses this to
   * mount plugin-scoped routes — `createPluginRouter({ name: plugin.name })`
   * is invoked per entry when `plugin.routes` is defined.
   */
  plugins: CoordinatorPlugin[];
  /**
   * Run every plugin's `onStart` hook in registration order. Engine is
   * threaded through `PluginLifecycleContext` so plugins that mutate their
   * registry post-construction can invoke `engine.invalidateSchemaCaches(ns)`.
   */
  runOnStart(engine: EngineHandle): Promise<void>;
  /**
   * Run every plugin's `onStop` hook in REVERSE registration order. Errors
   * from one plugin's teardown are logged via the metric sink under
   * `plugin_on_stop_error` and do NOT abort other plugins' teardown. The
   * binary's `compose()` `stop()` invokes this before the server stops
   * accepting connections and before the substrate `closeStore()` runs.
   */
  runOnStop(engine: EngineHandle): Promise<void>;
}

export async function loadPlugins(opts: LoadPluginsOptions): Promise<LoadedPlugins> {
  const namespaces = new Map<string, NamespaceConfig>();
  const datasets = new Map<string, Dataset>();
  const claimedBy = new Map<string, string>();
  const metric = opts.metric ?? ((): void => undefined);
  const schedule: LoadedPluginSchedule[] = [];

  for (const plugin of opts.plugins) {
    const pluginPolicy = composePluginPolicies(plugin.policies);
    for (const nsDef of plugin.namespaces) {
      const ns = nsDef.namespace;
      const prior = claimedBy.get(ns);
      if (prior !== undefined) {
        throw new PluginNamespaceCollision(ns, prior, plugin.name);
      }
      const dataset = opts.datasetFor(ns);
      if (dataset === undefined) {
        throw new MissingPluginDataset(ns, plugin.name);
      }
      const registry = new Registry();
      const installCtx: Parameters<typeof nsDef.install>[0] = {
        registry,
        dataset,
        edges: opts.edges
      };
      if (pluginPolicy !== undefined) installCtx.pluginPolicy = pluginPolicy;
      const postWriteContributions = collectPostWriteContributions(opts.kernelPlugins ?? [], nsDef);
      if (postWriteContributions !== undefined) {
        installCtx.postWriteContributions = postWriteContributions;
      }
      await nsDef.install(installCtx);
      namespaces.set(ns, {
        registry,
        ...(nsDef.annotations !== undefined ? { annotations: nsDef.annotations } : {})
      });
      datasets.set(ns, dataset);
      claimedBy.set(ns, plugin.name);
    }
    if (plugin.schedule !== undefined && plugin.schedule.length > 0) {
      schedule.push({ pluginName: plugin.name, tasks: plugin.schedule });
    }
  }

  return {
    namespaces,
    datasets,
    schedule,
    plugins: opts.plugins,
    runOnStart: async (engine: EngineHandle): Promise<void> => {
      for (const plugin of opts.plugins) {
        if (plugin.onStart === undefined) continue;
        await plugin.onStart({ lifecycle: 'coordinator', metric, engine });
      }
    },
    runOnStop: async (engine: EngineHandle): Promise<void> => {
      // Reverse registration order — late-loading plugins release first,
      // mirroring stack-allocated lifetimes. Errors are caught per-plugin
      // and reported via metric so one plugin's hang/throw can't block the
      // rest of the shutdown sequence.
      for (let i = opts.plugins.length - 1; i >= 0; i--) {
        const plugin = opts.plugins[i];
        if (plugin === undefined || plugin.onStop === undefined) continue;
        try {
          await plugin.onStop({ lifecycle: 'coordinator', metric, engine });
        } catch (err) {
          metric('plugin_on_stop_error', {
            plugin: plugin.name,
            message: err instanceof Error ? err.message : String(err)
          });
        }
      }
    }
  };
}

/**
 * Fold a plugin's `policies` array into a single composed `Policy` via
 * `and(...)`. Empty / undefined → `undefined` (no plugin-global layer).
 * Exposed for tests; callers should prefer letting `loadPlugins` handle
 * composition internally.
 */
export function composePluginPolicies(policies: Policy[] | undefined): Policy | undefined {
  if (policies === undefined || policies.length === 0) return undefined;
  if (policies.length === 1) return policies[0];
  return and(...policies);
}

/**
 * Walk composed substrate plugins and collect per-type `PostWriteHook`
 * contributions for a single coordinator namespace. Each substrate that
 * defines `contributePostWrites` is called once; hooks are stacked in
 * substrate composition order.
 *
 * Returns `undefined` when no substrate contributes any hooks (so the
 * install context omits the field entirely rather than carrying an empty
 * map).
 */
function collectPostWriteContributions(
  kernelPlugins: KernelPlugin[],
  nsDef: NamespaceDefinition
): Record<string, PostWriteHook[]> | undefined {
  const contributions: Record<string, PostWriteHook[]> = {};
  let hasAny = false;

  for (const sub of kernelPlugins) {
    if (sub.contributePostWrites === undefined) continue;
    const fromOne = sub.contributePostWrites(nsDef);
    for (const [typeName, hook] of Object.entries(fromOne)) {
      if (contributions[typeName] === undefined) {
        contributions[typeName] = [];
      }
      contributions[typeName].push(hook);
      hasAny = true;
    }
  }

  return hasAny ? contributions : undefined;
}

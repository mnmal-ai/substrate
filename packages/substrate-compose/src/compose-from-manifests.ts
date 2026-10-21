/**
 * `composeFromManifests` — the shared plugin-instantiation primitive.
 *
 * Owns the reusable middle of plugin loading: tier ordering (substrate before
 * coordinator, alphabetical within tier), bootstrap invocation, and
 * `BootstrapConfigError` → `PluginLoadError` wrapping. It does NOT scan a
 * filesystem and does NOT call `compose()` — discovery, module resolution, and
 * config resolution are injected, and the caller still owns substrate host-dep
 * wiring + the `compose()` handoff.
 *
 * Two consumers share this one contract:
 *   - the binary's `loadPluginsFromDir` (apps/substrate) supplies fs-backed
 *     resolvers over a `SUBSTRATE_PLUGIN_DIR` node_modules scan;
 *   - a downstream single-file binary (e.g. brain) supplies a statically-built
 *     manifest list + resolvers that look up bundled bootstraps, so it reuses
 *     the ordering/invocation contract without an fs-scan or dynamic `import()`.
 *
 * Manifests are generic (`M extends ComposableManifest`) so the binary can pass
 * its richer fs manifest (with package paths) straight through to its resolvers
 * while a static consumer passes a bare `{ packageName, tier }`.
 */

import { BootstrapConfigError } from '@mnmal-ai/substrate-bootstrap';
import type { CoordinatorPlugin, KernelPlugin } from '@mnmal-ai/substrate-types';
import semver from 'semver';

/**
 * Bag of host-built deps any substrate plugin might consume. Each plugin's
 * `THostDeps` (declared at its bootstrap call site) is a subset; the loader
 * passes the whole bag and zod-typed bootstraps narrow as needed.
 */
export type KernelHostDeps = Readonly<Record<string, unknown>>;

/** Minimal manifest shape `composeFromManifests` needs to order + dispatch. */
export interface ComposableManifest {
  /** The npm package the plugin ships in. */
  packageName: string;
  /**
   * Identifier used for ordering, error attribution, and the configs map key.
   * Defaults to `packageName`. A package that ships more than one plugin gives
   * each its own id, conventionally `<packageName>/<name>`.
   */
  pluginId?: string;
  /** Composition tier — substrate plugins compose BEFORE coordinators by contract. */
  tier: 'kernel' | 'coordinator';
}

/**
 * A resolved bootstrap function. Coordinator bootstraps take config only;
 * substrate bootstraps additionally receive the host-deps bag. Typed as the
 * union so a single resolver can return either; the tier selects the call shape.
 */
export type ResolvedBootstrap = (
  rawConfig: Record<string, unknown>,
  hostDeps?: KernelHostDeps
) => CoordinatorPlugin | KernelPlugin;

export interface ComposeFromManifestsOptions<M extends ComposableManifest> {
  /** Manifests to instantiate, in any order — this function sorts them. */
  manifests: readonly M[];
  /**
   * Resolve a manifest to its bootstrap function. The fs path dynamic-imports
   * the manifest's entry; a static consumer looks the manifest up in a bundled
   * registry. May be sync or async.
   */
  resolveBootstrap: (manifest: M) => ResolvedBootstrap | Promise<ResolvedBootstrap>;
  /**
   * Resolve a manifest's merged operator config. Optional — defaults to `{}`
   * so a consumer with no config layer doesn't have to supply a resolver.
   */
  resolveConfig?: (manifest: M) => Record<string, unknown> | Promise<Record<string, unknown>>;
  /** Host-built deps passed to every substrate plugin's bootstrap. */
  kernelHostDeps: KernelHostDeps;
  /**
   * Contract-version gate. Omit to skip entirely — a consumer that doesn't
   * version-gate its plugins shouldn't have to supply a version it has no
   * concept of.
   *
   * `onViolation` IS the policy: warn-and-continue by returning, refuse by
   * throwing. Keeping the decision at the call site lets the host move from
   * warning to refusal without a change to this package.
   */
  contractCheck?: ContractCheck;
}

/** A plugin whose declared `contractVersion` doesn't admit the host. */
export interface ContractViolation {
  /** The plugin's id: `pluginId` when the manifest set one, else `packageName`. */
  packageName: string;
  tier: 'kernel' | 'coordinator';
  /** The range the plugin declared, verbatim. */
  declared: string;
  /** Host contract version the range was evaluated against. */
  hostVersion: string;
  /** `invalid-range` means `declared` isn't parseable as a semver range at all. */
  reason: 'unsatisfied' | 'invalid-range';
}

export interface ContractCheck {
  /** The host's substrate-types contract version, e.g. `'4.1.1'`. */
  hostVersion: string;
  onViolation: (violation: ContractViolation) => void;
}

export interface ComposeFromManifestsResult {
  /** Substrate plugins, in composition order (alphabetical by plugin id). */
  kernel: KernelPlugin[];
  /** Coordinator plugins, in composition order (alphabetical by plugin id). */
  coordinators: CoordinatorPlugin[];
  /**
   * Merged config each plugin's bootstrap was invoked with, keyed by plugin
   * id. Surfaced for telemetry / `substrate plugins describe`.
   */
  configs: ReadonlyMap<string, Readonly<Record<string, unknown>>>;
}

/**
 * Raised when a plugin's bootstrap fails — config invalid (zod) or the
 * bootstrap function threw. Carries the offending plugin's id (its package
 * name, unless the package ships several) so operators see `[<plugin>] <issue>`
 * rather than a bare stack.
 */
export class PluginLoadError extends Error {
  readonly packageName: string;
  override readonly cause: unknown;

  constructor(packageName: string, message: string, cause: unknown) {
    super(`[${packageName}] ${message}`);
    this.name = 'PluginLoadError';
    this.packageName = packageName;
    this.cause = cause;
  }
}

export async function composeFromManifests<M extends ComposableManifest>(
  opts: ComposeFromManifestsOptions<M>
): Promise<ComposeFromManifestsResult> {
  assertUniqueIds(opts.manifests);
  const byName = (a: M, b: M): number => pluginIdOf(a).localeCompare(pluginIdOf(b));
  const kernelManifests = opts.manifests.filter((m) => m.tier === 'kernel').sort(byName);
  const coordinatorManifests = opts.manifests.filter((m) => m.tier === 'coordinator').sort(byName);

  const configs = new Map<string, Record<string, unknown>>();
  const kernel: KernelPlugin[] = [];
  const coordinators: CoordinatorPlugin[] = [];

  for (const manifest of kernelManifests) {
    const mergedConfig = await resolveConfig(opts, manifest);
    const bootstrap = await opts.resolveBootstrap(manifest);
    const plugin = invokeBootstrap(manifest, bootstrap, mergedConfig, opts.kernelHostDeps);
    checkContract(manifest, plugin, 'kernel', opts.contractCheck);
    kernel.push(plugin as KernelPlugin);
    configs.set(pluginIdOf(manifest), mergedConfig);
  }

  for (const manifest of coordinatorManifests) {
    const mergedConfig = await resolveConfig(opts, manifest);
    const bootstrap = await opts.resolveBootstrap(manifest);
    const plugin = invokeBootstrap(manifest, bootstrap, mergedConfig, undefined);
    checkContract(manifest, plugin, 'coordinator', opts.contractCheck);
    coordinators.push(plugin as CoordinatorPlugin);
    configs.set(pluginIdOf(manifest), mergedConfig);
  }

  return { kernel, coordinators, configs };
}

function pluginIdOf(manifest: ComposableManifest): string {
  return manifest.pluginId ?? manifest.packageName;
}

/** Two plugins under one id would share a configs slot and an error label. */
function assertUniqueIds(manifests: readonly ComposableManifest[]): void {
  const seen = new Set<string>();
  for (const manifest of manifests) {
    const id = pluginIdOf(manifest);
    if (seen.has(id)) {
      throw new PluginLoadError(id, 'two plugins declare this id', undefined);
    }
    seen.add(id);
  }
}

async function resolveConfig<M extends ComposableManifest>(
  opts: ComposeFromManifestsOptions<M>,
  manifest: M
): Promise<Record<string, unknown>> {
  if (opts.resolveConfig === undefined) return {};
  return opts.resolveConfig(manifest);
}

/**
 * Evaluates a plugin's declared `contractVersion` against the host and reports
 * an unsatisfied or unparseable range to `check.onViolation`. No-op when
 * `check` is undefined.
 *
 * Lives here because this is the one seam every consumer instantiates plugins
 * through.
 */
function checkContract<M extends ComposableManifest>(
  manifest: M,
  plugin: CoordinatorPlugin | KernelPlugin,
  tier: 'kernel' | 'coordinator',
  check: ContractCheck | undefined
): void {
  if (check === undefined) return;
  const declared = plugin.contractVersion;
  // Absent is deliberately not a violation: `contractVersion` is required on
  // both plugin interfaces, so a missing one is already a type error.
  if (typeof declared !== 'string' || declared.length === 0) return;

  const base = {
    packageName: pluginIdOf(manifest),
    tier,
    declared,
    hostVersion: check.hostVersion
  };
  if (semver.validRange(declared) === null) {
    check.onViolation({ ...base, reason: 'invalid-range' });
    return;
  }
  if (!semver.satisfies(check.hostVersion, declared)) {
    check.onViolation({ ...base, reason: 'unsatisfied' });
  }
}

function invokeBootstrap<M extends ComposableManifest>(
  manifest: M,
  bootstrap: ResolvedBootstrap,
  mergedConfig: Record<string, unknown>,
  hostDeps: KernelHostDeps | undefined
): CoordinatorPlugin | KernelPlugin {
  try {
    return hostDeps === undefined ? bootstrap(mergedConfig) : bootstrap(mergedConfig, hostDeps);
  } catch (err) {
    if (err instanceof BootstrapConfigError) {
      throw new PluginLoadError(pluginIdOf(manifest), `config invalid:\n${err.message}`, err);
    }
    throw new PluginLoadError(
      pluginIdOf(manifest),
      `bootstrap threw: ${err instanceof Error ? err.message : String(err)}`,
      err
    );
  }
}

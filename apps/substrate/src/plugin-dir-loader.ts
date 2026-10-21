/**
 * Plugin discovery + loader for the `SUBSTRATE_PLUGIN_DIR` boot path.
 *
 * Scans `<dir>/node_modules/{*,@*\/*}/package.json` for the dependencies
 * `<dir>/package.json` lists that declare a
 * `substrate` manifest, reads each plugin's defaults + the operator's colocated
 * `<basename>.config.json` overrides, and invokes each plugin's structured
 * `bootstrap(rawConfig[, hostDeps])` from `@mnmal-ai/substrate-bootstrap`.
 *
 * This module owns the fs-specific parts — directory scan, config-file reads,
 * dynamic `import()` of the bootstrap entry. The tier ordering (substrate
 * before coordinator, alphabetical within tier) + bootstrap invocation +
 * `BootstrapConfigError` wrapping live in `composeFromManifests`
 * (`@mnmal-ai/substrate-compose`), shared with downstream consumers that load from
 * a statically-bundled manifest list rather than an fs scan.
 *
 * Failure mode: refuse boot. Manifest parse errors,
 * `BootstrapConfigError` from a plugin's zod schema, and import errors all
 * surface as `PluginLoadError` with the offending package name attached so
 * the operator sees `<plugin>: <issue>` rather than a bare zod dump.
 *
 * Coordinator plugins receive operator config only — no code-shaped extras.
 * The substrate-driven postWrite registry (substrate-recall's `contributePostWrites`)
 * is the correct path for cross-plugin wiring; the binary does not post-attach
 * anything to specific coordinators.
 */

import { readFile } from 'node:fs/promises';
import { resolve as resolvePath } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  type ContractCheck,
  composeFromManifests,
  type KernelHostDeps,
  PluginLoadError,
  type ResolvedBootstrap
} from '@mnmal-ai/substrate-compose';
import type { CoordinatorPlugin, KernelPlugin } from '@mnmal-ai/substrate-types';
import { listPluginManifests, type PluginManifest } from './plugin-manifest.js';

// Re-exported beside the loader that throws and takes them; the canonical
// definitions live in substrate-compose.
export { type KernelHostDeps, PluginLoadError };

/**
 * Override hook for tests to short-circuit dynamic imports without touching
 * the real module resolver. Production uses Node's `import(absoluteUrl)`.
 */
export type ImportResolver = (entryPath: string) => Promise<{ default: unknown }>;

const defaultImportResolver: ImportResolver = async (entryPath) => {
  // Convert absolute filesystem path to a file:// URL — required for ESM
  // imports of files outside the calling module's package.
  const url = pathToFileURL(entryPath).href;
  return import(url);
};

export interface LoadPluginsFromDirOptions {
  /** Absolute path to the plugin install root (the dir containing node_modules/). */
  pluginDir: string;
  /**
   * Host-built deps passed to every substrate plugin's bootstrap. Each
   * substrate plugin's `THostDeps` declaration narrows to the subset it
   * consumes from this bag.
   */
  kernelHostDeps: KernelHostDeps;
  /** Test-only: override dynamic import. Default: real `import()`. */
  importResolver?: ImportResolver;
  /**
   * Contract-version gate, forwarded to `composeFromManifests`. Omitted by
   * callers that don't gate (tests composing throwaway plugins).
   */
  contractCheck?: ContractCheck;
}

export interface LoadPluginsFromDirResult {
  kernel: KernelPlugin[];
  coordinators: CoordinatorPlugin[];
  /** Discovered manifests, indexed by plugin id. Useful for `substrate plugins describe` + telemetry. */
  manifests: ReadonlyMap<string, PluginManifest>;
  /**
   * Raw merged configs (default-config.json ⊕ operator override) keyed by
   * plugin id — exactly what each plugin's bootstrap was invoked with,
   * before the bootstrap's own zod schema applied defaults / parsed.
   *
   * Surfaced for callers that need to inspect the resolved config post-load
   * (e.g. telemetry, `substrate plugins describe`). Plugin authors should NOT
   * consume this; the bootstrap is the only blessed seam for config validation.
   */
  configs: ReadonlyMap<string, Readonly<Record<string, unknown>>>;
}

export async function loadPluginsFromDir(
  opts: LoadPluginsFromDirOptions
): Promise<LoadPluginsFromDirResult> {
  const importResolver = opts.importResolver ?? defaultImportResolver;
  const manifests = await listPluginManifests(opts.pluginDir);

  const { kernel, coordinators, configs } = await composeFromManifests<PluginManifest>({
    manifests,
    kernelHostDeps: opts.kernelHostDeps,
    ...(opts.contractCheck !== undefined ? { contractCheck: opts.contractCheck } : {}),
    resolveConfig: (manifest) => readMergedConfig(manifest, opts.pluginDir),
    resolveBootstrap: async (manifest) => {
      const mod = await importBootstrapModule(manifest, importResolver);
      return mod.default as ResolvedBootstrap;
    }
  });

  const manifestMap = new Map<string, PluginManifest>();
  for (const m of manifests) {
    manifestMap.set(m.pluginId, m);
  }

  return { kernel, coordinators, manifests: manifestMap, configs };
}

async function importBootstrapModule(
  manifest: PluginManifest,
  importResolver: ImportResolver
): Promise<{ default: unknown }> {
  const entryAbs = resolvePath(manifest.packageDir, manifest.entry);
  let mod: { default: unknown };
  try {
    mod = await importResolver(entryAbs);
  } catch (err) {
    throw new PluginLoadError(
      manifest.pluginId,
      `failed to import bootstrap entry '${manifest.entry}': ${describeError(err)}`,
      err
    );
  }

  if (typeof mod.default !== 'function') {
    throw new PluginLoadError(
      manifest.pluginId,
      `bootstrap entry '${manifest.entry}' must default-export a function (got ${typeof mod.default})`,
      undefined
    );
  }

  return mod;
}

async function readMergedConfig(
  manifest: PluginManifest,
  pluginDir: string
): Promise<Record<string, unknown>> {
  const defaults = await readJsonIfPresent(manifest.defaultConfigPath, manifest.pluginId);
  const overrides = await readJsonIfPresent(
    resolvePath(pluginDir, `${manifest.configBasename}.config.json`),
    manifest.pluginId
  );
  return { ...defaults, ...overrides };
}

async function readJsonIfPresent(
  path: string | undefined,
  pluginId: string
): Promise<Record<string, unknown>> {
  if (path === undefined) return {};
  let content: string;
  try {
    content = await readFile(path, 'utf8');
  } catch (err) {
    if (isENOENT(err)) return {};
    throw new PluginLoadError(pluginId, `failed to read config at '${path}'`, err);
  }
  try {
    const parsed: unknown = JSON.parse(content);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new PluginLoadError(
        pluginId,
        `config at '${path}' must be a JSON object (got ${Array.isArray(parsed) ? 'array' : typeof parsed})`,
        undefined
      );
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    if (err instanceof PluginLoadError) throw err;
    throw new PluginLoadError(pluginId, `config at '${path}' is not valid JSON`, err);
  }
}

function isENOENT(err: unknown): boolean {
  return (
    err !== null &&
    typeof err === 'object' &&
    'code' in err &&
    (err as { code: unknown }).code === 'ENOENT'
  );
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

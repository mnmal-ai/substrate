/**
 * Manifest discovery + parsing for the `SUBSTRATE_PLUGIN_DIR` loader.
 *
 * Walks `<pluginDir>/node_modules/{*,@*\/*}/package.json` for the packages
 * `<pluginDir>/package.json` lists as dependencies, picks up those
 * declaring a `substrate` block, and produces typed `PluginManifest` rows
 * the loader feeds through bootstrap invocation.
 *
 * A `substrate` block is either one plugin (`{ tier, entry, … }`) or several
 * (`{ plugins: [{ name, tier, entry, … }, …] }`). The second form lets one
 * package carry a substrate plugin and a coordinator plugin at two subpaths.
 *
 * Manifest parsing is fail-fast: any package whose `substrate` block is malformed
 * throws (with the offending package name) rather than being silently
 * skipped.
 */

import type { Dirent } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, resolve as resolvePath } from 'node:path';

export interface PluginManifest {
  /** The package's own `package.json#name` (e.g. `@acme/notes`). */
  packageName: string;
  /**
   * The plugin's identity for ordering, configs and error attribution:
   * `packageName` for a single-plugin package, `<packageName>/<name>` for each
   * entry of a `substrate.plugins` array.
   */
  pluginId: string;
  /** Absolute path to the package directory inside `<pluginDir>/node_modules/`. */
  packageDir: string;
  /** Composition tier — substrate plugins compose BEFORE coordinators by contract. */
  tier: 'kernel' | 'coordinator';
  /** Path to the bootstrap entry, relative to `packageDir`. */
  entry: string;
  /** Absolute path to the package's `default-config.json`, when declared and resolvable. */
  defaultConfigPath: string | undefined;
  /** Absolute path to the package's `config.schema.json`, when declared (informational; loader does not pre-validate). */
  configSchemaPath: string | undefined;
  /**
   * Operator-config filename basename (without `.config.json` extension) — for
   * `@acme/notes` this resolves to `notes`, so the operator's
   * override lives at `<pluginDir>/notes.config.json`. Manifests can
   * pin a custom basename via `configBasename`; otherwise we strip the npm
   * scope and use the bare package name, suffixed `-<name>` for an entry of
   * a `substrate.plugins` array.
   */
  configBasename: string;
}

interface RawSubstrateManifestBlock {
  name?: unknown;
  plugins?: unknown;
  tier?: unknown;
  entry?: unknown;
  configSchema?: unknown;
  defaultConfig?: unknown;
  configBasename?: unknown;
}

interface RawPackageJson {
  name?: unknown;
  substrate?: RawSubstrateManifestBlock | unknown;
}

export class PluginManifestError extends Error {
  readonly packageName: string | undefined;

  constructor(packageName: string | undefined, message: string) {
    const prefix = packageName !== undefined ? `[${packageName}] ` : '';
    super(`${prefix}${message}`);
    this.name = 'PluginManifestError';
    this.packageName = packageName;
  }
}

export async function listPluginManifests(pluginDir: string): Promise<PluginManifest[]> {
  const nodeModulesDir = resolvePath(pluginDir, 'node_modules');
  if (!(await isDirectory(nodeModulesDir))) {
    return [];
  }
  const packageDirs = await listPackageDirs(nodeModulesDir, await declaredDependencies(pluginDir));
  const manifests: PluginManifest[] = [];
  for (const packageDir of packageDirs) {
    manifests.push(...(await readManifestsIfPresent(packageDir)));
  }
  return manifests;
}

/**
 * The names `<pluginDir>/package.json` lists under `dependencies`. Only these
 * are plugin candidates: a transitive package hoisted into `node_modules` is
 * not something the operator chose to run. No package.json means none.
 */
async function declaredDependencies(pluginDir: string): Promise<Set<string>> {
  let raw: string;
  try {
    raw = await readFile(resolvePath(pluginDir, 'package.json'), 'utf8');
  } catch {
    return new Set();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new PluginManifestError(undefined, `${pluginDir}/package.json is not valid JSON: ${msg}`);
  }
  const deps = (parsed as { dependencies?: unknown } | null)?.dependencies;
  return new Set(deps !== null && typeof deps === 'object' ? Object.keys(deps) : []);
}

async function listPackageDirs(nodeModulesDir: string, declared: Set<string>): Promise<string[]> {
  const entries = await readdir(nodeModulesDir, { withFileTypes: true });
  const result: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    if (!(await isDirectoryEntry(nodeModulesDir, entry))) continue;
    if (entry.name.startsWith('@')) {
      const scopeDir = resolvePath(nodeModulesDir, entry.name);
      const scopedEntries = await readdir(scopeDir, { withFileTypes: true });
      for (const scoped of scopedEntries) {
        if (scoped.name.startsWith('.')) continue;
        if (!declared.has(`${entry.name}/${scoped.name}`)) continue;
        if (!(await isDirectoryEntry(scopeDir, scoped))) continue;
        result.push(resolvePath(scopeDir, scoped.name));
      }
    } else if (declared.has(entry.name)) {
      result.push(resolvePath(nodeModulesDir, entry.name));
    }
  }
  return result;
}

/**
 * Treat both real directories AND symlinks-to-directories as plugin
 * candidates. `Dirent.isDirectory()` is false for symlinks (it returns
 * true for `isSymbolicLink()` instead) — without the follow-through,
 * operators using a symlinked node_modules layout (the typical pattern
 * when wiring the workspace's plugin dirs into a runtime plugin dir
 * via `ln -s`) would see their plugins silently skipped.
 */
async function isDirectoryEntry(parentDir: string, entry: Dirent): Promise<boolean> {
  if (entry.isDirectory()) return true;
  if (!entry.isSymbolicLink()) return false;
  try {
    const stats = await stat(resolvePath(parentDir, entry.name));
    return stats.isDirectory();
  } catch {
    return false;
  }
}

async function readManifestsIfPresent(packageDir: string): Promise<PluginManifest[]> {
  const pkgPath = resolvePath(packageDir, 'package.json');
  let raw: string;
  try {
    raw = await readFile(pkgPath, 'utf8');
  } catch {
    return [];
  }
  let pkg: RawPackageJson;
  try {
    pkg = JSON.parse(raw) as RawPackageJson;
  } catch (err) {
    throw new PluginManifestError(
      undefined,
      `package.json at '${pkgPath}' is not valid JSON: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  if (pkg.substrate === undefined) return [];
  return parseManifests(pkg, packageDir);
}

const PLUGIN_NAME = /^[a-z0-9][a-z0-9-]*$/;

function parseManifests(pkg: RawPackageJson, packageDir: string): PluginManifest[] {
  const packageName = typeof pkg.name === 'string' ? pkg.name : undefined;
  if (packageName === undefined || packageName.length === 0) {
    throw new PluginManifestError(undefined, `package.json at '${packageDir}' is missing a name`);
  }
  if (!isPlainObject(pkg.substrate)) {
    throw new PluginManifestError(packageName, '`substrate` manifest must be an object');
  }
  const block = pkg.substrate as RawSubstrateManifestBlock;
  if (block.plugins === undefined) {
    return [parseEntry(block, packageName, packageDir, undefined, '`substrate')];
  }

  const strays = Object.keys(block).filter((key) => key !== 'plugins');
  if (strays.length > 0) {
    throw new PluginManifestError(
      packageName,
      `\`substrate.plugins\` cannot sit beside single-plugin keys (${strays.join(', ')}); move them into the entries`
    );
  }
  if (!Array.isArray(block.plugins) || block.plugins.length === 0) {
    throw new PluginManifestError(packageName, '`substrate.plugins` must be a non-empty array');
  }
  const names = new Set<string>();
  return block.plugins.map((raw: unknown, i) => {
    const at = `\`substrate.plugins[${i}]`;
    if (!isPlainObject(raw)) {
      throw new PluginManifestError(packageName, `${at}\` must be an object`);
    }
    const entry = raw as RawSubstrateManifestBlock;
    if (typeof entry.name !== 'string' || !PLUGIN_NAME.test(entry.name)) {
      throw new PluginManifestError(
        packageName,
        `${at}.name\` must be lowercase letters, digits and hyphens (got ${JSON.stringify(entry.name)})`
      );
    }
    if (names.has(entry.name)) {
      throw new PluginManifestError(packageName, `${at}.name\` '${entry.name}' is declared twice`);
    }
    names.add(entry.name);
    if (entry.plugins !== undefined) {
      throw new PluginManifestError(packageName, `${at}\` cannot nest \`plugins\``);
    }
    return parseEntry(entry, packageName, packageDir, entry.name, at);
  });
}

function parseEntry(
  block: RawSubstrateManifestBlock,
  packageName: string,
  packageDir: string,
  name: string | undefined,
  at: string
): PluginManifest {
  if (name === undefined && block.name !== undefined) {
    throw new PluginManifestError(
      packageName,
      '`substrate.name` is only meaningful inside a `substrate.plugins` entry'
    );
  }
  if (block.tier !== 'kernel' && block.tier !== 'coordinator') {
    throw new PluginManifestError(
      packageName,
      `${at}.tier\` must be 'kernel' or 'coordinator' (got ${JSON.stringify(block.tier)})`
    );
  }
  if (typeof block.entry !== 'string' || block.entry.length === 0) {
    throw new PluginManifestError(packageName, `${at}.entry\` must be a non-empty string`);
  }
  if (
    block.configSchema !== undefined &&
    (typeof block.configSchema !== 'string' || block.configSchema.length === 0)
  ) {
    throw new PluginManifestError(
      packageName,
      `${at}.configSchema\` must be a non-empty string when present`
    );
  }
  if (
    block.defaultConfig !== undefined &&
    (typeof block.defaultConfig !== 'string' || block.defaultConfig.length === 0)
  ) {
    throw new PluginManifestError(
      packageName,
      `${at}.defaultConfig\` must be a non-empty string when present`
    );
  }
  if (
    block.configBasename !== undefined &&
    (typeof block.configBasename !== 'string' || block.configBasename.length === 0)
  ) {
    throw new PluginManifestError(
      packageName,
      `${at}.configBasename\` must be a non-empty string when present`
    );
  }

  const defaultConfigPath =
    typeof block.defaultConfig === 'string'
      ? resolvePath(packageDir, block.defaultConfig)
      : undefined;
  const configSchemaPath =
    typeof block.configSchema === 'string'
      ? resolvePath(packageDir, block.configSchema)
      : undefined;
  const bareName = basename(packageName);
  const configBasename =
    typeof block.configBasename === 'string'
      ? block.configBasename
      : name === undefined
        ? bareName
        : `${bareName}-${name}`;

  return {
    packageName,
    pluginId: name === undefined ? packageName : `${packageName}/${name}`,
    packageDir,
    tier: block.tier,
    entry: block.entry,
    defaultConfigPath,
    configSchemaPath,
    configBasename
  };
}

function isPlainObject(value: unknown): boolean {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    const stats = await stat(path);
    return stats.isDirectory();
  } catch {
    return false;
  }
}

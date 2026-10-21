/**
 * Plugin dir loader tests. Walks a temp `node_modules/`
 * tree of fixture plugins, exercises:
 *   - manifest discovery (scoped + unscoped packages, missing/malformed
 *     manifests skipped/rejected)
 *   - default-config + operator override merging
 *   - two-pass invocation (substrate before coordinator, alphabetical within
 *     a tier)
 *   - host-deps pass-through to substrate bootstrap
 *   - failure mode: BootstrapConfigError, import errors, and bad bootstrap
 *     shapes all surface as PluginLoadError with the package name attached
 *
 * Uses a real filesystem temp dir + an injected importResolver so we don't
 * need to write valid JS bootstrap files; the resolver maps entry paths to
 * pre-built test bootstraps.
 */

import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve as resolvePath } from 'node:path';
import {
  BootstrapConfigError,
  type CoordinatorBootstrap,
  defineBootstrap,
  type KernelBootstrap
} from '@mnmal-ai/substrate-bootstrap';
import type { CoordinatorPlugin, KernelPlugin } from '@mnmal-ai/substrate-types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  type ImportResolver,
  loadPluginsFromDir,
  PluginLoadError
} from '../src/plugin-dir-loader.js';

interface FixtureEntry {
  tier: 'kernel' | 'coordinator';
  entry: string;
  defaultConfig?: string;
  configSchema?: string;
  configBasename?: string;
}

interface FixturePackage {
  name: string;
  substrate: FixtureEntry | { plugins: Array<FixtureEntry & { name: string }> };
}

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await mkdtemp(resolvePath(tmpdir(), 'substrate-plugin-dir-'));
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

/** List `name` in the plugin dir's own package.json, as `pnpm add` would. */
async function declare(name: string): Promise<void> {
  const path = resolvePath(tmpRoot, 'package.json');
  let deps: Record<string, string> = {};
  try {
    deps = JSON.parse(await readFile(path, 'utf8')).dependencies ?? {};
  } catch {
    // First declaration.
  }
  await writeFile(path, JSON.stringify({ dependencies: { ...deps, [name]: '*' } }));
}

async function writePackage(
  pkg: FixturePackage,
  defaultConfig?: Record<string, unknown>
): Promise<string> {
  const isScoped = pkg.name.startsWith('@');
  const segments = isScoped ? pkg.name.split('/') : [pkg.name];
  const packageDir = resolvePath(tmpRoot, 'node_modules', ...segments);
  await mkdir(packageDir, { recursive: true });
  await writeFile(resolvePath(packageDir, 'package.json'), JSON.stringify(pkg, null, 2));
  await declare(pkg.name);
  if (defaultConfig !== undefined) {
    const defaultsPath =
      ('defaultConfig' in pkg.substrate ? pkg.substrate.defaultConfig : undefined) ??
      'default-config.json';
    await writeFile(resolvePath(packageDir, defaultsPath), JSON.stringify(defaultConfig, null, 2));
  }
  return packageDir;
}

async function writeOperatorOverride(
  basename: string,
  override: Record<string, unknown>
): Promise<void> {
  await writeFile(
    resolvePath(tmpRoot, `${basename}.config.json`),
    JSON.stringify(override, null, 2)
  );
}

const coordinatorSchema = z.object({ name: z.string().default('default') }).strict();
const kernelSchema = z.object({ knob: z.number().int().positive().default(7) }).strict();

function buildCoordinatorBootstrap(name: string): CoordinatorBootstrap {
  return defineBootstrap.coordinator({
    schema: coordinatorSchema,
    build: (config): CoordinatorPlugin => ({
      name,
      contractVersion: '^2.3.0',
      namespaces: [],
      onboardInstructions: { configuredName: config.name }
    })
  });
}

function buildKernelBootstrap(name: string): KernelBootstrap<{ tag: string }> {
  return defineBootstrap.kernel<{ knob: number }, { tag: string }>({
    schema: kernelSchema,
    build: (config, deps): KernelPlugin => ({
      name,
      contractVersion: '^2.3.0',
      mcpTools: [
        {
          name: `${name}-knob`,
          description: `knob=${config.knob}, tag=${deps.tag}`,
          inputSchema: { type: 'object', properties: {} },
          handler: async () => ({ content: [] })
        }
      ]
    })
  });
}

function makeImportResolver(handlers: Record<string, unknown>): ImportResolver {
  return async (entryPath) => {
    const handler = handlers[entryPath];
    if (handler === undefined) {
      throw new Error(`no fixture for entry '${entryPath}'`);
    }
    return { default: handler };
  };
}

describe('listPluginManifests + loadPluginsFromDir — happy paths', () => {
  it('returns empty result for a dir with no node_modules', async () => {
    const result = await loadPluginsFromDir({
      pluginDir: tmpRoot,
      kernelHostDeps: {},
      importResolver: () => Promise.reject(new Error('should not import'))
    });
    expect(result.coordinators).toEqual([]);
    expect(result.kernel).toEqual([]);
    expect(result.manifests.size).toBe(0);
  });

  it('discovers a scoped + unscoped coordinator plugin and invokes both', async () => {
    const dirA = await writePackage(
      {
        name: '@scope/plugin-a',
        substrate: { tier: 'coordinator', entry: './bootstrap.js', defaultConfig: './default.json' }
      },
      { name: 'a-default' }
    );
    const dirB = await writePackage({
      name: 'plugin-b',
      substrate: { tier: 'coordinator', entry: './bootstrap.js' }
    });

    const result = await loadPluginsFromDir({
      pluginDir: tmpRoot,
      kernelHostDeps: {},
      importResolver: makeImportResolver({
        [resolvePath(dirA, 'bootstrap.js')]: buildCoordinatorBootstrap('plugin-a'),
        [resolvePath(dirB, 'bootstrap.js')]: buildCoordinatorBootstrap('plugin-b')
      })
    });

    expect(result.coordinators.map((p) => p.name)).toEqual(['plugin-a', 'plugin-b']);
    expect(result.kernel).toEqual([]);
    expect(result.manifests.size).toBe(2);
    expect(result.manifests.get('@scope/plugin-a')?.tier).toBe('coordinator');
  });

  it('orders coordinators alphabetically by package name', async () => {
    const dirZ = await writePackage({
      name: 'z-plugin',
      substrate: { tier: 'coordinator', entry: './bootstrap.js' }
    });
    const dirA = await writePackage({
      name: 'a-plugin',
      substrate: { tier: 'coordinator', entry: './bootstrap.js' }
    });

    const result = await loadPluginsFromDir({
      pluginDir: tmpRoot,
      kernelHostDeps: {},
      importResolver: makeImportResolver({
        [resolvePath(dirZ, 'bootstrap.js')]: buildCoordinatorBootstrap('z'),
        [resolvePath(dirA, 'bootstrap.js')]: buildCoordinatorBootstrap('a')
      })
    });

    expect(result.coordinators.map((p) => p.name)).toEqual(['a', 'z']);
  });

  it('separates kernel from coordinator + invokes kernel plugins with host deps', async () => {
    const subDir = await writePackage({
      name: 'plugin-sub',
      substrate: { tier: 'kernel', entry: './bootstrap.js' }
    });
    const coordDir = await writePackage({
      name: 'plugin-coord',
      substrate: { tier: 'coordinator', entry: './bootstrap.js' }
    });

    const result = await loadPluginsFromDir({
      pluginDir: tmpRoot,
      kernelHostDeps: { tag: 'wired-by-host' },
      importResolver: makeImportResolver({
        [resolvePath(subDir, 'bootstrap.js')]: buildKernelBootstrap('sub'),
        [resolvePath(coordDir, 'bootstrap.js')]: buildCoordinatorBootstrap('coord')
      })
    });

    expect(result.kernel.map((p) => p.name)).toEqual(['sub']);
    expect(result.coordinators.map((p) => p.name)).toEqual(['coord']);
    const tool = result.kernel[0]?.mcpTools?.[0];
    expect(tool?.description).toBe('knob=7, tag=wired-by-host');
  });

  it('merges default-config + operator override (override wins)', async () => {
    const dir = await writePackage(
      {
        name: 'plugin-merge',
        substrate: {
          tier: 'coordinator',
          entry: './bootstrap.js',
          defaultConfig: './defaults.json'
        }
      },
      { name: 'from-defaults' }
    );
    await writeOperatorOverride('plugin-merge', { name: 'from-override' });

    const result = await loadPluginsFromDir({
      pluginDir: tmpRoot,
      kernelHostDeps: {},
      importResolver: makeImportResolver({
        [resolvePath(dir, 'bootstrap.js')]: buildCoordinatorBootstrap('plugin-merge')
      })
    });

    const onboard = result.coordinators[0]?.onboardInstructions as { configuredName?: string };
    expect(onboard.configuredName).toBe('from-override');
  });

  it('uses configBasename override when manifest declares it', async () => {
    const dir = await writePackage({
      name: '@scope/long-package-name-x',
      substrate: { tier: 'coordinator', entry: './bootstrap.js', configBasename: 'shortname' }
    });
    await writeOperatorOverride('shortname', { name: 'from-shortname' });

    const result = await loadPluginsFromDir({
      pluginDir: tmpRoot,
      kernelHostDeps: {},
      importResolver: makeImportResolver({
        [resolvePath(dir, 'bootstrap.js')]: buildCoordinatorBootstrap('x')
      })
    });

    const onboard = result.coordinators[0]?.onboardInstructions as { configuredName?: string };
    expect(onboard.configuredName).toBe('from-shortname');
  });

  it('discovers plugins via symlinked package dirs (operator wires workspace → runtime)', async () => {
    // Build the package outside the runtime tree, then symlink it into the
    // runtime's node_modules. Mirrors the operator's `ln -s workspace/plugins/<x>
    // <runtime-dir>/node_modules/@mnmal-ai/<x>` pattern.
    const realPackageRoot = await mkdtemp(resolvePath(tmpdir(), 'substrate-real-pkg-'));
    try {
      const realPackageDir = resolvePath(realPackageRoot, 'real-plugin');
      await mkdir(realPackageDir, { recursive: true });
      await writeFile(
        resolvePath(realPackageDir, 'package.json'),
        JSON.stringify({
          name: '@scope/symlinked-plugin',
          substrate: { tier: 'coordinator', entry: './bootstrap.js' }
        })
      );

      const scopeDir = resolvePath(tmpRoot, 'node_modules', '@scope');
      await mkdir(scopeDir, { recursive: true });
      await symlink(realPackageDir, resolvePath(scopeDir, 'symlinked-plugin'));
      await declare('@scope/symlinked-plugin');

      const result = await loadPluginsFromDir({
        pluginDir: tmpRoot,
        kernelHostDeps: {},
        importResolver: makeImportResolver({
          [resolvePath(scopeDir, 'symlinked-plugin', 'bootstrap.js')]:
            buildCoordinatorBootstrap('symlinked-plugin')
        })
      });

      expect(result.coordinators.map((p) => p.name)).toEqual(['symlinked-plugin']);
      expect(result.manifests.has('@scope/symlinked-plugin')).toBe(true);
    } finally {
      await rm(realPackageRoot, { recursive: true, force: true });
    }
  });

  it('ignores a manifest package the plugin dir does not list as a dependency', async () => {
    await writePackage({
      name: 'listed',
      substrate: { tier: 'coordinator', entry: './bootstrap.js' }
    });
    const hoisted = resolvePath(tmpRoot, 'node_modules', 'hoisted');
    await mkdir(hoisted, { recursive: true });
    await writeFile(
      resolvePath(hoisted, 'package.json'),
      JSON.stringify({ name: 'hoisted', substrate: { tier: 'coordinator', entry: './b.js' } })
    );

    const result = await loadPluginsFromDir({
      pluginDir: tmpRoot,
      kernelHostDeps: {},
      importResolver: makeImportResolver({
        [resolvePath(tmpRoot, 'node_modules', 'listed', 'bootstrap.js')]:
          buildCoordinatorBootstrap('listed')
      })
    });
    expect([...result.manifests.keys()]).toEqual(['listed']);
  });

  it('skips packages without a substrate manifest block', async () => {
    await mkdir(resolvePath(tmpRoot, 'node_modules', 'plain-pkg'), { recursive: true });
    await writeFile(
      resolvePath(tmpRoot, 'node_modules', 'plain-pkg', 'package.json'),
      JSON.stringify({ name: 'plain-pkg' })
    );
    await declare('plain-pkg');

    const result = await loadPluginsFromDir({
      pluginDir: tmpRoot,
      kernelHostDeps: {},
      importResolver: () => Promise.reject(new Error('should not import'))
    });
    expect(result.coordinators).toEqual([]);
    expect(result.manifests.size).toBe(0);
  });
});

describe('loadPluginsFromDir — failure modes', () => {
  it('rejects malformed manifest tier', async () => {
    await writePackage({
      name: 'bad-tier',
      substrate: { tier: 'unknown' as 'coordinator', entry: './bootstrap.js' }
    });

    await expect(
      loadPluginsFromDir({
        pluginDir: tmpRoot,
        kernelHostDeps: {},
        importResolver: () => Promise.reject(new Error('should not import'))
      })
    ).rejects.toThrow(/bad-tier.*tier.*kernel.*coordinator/);
  });

  it('rejects manifest missing entry', async () => {
    await writePackage({
      name: 'bad-entry',
      substrate: { tier: 'coordinator', entry: '' }
    });

    await expect(
      loadPluginsFromDir({
        pluginDir: tmpRoot,
        kernelHostDeps: {},
        importResolver: () => Promise.reject(new Error('should not import'))
      })
    ).rejects.toThrow(/bad-entry.*entry/);
  });

  it('wraps BootstrapConfigError with the offending plugin name', async () => {
    const dir = await writePackage(
      {
        name: 'plugin-bad-config',
        substrate: {
          tier: 'coordinator',
          entry: './bootstrap.js',
          defaultConfig: './defaults.json'
        }
      },
      { name: 42 }
    );

    let caught: unknown;
    try {
      await loadPluginsFromDir({
        pluginDir: tmpRoot,
        kernelHostDeps: {},
        importResolver: makeImportResolver({
          [resolvePath(dir, 'bootstrap.js')]: buildCoordinatorBootstrap('plugin-bad-config')
        })
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(PluginLoadError);
    expect((caught as PluginLoadError).packageName).toBe('plugin-bad-config');
    expect((caught as PluginLoadError).cause).toBeInstanceOf(BootstrapConfigError);
    expect((caught as Error).message).toContain('plugin-bad-config');
    expect((caught as Error).message).toContain('config invalid');
  });

  it('wraps import errors with the offending plugin name', async () => {
    const dir = await writePackage({
      name: 'plugin-import-fails',
      substrate: { tier: 'coordinator', entry: './bootstrap.js' }
    });

    await expect(
      loadPluginsFromDir({
        pluginDir: tmpRoot,
        kernelHostDeps: {},
        importResolver: () => {
          throw new Error('boom');
        }
      })
    ).rejects.toThrow(/plugin-import-fails.*import.*boom/);
    void dir;
  });

  it('rejects bootstrap whose default export is not a function', async () => {
    const dir = await writePackage({
      name: 'plugin-bad-export',
      substrate: { tier: 'coordinator', entry: './bootstrap.js' }
    });

    await expect(
      loadPluginsFromDir({
        pluginDir: tmpRoot,
        kernelHostDeps: {},
        importResolver: makeImportResolver({
          [resolvePath(dir, 'bootstrap.js')]: { not: 'a function' }
        })
      })
    ).rejects.toThrow(/plugin-bad-export.*default-export a function/);
  });

  it('rejects non-object operator override JSON', async () => {
    const dir = await writePackage({
      name: 'plugin-array-override',
      substrate: { tier: 'coordinator', entry: './bootstrap.js' }
    });
    await writeFile(
      resolvePath(tmpRoot, 'plugin-array-override.config.json'),
      JSON.stringify(['nope'])
    );

    await expect(
      loadPluginsFromDir({
        pluginDir: tmpRoot,
        kernelHostDeps: {},
        importResolver: makeImportResolver({
          [resolvePath(dir, 'bootstrap.js')]: buildCoordinatorBootstrap('x')
        })
      })
    ).rejects.toThrow(/plugin-array-override.*JSON object/);
  });
});

describe('loadPluginsFromDir — several plugins in one package (substrate.plugins)', () => {
  const twoHalves = (overrides: Partial<FixtureEntry> = {}): FixturePackage => ({
    name: '@scope/both',
    substrate: {
      plugins: [
        { name: 'kernel', tier: 'kernel', entry: './kernel.js' },
        { name: 'coordinator', tier: 'coordinator', entry: './coordinator.js', ...overrides }
      ]
    }
  });

  it('loads each entry in its own tier, with an id of <package>/<name>', async () => {
    const dir = await writePackage(twoHalves());

    const result = await loadPluginsFromDir({
      pluginDir: tmpRoot,
      kernelHostDeps: { tag: 'host' },
      importResolver: makeImportResolver({
        [resolvePath(dir, 'kernel.js')]: buildKernelBootstrap('both-sub'),
        [resolvePath(dir, 'coordinator.js')]: buildCoordinatorBootstrap('both-coord')
      })
    });

    expect(result.kernel.map((p) => p.name)).toEqual(['both-sub']);
    expect(result.coordinators.map((p) => p.name)).toEqual(['both-coord']);
    expect(result.kernel[0]?.mcpTools?.[0]?.description).toBe('knob=7, tag=host');
    expect([...result.manifests.keys()].sort()).toEqual([
      '@scope/both/coordinator',
      '@scope/both/kernel'
    ]);
    expect(result.manifests.get('@scope/both/kernel')?.packageName).toBe('@scope/both');
  });

  it('reads each entry its own operator override, <bare>-<name>.config.json by default', async () => {
    const dir = await writePackage(twoHalves());
    await writeOperatorOverride('both-kernel', { knob: 3 });
    await writeOperatorOverride('both-coordinator', { name: 'from-coordinator-file' });

    const result = await loadPluginsFromDir({
      pluginDir: tmpRoot,
      kernelHostDeps: { tag: 'host' },
      importResolver: makeImportResolver({
        [resolvePath(dir, 'kernel.js')]: buildKernelBootstrap('s'),
        [resolvePath(dir, 'coordinator.js')]: buildCoordinatorBootstrap('c')
      })
    });

    expect(result.kernel[0]?.mcpTools?.[0]?.description).toBe('knob=3, tag=host');
    const onboard = result.coordinators[0]?.onboardInstructions as { configuredName?: string };
    expect(onboard.configuredName).toBe('from-coordinator-file');
    expect(result.configs.get('@scope/both/kernel')).toEqual({ knob: 3 });
  });

  it('honours an entry configBasename, so a folded package keeps its old override file', async () => {
    const dir = await writePackage(twoHalves({ configBasename: 'both' }));
    await writeOperatorOverride('both', { name: 'from-legacy-name' });

    const result = await loadPluginsFromDir({
      pluginDir: tmpRoot,
      kernelHostDeps: { tag: 'host' },
      importResolver: makeImportResolver({
        [resolvePath(dir, 'kernel.js')]: buildKernelBootstrap('s'),
        [resolvePath(dir, 'coordinator.js')]: buildCoordinatorBootstrap('c')
      })
    });

    const onboard = result.coordinators[0]?.onboardInstructions as { configuredName?: string };
    expect(onboard.configuredName).toBe('from-legacy-name');
  });

  const rejects = async (substrate: unknown, pattern: RegExp): Promise<void> => {
    const packageDir = resolvePath(tmpRoot, 'node_modules', 'bad-multi');
    await mkdir(packageDir, { recursive: true });
    await writeFile(
      resolvePath(packageDir, 'package.json'),
      JSON.stringify({ name: 'bad-multi', substrate })
    );
    await declare('bad-multi');
    await expect(
      loadPluginsFromDir({
        pluginDir: tmpRoot,
        kernelHostDeps: {},
        importResolver: () => Promise.reject(new Error('should not import'))
      })
    ).rejects.toThrow(pattern);
  };

  it('rejects plugins beside single-plugin keys', async () => {
    await rejects(
      { tier: 'coordinator', plugins: [{ name: 'a', tier: 'coordinator', entry: './a.js' }] },
      /bad-multi.*cannot sit beside single-plugin keys \(tier\)/
    );
  });

  it('rejects an empty plugins array', async () => {
    await rejects({ plugins: [] }, /bad-multi.*non-empty array/);
  });

  it('rejects an entry without a valid name', async () => {
    await rejects(
      { plugins: [{ name: 'Sub Strate', tier: 'kernel', entry: './s.js' }] },
      /bad-multi.*plugins\[0\]\.name.*lowercase/
    );
  });

  it('rejects a name declared twice', async () => {
    await rejects(
      {
        plugins: [
          { name: 'a', tier: 'kernel', entry: './s.js' },
          { name: 'a', tier: 'coordinator', entry: './c.js' }
        ]
      },
      /bad-multi.*plugins\[1\]\.name.*declared twice/
    );
  });

  it('labels an invalid entry field with its index', async () => {
    await rejects(
      { plugins: [{ name: 'a', tier: 'middle', entry: './s.js' }] },
      /bad-multi.*plugins\[0\]\.tier/
    );
  });

  it('rejects name on a single-plugin block, where it would be silently meaningless', async () => {
    await rejects(
      { name: 'x', tier: 'coordinator', entry: './c.js' },
      /bad-multi.*substrate\.name.*only meaningful/
    );
  });
});

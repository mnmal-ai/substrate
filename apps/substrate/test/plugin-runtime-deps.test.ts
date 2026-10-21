/**
 * Every `@mnmal-ai/*` package a plugin imports AT RUNTIME must be declared in
 * its `dependencies` or `peerDependencies`.
 *
 * This is not a tidiness rule. tsdown/rolldown externalises a package when it
 * is declared (either slot) and INLINES it otherwise — so an undeclared
 * runtime import does not fail the build, it silently ships a private copy of
 * that package and its whole module graph inside the published tarball. For
 * a singleton package that means a second realm in the host process.
 *
 * Checked statically against source rather than against `dist/`: the defect
 * is an undeclared import, and a static check needs no build step.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const PLUGINS_DIR = new URL('../../../plugins', import.meta.url).pathname;

interface Manifest {
  name?: string;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

/**
 * Runtime imports only. `import type { ... } from '@mnmal-ai/x'` is erased by
 * the compiler and crosses no value, so it neither needs declaring for the
 * bundler nor creates a realm.
 */
function runtimeMnmalImports(dir: string): Set<string> {
  const found = new Set<string>();
  const walk = (path: string): void => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const full = join(path, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.name.endsWith('.ts')) continue;
      for (const line of readFileSync(full, 'utf8').split('\n')) {
        if (/^\s*import\s+type\s/.test(line)) continue;
        const m = line.match(/from\s+['"](@mnmal-ai\/[a-z0-9-]+)['"]/);
        if (m?.[1] !== undefined) found.add(m[1]);
      }
    }
  };
  walk(dir);
  return found;
}

const pluginDirs = readdirSync(PLUGINS_DIR, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .filter((name) => {
    try {
      readFileSync(join(PLUGINS_DIR, name, 'package.json'), 'utf8');
      return true;
    } catch {
      return false;
    }
  });

describe('plugin runtime deps are declared, so the bundler externalises them', () => {
  it('found plugins to check', () => {
    expect(pluginDirs.length).toBeGreaterThan(0);
  });

  for (const name of pluginDirs) {
    const dir = join(PLUGINS_DIR, name);
    it(`${name}: every runtime @mnmal-ai import is declared`, () => {
      const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as Manifest;
      const declared = new Set([
        ...Object.keys(manifest.dependencies ?? {}),
        ...Object.keys(manifest.peerDependencies ?? {})
      ]);
      const imported = runtimeMnmalImports(join(dir, 'src'));
      // A package importing itself is a re-export inside its own graph, not a
      // dependency it could declare.
      imported.delete(manifest.name ?? '');

      const undeclared = [...imported].filter((d) => !declared.has(d)).sort();
      expect(
        undeclared,
        `${name} imports these at runtime but declares them in neither dependencies nor ` +
          'peerDependencies, so the bundler will INLINE them into the published tarball ' +
          'along with their transitive graph — silently, with no build failure'
      ).toEqual([]);
    });
  }
});

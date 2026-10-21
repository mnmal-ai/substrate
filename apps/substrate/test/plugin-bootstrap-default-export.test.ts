/**
 * The manifest loader imports each plugin's `substrate.entry` and requires a
 * default-exported function (PluginLoadError otherwise). A plugin without one
 * crash-loops the service on first install, and nothing else loads it the way
 * the binary does. Import every plugin's bootstrap source and assert the
 * contract the loader enforces.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const pluginsDir = new URL('../../../plugins/', import.meta.url);
const plugins = readdirSync(pluginsDir).filter((name) => {
  try {
    const pkg = JSON.parse(readFileSync(new URL(`${name}/package.json`, pluginsDir), 'utf8'));
    return typeof pkg.substrate?.entry === 'string';
  } catch {
    return false;
  }
});

describe('every plugin bootstrap default-exports a function', () => {
  it('finds the plugins', () => {
    expect(plugins).toContain('substrate-nl');
  });
  it.each(plugins)('%s', async (name) => {
    const mod = await import(new URL(`${name}/src/bootstrap.ts`, pluginsDir).href);
    expect(typeof mod.default).toBe('function');
  });
});

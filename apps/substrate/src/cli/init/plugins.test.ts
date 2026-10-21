import { describe, expect, it } from 'vitest';
import { defaultPluginsForPersona, KNOWN_PLUGINS, pluginNpmName } from './plugins.js';

describe('KNOWN_PLUGINS', () => {
  it('includes cortext with a description', () => {
    const claude = KNOWN_PLUGINS.find((p) => p.name === 'cortext');
    expect(claude).toBeDefined();
    expect(claude!.description.length).toBeGreaterThan(0);
    expect(claude!.npmName).toBe('@mnmal-ai/cortext');
  });

  it('lists no built-in plugin', () => {
    expect(KNOWN_PLUGINS.map((p) => p.name)).not.toContain('substrate-recall');
    expect(KNOWN_PLUGINS.map((p) => p.name)).not.toContain('substrate-proposals');
  });
});

describe('defaultPluginsForPersona', () => {
  it('agent-context picks cortext', () => {
    expect([...defaultPluginsForPersona('agent-context')]).toEqual(['cortext']);
  });

  it('minimal picks empty', () => {
    expect(defaultPluginsForPersona('minimal')).toEqual([]);
  });

  it('full picks every known plugin', () => {
    const full = [...defaultPluginsForPersona('full')].sort();
    const known = KNOWN_PLUGINS.map((p) => p.name).sort();
    expect(full).toEqual(known);
  });
});

describe('pluginNpmName', () => {
  it('maps a known short name to its @mnmal-ai npm name', () => {
    expect(pluginNpmName('cortext')).toBe('@mnmal-ai/cortext');
  });

  it('passes through an already-scoped name unchanged', () => {
    expect(pluginNpmName('@scope/foo')).toBe('@scope/foo');
  });

  it('defaults an unscoped unknown name to @mnmal-ai org', () => {
    expect(pluginNpmName('custom-plugin')).toBe('@mnmal-ai/custom-plugin');
  });
});

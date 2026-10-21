import { describe, expect, it } from 'vitest';
import type { NlEngineAccess } from '../access.js';
import { bootstrap, NlBootstrapConfigSchema } from '../bootstrap.js';
import { createNlPlugin } from '../plugin.js';

describe('substrate-nl config', () => {
  it('empty config is parser-only with the default TTL', () => {
    expect(NlBootstrapConfigSchema.parse({})).toEqual({ packTtlMs: 300000 });
  });
  it('accepts a judge and rulings', () => {
    const c = NlBootstrapConfigSchema.parse({
      judge: { baseUrl: 'http://ollama.local:11434', model: 'qwen3:14b' },
      rulings: { journal: { liveStatus: { Todo: 'open' } } }
    });
    expect(c.judge).toEqual({
      baseUrl: 'http://ollama.local:11434',
      model: 'qwen3:14b',
      timeoutMs: 20000
    });
  });
  it('an unknown key fails loudly and names it', () => {
    const r = NlBootstrapConfigSchema.safeParse({ provider: { kind: 'ollama' } });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toMatch(/provider/);
  });
});

describe('createNlPlugin', () => {
  it('claims POST nl and GET nl/pack/:ns, both read-gated', () => {
    const p = createNlPlugin({
      engine: { federatedSchema: () => ({}), operators: () => undefined, query: async () => ({}) }
    });
    expect(p.kernelRoutes?.map((r) => [r.method, r.path, r.capability])).toEqual([
      ['POST', 'nl', 'read'],
      ['GET', 'nl/pack/:ns', 'read']
    ]);
  });
});

describe('bootstrap', () => {
  const nlEngine: NlEngineAccess = {
    federatedSchema: () => ({}),
    operators: () => undefined,
    query: async () => ({})
  };
  const routes = (p: { kernelRoutes?: readonly { method: string; path: string }[] }) =>
    p.kernelRoutes?.map((r) => `${r.method} ${r.path}`);

  it('builds the two routes parser-only from an empty config', () => {
    expect(routes(bootstrap({}, { nlEngine }))).toEqual(['POST nl', 'GET nl/pack/:ns']);
  });

  it('builds the two routes with a judge configured', () => {
    const p = bootstrap({ judge: { baseUrl: 'http://127.0.0.1:1', model: 'm' } }, { nlEngine });
    expect(routes(p)).toEqual(['POST nl', 'GET nl/pack/:ns']);
  });

  it('refuses an unknown key at boot', () => {
    expect(() => bootstrap({ provider: { kind: 'ollama' } }, { nlEngine })).toThrow(/provider/);
  });
});

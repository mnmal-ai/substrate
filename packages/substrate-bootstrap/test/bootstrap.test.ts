/**
 * Contract tests for `@mnmal-ai/substrate-bootstrap`.
 *
 * The helper is the seam every plugin's `bootstrap.ts` uses. These tests pin
 * its contract: parse → defaults → validate → invoke factory; failure on bad
 * config surfaces as `BootstrapConfigError` with the underlying zod issues
 * accessible for the loader to decorate with the offending plugin name.
 */

import type { CoordinatorPlugin, KernelPlugin } from '@mnmal-ai/substrate-types';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { BootstrapConfigError, defineBootstrap } from '../src/index.js';

const TestSchema = z
  .object({
    name: z.string().min(1).default('default-name'),
    count: z.number().int().nonnegative().default(0)
  })
  .strict();

type TestConfig = z.infer<typeof TestSchema>;

const stubPlugin = (): CoordinatorPlugin => ({
  name: 'test-plugin',
  contractVersion: '^2.3.0',
  namespaces: []
});

describe('defineBootstrap.coordinator', () => {
  it('parses raw config, applies defaults, invokes build', () => {
    let captured: TestConfig | undefined;
    const bootstrap = defineBootstrap.coordinator({
      schema: TestSchema,
      build: (config) => {
        captured = config;
        return stubPlugin();
      }
    });
    bootstrap({});
    expect(captured).toEqual({ name: 'default-name', count: 0 });
  });

  it('preserves operator overrides over defaults', () => {
    let captured: TestConfig | undefined;
    const bootstrap = defineBootstrap.coordinator({
      schema: TestSchema,
      build: (config) => {
        captured = config;
        return stubPlugin();
      }
    });
    bootstrap({ name: 'custom', count: 42 });
    expect(captured).toEqual({ name: 'custom', count: 42 });
  });

  it('returns the built plugin from build()', () => {
    const plugin = stubPlugin();
    const bootstrap = defineBootstrap.coordinator({
      schema: TestSchema,
      build: () => plugin
    });
    expect(bootstrap({})).toBe(plugin);
  });

  it('throws BootstrapConfigError when config fails the schema', () => {
    const bootstrap = defineBootstrap.coordinator({
      schema: TestSchema,
      build: () => stubPlugin()
    });
    expect(() => bootstrap({ count: 'not-a-number' })).toThrow(BootstrapConfigError);
  });

  it('rejects unknown top-level keys (typo guard via .strict())', () => {
    const bootstrap = defineBootstrap.coordinator({
      schema: TestSchema,
      build: () => stubPlugin()
    });
    expect(() => bootstrap({ namee: 'typo' })).toThrow(BootstrapConfigError);
  });

  it('does not invoke build when config is invalid', () => {
    let buildCalls = 0;
    const bootstrap = defineBootstrap.coordinator({
      schema: TestSchema,
      build: () => {
        buildCalls++;
        return stubPlugin();
      }
    });
    expect(() => bootstrap({ count: 'bad' })).toThrow(BootstrapConfigError);
    expect(buildCalls).toBe(0);
  });
});

describe('BootstrapConfigError', () => {
  const buildBootstrap = () =>
    defineBootstrap.coordinator({
      schema: TestSchema,
      build: () => stubPlugin()
    });

  it('exposes the underlying ZodError for loader-side decoration', () => {
    try {
      buildBootstrap()({ count: 'bad' });
      expect.fail('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(BootstrapConfigError);
      expect((err as BootstrapConfigError).zodError.issues.length).toBeGreaterThan(0);
    }
  });

  it('formats issues as `path: message` lines for human-readable boot output', () => {
    try {
      buildBootstrap()({ count: 'bad' });
      expect.fail('expected throw');
    } catch (err) {
      expect((err as Error).message).toContain('count');
    }
  });
});

interface TestHostDeps {
  sql: { query: string };
  embedderDimension: number;
}

const stubKernelPlugin = (): KernelPlugin => ({
  name: 'test-substrate',
  contractVersion: '^2.3.0'
});

describe('defineBootstrap.kernel', () => {
  it('parses raw config, applies defaults, invokes build with config + hostDeps', () => {
    let captured: { config: TestConfig; deps: TestHostDeps } | undefined;
    const bootstrap = defineBootstrap.kernel<TestConfig, TestHostDeps>({
      schema: TestSchema,
      build: (config, deps) => {
        captured = { config, deps };
        return stubKernelPlugin();
      }
    });
    const deps: TestHostDeps = { sql: { query: 'SELECT 1' }, embedderDimension: 768 };
    bootstrap({}, deps);
    expect(captured?.config).toEqual({ name: 'default-name', count: 0 });
    expect(captured?.deps).toBe(deps);
  });

  it('preserves operator overrides over defaults', () => {
    let captured: TestConfig | undefined;
    const bootstrap = defineBootstrap.kernel<TestConfig, TestHostDeps>({
      schema: TestSchema,
      build: (config) => {
        captured = config;
        return stubKernelPlugin();
      }
    });
    bootstrap({ name: 'custom', count: 7 }, { sql: { query: '' }, embedderDimension: 1024 });
    expect(captured).toEqual({ name: 'custom', count: 7 });
  });

  it('returns the built plugin from build()', () => {
    const plugin = stubKernelPlugin();
    const bootstrap = defineBootstrap.kernel<TestConfig, TestHostDeps>({
      schema: TestSchema,
      build: () => plugin
    });
    expect(bootstrap({}, { sql: { query: '' }, embedderDimension: 768 })).toBe(plugin);
  });

  it('throws BootstrapConfigError when config fails the schema', () => {
    const bootstrap = defineBootstrap.kernel<TestConfig, TestHostDeps>({
      schema: TestSchema,
      build: () => stubKernelPlugin()
    });
    expect(() =>
      bootstrap({ count: 'not-a-number' }, { sql: { query: '' }, embedderDimension: 768 })
    ).toThrow(BootstrapConfigError);
  });

  it('does not invoke build when config is invalid', () => {
    let buildCalls = 0;
    const bootstrap = defineBootstrap.kernel<TestConfig, TestHostDeps>({
      schema: TestSchema,
      build: () => {
        buildCalls++;
        return stubKernelPlugin();
      }
    });
    expect(() =>
      bootstrap({ count: 'bad' }, { sql: { query: '' }, embedderDimension: 768 })
    ).toThrow(BootstrapConfigError);
    expect(buildCalls).toBe(0);
  });
});

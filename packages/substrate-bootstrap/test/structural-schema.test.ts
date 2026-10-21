/**
 * The schema seam is structural: anything exposing `safeParse` with the
 * success/issues result shape is accepted, so a consumer's zod (any minor)
 * or a hand-written validator fits without sharing a zod type identity.
 */

import type { CoordinatorPlugin } from '@mnmal-ai/substrate-types';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';
import {
  BootstrapConfigError,
  type ConfigSchema,
  type ConfigValidationError,
  defineBootstrap
} from '../src/index.js';

interface PortConfig {
  port: number;
}

const portSchema: ConfigSchema<PortConfig> = {
  safeParse(raw) {
    const port = (raw as { port?: unknown }).port;
    if (typeof port === 'number') return { success: true, data: { port } };
    return {
      success: false,
      error: { issues: [{ path: ['port'], message: 'expected a number' }] }
    };
  }
};

const stubPlugin = (): CoordinatorPlugin => ({
  name: 'test-plugin',
  contractVersion: '^2.3.0',
  namespaces: []
});

describe('structural config schema', () => {
  it('accepts a non-zod validator and passes its parsed data to build', () => {
    let captured: PortConfig | undefined;
    const bootstrap = defineBootstrap.coordinator({
      schema: portSchema,
      build: (config) => {
        captured = config;
        return stubPlugin();
      }
    });
    bootstrap({ port: 3100 });
    expect(captured).toEqual({ port: 3100 });
  });

  it('formats a non-zod failure the same way and exposes it as validationError', () => {
    const bootstrap = defineBootstrap.coordinator({ schema: portSchema, build: stubPlugin });
    try {
      bootstrap({ port: 'x' });
      expect.fail('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(BootstrapConfigError);
      const e = err as BootstrapConfigError;
      expect(e.message).toBe('Plugin config validation failed:\n  • port: expected a number');
      expect(e.validationError.issues).toEqual([{ path: ['port'], message: 'expected a number' }]);
      expect(e.zodError).toBe(e.validationError);
    }
  });

  it('renders an empty path as <root>', () => {
    const err = new BootstrapConfigError({ issues: [{ path: [], message: 'bad' }] });
    expect(err.message).toBe('Plugin config validation failed:\n  • <root>: bad');
  });

  it('infers TConfig from a zod schema, defaults applied', () => {
    const schema = z.object({ name: z.string().default('n') });
    defineBootstrap.coordinator({
      schema,
      build: (config) => {
        expectTypeOf(config).toEqualTypeOf<{ name: string }>();
        return stubPlugin();
      }
    });
    expectTypeOf(schema).toExtend<ConfigSchema<{ name: string }>>();
  });

  it('accepts a zod error as a ConfigValidationError', () => {
    const result = z.object({ n: z.number() }).safeParse({ n: 'x' });
    if (result.success) expect.fail('expected failure');
    expectTypeOf(result.error).toExtend<ConfigValidationError>();
    expect(new BootstrapConfigError(result.error).message).toContain('n:');
  });

  it('rejects a schema without safeParse at compile time', () => {
    defineBootstrap.coordinator({
      // @ts-expect-error — a schema must expose safeParse
      schema: { parse: (raw: unknown) => raw },
      build: stubPlugin
    });
  });
});

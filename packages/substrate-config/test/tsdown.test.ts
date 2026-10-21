import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { UserConfig } from 'tsdown';
import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  defineBinTsdown,
  defineLibTsdown,
  type TsdownBanner,
  type TsdownConfig
} from '../src/tsdown.js';

describe('tsdown helpers', () => {
  it('return a config assignable to the consumer’s own tsdown UserConfig', () => {
    expectTypeOf(defineLibTsdown()).toEqualTypeOf<TsdownConfig>();
    expectTypeOf(defineBinTsdown({ entry: { x: 'src/x.ts' } })).toEqualTypeOf<TsdownConfig>();
    expectTypeOf<TsdownConfig>().toExtend<UserConfig>();
    expectTypeOf<TsdownBanner>().toExtend<NonNullable<UserConfig['banner']>>();
  });

  it('do not import tsdown in their source, so the published types name none of it', () => {
    const src = readFileSync(join(import.meta.dirname, '..', 'src', 'tsdown.ts'), 'utf8');
    expect(src).not.toMatch(/from ['"]tsdown['"]/);
  });

  it('defineLibTsdown maps external to deps.neverBundle and passes banner through', () => {
    const banner = { js: '// hi' };
    const config = defineLibTsdown({ external: ['zod'], platform: 'neutral', banner });
    expect(config).toMatchObject({
      entry: ['src/index.ts'],
      format: ['esm'],
      platform: 'neutral',
      fixedExtension: false,
      dts: false,
      deps: { neverBundle: ['zod'] },
      banner
    });
    expect(defineLibTsdown()).not.toHaveProperty('deps');
    expect(defineLibTsdown()).not.toHaveProperty('banner');
  });

  it('defineBinTsdown merges builtins before extra neverBundle and forwards alwaysBundle', () => {
    const config = defineBinTsdown({
      entry: { bin: 'src/bin.ts' },
      neverBundle: [/^@mnmal-ai\//],
      alwaysBundle: ['x'],
      clean: false
    });
    expect(config.clean).toBe(false);
    expect(config.shims).toBe(true);
    expect(config.deps?.neverBundle?.[0]).toBe('assert');
    expect(config.deps?.neverBundle?.at(-1)).toEqual(/^@mnmal-ai\//);
    expect(config.deps?.alwaysBundle).toEqual(['x']);
  });
});

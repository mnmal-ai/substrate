/**
 * `serve` reads only SUBSTRATE_* env names. A hydra-era env file must not boot a
 * store whose auth silently fell back to off, and any other HYDRA_* key is named
 * at boot so the operator knows it was ignored.
 */
import { describe, expect, it } from 'vitest';
import { EnvConfigError, legacyHydraEnvBanner, parseEnv } from '../src/main.js';

describe('legacy HYDRA_* env', () => {
  it('refuses HYDRA_AUTH_MODE without SUBSTRATE_AUTH_MODE', () => {
    expect(() => parseEnv({ HYDRA_AUTH_MODE: 'required' })).toThrow(EnvConfigError);
    expect(() => parseEnv({ HYDRA_AUTH_MODE: 'required' })).toThrow(/SUBSTRATE_AUTH_MODE/);
  });

  it('lists every other HYDRA_* key it ignores', () => {
    const config = parseEnv({ HYDRA_URL: 'https://x', HYDRA_PG_URL: 'postgres://x' });
    expect(config.legacyHydraEnv).toEqual(['HYDRA_PG_URL', 'HYDRA_URL']);
  });

  it('lists nothing when no HYDRA_* key is set', () => {
    expect(parseEnv({}).legacyHydraEnv).toEqual([]);
  });

  it('names every ignored key in the banner, never its value', () => {
    const banner = legacyHydraEnvBanner(['HYDRA_PG_URL', 'HYDRA_URL']);
    expect(banner).toContain('HYDRA_PG_URL');
    expect(banner).toContain('HYDRA_URL');
    expect(banner).toMatch(/ignoring 2 HYDRA_\* env key/);
  });
});

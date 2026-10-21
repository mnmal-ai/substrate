/**
 * §5.13 — env parsing for mutation idempotency knobs.
 *
 * Pure `parseEnv` coverage: dedup is ON by default, the engine's own 24h
 * default kicks in when no TTL override is supplied, the `SUBSTRATE_IDEMPOTENCY_*`
 * vars shape the returned config, and malformed values throw at boot rather
 * than silently falling back.
 */

import { describe, expect, it } from 'vitest';
import { EnvConfigError, parseEnv } from '../src/main.js';

describe('parseEnv — §5.13 idempotency knobs', () => {
  it('defaults to dedup ON with no TTL override (engine uses its 24h default)', () => {
    const cfg = parseEnv({});
    expect(cfg.idempotency).toEqual({ defaultTtlMs: null, disabled: false });
  });

  it('SUBSTRATE_IDEMPOTENCY_TTL_MS parses as a positive integer override', () => {
    const cfg = parseEnv({ SUBSTRATE_IDEMPOTENCY_TTL_MS: '3600000' });
    expect(cfg.idempotency).toEqual({ defaultTtlMs: 3_600_000, disabled: false });
  });

  it("SUBSTRATE_IDEMPOTENCY_DISABLED='1' disables dedup and drops the TTL override", () => {
    const cfg = parseEnv({
      SUBSTRATE_IDEMPOTENCY_DISABLED: '1',
      SUBSTRATE_IDEMPOTENCY_TTL_MS: '999'
    });
    expect(cfg.idempotency).toEqual({ defaultTtlMs: null, disabled: true });
  });

  it("SUBSTRATE_IDEMPOTENCY_DISABLED='true' (case-insensitive) disables dedup", () => {
    const cfg = parseEnv({ SUBSTRATE_IDEMPOTENCY_DISABLED: 'true' });
    expect(cfg.idempotency.disabled).toBe(true);
    const cfgUpper = parseEnv({ SUBSTRATE_IDEMPOTENCY_DISABLED: 'TRUE' });
    expect(cfgUpper.idempotency.disabled).toBe(true);
    const cfgMixed = parseEnv({ SUBSTRATE_IDEMPOTENCY_DISABLED: 'True' });
    expect(cfgMixed.idempotency.disabled).toBe(true);
  });

  it('SUBSTRATE_IDEMPOTENCY_DISABLED with any other value leaves dedup enabled', () => {
    const cfg = parseEnv({ SUBSTRATE_IDEMPOTENCY_DISABLED: 'no' });
    expect(cfg.idempotency.disabled).toBe(false);
  });

  it('non-integer SUBSTRATE_IDEMPOTENCY_TTL_MS throws EnvConfigError', () => {
    expect(() => parseEnv({ SUBSTRATE_IDEMPOTENCY_TTL_MS: 'abc' })).toThrow(EnvConfigError);
    expect(() => parseEnv({ SUBSTRATE_IDEMPOTENCY_TTL_MS: '1.5' })).toThrow(EnvConfigError);
    expect(() => parseEnv({ SUBSTRATE_IDEMPOTENCY_TTL_MS: 'abc' })).toThrow(
      /SUBSTRATE_IDEMPOTENCY_TTL_MS/
    );
  });

  it('negative SUBSTRATE_IDEMPOTENCY_TTL_MS throws EnvConfigError', () => {
    expect(() => parseEnv({ SUBSTRATE_IDEMPOTENCY_TTL_MS: '-1' })).toThrow(EnvConfigError);
    expect(() => parseEnv({ SUBSTRATE_IDEMPOTENCY_TTL_MS: '-1000' })).toThrow(
      /non-negative integer/
    );
  });
});

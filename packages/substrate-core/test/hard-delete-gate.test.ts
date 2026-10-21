import { ResolverFrameError } from '@mnmal-ai/substrate-types';
import { describe, expect, it } from 'vitest';
import { assertHardDeleteAllowed, validateHardDeleteEnv } from '../src/hard-delete-gate.js';
import { useEnvSnapshot } from './_env-override.js';

describe('assertHardDeleteAllowed', () => {
  useEnvSnapshot('SUBSTRATE_HARD_DELETE');

  it('allows when env is unset (default)', () => {
    delete process.env.SUBSTRATE_HARD_DELETE;
    expect(() => assertHardDeleteAllowed()).not.toThrow();
  });

  it('allows when env is "allow"', () => {
    process.env.SUBSTRATE_HARD_DELETE = 'allow';
    expect(() => assertHardDeleteAllowed()).not.toThrow();
  });

  it('throws ResolverFrameError(destructive_ops_disabled) when env is "refuse"', () => {
    process.env.SUBSTRATE_HARD_DELETE = 'refuse';
    let caught: unknown;
    try {
      assertHardDeleteAllowed();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ResolverFrameError);
    expect((caught as ResolverFrameError).code).toBe('destructive_ops_disabled');
  });
});

describe('validateHardDeleteEnv', () => {
  useEnvSnapshot('SUBSTRATE_HARD_DELETE');

  it('accepts undefined / allow / refuse', () => {
    delete process.env.SUBSTRATE_HARD_DELETE;
    expect(() => validateHardDeleteEnv()).not.toThrow();
    process.env.SUBSTRATE_HARD_DELETE = 'allow';
    expect(() => validateHardDeleteEnv()).not.toThrow();
    process.env.SUBSTRATE_HARD_DELETE = 'refuse';
    expect(() => validateHardDeleteEnv()).not.toThrow();
  });

  it('throws on any other value', () => {
    process.env.SUBSTRATE_HARD_DELETE = 'yes';
    expect(() => validateHardDeleteEnv()).toThrow(/'allow' or 'refuse'/);
  });
});

import { describe, expect, it } from 'vitest';
import {
  BridgeUnreachableError,
  isResolverFrameError,
  isRestrictViolation,
  MissingReferentError,
  ResolverFrameError,
  RestrictViolation
} from '../src/errors.js';

describe('isResolverFrameError', () => {
  it('recognises a same-realm instance', () => {
    expect(isResolverFrameError(new ResolverFrameError('invalid_enum_value', 'bad'))).toBe(true);
  });

  it('recognises a foreign-realm base ResolverFrameError by brand + code (instanceof would fail)', () => {
    // A ResolverFrameError thrown from a different module realm (bundled
    // plugin): structurally identical, not `instanceof` the local class.
    const foreign = Object.assign(new Error('bad'), {
      name: 'ResolverFrameError',
      __substrateResolverFrameError: true,
      code: 'invalid_enum_value'
    });
    expect(foreign instanceof ResolverFrameError).toBe(false);
    expect(isResolverFrameError(foreign)).toBe(true);
  });

  it('recognises a same-realm MissingReferentError despite its overridden name', () => {
    const err = new MissingReferentError('trace', { ns: 'labs', type: 'Trace', id: 't1' });
    expect(isResolverFrameError(err)).toBe(true);
  });

  it('recognises a foreign-realm MissingReferentError whose name is NOT "ResolverFrameError"', () => {
    // A subclass overrides `name` to its own tag, so a name-based brand check
    // misses it. The dedicated __substrateResolverFrameError field survives the
    // override because it's set once on the base class and never reassigned.
    const foreign = {
      name: 'MissingReferentError',
      __substrateResolverFrameError: true,
      code: 'missing_referent',
      message: 'x',
      details: {}
    };
    expect(isResolverFrameError(foreign)).toBe(true);
  });

  it('rejects unrelated errors and non-errors', () => {
    expect(isResolverFrameError(new Error('plain'))).toBe(false);
    expect(isResolverFrameError({ name: 'ResolverFrameError' })).toBe(false); // no brand, no code
    expect(isResolverFrameError({ name: 'TypeError', message: 'x' })).toBe(false); // no brand, no code
    expect(isResolverFrameError(null)).toBe(false);
    expect(isResolverFrameError('invalid_enum_value')).toBe(false);
  });
});

describe('isRestrictViolation', () => {
  it('recognises a same-realm instance', () => {
    const v = new RestrictViolation({ ns: 'default', type: 'Todo', id: '1' }, []);
    expect(isRestrictViolation(v)).toBe(true);
  });

  it('recognises a foreign-realm error by name + blockedBy brand', () => {
    const foreign = Object.assign(new Error('restrict'), {
      name: 'RestrictViolation',
      blockedBy: [{ id: 'edge-1' }]
    });
    expect(foreign instanceof RestrictViolation).toBe(false);
    expect(isRestrictViolation(foreign)).toBe(true);
  });

  it('rejects unrelated errors and non-errors', () => {
    expect(isRestrictViolation(new Error('plain'))).toBe(false);
    expect(isRestrictViolation({ name: 'RestrictViolation' })).toBe(false); // no blockedBy array
    expect(isRestrictViolation(null)).toBe(false);
  });
});

describe('MissingReferentError', () => {
  it('carries the missing_referent code, structured details, and message', () => {
    const err = new MissingReferentError('trace', { ns: 'labs', type: 'Trace', id: 't-99' });
    expect(err).toBeInstanceOf(ResolverFrameError);
    expect(err.name).toBe('MissingReferentError');
    expect(err.code).toBe('missing_referent');
    expect(err.details).toEqual({
      field: 'trace',
      target: { ns: 'labs', type: 'Trace', id: 't-99' }
    });
    expect(err.message).toContain('labs/Trace');
    expect(err.message).toContain('t-99');
  });
});

describe('BridgeUnreachableError', () => {
  it('says unreachable when the peer genuinely could not be reached', () => {
    const err = new BridgeUnreachableError('peer-b', 'https://b.internal:3100', 'HTTP 503');
    expect(err.message).toContain('unreachable');
    expect(err.message).toContain('peer-b');
    expect(err.message).toContain('https://b.internal:3100');
  });

  /**
   * An auth failure (401/403) means the peer was reachable and made a
   * deliberate authorization decision. Calling that "unreachable" sends the
   * operator to chase DNS, TLS and network instead of the credential.
   */
  it('says refused, not unreachable, when the peer answered with an auth failure', () => {
    const err = new BridgeUnreachableError('peer-b', 'https://b.internal:3100', 'HTTP 403 (auth)');
    expect(err.message).not.toContain('unreachable');
    expect(err.message).toContain('refused');
    expect(err.message).toContain('403');
    expect(err.message).toMatch(/capabilit|authoriz/i);
  });

  it('keeps bridgeName, baseUrl and cause addressable either way', () => {
    const err = new BridgeUnreachableError('peer-b', 'https://b.internal:3100', 'HTTP 401 (auth)');
    expect(err.bridgeName).toBe('peer-b');
    expect(err.baseUrl).toBe('https://b.internal:3100');
    expect(err.cause).toBe('HTTP 401 (auth)');
    expect(err.name).toBe('BridgeUnreachableError');
  });
});

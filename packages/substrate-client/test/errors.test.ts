import { describe, expect, it } from 'vitest';
import { AuthError, NetworkError, SchemaDriftError, SubscribeError } from '../src/errors.js';

describe('SchemaDriftError (re-exported from substrate-pack)', () => {
  it('carries envelope + expected versions', () => {
    const err = new SchemaDriftError('abc123', 'def456');
    expect(err.envelopeSchemaVersion).toBe('abc123');
    expect(err.expectedSchemaVersion).toBe('def456');
    expect(err.name).toBe('SchemaDriftError');
    expect(err.message).toContain('abc123');
    expect(err.message).toContain('def456');
  });

  it('is instanceof Error', () => {
    expect(new SchemaDriftError('a', 'b')).toBeInstanceOf(Error);
  });
});

describe('NetworkError', () => {
  it('wraps a cause', () => {
    const cause = new Error('econnrefused');
    const err = new NetworkError('fetch failed', cause);
    expect(err.cause).toBe(cause);
    expect(err.name).toBe('NetworkError');
  });
});

describe('AuthError', () => {
  it('carries HTTP status', () => {
    const err = new AuthError('unauthorised', 401);
    expect(err.status).toBe(401);
    expect(err.name).toBe('AuthError');
  });

  it('accepts 403', () => {
    const err = new AuthError('forbidden', 403);
    expect(err.status).toBe(403);
  });
});

describe('SubscribeError', () => {
  it('carries a code string', () => {
    const err = new SubscribeError('bus closed', 'bus_closed');
    expect(err.code).toBe('bus_closed');
    expect(err.name).toBe('SubscribeError');
  });
});

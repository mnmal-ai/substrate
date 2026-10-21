import { describe, expect, it } from 'vitest';
import { decodeJoinToken, encodeJoinToken, JoinTokenError } from '../src/cli/federate/token.js';

/** Build a token around an arbitrary payload, bypassing encodeJoinToken's typing. */
function tokenFor(payload: unknown): string {
  const b64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `substrate-join-v1.${b64}`;
}

describe('join token', () => {
  it('round-trips origin and code', () => {
    const token = encodeJoinToken({ origin: 'https://b.internal:3100', code: 'abc123' });
    expect(token.startsWith('substrate-join-v1.')).toBe(true);
    expect(decodeJoinToken(token)).toEqual({
      origin: 'https://b.internal:3100',
      code: 'abc123'
    });
  });

  it('normalises the origin so it matches new URL(url).origin', () => {
    // A trailing slash and a path must both collapse to the bare origin —
    // this is what makes an origin mismatch at boot impossible to cause
    // via the token.
    for (const raw of [
      'https://b.internal:3100/',
      'https://b.internal:3100/substrate/v1/query',
      'https://b.internal:3100'
    ]) {
      expect(decodeJoinToken(tokenFor({ origin: raw, code: 'c' })).origin).toBe(
        'https://b.internal:3100'
      );
    }
  });

  it('rejects a token without the versioned prefix', () => {
    expect(() => decodeJoinToken('abc123')).toThrow(JoinTokenError);
    expect(() => decodeJoinToken('abc123')).toThrow(/substrate-join-v1\./);
  });

  it('rejects a future token version', () => {
    expect(() => decodeJoinToken('substrate-join-v2.eyJhIjoxfQ')).toThrow(/substrate-join-v1\./);
  });

  it('rejects an empty payload', () => {
    expect(() => decodeJoinToken('substrate-join-v1.')).toThrow(/empty payload/);
  });

  it('rejects a payload outside the base64url alphabet', () => {
    expect(() => decodeJoinToken('substrate-join-v1.not base64!')).toThrow(/base64url/);
  });

  it('rejects a payload that is not JSON', () => {
    const b64 = Buffer.from('this is not json', 'utf8').toString('base64url');
    expect(() => decodeJoinToken(`substrate-join-v1.${b64}`)).toThrow(/valid JSON/);
  });

  it('rejects a payload that is not a JSON object', () => {
    expect(() => decodeJoinToken(tokenFor([1, 2]))).toThrow(/JSON object/);
  });

  it('rejects a payload missing code', () => {
    expect(() => decodeJoinToken(tokenFor({ origin: 'https://b.internal' }))).toThrow(/'code'/);
  });

  it('rejects a payload missing origin', () => {
    expect(() => decodeJoinToken(tokenFor({ code: 'c' }))).toThrow(/'origin'/);
  });

  it('rejects a non-http(s) origin', () => {
    expect(() => decodeJoinToken(tokenFor({ origin: 'ftp://b.internal', code: 'c' }))).toThrow(
      /http\(s\)/
    );
  });

  it('rejects an unparseable origin', () => {
    expect(() => decodeJoinToken(tokenFor({ origin: 'not a url', code: 'c' }))).toThrow(
      /not a valid URL/
    );
  });

  it('tolerates surrounding whitespace from a paste', () => {
    const token = encodeJoinToken({ origin: 'https://b.internal:3100', code: 'abc123' });
    expect(decodeJoinToken(`  ${token}\n`).code).toBe('abc123');
  });
});

/**
 * Cursor encoding round-trip tests. Spec §5.2.
 */

import { describe, expect, it } from 'vitest';
import { CursorDecodeError, decodeCursor, encodeCursor } from '../src/index.js';

describe('encodeCursor / decodeCursor', () => {
  it('round-trips a simple payload', () => {
    const cursor = encodeCursor({ orderByValues: ['2026-04-18', 42], id: 't1' });
    const out = decodeCursor(cursor);
    expect(out.id).toBe('t1');
    expect(out.orderByValues).toEqual(['2026-04-18', 42]);
  });

  it('uses base64url — no +, /, or = in the output', () => {
    // Force binary content via weird characters that'd normally encode to + or /.
    const cursor = encodeCursor({ orderByValues: ['>>??<<'], id: 'b\xefd' });
    expect(cursor).not.toMatch(/[+/=]/);
  });

  it('round-trips a numeric id', () => {
    const cursor = encodeCursor({ orderByValues: [], id: 42 });
    expect(decodeCursor(cursor).id).toBe(42);
  });

  it('throws CursorDecodeError on non-base64 input', () => {
    expect(() => decodeCursor('\u0000!@#$%^&*')).toThrow(CursorDecodeError);
  });

  it('throws CursorDecodeError on non-JSON payload', () => {
    const garbage = Buffer.from('not valid json', 'utf8').toString('base64url');
    expect(() => decodeCursor(garbage)).toThrow(CursorDecodeError);
  });

  it('throws CursorDecodeError when orderByValues is missing', () => {
    const bad = Buffer.from(JSON.stringify({ id: 'x' }), 'utf8').toString('base64url');
    expect(() => decodeCursor(bad)).toThrow(CursorDecodeError);
  });

  it('throws CursorDecodeError when id is missing or wrong type', () => {
    const badId = Buffer.from(
      JSON.stringify({ orderByValues: [], id: { nested: true } }),
      'utf8'
    ).toString('base64url');
    expect(() => decodeCursor(badId)).toThrow(CursorDecodeError);
  });

  it('throws CursorDecodeError when an orderByValue is not a scalar', () => {
    for (const forged of [{ $gt: 1 }, [1, 2]]) {
      const bad = Buffer.from(
        JSON.stringify({ orderByValues: ['a', forged], id: 'x' }),
        'utf8'
      ).toString('base64url');
      expect(() => decodeCursor(bad)).toThrow(CursorDecodeError);
    }
    const ok = encodeCursor({ orderByValues: ['a', 1, true, null], id: 'x' });
    expect(decodeCursor(ok).orderByValues).toEqual(['a', 1, true, null]);
  });
});

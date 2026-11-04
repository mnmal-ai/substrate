/**
 * Cursor encoding round-trip tests. Spec §5.2.
 */

import { describe, expect, it } from 'vitest';
import { CursorDecodeError, type CursorOrder, decodeCursor, encodeCursor } from '../src/index.js';

const ID: CursorOrder = [['id', 'asc']];

describe('encodeCursor / decodeCursor', () => {
  it('round-trips a simple payload', () => {
    const cursor = encodeCursor({ orderByValues: ['2026-04-18', 42], id: 't1', order: ID });
    const out = decodeCursor(cursor, ID);
    expect(out.id).toBe('t1');
    expect(out.orderByValues).toEqual(['2026-04-18', 42]);
  });

  it('uses base64url — no +, /, or = in the output', () => {
    // Force binary content via weird characters that'd normally encode to + or /.
    const cursor = encodeCursor({ orderByValues: ['>>??<<'], id: 'b\xefd', order: ID });
    expect(cursor).not.toMatch(/[+/=]/);
  });

  it('round-trips a numeric id', () => {
    const cursor = encodeCursor({ orderByValues: [], id: 42, order: ID });
    expect(decodeCursor(cursor, ID).id).toBe(42);
  });

  it('throws CursorDecodeError on non-base64 input', () => {
    expect(() => decodeCursor('\u0000!@#$%^&*', ID)).toThrow(CursorDecodeError);
  });

  it('throws CursorDecodeError on non-JSON payload', () => {
    const garbage = Buffer.from('not valid json', 'utf8').toString('base64url');
    expect(() => decodeCursor(garbage, ID)).toThrow(CursorDecodeError);
  });

  it('throws CursorDecodeError when orderByValues is missing', () => {
    const bad = Buffer.from(JSON.stringify({ id: 'x' }), 'utf8').toString('base64url');
    expect(() => decodeCursor(bad, ID)).toThrow(CursorDecodeError);
  });

  it('throws CursorDecodeError when id is missing or wrong type', () => {
    const badId = Buffer.from(
      JSON.stringify({ orderByValues: [], id: { nested: true } }),
      'utf8'
    ).toString('base64url');
    expect(() => decodeCursor(badId, ID)).toThrow(CursorDecodeError);
  });

  it('throws CursorDecodeError when an orderByValue is not a scalar', () => {
    for (const forged of [{ $gt: 1 }, [1, 2]]) {
      const bad = Buffer.from(
        JSON.stringify({ orderByValues: ['a', forged], id: 'x' }),
        'utf8'
      ).toString('base64url');
      expect(() => decodeCursor(bad, ID)).toThrow(CursorDecodeError);
    }
    const ok = encodeCursor({ orderByValues: ['a', 1, true, null], id: 'x', order: ID });
    expect(decodeCursor(ok, ID).orderByValues).toEqual(['a', 1, true, null]);
  });

  it('refuses a cursor without an order (the pre-signing format) as invalid_cursor', () => {
    const legacy = Buffer.from(JSON.stringify({ orderByValues: [], id: 'x' }), 'utf8').toString(
      'base64url'
    );
    expect(() => decodeCursor(legacy, ID)).toThrow(/carries no 'order'/);
    try {
      decodeCursor(legacy, ID);
    } catch (err) {
      expect(err).toMatchObject({ code: 'invalid_cursor', details: { field: 'cursor' } });
    }
  });

  it('refuses a cursor replayed under a different order, naming both', () => {
    const issued: CursorOrder = [
      ['createdAt', 'desc'],
      ['id', 'asc']
    ];
    const cursor = encodeCursor({ orderByValues: ['2026-01-01'], id: 'x', order: issued });
    expect(() => decodeCursor(cursor, issued)).not.toThrow();
    expect(() =>
      decodeCursor(cursor, [
        ['rating', 'desc'],
        ['id', 'asc']
      ])
    ).toThrow(
      /issued for orderBy 'createdAt desc, id asc' but this read orders by 'rating desc, id asc'/
    );
  });
});

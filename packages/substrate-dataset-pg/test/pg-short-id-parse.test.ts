/**
 * Pure-logic tests for `parseShortId`'s safe-integer guard. No POSTGRES_URL
 * required: the source module has only type-only `postgres` imports, so it
 * loads without a configured pg.
 */

import { describe, expect, it } from 'vitest';
import { parseShortId } from '../src/pg-short-id-store.js';

describe('parseShortId', () => {
  it('returns 0 for undefined (no row returned)', () => {
    expect(parseShortId(undefined)).toBe(0);
  });

  it('parses small positive integers', () => {
    expect(parseShortId('1')).toBe(1);
    expect(parseShortId('42')).toBe(42);
    expect(parseShortId('1000')).toBe(1000);
  });

  it('parses Number.MAX_SAFE_INTEGER exactly', () => {
    // 2^53 - 1 = 9007199254740991 — the largest value JS can hold without
    // rounding. This must round-trip exactly through the helper.
    const max = Number.MAX_SAFE_INTEGER;
    expect(parseShortId(String(max))).toBe(max);
  });

  it('throws when raw exceeds Number.MAX_SAFE_INTEGER', () => {
    // 2^53 + 1 = 9007199254740993. JS Number cannot represent it; parseInt
    // would silently round to 9007199254740992. The guard must catch this.
    expect(() => parseShortId('9007199254740993')).toThrow(/exceeds JS safe integer range/);
  });

  it('throws on a much-larger bigint string (well beyond safe range)', () => {
    // Worst case: a hand-rolled value or a sequence inflated by a CYCLEd or
    // mis-restored sequence. Must still throw rather than silently corrupt.
    expect(() => parseShortId('18446744073709551615')).toThrow(/exceeds JS safe integer range/);
  });
});

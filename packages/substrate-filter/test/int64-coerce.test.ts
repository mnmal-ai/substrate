import { describe, expect, it } from 'vitest';
import { evaluateWhere, parseInt64 } from '../src/index.js';

describe('parseInt64', () => {
  it.each([
    [9007199254740993n, 9007199254740993n],
    ['9223372036854775807', 2n ** 63n - 1n],
    ['-9223372036854775808', -(2n ** 63n)],
    [42, 42n],
    ['0', 0n],
    ['-7', -7n]
  ])('reads %s', (input, expected) => {
    expect(parseInt64(input)).toBe(expected);
  });

  it.each([
    '007',
    '1e3',
    '+1',
    '1.5',
    '',
    '9223372036854775808',
    '-9223372036854775809',
    1.5,
    2 ** 53,
    Number.NaN,
    2n ** 63n,
    null,
    true,
    {}
  ])('refuses %s', (input) => {
    expect(parseInt64(input)).toBeUndefined();
  });
});

describe('evaluateWhere on an int64 field', () => {
  const def = { kind: 'scalar', type: 'int64' } as const;
  const fieldDefOf = (f: string) => (f === 'n' ? def : undefined);
  const row = { id: 'a', n: 9007199254740993n };

  it('compares exactly past 2^53, whatever form the operand takes', () => {
    expect(evaluateWhere(row, { n: { eq: '9007199254740993' } }, fieldDefOf)).toBe(true);
    expect(evaluateWhere(row, { n: { eq: '9007199254740992' } }, fieldDefOf)).toBe(false);
    expect(evaluateWhere(row, { n: { gt: '9007199254740992' } }, fieldDefOf)).toBe(true);
    expect(evaluateWhere(row, { n: { lte: 9007199254740991 } }, fieldDefOf)).toBe(false);
    expect(evaluateWhere(row, { n: { in: [1, '9007199254740993'] } }, fieldDefOf)).toBe(true);
    expect(
      evaluateWhere(row, { n: { between: ['9007199254740993', '9007199254740994'] } }, fieldDefOf)
    ).toBe(true);
  });

  it('refuses an operand that is not an int64', () => {
    expect(() => evaluateWhere(row, { n: { gt: 1.5 } }, fieldDefOf)).toThrow(/int64/);
  });
});

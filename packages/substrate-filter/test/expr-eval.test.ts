import type { Expr } from '@mnmal-ai/substrate-types';
import { describe, expect, it } from 'vitest';
import { evalExpr } from '../src/expr-eval.js';
import { EXPR_CORPUS } from './fixtures/expr-corpus.js';

describe('evalExpr corpus', () => {
  it.each(EXPR_CORPUS)('$name', ({ expr, row, expected }) => {
    expect(evalExpr(expr, row)).toEqual(expected);
  });
});

describe('evalExpr', () => {
  it('throws RangeError outside int64', () => {
    expect(() => evalExpr({ add: ['a', 1] }, { a: 9223372036854775807n })).toThrow(RangeError);
    expect(() => evalExpr({ mul: ['a', 2] }, { a: 9223372036854775807n })).toThrow(RangeError);
    expect(() => evalExpr({ neg: ['a'] }, { a: -(2n ** 63n) })).toThrow(RangeError);
  });
  it('throws RangeError on int64 sub overflow', () => {
    expect(() => evalExpr({ sub: ['a', 1] }, { a: -(2n ** 63n) })).toThrow(RangeError);
  });
  it('raises on float8 overflow and underflow, as Postgres does', () => {
    expect(() => evalExpr({ mul: [1e200, 1e200] }, {})).toThrow('value out of range: overflow');
    expect(() => evalExpr({ mul: [1e-200, 1e-200] }, {})).toThrow('value out of range: underflow');
    expect(() => evalExpr({ add: [1.7e308, 1.7e308] }, {})).toThrow('value out of range: overflow');
    expect(() => evalExpr({ div: [1e-200, 1e200] }, {})).toThrow('value out of range: underflow');
  });
  it('refuses a LIKE pattern ending in an escape', () => {
    expect(() => evalExpr({ like: [{ lit: 'a' }, { lit: 'a\\' }] }, {})).toThrow(
      'LIKE pattern must not end with escape character'
    );
  });
  it('matches LIKE with many wildcards without blowing up', () => {
    const pattern = `${'%a'.repeat(30)}b`;
    expect(evalExpr({ like: [{ lit: 'a'.repeat(5000) }, { lit: pattern }] }, {})).toBe(false);
  });
  it('does not resolve bare strings through the prototype chain', () => {
    expect(evalExpr('constructor', {})).toBeNull();
    expect(evalExpr('constructor', {}, { output: {} })).toBeNull();
    expect(evalExpr({ eq: ['constructor', 1] }, {})).toBeNull();
  });
  it('reads bare strings from the output first, then the row', () => {
    expect(evalExpr('a', { a: 1 }, { output: { a: 2 } })).toBe(2);
    expect(evalExpr('a', { a: 1 }, { output: { b: 2 } })).toBe(1);
  });
  it('reads a missing field as null and a Date as an ISO string', () => {
    expect(evalExpr('zz', {})).toBeNull();
    expect(evalExpr('d', { d: new Date('2013-07-17T10:11:12Z') })).toBe('2013-07-17T10:11:12.000Z');
  });
  it('never throws on null input', () => {
    for (const fn of ['length', 'lower', 'upper', 'neg', 'not']) {
      expect(evalExpr({ [fn]: [null] } as Expr, {})).toBeNull();
    }
    expect(evalExpr({ mod: [1, 0] }, {})).toBeNull();
  });
});

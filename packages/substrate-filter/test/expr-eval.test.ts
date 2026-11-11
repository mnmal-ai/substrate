import type { Expr, ExprType } from '@mnmal-ai/substrate-types';
import { describe, expect, it } from 'vitest';
import { type EvalEnv, evalExpr } from '../src/expr-eval.js';
import { CORPUS_FIELD_TYPES, EXPR_CORPUS } from './fixtures/expr-corpus.js';

const FIELDS = { ...CORPUS_FIELD_TYPES, a: 'int64', zz: 'number', b: 'number' } as const;
const fieldType = (n: string) => (FIELDS as Record<string, ExprType | undefined>)[n];
const ev = (e: Expr, row: Record<string, unknown>, env: Partial<EvalEnv> = {}) =>
  evalExpr(e, row, { fieldType, ...env });

describe('evalExpr corpus', () => {
  it.each(EXPR_CORPUS)('$name', ({ expr, row, expected }) => {
    expect(ev(expr, row)).toEqual(expected);
  });
});

describe('evalExpr', () => {
  it("raises pg's message on int64 overflow", () => {
    expect(() => ev({ add: ['a', 1] }, { a: 9223372036854775807n })).toThrow('bigint out of range');
  });
  it('throws RangeError outside int64', () => {
    expect(() => ev({ add: ['a', 1] }, { a: 9223372036854775807n })).toThrow(RangeError);
    expect(() => ev({ mul: ['a', 2] }, { a: 9223372036854775807n })).toThrow(RangeError);
    expect(() => ev({ neg: ['a'] }, { a: -(2n ** 63n) })).toThrow(RangeError);
  });
  it('throws RangeError on int64 sub overflow', () => {
    expect(() => ev({ sub: ['a', 1] }, { a: -(2n ** 63n) })).toThrow(RangeError);
  });
  it('raises on float8 overflow and underflow, as Postgres does', () => {
    expect(() => ev({ mul: [1e200, 1e200] }, {})).toThrow('value out of range: overflow');
    expect(() => ev({ mul: [1e-200, 1e-200] }, {})).toThrow('value out of range: underflow');
    expect(() => ev({ add: [1.7e308, 1.7e308] }, {})).toThrow('value out of range: overflow');
    expect(() => ev({ div: [1e-200, 1e200] }, {})).toThrow('value out of range: underflow');
  });
  it('compares an int64 beside a number as a number', () => {
    expect(ev({ lt: [9007199254740992, 'big'] }, { big: 9007199254740993n })).toBe(false);
    expect(ev({ in: ['big', 9007199254740992] }, { big: 9007199254740993n })).toBe(true);
  });
  it('matches LIKE with many wildcards without blowing up', () => {
    const pattern = `${'%a'.repeat(30)}b`;
    expect(ev({ like: [{ lit: 'a'.repeat(5000) }, { lit: pattern }] }, {})).toBe(false);
  });
  it('does not resolve bare strings through the prototype chain', () => {
    expect(ev('constructor', {})).toBeNull();
    expect(ev('constructor', {}, { output: {} })).toBeNull();
    expect(ev({ eq: ['constructor', 1] }, {})).toBeNull();
  });
  it('reads bare strings from the output first, then the row', () => {
    expect(ev('a', { a: 1 }, { output: { a: 2 } })).toBe(2);
    expect(ev('a', { a: 1 }, { output: { b: 2 } })).toBe(1);
  });
  it('reads a missing field as null and a Date as canonical microsecond text', () => {
    expect(ev('zz', {})).toBeNull();
    expect(ev('d', { d: new Date('2013-07-17T10:11:12Z') })).toBe('2013-07-17T10:11:12.000000Z');
  });
  it('never throws on null input', () => {
    for (const fn of ['length', 'lower', 'upper', 'neg', 'not']) {
      expect(ev({ [fn]: [null] } as Expr, {})).toBeNull();
    }
    expect(ev({ mod: [1, 0] }, {})).toBeNull();
  });
});

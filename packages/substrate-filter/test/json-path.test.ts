/**
 * Json path predicates — the reference semantics
 * both substrates must match. Type-strict throughout.
 */

import { UnsupportedFilterError } from '@mnmal-ai/substrate-types';
import { describe, expect, it } from 'vitest';
import {
  evaluateJsonPathPredicate,
  isJsonPathPredicate,
  JSON_PATH_OPS,
  jsonPathNeedsScan,
  jsonPathOperandProblem,
  jsonPathProblem,
  resolveJsonPath
} from '../src/index.js';

const ev = (value: unknown, pred: Record<string, unknown>): boolean =>
  evaluateJsonPathPredicate('values', value, pred as never);

describe('isJsonPathPredicate', () => {
  it('is true only when path is an array', () => {
    expect(isJsonPathPredicate({ path: ['a'], eq: 1 })).toBe(true);
    expect(isJsonPathPredicate({ path: { eq: 'x' } })).toBe(false); // struct sub-field named path
    expect(isJsonPathPredicate({ eq: 1 })).toBe(false);
    expect(isJsonPathPredicate(null)).toBe(false);
    expect(isJsonPathPredicate([])).toBe(false);
  });
});

describe('JSON_PATH_OPS', () => {
  it('is the full scalar set plus has', () => {
    expect([...JSON_PATH_OPS].sort()).toEqual(
      [
        'between',
        'contains',
        'endsWith',
        'eq',
        'gt',
        'gte',
        'has',
        'in',
        'lt',
        'lte',
        'neq',
        'nin',
        'startsWith'
      ].sort()
    );
  });
});

describe('jsonPathProblem', () => {
  it('accepts 1..16 non-empty strings', () => {
    expect(jsonPathProblem(['a'])).toBeNull();
    expect(jsonPathProblem(Array.from({ length: 16 }, () => 'k'))).toBeNull();
  });
  it('refuses empty, too deep, non-string and empty-string segments', () => {
    expect(jsonPathProblem([])).toMatch(/at least one key/);
    expect(jsonPathProblem(Array.from({ length: 17 }, () => 'k'))).toMatch(/deeper than 16/);
    expect(jsonPathProblem([0])).toMatch(/non-empty strings/);
    expect(jsonPathProblem([''])).toMatch(/non-empty strings/);
  });
});

describe('jsonPathOperandProblem', () => {
  it.each([
    ['eq', 1],
    ['eq', 'x'],
    ['eq', true],
    ['eq', null],
    ['in', [1, 'x', null]],
    ['nin', []],
    ['gt', 1],
    ['lte', 'm'],
    ['between', [1, 2]],
    ['between', ['a', 'b']],
    ['contains', 'x'],
    ['has', 'x'],
    ['has', 3]
  ])('accepts %s %j', (op, operand) => {
    expect(jsonPathOperandProblem(op, operand)).toBeNull();
  });
  it.each([
    ['eq', { a: 1 }],
    ['eq', [1]],
    ['eq', new Date()],
    ['in', 'x'],
    ['in', [{ a: 1 }]],
    ['in', [new Date()]],
    ['gt', true],
    ['gt', null],
    ['between', [1]],
    ['between', [1, 'b']],
    ['contains', 3],
    ['has', null],
    ['has', { a: 1 }],
    ['bogus', 1]
  ])('refuses %s %j', (op, operand) => {
    expect(jsonPathOperandProblem(op, operand)).not.toBeNull();
  });
  it.each([
    ['eq', Number.NaN],
    ['eq', Number.POSITIVE_INFINITY],
    ['gt', Number.NEGATIVE_INFINITY],
    ['in', [1, Number.NaN]],
    ['between', [0, Number.POSITIVE_INFINITY]],
    ['has', Number.NaN]
  ])('refuses non-finite %s %j — JSON cannot hold it, and pg would read null', (op, operand) => {
    expect(jsonPathOperandProblem(op, operand)).toMatch(/finite/);
  });
  it('caps in/nin membership so both backends refuse the same size', () => {
    expect(
      jsonPathOperandProblem(
        'in',
        Array.from({ length: 10_000 }, (_, i) => i)
      )
    ).toBeNull();
    expect(
      jsonPathOperandProblem(
        'nin',
        Array.from({ length: 10_001 }, (_, i) => i)
      )
    ).toMatch(/10000/);
  });
  it('points a Date at ISO strings', () => {
    expect(jsonPathOperandProblem('gt', new Date())).toMatch(/ISO string/);
  });
});

describe('jsonPathNeedsScan', () => {
  it('lets containment-compilable operators through', () => {
    expect(jsonPathNeedsScan('eq', 1)).toBe(false);
    expect(jsonPathNeedsScan('in', [1, 2])).toBe(false);
    expect(jsonPathNeedsScan('in', [])).toBe(false);
    expect(jsonPathNeedsScan('has', 'x')).toBe(false);
  });
  it('flags a large in — past a few dozen members the planner scans anyway', () => {
    expect(
      jsonPathNeedsScan(
        'in',
        Array.from({ length: 32 }, (_, i) => i)
      )
    ).toBe(false);
    expect(
      jsonPathNeedsScan(
        'in',
        Array.from({ length: 33 }, (_, i) => i)
      )
    ).toBe(true);
  });
  it('flags every scan', () => {
    expect(jsonPathNeedsScan('eq', null)).toBe(true);
    expect(jsonPathNeedsScan('in', [1, null])).toBe(true);
    for (const op of [
      'neq',
      'nin',
      'gt',
      'gte',
      'lt',
      'lte',
      'between',
      'contains',
      'startsWith',
      'endsWith'
    ]) {
      expect(jsonPathNeedsScan(op, 1)).toBe(true);
    }
  });
});

describe('resolveJsonPath', () => {
  it('walks plain objects only', () => {
    expect(resolveJsonPath({ a: { b: 7 } }, ['a', 'b'])).toBe(7);
    expect(resolveJsonPath({ a: 1 }, ['a', 'b'])).toBeUndefined(); // hop into a scalar
    expect(resolveJsonPath({ a: ['x'] }, ['a', '0'])).toBeUndefined(); // never indexes an array
    expect(resolveJsonPath({ a: { '0': 'x' } }, ['a', '0'])).toBe('x'); // "0" is a key
    expect(resolveJsonPath(null, ['a'])).toBeUndefined();
    expect(resolveJsonPath({ a: null }, ['a'])).toBeNull();
    expect(resolveJsonPath({}, ['toString'])).toBeUndefined(); // own keys only
  });
});

describe('evaluateJsonPathPredicate — type-strict truth table', () => {
  const v = {
    year: 1995,
    s: '1995',
    done: true,
    sdone: 'true',
    genre: 'Jazz Fusion',
    tags: ['jazz', 3],
    nul: null,
    contains: 'x'
  };

  it('eq is strict', () => {
    expect(ev(v, { path: ['year'], eq: 1995 })).toBe(true);
    expect(ev(v, { path: ['year'], eq: '1995' })).toBe(false);
    expect(ev(v, { path: ['s'], eq: 1995 })).toBe(false);
    expect(ev(v, { path: ['done'], eq: true })).toBe(true);
    expect(ev(v, { path: ['sdone'], eq: true })).toBe(false);
  });
  it('eq null matches absent and explicit null', () => {
    expect(ev(v, { path: ['nul'], eq: null })).toBe(true);
    expect(ev(v, { path: ['missing'], eq: null })).toBe(true);
    expect(ev(null, { path: ['year'], eq: null })).toBe(true);
    expect(ev(v, { path: ['year'], eq: null })).toBe(false);
  });
  it('neq / nin negate eq / in exactly', () => {
    expect(ev(v, { path: ['missing'], neq: 5 })).toBe(true);
    expect(ev(v, { path: ['year'], neq: 1995 })).toBe(false);
    expect(ev(v, { path: ['nul'], neq: null })).toBe(false);
    expect(ev(v, { path: ['year'], in: [1, 1995] })).toBe(true);
    expect(ev(v, { path: ['missing'], in: [null] })).toBe(true);
    expect(ev(v, { path: ['year'], in: [] })).toBe(false);
    expect(ev(v, { path: ['year'], nin: [] })).toBe(true);
    expect(ev(v, { path: ['s'], nin: [1995] })).toBe(true);
  });
  it('ranges match only on the same JSON type', () => {
    expect(ev(v, { path: ['year'], gt: 1990 })).toBe(true);
    expect(ev(v, { path: ['s'], gt: 1990 })).toBe(false);
    expect(ev(v, { path: ['s'], gt: '1990' })).toBe(true);
    expect(ev(v, { path: ['missing'], lt: 5 })).toBe(false);
    expect(ev(v, { path: ['year'], gte: 1995, lt: 2000 })).toBe(true);
    expect(ev(v, { path: ['year'], between: [1990, 2000] })).toBe(true);
    expect(ev(v, { path: ['year'], between: ['1990', '2000'] })).toBe(false);
  });
  it('orders strings by code point, not UTF-16 unit', () => {
    // U+FF5E (fullwidth tilde) sorts BELOW U+1F600 by code point, ABOVE it by UTF-16 unit.
    expect(ev({ k: '～' }, { path: ['k'], lt: '\u{1F600}' })).toBe(true);
  });
  it('text ops are case-insensitive and string-only', () => {
    expect(ev(v, { path: ['genre'], contains: 'jazz' })).toBe(true);
    expect(ev(v, { path: ['genre'], startsWith: 'JAZZ' })).toBe(true);
    expect(ev(v, { path: ['genre'], endsWith: 'ion' })).toBe(true);
    expect(ev(v, { path: ['year'], contains: '99' })).toBe(false);
  });
  it('has needs an array and a strictly-equal element', () => {
    expect(ev(v, { path: ['tags'], has: 'jazz' })).toBe(true);
    expect(ev(v, { path: ['tags'], has: 3 })).toBe(true);
    expect(ev(v, { path: ['tags'], has: '3' })).toBe(false);
    expect(ev({ tags: { '0': 'jazz' } }, { path: ['tags'], has: 'jazz' })).toBe(false);
  });
  it('a data key named like an operator is just a key', () => {
    expect(ev(v, { path: ['contains'], eq: 'x' })).toBe(true);
  });
  it('refuses a malformed predicate loudly', () => {
    expect(() => ev(v, { path: [], eq: 1 })).toThrow(UnsupportedFilterError);
    expect(() => ev(v, { path: ['year'] })).toThrow(/at least one operator/);
    expect(() => ev(v, { path: ['year'], gt: true })).toThrow(UnsupportedFilterError);
    expect(() => ev(v, { path: ['year'], bogus: 1 })).toThrow(UnsupportedFilterError);
  });
});

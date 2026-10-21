/**
 * evaluateWhere / assertWhereHonourable over json path predicates.
 */

import { type Row, UnsupportedFilterError, type WhereClause } from '@mnmal-ai/substrate-types';
import { describe, expect, it } from 'vitest';
import { assertWhereHonourable, evaluateWhere } from '../src/index.js';

const rows: Row[] = [
  { id: '1', values: { year: 1995, contains: 'x' }, address: { path: 'a' } },
  { id: '2', values: { year: '1995' }, address: { path: 'b' } },
  { id: '3', values: null }
];
const match = (w: WhereClause): string[] =>
  rows.filter((r) => evaluateWhere(r, w)).map((r) => String(r.id));

describe('evaluateWhere — json path predicates', () => {
  it('filters on a value inside the json field', () => {
    expect(match({ values: { path: ['year'], eq: 1995 } })).toEqual(['1']);
    expect(match({ values: { path: ['year'], eq: null } })).toEqual(['3']);
  });
  it('composes with NOT, AND and OR', () => {
    expect(match({ NOT: { values: { path: ['year'], gt: 1990 } } })).toEqual(['2', '3']);
    expect(
      match({
        OR: [{ values: { path: ['year'], eq: 1995 } }, { values: { path: ['year'], eq: '1995' } }]
      })
    ).toEqual(['1', '2']);
    expect(
      match({
        AND: [{ values: { path: ['year'], gt: 1990 } }, { values: { path: ['contains'], eq: 'x' } }]
      })
    ).toEqual(['1']);
  });
  it('a data key named like an operator is addressable', () => {
    expect(match({ values: { path: ['contains'], eq: 'x' } })).toEqual(['1']);
  });
  it('an OBJECT-valued `path` is still a struct sub-field filter', () => {
    expect(match({ address: { path: { eq: 'b' } } })).toEqual(['2']);
  });
});

describe('assertWhereHonourable — json path predicates', () => {
  it('passes a well-formed path predicate without rows', () => {
    expect(() => assertWhereHonourable({ values: { path: ['year'], gt: 1990 } })).not.toThrow();
  });
  it('refuses malformed ones before any row is read', () => {
    for (const w of [
      { values: { path: [], eq: 1 } },
      { values: { path: ['year'] } },
      { values: { path: ['year'], gt: true } },
      { values: { path: ['year'], eq: { a: 1 } } },
      { values: { path: ['year'], bogus: 1 } },
      { NOT: { values: { path: ['year'], between: [1, 'b'] } } }
    ] as WhereClause[]) {
      expect(() => assertWhereHonourable(w)).toThrow(UnsupportedFilterError);
    }
  });
});

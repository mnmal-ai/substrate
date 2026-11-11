/**
 * Engine-neutral expression cases: every engine that evaluates an `Expr` over a
 * dataset row must produce `expected`. Rows carry what a dataset row carries
 * (numbers, strings, booleans, `bigint` for int64, ISO-8601 UTC strings for dates).
 */
import type { Expr, ExprType } from '@mnmal-ai/substrate-types';

export interface ExprCase {
  name: string;
  expr: Expr;
  row: Record<string, unknown>;
  expected: unknown;
}

/** A `case` call; its branch pairs are arrays, which `Expr` does not model. */
const kase = (...args: unknown[]): Expr => ({ case: args as Expr[] });
const lit = (s: string): Expr => ({ lit: s });
const D = '2013-07-17T10:11:12.000Z';
const row = { s: '😀é', n: null, d: D, big: 9223372036854775800n, i: 5n, x: 2.5 };

/** The declared type of each field the corpus rows carry, which an engine takes from its schema. */
export const CORPUS_FIELD_TYPES: Record<string, ExprType> = {
  s: 'string',
  n: 'number',
  d: 'date',
  big: 'int64',
  i: 'int64',
  x: 'number',
  e: 'date',
  constructor: 'string' as ExprType
};

export const EXPR_CORPUS: ExprCase[] = [
  { name: 'add numbers', expr: { add: ['x', 1] }, row, expected: 3.5 },
  { name: 'add int64 stays exact', expr: { add: ['big', 7] }, row, expected: 9223372036854775807n },
  { name: 'add int64 beside number widens', expr: { add: ['i', 'x'] }, row, expected: 7.5 },
  { name: 'sub int64', expr: { sub: ['i', 7] }, row, expected: -2n },
  { name: 'mul int64', expr: { mul: ['i', 3] }, row, expected: 15n },
  { name: 'mul numbers', expr: { mul: ['x', 2] }, row, expected: 5 },
  { name: 'div returns a number', expr: { div: [1, 2] }, row, expected: 0.5 },
  { name: 'div by zero is null', expr: { div: [1, 0] }, row, expected: null },
  { name: 'mod takes the dividend sign', expr: { mod: [-7, 3] }, row, expected: -1n },
  { name: 'mod int64', expr: { mod: ['i', 3] }, row, expected: 2n },
  { name: 'neg number', expr: { neg: ['x'] }, row, expected: -2.5 },
  { name: 'neg int64', expr: { neg: ['i'] }, row, expected: -5n },
  { name: 'add null is null', expr: { add: [null, 1] }, row, expected: null },
  { name: 'eq', expr: { eq: ['x', 2.5] }, row, expected: true },
  { name: 'eq int64 and number compare as number', expr: { eq: ['i', 5] }, row, expected: true },
  { name: 'neq', expr: { neq: [lit('a'), lit('b')] }, row, expected: true },
  { name: 'gt', expr: { gt: ['x', 3] }, row, expected: false },
  { name: 'gte', expr: { gte: ['x', 2.5] }, row, expected: true },
  { name: 'lt int64', expr: { lt: ['i', 6] }, row, expected: true },
  { name: 'lte', expr: { lte: ['x', 2] }, row, expected: false },
  { name: 'comparison with null is null', expr: { eq: ['n', 1] }, row, expected: null },
  { name: 'and null false is false', expr: { and: [null, false] }, row, expected: false },
  { name: 'and null true is null', expr: { and: [null, true] }, row, expected: null },
  { name: 'and all true', expr: { and: [true, true] }, row, expected: true },
  { name: 'or null true is true', expr: { or: [null, true] }, row, expected: true },
  { name: 'or null false is null', expr: { or: [null, false] }, row, expected: null },
  { name: 'not null is null', expr: { not: [null] }, row, expected: null },
  { name: 'not', expr: { not: [false] }, row, expected: true },
  { name: 'isNull of null', expr: { isNull: [null] }, row, expected: true },
  { name: 'isNull of a value', expr: { isNull: ['x'] }, row, expected: false },
  { name: 'in finds a member', expr: { in: [2, 1, 2] }, row, expected: true },
  { name: 'in misses', expr: { in: [3, 1, 2] }, row, expected: false },
  { name: 'in with null needle is null', expr: { in: [null, 1] }, row, expected: null },
  {
    name: 'in with a null member and no match is null',
    expr: { in: [3, 1, null] },
    row,
    expected: null
  },
  { name: 'length counts characters', expr: { length: ['s'] }, row, expected: 2 },
  { name: 'lower', expr: { lower: [lit('ÀB')] }, row, expected: 'Àb' },
  { name: 'upper', expr: { upper: [lit('àb')] }, row, expected: 'àB' },
  { name: 'substring by characters', expr: { substring: ['s', 2, 1] }, row, expected: 'é' },
  { name: 'substring start below 1', expr: { substring: [lit('abc'), 0, 2] }, row, expected: 'a' },
  { name: 'substring past the end', expr: { substring: [lit('abc'), 2, 10] }, row, expected: 'bc' },
  { name: 'concat', expr: { concat: [lit('a'), lit('b'), lit('c')] }, row, expected: 'abc' },
  { name: 'concat with null is null', expr: { concat: [lit('a'), null] }, row, expected: null },
  {
    name: 'like with underscore escape',
    expr: { like: [lit('a_c'), lit('a\\_c')] },
    row,
    expected: true
  },
  {
    name: 'like escaped underscore is literal',
    expr: { like: [lit('abc'), lit('a\\_c')] },
    row,
    expected: false
  },
  { name: 'like percent', expr: { like: [lit('google.com'), lit('%goo%')] }, row, expected: true },
  {
    name: 'like is case-sensitive',
    expr: { like: [lit('Google'), lit('%goo%')] },
    row,
    expected: false
  },
  { name: 'like is anchored', expr: { like: [lit('xgoogle'), lit('goo%')] }, row, expected: false },
  { name: 'notLike', expr: { notLike: [lit('abc'), lit('a%')] }, row, expected: false },
  {
    name: 'regexpMatch anywhere',
    expr: { regexpMatch: [lit('xxabcxx'), lit('b+c')] },
    row,
    expected: true
  },
  {
    name: 'regexpMatch anchored miss',
    expr: { regexpMatch: [lit('xxabc'), lit('^abc')] },
    row,
    expected: false
  },
  {
    name: 'regexpMatch dot matches newline',
    expr: { regexpMatch: [lit('a\nb'), lit('a.b')] },
    row,
    expected: true
  },
  {
    name: 'regexpReplace with a group',
    expr: {
      regexpReplace: [
        lit('https://www.example.com/a'),
        lit('^https?://(?:www\\.)?([^/]+)/.*$'),
        lit('\\1')
      ]
    },
    row,
    expected: 'example.com'
  },
  {
    name: 'regexpReplace replaces the first match only',
    expr: { regexpReplace: [lit('aaa'), lit('a'), lit('b')] },
    row,
    expected: 'baa'
  },
  {
    name: 'regexpReplace keeps $ literal',
    expr: { regexpReplace: [lit('ab'), lit('a'), lit('$1$&')] },
    row,
    expected: '$1$&b'
  },
  {
    name: 'regexpReplace of null is null',
    expr: { regexpReplace: [null, lit('a'), lit('b')] },
    row,
    expected: null
  },
  {
    name: 'dateTrunc week is Monday',
    expr: { dateTrunc: [lit('week'), 'd'] },
    row,
    expected: '2013-07-15T00:00:00.000000Z'
  },
  {
    name: 'dateTrunc day',
    expr: { dateTrunc: [lit('day'), 'd'] },
    row,
    expected: '2013-07-17T00:00:00.000000Z'
  },
  {
    name: 'dateTrunc hour',
    expr: { dateTrunc: [lit('hour'), 'd'] },
    row,
    expected: '2013-07-17T10:00:00.000000Z'
  },
  {
    name: 'dateTrunc minute',
    expr: { dateTrunc: [lit('minute'), 'd'] },
    row,
    expected: '2013-07-17T10:11:00.000000Z'
  },
  {
    name: 'dateTrunc month',
    expr: { dateTrunc: [lit('month'), 'd'] },
    row,
    expected: '2013-07-01T00:00:00.000000Z'
  },
  {
    name: 'dateTrunc year',
    expr: { dateTrunc: [lit('year'), 'd'] },
    row,
    expected: '2013-01-01T00:00:00.000000Z'
  },
  {
    name: 'dateTrunc second',
    expr: { dateTrunc: [lit('second'), 'd'] },
    row,
    expected: '2013-07-17T10:11:12.000000Z'
  },
  { name: 'extract minute', expr: { extract: [lit('minute'), 'd'] }, row, expected: 11 },
  { name: 'extract second', expr: { extract: [lit('second'), 'd'] }, row, expected: 12 },
  { name: 'extract hour', expr: { extract: [lit('hour'), 'd'] }, row, expected: 10 },
  { name: 'extract day', expr: { extract: [lit('day'), 'd'] }, row, expected: 17 },
  { name: 'extract month', expr: { extract: [lit('month'), 'd'] }, row, expected: 7 },
  { name: 'extract year', expr: { extract: [lit('year'), 'd'] }, row, expected: 2013 },
  { name: 'extract ISO week', expr: { extract: [lit('week'), 'd'] }, row, expected: 29 },
  {
    name: 'extract ISO week at a year boundary',
    expr: { extract: [lit('week'), { lit: '2021-01-03T00:00:00.000Z' } as Expr] },
    row: {},
    expected: 53
  },
  {
    name: 'dateTrunc of null is null',
    expr: { dateTrunc: [lit('day'), 'n'] },
    row,
    expected: null
  },
  {
    name: 'case takes the first true branch',
    expr: kase([false, 1], [true, 2], 3),
    row,
    expected: 2
  },
  { name: 'case falls to else', expr: kase([false, 1], 3), row, expected: 3 },
  { name: 'case skips a null condition', expr: kase([null, 1], 3), row, expected: 3 },
  { name: 'coalesce', expr: { coalesce: [null, 2] }, row, expected: 2 },
  { name: 'coalesce of all null', expr: { coalesce: [null, 'n'] }, row, expected: null },
  {
    name: 'substring with an int64 start',
    expr: { substring: [lit('abc'), 'i', 1] },
    row: { i: 2n },
    expected: 'b'
  },
  {
    name: 'substring with a negative length',
    expr: { substring: [lit('abc'), 1, -1] },
    row,
    expected: ''
  },
  {
    name: 'extract second keeps fractions',
    expr: { extract: [lit('second'), 'd'] },
    row: { d: '2013-07-17T10:11:12.500Z' },
    expected: 12.5
  },
  // Dates compare as instants, whatever text form the writer sent.
  {
    name: 'eq dates in different text forms',
    expr: { eq: ['d', 'e'] },
    row: { d: '2024-01-01T00:00:00Z', e: '2024-01-01T00:00:00.000Z' },
    expected: true
  },
  {
    name: 'gt dates in different text forms',
    expr: { gt: ['d', 'e'] },
    row: { d: '2024-01-01T00:00:00Z', e: '2024-01-01T00:00:00.000Z' },
    expected: false
  },
  {
    name: 'a date equals its own day truncation',
    expr: { eq: ['d', { dateTrunc: [lit('day'), 'd'] }] },
    row: { d: '2024-01-01T02:00:00+02:00' },
    expected: true
  },
  {
    name: 'dates compare to the microsecond',
    expr: { gt: ['d', 'e'] },
    row: { d: '2024-01-01T00:00:00.000001Z', e: '2024-01-01T00:00:00.000Z' },
    expected: true
  },
  {
    name: 'a date without offset is UTC',
    expr: { extract: [lit('hour'), 'd'] },
    row: { d: '2024-01-01T00:00:00' },
    expected: 0
  },
  {
    name: 'extract second keeps microseconds',
    expr: { extract: [lit('second'), 'd'] },
    row: { d: '2024-01-01T00:00:12.500001Z' },
    expected: 12.500001
  },
  {
    name: 'a date field reads as canonical text',
    expr: { coalesce: ['d'] },
    row: { d: '2024-01-01T02:00:00+02:00' },
    expected: '2024-01-01T00:00:00.000000Z'
  },
  {
    name: 'dateTrunc keeps years before 100',
    expr: { dateTrunc: [lit('year'), 'd'] },
    row: { d: '0050-06-15T00:00:00.000Z' },
    expected: '0050-01-01T00:00:00.000000Z'
  },
  {
    name: 'string order is by code point',
    expr: { lt: [lit('\uFF5E'), lit('\u{1F600}')] },
    row,
    expected: true
  },
  {
    name: 'in compares strings exactly',
    expr: { in: [lit('\u{1F600}'), lit('\uFF5E'), lit('\u{1F600}')] },
    row,
    expected: true
  },
  {
    name: 'substring clamps start and length into int4',
    expr: { substring: [lit('abcdef'), -3000000000, 3000000005] },
    row,
    expected: ''
  },
  // Expected values below were read from Postgres 18: the match is leftmost-longest.
  {
    name: 'regexpReplace takes the longest match, not the first',
    expr: { regexpReplace: [lit('ab'), lit('(a?)(ab)?'), lit('[\\1|\\2]')] },
    row,
    expected: '[|ab]'
  },
  {
    name: 'regexpReplace longest match through an optional group',
    expr: { regexpReplace: [lit('xxy'), lit('x*(xy)?'), lit('<\\&>')] },
    row,
    expected: '<xxy>'
  },
  {
    name: 'regexpReplace longest match moves the capture',
    expr: { regexpReplace: [lit('abc'), lit('(ab)?(abc)?'), lit('[\\1|\\2]')] },
    row,
    expected: '[|abc]'
  },
  {
    name: 'regexpReplace alternation without groups takes the longest',
    expr: { regexpReplace: [lit('ab'), lit('a|ab'), lit('X')] },
    row,
    expected: 'X'
  },
  {
    name: 'regexpReplace alternation after a star takes the longest',
    expr: { regexpReplace: [lit('xyz'), lit('x*|xyz'), lit('Q')] },
    row,
    expected: 'Q'
  },
  {
    name: 'regexpReplace \\& is the whole match',
    expr: { regexpReplace: [lit('ab'), lit('a'), lit('x\\&y')] },
    row,
    expected: 'xayb'
  },
  {
    name: 'upper maps ASCII letters only',
    expr: { upper: [lit('ß')] },
    row,
    expected: 'ß'
  },
  {
    name: 'a field named like a prototype member is null',
    expr: { isNull: ['constructor'] },
    row,
    expected: true
  },
  { name: 'lower leaves a non-ASCII character', expr: { lower: [lit('İ')] }, row, expected: 'İ' },
  {
    name: 'coalesce widens int64 beside a number',
    expr: { coalesce: ['i', 'x'] },
    row,
    expected: 5
  },
  { name: 'case adopts int64 for a literal', expr: kase([false, 'i'], 0), row, expected: 0n },
  {
    name: 'coalesce(i, x) is a number even when x is null',
    expr: { coalesce: ['i', 'x'] },
    row: { i: 5n, x: null },
    expected: 5
  },
  {
    name: 'coalesce(x, i) takes the number first',
    expr: { coalesce: ['x', 'i'] },
    row: { i: 5n, x: 2.5 },
    expected: 2.5
  },
  {
    name: 'coalesce(x, i) widens i when x is null',
    expr: { coalesce: ['x', 'i'] },
    row: { i: 5n, x: null },
    expected: 5
  },
  {
    name: 'case widens an int64 branch beside a number branch',
    expr: kase([true, 'i'], 'x'),
    row: { i: 5n, x: null },
    expected: 5
  },
  { name: 'mod by zero is null', expr: { mod: ['i', 0] }, row, expected: null },
  {
    name: 'int64 literal',
    expr: { add: [{ int64: '435090932899640449' }, 1] },
    row,
    expected: 435090932899640450n
  }
];

import { describe, expect, it } from 'vitest';
import { checkRegexSubset } from '../src/regex-subset.js';
import { ACCEPTED } from './fixtures/regex-corpus.js';

const REFUSED = [
  `${'a{0,255}'.repeat(31)}b`,
  `(?:${'a'.repeat(240)}){0,255}b`,
  '(a+)+',
  '(a|aa)*',
  '(?:a*)*',
  '((a)b?)*',
  'a'.repeat(257),
  '\\d',
  '(?=x)',
  '(?<=x)',
  '(?!x)',
  '\\1',
  '[[:alpha:]]',
  '(?i)x',
  'a\nb',
  'a*?',
  'a**',
  '(a',
  'a)',
  '[a',
  'x{2',
  '*a',
  '[z-a]',
  '^*',
  '\\_',
  '\\,',
  '\\<',
  '\\ ',
  '[\\,]',
  'x{256}',
  'x{1,256}',
  'x{256,}',
  '[a-c-e]',
  '[\u{1F602}-\u{1F600}]'
];

describe('checkRegexSubset', () => {
  it.each(ACCEPTED)('accepts %s', (p) => expect(checkRegexSubset(p)).toBeNull());
  it.each(REFUSED)('refuses %j with a reason', (p) =>
    expect(checkRegexSubset(p)).toEqual(expect.any(String))
  );
  it.each(ACCEPTED)('constructs %s under flags us', (p) => {
    expect(() => new RegExp(p, 'us')).not.toThrow();
  });
  it('compares astral class endpoints by code point', () => {
    expect(checkRegexSubset('[\u{1F600}-\u{1F602}]')).toBeNull();
    expect(checkRegexSubset('[a-\u{1F600}]')).toBeNull();
  });
});

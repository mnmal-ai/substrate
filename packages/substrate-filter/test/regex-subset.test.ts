import { describe, expect, it } from 'vitest';
import { checkRegexSubset } from '../src/regex-subset.js';

describe('checkRegexSubset', () => {
  it.each(['^https?://(?:www\\.)?([^/]+)/.*$', 'a|b', '[a-z]+', 'x{2,3}', '', 'a||b', '[^a-c.]'])(
    'accepts %s',
    (p) => expect(checkRegexSubset(p)).toBeNull()
  );
  it.each([
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
    '^*'
  ])('refuses %j with a reason', (p) => expect(checkRegexSubset(p)).toEqual(expect.any(String)));
});

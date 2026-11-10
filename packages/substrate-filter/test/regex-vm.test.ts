import { describe, expect, it } from 'vitest';
import { lru } from '../src/expr-eval.js';
import { parse, programSize } from '../src/regex-ast.js';
import { checkRegexSubset } from '../src/regex-subset.js';
import { compileRegex, execRegex } from '../src/regex-vm.js';
import { ACCEPTED } from './fixtures/regex-corpus.js';

const SUBJECTS = [
  '',
  'a',
  'ab',
  'aaa',
  'abab',
  'xxabcxx',
  'a\nb',
  'line1\nline2\n',
  '😀',
  'a😀b',
  '😀😀',
  'https://www.example.com/a',
  'http://example.com/',
  'a|b',
  '{',
  'a-b',
  'a.b',
  '/.{',
  'abc',
  '-a',
  'xx',
  'x'.repeat(255),
  'é😀é'
];
const EXTRA = [
  '((^))?|',
  '(($)){0,2}',
  '(($){0,2}|)',
  '(^)*a',
  'a*',
  'a+b',
  '(a)(b)?',
  '(a|ab)(c|bcd)',
  'a|ab|abc',
  'x*',
  '(a*)',
  '(a)*',
  '^',
  '$',
  '^$',
  'a$',
  '^a',
  'a.b',
  '[^a]',
  '[a-c]+',
  '.',
  '.+',
  '😀+',
  '(😀)(.)',
  'a{2}',
  'a{1,2}b?',
  'a{2,}'
];

describe('regex VM', () => {
  it('agrees with RegExp on match, index and groups', () => {
    for (const p of [...ACCEPTED, ...EXTRA]) {
      const prog = compileRegex(p);
      const re = new RegExp(p, 'us');
      for (const subject of SUBJECTS) {
        const js = re.exec(subject);
        const vm = execRegex(prog, subject);
        const label = `${JSON.stringify(p)} on ${JSON.stringify(subject)}`;
        if (!js) {
          expect(vm, label).toBeNull();
          continue;
        }
        expect(vm, label).not.toBeNull();
        expect(vm?.index, label).toBe(js.index);
        expect(vm?.end, label).toBe(js.index + js[0].length);
        expect(vm?.groups, label).toEqual(js.slice(1));
      }
    }
  });

  it('runs polynomial-looking patterns in linear time', () => {
    const subject = 'a'.repeat(50_000);
    for (const p of ['a*a*a*a*a*a*b', '(a*)(a*)(a*)(a*)b', '(?:a|aa)b', 'a{0,20}a{0,20}b']) {
      const prog = compileRegex(p);
      const t = Date.now();
      expect(execRegex(prog, subject)).toBeNull();
      expect(Date.now() - t).toBeLessThan(5000);
    }
  }, 20_000);

  it('sizes every accepted program exactly', () => {
    for (const p of [...ACCEPTED, ...EXTRA]) {
      expect(programSize(parse(p).node), p).toBe(compileRegex(p).insts.length);
    }
  });

  it('refuses a program past the instruction budget', () => {
    for (const p of [`${'a{0,255}'.repeat(31)}b`, `(?:${'a'.repeat(240)}){0,255}b`]) {
      expect(checkRegexSubset(p)).toContain('program too large');
      expect(() => compileRegex(p)).toThrow('program too large');
    }
  });

  it('refuses a pattern outside the subset', () => {
    expect(() => compileRegex('\\d')).toThrow('invalid regex');
  });
});

describe('lru', () => {
  it('evicts the least recently used entry at capacity', () => {
    let made = 0;
    const get = lru(2, (k) => `${k}${++made}`);
    get('a');
    get('b');
    get('a'); // a is now most recent
    get('c'); // evicts b
    expect(made).toBe(3);
    get('a');
    expect(made).toBe(3);
    get('b');
    expect(made).toBe(4);
  });
});

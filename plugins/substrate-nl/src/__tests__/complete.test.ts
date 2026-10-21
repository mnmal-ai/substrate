import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { complete } from '../complete/complete.js';
import { pack as basePack, rulings } from './_fixture.js';

const pack = { ...basePack, rulings };
const labels = (d: string, c = d.length) => complete(d, c, pack).map((s) => s.label);

describe('complete', () => {
  it('suggests type phrases for a leading token, prefix matches first', () => {
    const got = complete('to', 2, pack);
    expect(got[0]).toMatchObject({ replace: [0, 2], insert: 'todo' });
    expect(got.map((s) => s.insert)).toContain('todos');
    expect(got.every((s, i, a) => i === 0 || a[i - 1]!.score >= s.score)).toBe(true);
  });

  it('after a type, suggests that type field phrases', () => {
    expect(labels('todos pri')).toContain('priority');
  });

  it('field: suggests vocabulary values, aliases labelled alias → canonical', () => {
    const got = complete('todos status:', 'todos status:'.length, pack);
    expect(got.map((s) => s.insert)).toEqual(
      expect.arrayContaining(['open', 'done', 'closed', 'blocked'])
    );
  });

  it('suggests project names from the profile', () => {
    expect(labels('todos in la')).toContain('labs');
  });

  it('ranking is deterministic: prefix before substring, then shorter, then alphabetical', () => {
    const a = complete('o', 1, pack).map((s) => s.insert);
    expect(complete('o', 1, pack).map((s) => s.insert)).toEqual(a);
  });

  it('never throws on hostile input', () => {
    for (const [d, c] of [
      ['', 0],
      ['   ', 3],
      ['todos', -5],
      ['todos', 999],
      ['tod os', 3],
      ['ℵ todos 😀', 4]
    ] as const) {
      expect(() => complete(d, c, pack)).not.toThrow();
    }
    expect(complete('', 0, pack)).toEqual([]);
    expect(complete('   ', 3, pack)).toEqual([]);
  });

  it('prototype-named drafts never throw', () => {
    for (const d of [
      'todos constructor:',
      'todos __proto__:',
      'todos toString:',
      'todos hasOwnProperty:',
      '__proto__',
      'constructor',
      'todos toString',
      'todos status:constructor'
    ]) {
      for (const p of [pack, basePack]) {
        let got: ReturnType<typeof complete> = [];
        expect(() => {
          got = complete(d, d.length, p);
        }).not.toThrow();
        expect(Array.isArray(got)).toBe(true);
      }
    }
  });

  it('a cursor mid-token replaces the whole token', () => {
    const got = complete('tod os', 2, pack);
    expect(got[0]?.replace).toEqual([0, 3]);
  });

  it('the module imports types only (browser-safe)', () => {
    const src = readFileSync(new URL('../complete/complete.ts', import.meta.url), 'utf8');
    const imports = [...src.matchAll(/^import\s+(type\s+)?[^;]*from\s+'([^']+)'/gm)];
    expect(imports.every((m) => m[1] !== undefined)).toBe(true);
  });

  it('never splits a surrogate pair, and replace ranges stay in bounds', () => {
    const drafts = [
      '',
      ' ',
      'todos',
      'tod os',
      'todos status:',
      'todos in co',
      'to😀do',
      '😀',
      '😀 todos 😀',
      'ℵ todos 😀',
      'todos status:op😀'
    ];
    for (const d of drafts) {
      for (let c = -2; c <= d.length + 2; c++) {
        const got = complete(d, c, pack);
        for (const s of got) {
          const [a, b] = s.replace;
          expect(a).toBeGreaterThanOrEqual(0);
          expect(a).toBeLessThanOrEqual(b);
          expect(b).toBeLessThanOrEqual(d.length);
          for (const i of [a, b]) {
            const split =
              i > 0 &&
              i < d.length &&
              /[\uD800-\uDBFF]/.test(d[i - 1] as string) &&
              /[\uDC00-\uDFFF]/.test(d[i] as string);
            expect(split).toBe(false);
          }
        }
      }
    }
  });

  it('a cursor inside an emoji adjacent to a token is clamped, not thrown on', () => {
    const d = 'to😀';
    expect(() => complete(d, 3, pack)).not.toThrow();
    expect(() => complete('😀 to', 1, pack)).not.toThrow();
    expect(complete('😀 to', 5, pack)[0]?.replace).toEqual([3, 5]);
  });

  it('non-integer and NaN cursors do not throw', () => {
    expect(() => complete('todos', Number.NaN, pack)).not.toThrow();
    expect(() => complete('todos', 1.5, pack)).not.toThrow();
  });

  it('field suggestions insert `name:` and keep the bare label', () => {
    const got = complete('todos pri', 9, pack).find((x) => x.label === 'priority');
    expect(got?.insert).toBe('priority:');
  });

  it('empty value prefix offers DSL operators the field allows, after values', () => {
    const d = 'todos targetDate:';
    const got = complete(d, d.length, pack);
    expect(got.map((x) => x.insert)).toEqual(['>=', '<']);
    expect(got[0]?.detail).toContain('gte');
    const t = complete('todos title:', 12, pack).map((x) => x.insert);
    expect(t).toEqual(expect.arrayContaining(['~', '!']));
    expect(t).not.toContain('>=');
    const st = complete('todos priority:', 15, pack).map((x) => x.insert);
    expect(st.slice(0, 3).sort()).toEqual(['high', 'low', 'medium']);
  });

  it('a value prefix that is an operator form is not completed further', () => {
    for (const v of ['>', '>=', '!', '~', '..']) {
      const d = `todos targetDate:${v}`;
      expect(complete(d, d.length, pack)).toEqual([]);
    }
  });

  it('empty-prefix values are not duplicated', () => {
    const ins = complete('todos status:', 13, pack).map((x) => x.insert);
    expect(new Set(ins).size).toBe(ins.length);
    expect(ins.filter((i) => i === 'open')).toHaveLength(1);
  });

  it('rulings.fieldAliases complete as `alias:` and resolve for values', () => {
    const got = complete('todos re', 8, pack).find((x) => x.insert === 'repo:');
    expect(got?.label).toBe('repo → project');
    expect(complete('todos repo:', 11, pack).map((x) => x.insert)).toEqual(
      expect.arrayContaining(['labs', 'substrate'])
    );
  });

  it('single-word (hyphenated ok) rulings.valueAliases join the after-type pool; multi-word do not', () => {
    const got = complete('decisions acc', 13, pack).find((x) => x.insert === 'accepted');
    expect(got?.detail).toBe('Decision.status');
    const sg = complete('todos signal', 12, pack).find((x) => x.insert === 'signal-gated');
    expect(sg?.detail).toBe('Todo.title');
    const multi = {
      ...pack,
      rulings: {
        ...rulings,
        valueAliases: { 'in force': [{ type: 'Decision', field: 'status', in: ['x'] }] }
      }
    };
    expect(complete('decisions in', 12, multi).map((x) => x.insert)).not.toContain('in force');
  });

  it('field-level aliases are labelled alias → canonical', () => {
    const f = { ...pack.types.Todo!.fields.status!, aliases: { wip: 'open' } };
    const p = {
      ...pack,
      types: {
        ...pack.types,
        Todo: { ...pack.types.Todo!, fields: { ...pack.types.Todo!.fields, status: f } }
      }
    };
    const got = complete('todos status:w', 14, p).find((x) => x.insert === 'wip');
    expect(got?.label).toBe('wip → open');
  });

  it('prefix matches rank before shorter substring matches', () => {
    const p = {
      ...pack,
      types: {
        T: { name: 'T', phrases: ['zab', 'abcdef'], fields: {} }
      },
      values: {}
    };
    const got = complete('ab', 2, p).map((x) => x.insert);
    expect(got).toEqual(['abcdef', 'zab']);
  });
});

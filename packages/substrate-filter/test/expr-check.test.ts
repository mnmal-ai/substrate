import { type ArgType, EXPR_FUNCTIONS, type Expr, type ExprType } from '@mnmal-ai/substrate-types';
import { describe, expect, it } from 'vitest';
import { checkExpr, type ExprScope } from '../src/expr-check.js';

const fields: Record<string, ExprType> = {
  ResolutionWidth: 'number',
  URL: 'string',
  EventTime: 'date',
  c: 'number',
  big: 'int64',
  flag: 'boolean'
};
const scope: ExprScope = { field: (n) => fields[n] };
const run = (e: Expr) => checkExpr(e, scope, ['select', 'x']);
const type = (e: Expr) => {
  const r = run(e);
  if (!r.ok) throw new Error(r.message);
  return r.type;
};
const refusal = (e: Expr) => {
  const r = run(e);
  if (r.ok) throw new Error('expected refusal');
  return r;
};

describe('checkExpr types', () => {
  it('infers the catalogue examples', () => {
    expect(type({ add: ['ResolutionWidth', 1] })).toBe('number');
    expect(type({ length: ['URL'] })).toBe('number');
    expect(type({ dateTrunc: [{ lit: 'minute' }, 'EventTime'] })).toBe('date');
    expect(type({ extract: [{ lit: 'year' }, 'EventTime'] })).toBe('number');
    expect(type({ gt: ['c', 100000] })).toBe('boolean');
    expect(type({ int64: '435090932899640449' })).toBe('int64');
    expect(type({ regexpMatch: ['URL', { lit: 'a|b' }] })).toBe('boolean');
  });
  it('widens int64 with number and keeps int64 with safe integers', () => {
    expect(type({ add: ['big', 1] })).toBe('int64');
    expect(type({ add: ['big', 1.5] })).toBe('number');
    expect(type({ add: ['big', 'c'] })).toBe('number');
    expect(type({ div: ['big', 'big'] })).toBe('number');
    expect(type({ gt: ['big', 'c'] })).toBe('boolean');
  });
  it('checks case, coalesce and in by their own rules', () => {
    expect(
      type({ case: [[{ gt: ['c', 1] }, { lit: 'a' }], { lit: 'b' }] } as unknown as Expr)
    ).toBe('string');
    expect(type({ coalesce: ['c', 0] })).toBe('number');
    expect(type({ in: ['URL', { lit: 'a' }, { lit: 'b' }] })).toBe('boolean');
    expect(refusal({ in: ['URL', 1] }).message).toMatch(/in/);
    expect(refusal({ coalesce: ['c', 'URL'] }).code).toBe('expr_invalid');
    expect(refusal({ case: [[{ gt: ['c', 1] }, 'URL'], 'c'] } as unknown as Expr).code).toBe(
      'expr_invalid'
    );
  });
});

describe('checkExpr refusals', () => {
  it('refuses a non-literal LIKE pattern and a literal ending in an unescaped backslash', () => {
    const r = refusal({ like: ['URL', { lit: 'a\\' }] });
    expect(r.message).toContain('LIKE pattern must not end with escape character');
    expect(r.path).toEqual(['select', 'x', 'like', '1']);
    expect(refusal({ notLike: ['URL', { lit: '%\\' }] }).code).toBe('expr_invalid');
    expect(type({ like: ['URL', { lit: 'a\\\\' }] })).toBe('boolean');
    expect(refusal({ like: ['URL', 'URL'] }).message).toContain('{ lit }');
    expect(refusal({ notLike: ['URL', { concat: [{ lit: 'a' }] }] }).path).toEqual([
      'select',
      'x',
      'notLike',
      '1'
    ]);
  });

  it('takes int64 only for mod', () => {
    expect(type({ mod: ['big', 3] })).toBe('int64');
    expect(refusal({ mod: ['c', 3] }).message).toContain('expected int64');
    expect(refusal({ mod: ['big', 1.5] }).message).toContain('expected int64');
  });

  it('refuses an unsafe integer in an int64 position', () => {
    // the JSON number 9007199254740993, as a client would send it
    const unsafe = JSON.parse('9007199254740993') as number;
    expect(refusal({ add: [{ int64: '1' }, unsafe] }).message).toMatch(/int64/);
  });
  it('refuses a malformed int64 constant', () => {
    expect(refusal({ int64: '1.5' }).code).toBe('expr_invalid');
  });
  it('names an unknown function and the path', () => {
    const r = refusal({ nope: [] });
    expect(r.message).toContain('nope');
    expect(r.message).toContain('select.x');
    expect(r.path).toEqual(['select', 'x']);
  });
  it('refuses mismatched types', () => {
    expect(refusal({ add: ['URL', 1] }).code).toBe('expr_invalid');
    expect(refusal({ eq: ['URL', 1] }).code).toBe('expr_invalid');
    expect(refusal({ and: ['c'] }).code).toBe('expr_invalid');
  });
  it('refuses an unknown date unit and a non-literal unit', () => {
    expect(refusal({ dateTrunc: [{ lit: 'fortnight' }, 'EventTime'] }).message).toContain(
      'fortnight'
    );
    expect(refusal({ dateTrunc: ['URL', 'EventTime'] }).code).toBe('expr_invalid');
  });
  it('refuses a regex outside the subset', () => {
    expect(refusal({ regexpMatch: ['URL', { lit: '\\d' }] }).message).toMatch(/regex/i);
    expect(refusal({ regexpMatch: ['URL', 'URL'] }).code).toBe('expr_invalid');
  });
  it('limits depth to 16 levels', () => {
    const nest = (levels: number): Expr => {
      let e: Expr = 'c';
      for (let i = 1; i < levels; i++) e = { neg: [e] };
      return e;
    };
    expect(run(nest(16)).ok).toBe(true);
    expect(refusal(nest(17)).message).toContain('maxDepth');
  });
  it('limits nodes to 64 per expression, counting every kind', () => {
    const wide = (n: number): Expr => ({
      concat: Array.from({ length: n - 1 }, () => ({ lit: 'x' }))
    });
    expect(run(wide(64)).ok).toBe(true);
    expect(refusal(wide(65)).message).toContain('maxNodesPerExpr');
    // unit and pattern literals are counted too
    const flags = (n: number) => Array.from({ length: n }, () => 'flag' as Expr);
    const withPattern = (n: number): Expr => ({
      and: [...flags(n), { regexpMatch: ['URL', { lit: 'a' }] }]
    });
    expect(run(withPattern(60)).ok).toBe(true);
    expect(refusal(withPattern(61)).message).toContain('maxNodesPerExpr');
    const withUnit = (n: number): Expr => ({
      and: [...flags(n), { gt: [{ extract: [{ lit: 'day' }, 'EventTime'] }, 1] }]
    });
    expect(run(withUnit(58)).ok).toBe(true);
    expect(refusal(withUnit(59)).message).toContain('maxNodesPerExpr');
  });
  it('does not count a case pair as a node', () => {
    const r = run({ case: [[{ gt: ['c', 1] }, { lit: 'a' }], { lit: 'b' }] } as unknown as Expr);
    expect(r).toMatchObject({ ok: true, nodes: 6 });
  });
  it('refuses an unknown bare field, naming it', () => {
    expect(refusal('Nope').message).toContain('Nope');
  });
  it('reports nodes and depth on success', () => {
    const r = run({ add: ['ResolutionWidth', 1] });
    expect(r).toMatchObject({ ok: true, nodes: 3, depth: 2 });
  });
});

describe('catalogue agrees with the checker', () => {
  const sample = (k: ArgType): Expr =>
    ({
      any: 'c',
      int64: 'big',
      number: 'c',
      string: 'URL',
      boolean: 'flag',
      date: 'EventTime',
      unit: { lit: 'day' },
      pattern: { lit: 'a' },
      likePattern: { lit: 'a%' }
    })[k] as Expr;
  const wrong = (k: ArgType): Expr | undefined =>
    k === 'unit' || k === 'pattern' || k === 'likePattern'
      ? 'URL'
      : k === 'any'
        ? undefined
        : k === 'boolean'
          ? 'URL'
          : 'flag';
  const variadic: Record<string, { ok: Expr[]; bad: Expr[] }> = {
    and: { ok: ['flag'], bad: [] },
    or: { ok: ['flag', 'flag'], bad: [] },
    concat: { ok: ['URL'], bad: [] },
    in: { ok: ['c', 1, 2], bad: ['c'] },
    case: { ok: [['flag', 'c'], 'c'] as unknown as Expr[], bad: ['c'] },
    coalesce: { ok: ['c', 1], bad: [] }
  };
  for (const f of EXPR_FUNCTIONS) {
    it(`${f.name}: ${f.description}`, () => {
      if (f.args === 'variadic') {
        const v = variadic[f.name];
        if (!v) throw new Error(`no representative call for ${f.name}`);
        const ok = run({ [f.name]: v.ok });
        expect(ok.ok).toBe(true);
        if (ok.ok && f.returns !== 'any') expect(ok.type).toBe(f.returns);
        expect(run({ [f.name]: [] }).ok).toBe(false);
        if (v.bad.length) expect(run({ [f.name]: v.bad }).ok).toBe(false);
        return;
      }
      const args = f.args.map(sample);
      const ok = run({ [f.name]: args });
      expect(ok.ok).toBe(true);
      if (ok.ok && f.returns !== 'any') expect(ok.type).toBe(f.returns);
      expect(run({ [f.name]: [...args, 'c'] }).ok).toBe(false);
      expect(run({ [f.name]: args.slice(0, -1) }).ok).toBe(false);
      f.args.forEach((k, i) => {
        const w = wrong(k);
        if (w === undefined) return;
        expect(run({ [f.name]: args.map((a, j) => (j === i ? w : a)) }).ok).toBe(false);
      });
    });
  }
  it('has an entry for exactly the names the checker knows', () => {
    expect(run({ nope: [] }).ok).toBe(false);
    expect(new Set(EXPR_FUNCTIONS.map((f) => f.name)).size).toBe(EXPR_FUNCTIONS.length);
  });
});

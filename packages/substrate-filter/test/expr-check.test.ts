import type { Expr, ExprType } from '@mnmal-ai/substrate-types';
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
  it('refuses an unsafe integer in an int64 position', () => {
    expect(refusal({ add: [{ int64: '1' }, 2 ** 53] }).message).toMatch(/int64/);
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
  it('refuses depth and node overruns, naming the limit', () => {
    let deep: Expr = 'c';
    for (let i = 0; i < 17; i++) deep = { neg: [deep] };
    expect(refusal(deep).message).toContain('maxDepth');
    const wide: Expr = { concat: Array.from({ length: 64 }, () => ({ lit: 'x' })) };
    expect(refusal(wide).message).toContain('maxNodesPerExpr');
  });
  it('refuses an unknown bare field, naming it', () => {
    expect(refusal('Nope').message).toContain('Nope');
  });
  it('reports nodes and depth on success', () => {
    const r = run({ add: ['ResolutionWidth', 1] });
    expect(r).toMatchObject({ ok: true, nodes: 3, depth: 2 });
  });
});

/** The checked type of a case or coalesce is computed once per node, never per row. */
import type { Expr, ExprType } from '@mnmal-ai/substrate-types';
import { describe, expect, it, vi } from 'vitest';

const calls = vi.hoisted(() => ({ n: 0 }));
vi.mock('../src/expr-check.js', async (orig) => {
  const real = await orig<typeof import('../src/expr-check.js')>();
  return {
    ...real,
    checkExpr: (...a: Parameters<typeof real.checkExpr>) => {
      calls.n++;
      return real.checkExpr(...a);
    }
  };
});

const { evalExpr } = await import('../src/expr-eval.js');

describe('evalExpr typing', () => {
  it('calls checkExpr once per call node, not per row', () => {
    const types: Record<string, ExprType> = { i: 'int64', x: 'number' };
    const fieldType = (n: string): ExprType | undefined => types[n];
    const expr: Expr = { coalesce: [{ coalesce: ['i', 'x'] }, 0] };
    calls.n = 0;
    evalExpr(expr, { i: null, x: null }, { fieldType });
    const first = calls.n;
    expect(first).toBeGreaterThan(0);
    for (let k = 0; k < 1000; k++) evalExpr(expr, { i: 5n, x: null }, { fieldType });
    expect(calls.n).toBe(first + 1); // the inner node, seen for the first time with a value
  });
});

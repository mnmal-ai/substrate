import { allowAll, and, denyAll, not, or, row } from '@mnmal-ai/substrate-policy';
import type { Policy, RequestContext, ResolverArgs, Row } from '@mnmal-ai/substrate-types';
import { describe, expect, it } from 'vitest';
import { evaluatePolicy } from '../src/index.js';
import { applyObligations } from '../src/policy-evaluator.js';

function makeCtx(): RequestContext {
  return {
    identity: null,
    namespace: 'test',
    operation: 'query',
    now: new Date(0),
    headers: {},
    meta: {}
  };
}

const emptyArgs: ResolverArgs = {};
const boom: Policy = () => {
  throw new Error('boom');
};

describe('evaluatePolicy', () => {
  it('allowAll passes', () => {
    const d = evaluatePolicy(allowAll(), makeCtx(), emptyArgs);
    expect(d).toEqual({ allow: true });
  });

  it('denyAll blocks with reason', () => {
    const d = evaluatePolicy(denyAll('nope'), makeCtx(), emptyArgs);
    expect(d).toEqual({ allow: false, reason: 'nope' });
  });

  it('catches throw at outer level and denies without the thrown text', () => {
    const d = evaluatePolicy(boom, makeCtx(), emptyArgs);
    expect(d).toEqual({ allow: false, reason: 'policy error' });
  });

  it('not(throw) remains a caught-error deny (invariant #2)', () => {
    const d = evaluatePolicy(not(boom), makeCtx(), emptyArgs);
    expect(d).toEqual({ allow: false, reason: 'policy error' });
  });

  it('or(throw, allow) allows (winner short-circuits)', () => {
    const d = evaluatePolicy(or(boom, allowAll()), makeCtx(), emptyArgs);
    expect(d.allow).toBe(true);
  });

  it('or(throw, deny) produces caught-error deny', () => {
    const d = evaluatePolicy(or(boom, denyAll('x')), makeCtx(), emptyArgs);
    expect(d).toEqual({ allow: false, reason: 'policy error' });
  });

  it('and(allow, deny) denies with second reason', () => {
    const d = evaluatePolicy(and(allowAll(), denyAll('second')), makeCtx(), emptyArgs);
    expect(d).toEqual({ allow: false, reason: 'second' });
  });

  it('and(allowA, allowB-with-obligation) accumulates obligations', () => {
    const flagger: Policy = () => ({
      allow: true,
      obligations: [{ kind: 'test-flag', payload: 'x' }]
    });
    const d = evaluatePolicy(and(allowAll(), flagger), makeCtx(), emptyArgs);
    expect(d.allow).toBe(true);
    expect(d.obligations).toEqual([{ kind: 'test-flag', payload: 'x' }]);
  });
});

describe('applyObligations', () => {
  it('row-filter obligation silently drops failing rows', () => {
    const policy = row<Row>((_ctx, r) => r.id === 1);
    const d = evaluatePolicy(policy, makeCtx(), emptyArgs);
    const rows: Row[] = [{ id: 1 }, { id: 2 }, { id: 3 }];
    const out = applyObligations(d, rows, makeCtx());
    expect(out).toEqual([{ id: 1 }]);
  });

  it('no obligations → rows unchanged', () => {
    const d = evaluatePolicy(allowAll(), makeCtx(), emptyArgs);
    const rows: Row[] = [{ id: 1 }, { id: 2 }];
    expect(applyObligations(d, rows, makeCtx())).toEqual(rows);
  });

  it('multiple row-filter obligations compose in order', () => {
    const gt1 = row<Row>((_ctx, r) => (r.id as number) > 1);
    const lt3 = row<Row>((_ctx, r) => (r.id as number) < 3);
    const d = evaluatePolicy(and(gt1, lt3), makeCtx(), emptyArgs);
    const rows: Row[] = [{ id: 1 }, { id: 2 }, { id: 3 }];
    expect(applyObligations(d, rows, makeCtx())).toEqual([{ id: 2 }]);
  });

  it('throwing predicate silently drops the row', () => {
    const crasher = row<Row>(() => {
      throw new Error('pred threw');
    });
    const d = evaluatePolicy(crasher, makeCtx(), emptyArgs);
    const rows: Row[] = [{ id: 1 }, { id: 2 }];
    expect(applyObligations(d, rows, makeCtx())).toEqual([]);
  });

  it('deny decision: applyObligations still runs — no obligations → passthrough', () => {
    // Caller should check decision.allow first; applyObligations itself only
    // acts on the obligations array.
    const d = evaluatePolicy(denyAll(), makeCtx(), emptyArgs);
    const rows: Row[] = [{ id: 1 }];
    expect(applyObligations(d, rows, makeCtx())).toEqual(rows);
  });
});

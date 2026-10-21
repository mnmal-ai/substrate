/**
 * Lossless extension-operator pre-resolve.
 *
 * `preResolveExtensionOperatorsDetailed`: operators can
 * return ordered, scored `{ hits: [...] }` and the pre-pass exposes them as a
 * side-channel `meta` while still rewriting the where-tree into a substrate-
 * native `{ id: { in: [...] } }` predicate. Any other result shape is refused.
 */

import type { FilterOperatorDef } from '@mnmal-ai/substrate-types';
import { afterEach, describe, expect, it } from 'vitest';
import {
  clearExtensionOperators,
  type ExtensionOpContext,
  ExtensionOperatorResultError,
  evaluateWhere,
  preResolveExtensionOperatorsDetailed,
  registerExtensionOperator
} from '../src/index.js';

/** Operator that echoes a fixed result regardless of value/substrate. */
function fixedOp(result: unknown): FilterOperatorDef {
  return {
    validate: (value) => ({ ok: true, value }),
    execute: async () => result
  };
}

const sub: ExtensionOpContext = { namespace: 'ns', type: 'T', k: 10 };

describe('preResolveExtensionOperatorsDetailed', () => {
  afterEach(() => clearExtensionOperators());

  it('hits-shaped operator → ordered in-array + meta (order preserved)', async () => {
    registerExtensionOperator(
      'sim',
      fixedOp({
        hits: [
          { id: 'b', score: 0.9, vector: [1, 0] },
          { id: 'a', score: 0.5 }
        ]
      })
    );

    const { where, meta } = await preResolveExtensionOperatorsDetailed({ sim: { to: 'x' } }, sub);

    expect(where).toEqual({ id: { in: ['b', 'a'] } });
    expect(meta).not.toBeNull();
    expect(meta?.orderedIds).toEqual(['b', 'a']);
    expect(meta?.computed.get('b')).toEqual({ score: 0.9, vector: [1, 0] });
    expect(meta?.computed.get('a')).toEqual({ score: 0.5 });
  });

  it.each([
    ['a bare array', [{ row: { id: 'x' }, score: 0.3 }]],
    ['an { ids } envelope', { ids: ['x'] }],
    ['undefined', undefined]
  ])('refuses %s, naming the operator', async (_label, result) => {
    registerExtensionOperator('sim', fixedOp(result));

    const err = await preResolveExtensionOperatorsDetailed({ sim: { to: 'x' } }, sub).then(
      () => undefined,
      (e: unknown) => e
    );

    expect(err).toBeInstanceOf(ExtensionOperatorResultError);
    expect((err as ExtensionOperatorResultError).operator).toBe('sim');
  });

  it("ANDs the caller's id predicate with the resolved one, in either key order", async () => {
    registerExtensionOperator(
      'sim',
      fixedOp({
        hits: [
          { id: 't1', score: 1 },
          { id: 't2', score: 1 }
        ]
      })
    );
    const rows = [{ id: 't1' }, { id: 't2' }, { id: 't3' }];
    for (const input of [
      { id: { eq: 't2' }, sim: {} },
      { sim: {}, id: { eq: 't2' } },
      { id: { in: ['t2', 't3'] }, sim: {} }
    ]) {
      const { where } = await preResolveExtensionOperatorsDetailed(input, sub);
      expect(rows.filter((r) => evaluateWhere(r, where)).map((r) => r.id)).toEqual(['t2']);
    }
  });

  it('refuses an operator named like a where-clause key', () => {
    for (const name of [
      'AND',
      'OR',
      'NOT',
      'id',
      'shortId',
      'createdById',
      'createdBy',
      'updatedAt'
    ]) {
      expect(() => registerExtensionOperator(name, fixedOp({ hits: [] }))).toThrow(/reserved/);
    }
  });

  it('hits-empty → match-nothing where + meta with empty orderedIds + empty computed', async () => {
    registerExtensionOperator('sim', fixedOp({ hits: [] }));

    const { where, meta } = await preResolveExtensionOperatorsDetailed({ sim: { to: 'x' } }, sub);

    expect(where).toEqual({ id: { in: [] } });
    expect(meta).not.toBeNull();
    expect(meta?.orderedIds).toEqual([]);
    expect(meta?.computed.size).toBe(0);
  });

  it('operator nested under AND → meta still produced, sibling predicate kept', async () => {
    registerExtensionOperator(
      'sim',
      fixedOp({
        hits: [
          { id: 'b', score: 0.9 },
          { id: 'a', score: 0.5 }
        ]
      })
    );

    const { where, meta } = await preResolveExtensionOperatorsDetailed(
      { AND: [{ status: { eq: 'open' } }, { sim: { to: 'x' } }] },
      sub
    );

    expect(where).toEqual({
      AND: [{ status: { eq: 'open' } }, { id: { in: ['b', 'a'] } }]
    });
    expect(meta).not.toBeNull();
    expect(meta?.orderedIds).toEqual(['b', 'a']);
  });

  it('threads returnVector through to the operator execute', async () => {
    const seen: unknown[] = [];
    registerExtensionOperator('sim', {
      validate: (value) => ({ ok: true, value }),
      execute: async (_value, context) => {
        seen.push(context);
        return { hits: [] };
      }
    });

    const subWithVector: ExtensionOpContext = { ...sub, returnVector: true };
    await preResolveExtensionOperatorsDetailed({ sim: { to: 'x' } }, subWithVector);

    expect(seen).toHaveLength(1);
    expect((seen[0] as ExtensionOpContext).returnVector).toBe(true);
  });

  it('hit without vector → computed entry has NO vector key (exactOptionalPropertyTypes)', async () => {
    registerExtensionOperator('sim', fixedOp({ hits: [{ id: 'a', score: 0.5 }] }));

    const { meta } = await preResolveExtensionOperatorsDetailed({ sim: { to: 'x' } }, sub);
    const entry = meta?.computed.get('a');
    expect(entry).toBeDefined();
    expect('vector' in (entry as object)).toBe(false);
  });
});

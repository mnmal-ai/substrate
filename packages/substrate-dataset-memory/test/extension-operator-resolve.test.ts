/**
 * Extension-operator pre-resolution tests for MemoryDataset.
 *
 * Substrate parity with the pg suite at
 * packages/substrate-dataset-pg/test/extension-operator-resolve.test.ts: same
 * fake operators, same expected row sets, same substrate context. Without the
 * pre-pass, an extension operator in the where-clause excludes every row.
 */

import { clearExtensionOperators, registerExtensionOperator } from '@mnmal-ai/substrate-filter';
import type { FilterOperatorDef } from '@mnmal-ai/substrate-types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemoryDataset } from '../src/index.js';

describe('MemoryDataset extension operator pre-resolution', () => {
  let ds: MemoryDataset;

  beforeEach(async () => {
    ds = new MemoryDataset({ namespace: 'ext_ns' });
    await ds.write('Note', [
      { id: 'r1', title: 'one', archived: false },
      { id: 'r2', title: 'two', archived: false },
      { id: 'r3', title: 'three', archived: true }
    ]);
  });

  afterEach(() => {
    clearExtensionOperators();
  });

  it('top-level operator returning hits substitutes id IN', async () => {
    const fakeRowResults: FilterOperatorDef = {
      validate: (v) => ({ ok: true, value: v }),
      execute: async () => ({
        hits: [
          { id: 'r1', score: 0.9 },
          { id: 'r3', score: 0.8 }
        ]
      })
    };
    registerExtensionOperator('fakeRowResults', fakeRowResults);

    const res = await ds.read('Note', { where: { fakeRowResults: { to: 'anything' } } });
    const ids = res.rows.map((r) => r.id).sort();
    expect(ids).toEqual(['r1', 'r3']);
  });

  it('a single-hit result selects just that row', async () => {
    const fakeIdsEnvelope: FilterOperatorDef = {
      validate: (v) => ({ ok: true, value: v }),
      execute: async () => ({ hits: [{ id: 'r2', score: 1 }] })
    };
    registerExtensionOperator('fakeIdsEnvelope', fakeIdsEnvelope);

    const res = await ds.read('Note', { where: { fakeIdsEnvelope: 'unused' } });
    expect(res.rows.map((r) => r.id)).toEqual(['r2']);
  });

  it('intersects extension-operator ids with sibling field clauses (implicit AND)', async () => {
    const fakeAll: FilterOperatorDef = {
      validate: (v) => ({ ok: true, value: v }),
      execute: async () => ({
        hits: [
          { id: 'r1', score: 1 },
          { id: 'r2', score: 1 },
          { id: 'r3', score: 1 }
        ]
      })
    };
    registerExtensionOperator('fakeAll', fakeAll);

    const res = await ds.read('Note', {
      where: { fakeAll: 'q', archived: { eq: false } }
    });
    const ids = res.rows.map((r) => r.id).sort();
    expect(ids).toEqual(['r1', 'r2']);
  });

  it('returns empty when the operator returns no matches', async () => {
    const fakeEmpty: FilterOperatorDef = {
      validate: (v) => ({ ok: true, value: v }),
      execute: async () => ({ hits: [] })
    };
    registerExtensionOperator('fakeEmpty', fakeEmpty);

    const res = await ds.read('Note', { where: { fakeEmpty: 'q' } });
    expect(res.rows).toEqual([]);
  });

  it('passes operator context context (namespace, type, k=limit) to op.execute', async () => {
    let captured: { namespace?: string; type?: string; k?: unknown } = {};
    const captureOp: FilterOperatorDef = {
      validate: (v) => ({ ok: true, value: v }),
      execute: async (_v, context) => {
        captured = context as typeof captured;
        return { hits: [{ id: 'r1', score: 1 }] };
      }
    };
    registerExtensionOperator('captureOp', captureOp);

    await ds.read('Note', { where: { captureOp: 'q' }, limit: 5 });
    expect(captured.namespace).toBe('ext_ns');
    expect(captured.type).toBe('Note');
    expect(captured.k).toBe(5);
  });

  it('resolves operators inside an AND combinator', async () => {
    const fakeR1R2: FilterOperatorDef = {
      validate: (v) => ({ ok: true, value: v }),
      execute: async () => ({
        hits: [
          { id: 'r1', score: 1 },
          { id: 'r2', score: 1 }
        ]
      })
    };
    registerExtensionOperator('fakeR1R2', fakeR1R2);

    const res = await ds.read('Note', {
      where: { AND: [{ fakeR1R2: 'q' }, { archived: { eq: false } }] }
    });
    const ids = res.rows.map((r) => r.id).sort();
    expect(ids).toEqual(['r1', 'r2']);
  });
});

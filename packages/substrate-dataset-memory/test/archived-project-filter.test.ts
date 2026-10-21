/**
 * archived + project filter parity with the pg suite
 * (packages/substrate-dataset-pg/test/read-archived-project-routing.test.ts):
 *
 *   where { archived: { eq: false }, project: { in: [<slug>, null] } }
 *
 * must return the same row set on both substrates, including IN-with-null.
 */

import { describe, expect, it } from 'vitest';
import { MemoryDataset } from '../src/index.js';

const mkDs = (): MemoryDataset => new MemoryDataset({ namespace: 'default' });

describe('MemoryDataset — archived + project filter', () => {
  it('where { archived: { eq: false } } returns only non-archived rows', async () => {
    const ds = mkDs();
    await ds.write('Memo', [
      { id: 'a1', archived: false },
      { id: 'a2', archived: true },
      { id: 'a3', archived: false }
    ]);
    const out = await ds.read('Memo', { where: { archived: { eq: false } } });
    expect(out.rows.map((r) => r.id).sort()).toEqual(['a1', 'a3']);
  });

  it('where { project: { eq: "substrate" } } returns only substrate-scoped rows', async () => {
    const ds = mkDs();
    await ds.write('Memo', [
      { id: 'b1', project: 'substrate' },
      { id: 'b2', project: 'other' },
      { id: 'b3', project: null }
    ]);
    const out = await ds.read('Memo', { where: { project: { eq: 'substrate' } } });
    expect(out.rows.map((r) => r.id)).toEqual(['b1']);
  });

  it('where { project: { eq: null } } returns only cross-cutting rows', async () => {
    const ds = mkDs();
    await ds.write('Memo', [
      { id: 'c1', project: 'substrate' },
      { id: 'c2', project: null },
      { id: 'c3', label: 'no project key' }
    ]);
    const out = await ds.read('Memo', { where: { project: { eq: null } } });
    expect(out.rows.map((r) => r.id).sort()).toEqual(['c2', 'c3']);
  });

  it('where { project: { in: ["substrate", null] } } returns substrate + cross-cutting', async () => {
    const ds = mkDs();
    await ds.write('Memo', [
      { id: 'd1', project: 'substrate' },
      { id: 'd2', project: 'other' },
      { id: 'd3', project: null },
      { id: 'd4', label: 'no project key' }
    ]);
    const out = await ds.read('Memo', { where: { project: { in: ['substrate', null] } } });
    expect(out.rows.map((r) => r.id).sort()).toEqual(['d1', 'd3', 'd4']);
  });

  it('cold-start hot-path: where { archived: { eq: false }, project: { in: ["substrate", null] } }', async () => {
    const ds = mkDs();
    await ds.write('Memo', [
      { id: 'e1', archived: false, project: 'substrate' },
      { id: 'e2', archived: true, project: 'substrate' },
      { id: 'e3', archived: false, project: 'other' },
      { id: 'e4', archived: false, project: null }
    ]);
    const out = await ds.read('Memo', {
      where: { archived: { eq: false }, project: { in: ['substrate', null] } }
    });
    expect(out.rows.map((r) => r.id).sort()).toEqual(['e1', 'e4']);
  });

  it('orderBy { archived: "asc" } sorts false < true with NULLS LAST', async () => {
    const ds = mkDs();
    await ds.write('Memo', [
      { id: 'f1', archived: true },
      { id: 'f2', archived: false },
      { id: 'f3', archived: false }
    ]);
    const out = await ds.read('Memo', {
      orderBy: [{ archived: 'asc' }, { id: 'asc' }]
    });
    expect(out.rows.map((r) => r.id)).toEqual(['f2', 'f3', 'f1']);
  });
});

/**
 * With a field lookup, the memory dataset filters and sorts `date` fields as
 * instants, as the pg dataset does.
 */

import type { FieldDef } from '@mnmal-ai/substrate-types';
import { describe, expect, it } from 'vitest';
import { MemoryDataset } from '../src/index.js';

const dateDef: FieldDef = { kind: 'scalar', type: 'date' };
const fieldDefLookup = (_type: string, f: string): FieldDef | undefined =>
  f === 'dueAt' ? dateDef : undefined;

const ROWS = [
  // 10:00+02:00 is 08:00Z: the earliest instant, though it sorts last as text.
  { id: 'a', dueAt: '2026-10-20T10:00:00+02:00' },
  { id: 'b', dueAt: '2026-10-20T09:00:00Z' },
  { id: 'c', dueAt: '2026-10-20T09:30:00.000Z' }
];

describe('MemoryDataset date fields', () => {
  it('sorts by instant, and pages on it', async () => {
    const ds = new MemoryDataset({ namespace: 't', fieldDefLookup });
    await ds.write('Task', ROWS);
    const all = await ds.read('Task', { orderBy: [{ dueAt: 'asc' }] });
    expect(all.rows.map((r) => r.id)).toEqual(['a', 'b', 'c']);
    const p1 = await ds.read('Task', { orderBy: [{ dueAt: 'asc' }], limit: 1 });
    const p2 = await ds.read('Task', {
      orderBy: [{ dueAt: 'asc' }],
      limit: 1,
      ...(p1.nextCursor !== undefined ? { cursor: p1.nextCursor } : {})
    });
    expect(p2.rows.map((r) => r.id)).toEqual(['b']);
  });

  it('filters by instant', async () => {
    const ds = new MemoryDataset({ namespace: 't', fieldDefLookup });
    await ds.write('Task', ROWS);
    const res = await ds.read('Task', { where: { dueAt: { lt: '2026-10-20T09:00:00Z' } } });
    expect(res.rows.map((r) => r.id)).toEqual(['a']);
  });
});

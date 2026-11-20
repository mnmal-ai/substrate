/**
 * A handle made by `forNamespace` answers field definitions from its own
 * namespace's lookup, not from the handle it was made on.
 */

import type { FieldDef } from '@mnmal-ai/substrate-types';
import { describe, expect, it } from 'vitest';
import { MemoryDataset } from '../src/index.js';

const dateDef: FieldDef = { kind: 'scalar', type: 'date' };
const fieldDefLookupFor =
  (namespace: string) =>
  (_type: string, field: string): FieldDef | undefined =>
    namespace === 'b' && field === 'dueAt' ? dateDef : undefined;

// 10:00+02:00 is 08:00Z: the earliest instant, though it sorts last as text.
const ROWS = [
  { id: 'a', dueAt: '2026-10-20T10:00:00+02:00' },
  { id: 'b', dueAt: '2026-10-20T09:00:00Z' }
];

const read = async (ds: MemoryDataset) => {
  await ds.write('Task', ROWS);
  return (await ds.read('Task', { orderBy: [{ dueAt: 'asc' }] })).rows.map((r) => r.id);
};

describe('MemoryDataset.forNamespace field definitions', () => {
  it("orders a date field by the sibling namespace's definitions", async () => {
    const parent = new MemoryDataset({
      namespace: 'a',
      fieldDefLookup: fieldDefLookupFor('a'),
      fieldDefLookupFor
    });
    expect(await read(parent.forNamespace('b') as MemoryDataset)).toEqual(['a', 'b']);
  });

  it("keeps the parent's definitions for a sibling when no per-namespace lookup is given", async () => {
    const parent = new MemoryDataset({ namespace: 'a', fieldDefLookup: fieldDefLookupFor('a') });
    // 'a' declares no date, so the sibling compares as text: '...+02:00' sorts after '...Z'.
    expect(await read(parent.forNamespace('b') as MemoryDataset)).toEqual(['b', 'a']);
  });
});

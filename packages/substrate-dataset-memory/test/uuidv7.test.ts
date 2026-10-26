import { describe, expect, it } from 'vitest';
import { MemoryDataset } from '../src/index.js';
import { uuidv7 } from '../src/uuidv7.js';

const V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('uuidv7 ids (memory)', () => {
  it('an id-less create gets a version-7 UUID', async () => {
    const ds = new MemoryDataset({ namespace: 'test' });
    const { ids, rows } = await ds.write('Todo', [{ title: 'a' }]);
    expect(ids[0]).toMatch(V7);
    expect(rows[0]?.id).toBe(ids[0]);
    const { rows: read } = await ds.read('Todo', { id: String(ids[0]) });
    expect(read[0]?.title).toBe('a');
  });

  it('a client-supplied id is kept verbatim, and ids keep input order', async () => {
    const ds = new MemoryDataset({ namespace: 'test' });
    const { ids } = await ds.write('Todo', [
      { title: 'a' },
      { id: 'given', title: 'b' },
      { title: 'c' }
    ]);
    expect(ids).toHaveLength(3);
    expect(ids[0]).toMatch(V7);
    expect(ids[1]).toBe('given');
    expect(ids[2]).toMatch(V7);
    expect(String(ids[0]) < String(ids[2])).toBe(true);
  });

  it('ids generated in sequence sort in creation order, with the version and variant bits set', () => {
    const ids = Array.from({ length: 10_000 }, () => uuidv7());
    for (const id of ids) expect(id).toMatch(V7);
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('carries the current unix milliseconds in the first 48 bits', () => {
    const before = Date.now();
    const id = uuidv7();
    const ms = Number.parseInt(id.replace(/-/g, '').slice(0, 12), 16);
    expect(ms).toBeGreaterThanOrEqual(before);
    // A burst that overflows the counter borrows a few milliseconds ahead.
    expect(ms).toBeLessThanOrEqual(Date.now() + 50);
  });
});

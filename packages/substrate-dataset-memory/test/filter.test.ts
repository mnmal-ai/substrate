/**
 * Filter / orderBy / cursor coverage for MemoryDataset. Spec §5.2.
 *
 * These tests exercise the in-memory evaluator directly — upstream validation
 * (engine + FilterValidationError) is covered separately in substrate-core.
 */

import { describe, expect, it } from 'vitest';
import { MemoryDataset } from '../src/index.js';

const mkDs = (): MemoryDataset => new MemoryDataset({ namespace: 'default' });

describe('MemoryDataset — where clause operators', () => {
  it('number: eq / neq / gt / gte / lt / lte', async () => {
    const ds = mkDs();
    await ds.write('N', [
      { id: 1, v: 5 },
      { id: 2, v: 10 },
      { id: 3, v: 15 }
    ]);
    expect((await ds.read('N', { where: { v: { eq: 10 } } })).rows.map((r) => r.id)).toEqual([2]);
    expect(
      (await ds.read('N', { where: { v: { neq: 10 } } })).rows.map((r) => r.id).sort()
    ).toEqual([1, 3]);
    expect((await ds.read('N', { where: { v: { gt: 10 } } })).rows.map((r) => r.id)).toEqual([3]);
    expect(
      (await ds.read('N', { where: { v: { gte: 10 } } })).rows.map((r) => r.id).sort()
    ).toEqual([2, 3]);
    expect((await ds.read('N', { where: { v: { lt: 10 } } })).rows.map((r) => r.id)).toEqual([1]);
    expect(
      (await ds.read('N', { where: { v: { lte: 10 } } })).rows.map((r) => r.id).sort()
    ).toEqual([1, 2]);
  });

  it('number: between (inclusive)', async () => {
    const ds = mkDs();
    await ds.write('N', [
      { id: 1, v: 5 },
      { id: 2, v: 10 },
      { id: 3, v: 15 }
    ]);
    const out = await ds.read('N', { where: { v: { between: [10, 15] } } });
    expect(out.rows.map((r) => r.id).sort()).toEqual([2, 3]);
  });

  it('number: in / nin', async () => {
    const ds = mkDs();
    await ds.write('N', [
      { id: 1, v: 5 },
      { id: 2, v: 10 },
      { id: 3, v: 15 }
    ]);
    expect(
      (await ds.read('N', { where: { v: { in: [5, 15] } } })).rows.map((r) => r.id).sort()
    ).toEqual([1, 3]);
    expect((await ds.read('N', { where: { v: { nin: [5, 15] } } })).rows.map((r) => r.id)).toEqual([
      2
    ]);
  });

  it('string: gt / lt / between (lexicographic UTF-16 code-unit order)', async () => {
    // evaluateWhere compares strings by UTF-16 code unit — byte-stable for
    // ASCII-shaped keys (ISO dates, ULIDs, zero-padded sequences).
    const ds = mkDs();
    await ds.write('S', [
      { id: 1, title: 'apple' },
      { id: 2, title: 'mango' },
      { id: 3, title: 'zebra' }
    ]);
    // gt 'm' → rows strictly greater-than 'm': 'mango' > 'm' ✓, 'zebra' > 'm' ✓
    expect(
      (await ds.read('S', { where: { title: { gt: 'm' } } })).rows
        .map((r) => r.title as string)
        .sort()
    ).toEqual(['mango', 'zebra']);
    // between ['a', 'n'] inclusive: 'apple' ✓, 'mango' ✓ (both < 'n'); 'zebra' ✗
    expect(
      (await ds.read('S', { where: { title: { between: ['a', 'n'] } } })).rows
        .map((r) => r.title as string)
        .sort()
    ).toEqual(['apple', 'mango']);
    // lt 'm' → 'apple' < 'm' ✓; 'mango' >= 'm' ✗; 'zebra' >= 'm' ✗
    expect(
      (await ds.read('S', { where: { title: { lt: 'm' } } })).rows.map((r) => r.title as string)
    ).toEqual(['apple']);
  });

  it('string: contains / startsWith / endsWith (case-insensitive)', async () => {
    const ds = mkDs();
    await ds.write('S', [
      { id: 1, label: 'Hello World' },
      { id: 2, label: 'WORLD PEACE' },
      { id: 3, label: 'goodnight' }
    ]);
    expect(
      (await ds.read('S', { where: { label: { contains: 'world' } } })).rows.map((r) => r.id).sort()
    ).toEqual([1, 2]);
    expect(
      (await ds.read('S', { where: { label: { startsWith: 'hello' } } })).rows.map((r) => r.id)
    ).toEqual([1]);
    expect(
      (await ds.read('S', { where: { label: { endsWith: 'PEACE' } } })).rows.map((r) => r.id)
    ).toEqual([2]);
  });

  it('boolean: eq', async () => {
    const ds = mkDs();
    await ds.write('B', [
      { id: 1, done: true },
      { id: 2, done: false }
    ]);
    expect((await ds.read('B', { where: { done: { eq: true } } })).rows.map((r) => r.id)).toEqual([
      1
    ]);
    expect((await ds.read('B', { where: { done: { eq: false } } })).rows.map((r) => r.id)).toEqual([
      2
    ]);
  });

  it('eq null / neq null', async () => {
    const ds = mkDs();
    await ds.write('X', [
      { id: 1, opt: 'filled' },
      { id: 2, opt: null }
    ]);
    expect((await ds.read('X', { where: { opt: { eq: null } } })).rows.map((r) => r.id)).toEqual([
      2
    ]);
    expect((await ds.read('X', { where: { opt: { neq: null } } })).rows.map((r) => r.id)).toEqual([
      1
    ]);
  });
});

describe('MemoryDataset — logical combinators', () => {
  it('AND flattens children', async () => {
    const ds = mkDs();
    await ds.write('T', [
      { id: 1, a: 1, b: 'x' },
      { id: 2, a: 1, b: 'y' },
      { id: 3, a: 2, b: 'x' }
    ]);
    const out = await ds.read('T', {
      where: { AND: [{ a: { eq: 1 } }, { b: { eq: 'x' } }] }
    });
    expect(out.rows.map((r) => r.id)).toEqual([1]);
  });

  it('OR unions', async () => {
    const ds = mkDs();
    await ds.write('T', [
      { id: 1, a: 1 },
      { id: 2, a: 2 },
      { id: 3, a: 3 }
    ]);
    const out = await ds.read('T', {
      where: { OR: [{ a: { eq: 1 } }, { a: { eq: 3 } }] }
    });
    expect(out.rows.map((r) => r.id).sort()).toEqual([1, 3]);
  });

  it('NOT inverts', async () => {
    const ds = mkDs();
    await ds.write('T', [
      { id: 1, a: 1 },
      { id: 2, a: 2 }
    ]);
    const out = await ds.read('T', { where: { NOT: { a: { eq: 1 } } } });
    expect(out.rows.map((r) => r.id)).toEqual([2]);
  });
});

describe('MemoryDataset — orderBy', () => {
  it('single-key asc / desc', async () => {
    const ds = mkDs();
    await ds.write('T', [
      { id: 1, v: 30 },
      { id: 2, v: 10 },
      { id: 3, v: 20 }
    ]);
    expect((await ds.read('T', { orderBy: [{ v: 'asc' }] })).rows.map((r) => r.v)).toEqual([
      10, 20, 30
    ]);
    expect((await ds.read('T', { orderBy: [{ v: 'desc' }] })).rows.map((r) => r.v)).toEqual([
      30, 20, 10
    ]);
  });

  it('multi-key honours leftmost-first', async () => {
    const ds = mkDs();
    await ds.write('T', [
      { id: 1, group: 'a', v: 1 },
      { id: 2, group: 'b', v: 1 },
      { id: 3, group: 'a', v: 2 }
    ]);
    const out = await ds.read('T', {
      orderBy: [{ group: 'asc' }, { v: 'desc' }]
    });
    expect(out.rows.map((r) => r.id)).toEqual([3, 1, 2]);
  });

  it('nulls sort last regardless of direction', async () => {
    const ds = mkDs();
    await ds.write('T', [
      { id: 1, v: 10 },
      { id: 2, v: null },
      { id: 3, v: 5 }
    ]);
    const asc = await ds.read('T', { orderBy: [{ v: 'asc' }] });
    expect(asc.rows.map((r) => r.id)).toEqual([3, 1, 2]);
    const desc = await ds.read('T', { orderBy: [{ v: 'desc' }] });
    expect(desc.rows.map((r) => r.id)).toEqual([1, 3, 2]);
  });

  it('id is the implicit final tie-breaker', async () => {
    const ds = mkDs();
    await ds.write('T', [
      { id: 3, v: 1 },
      { id: 1, v: 1 },
      { id: 2, v: 1 }
    ]);
    const out = await ds.read('T', { orderBy: [{ v: 'asc' }] });
    expect(out.rows.map((r) => r.id)).toEqual([1, 2, 3]);
  });
});

describe('MemoryDataset — cursor pagination', () => {
  it('walks end-to-end with no dupes or skips', async () => {
    const ds = mkDs();
    // Insert 20 rows with unique `n` values.
    const rows = Array.from({ length: 20 }, (_, i) => ({ id: `t${i + 1}`, n: i + 1 }));
    await ds.write('T', rows);

    const seen: unknown[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 5; page++) {
      const res = await ds.read('T', {
        orderBy: [{ n: 'asc' }],
        limit: 5,
        ...(cursor !== undefined ? { cursor } : {})
      });
      expect(res.rows).toHaveLength(page < 3 ? 5 : page === 3 ? 5 : 0);
      seen.push(...res.rows.map((r) => r.id));
      if (!res.hasMore) break;
      cursor = res.nextCursor;
    }
    expect(seen).toHaveLength(20);
    expect(new Set(seen).size).toBe(20);
    // Expected order: t1 through t20.
    expect(seen).toEqual(rows.map((r) => r.id));
  });

  it('walks every page with NO orderBy, sorting by id as pg does', async () => {
    const ds = mkDs();
    // Inserted out of id order, so insertion order and id order disagree.
    const ids = Array.from({ length: 25 }, (_, i) => `r${String(i + 1).padStart(2, '0')}`);
    await ds.write(
      'T',
      [...ids].reverse().map((id) => ({ id, keep: true }))
    );

    const seen: unknown[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 5; page++) {
      const res = await ds.read('T', {
        where: { keep: { eq: true } },
        limit: 10,
        ...(cursor !== undefined ? { cursor } : {})
      });
      seen.push(...res.rows.map((r) => r.id));
      if (!res.hasMore) break;
      cursor = res.nextCursor;
    }
    expect(seen).toEqual(ids);
  });

  it.each([
    { label: 'id first', orderBy: [{ id: 'asc' as const }, { title: 'asc' as const }] },
    {
      label: 'id in the middle',
      orderBy: [{ group: 'asc' as const }, { id: 'desc' as const }, { title: 'asc' as const }]
    }
  ])(
    'walks every row once when id is not the last orderBy clause ($label)',
    async ({ orderBy }) => {
      const ds = mkDs();
      // title order (c, a, b) disagrees with id order (1, 2, 3).
      await ds.write('T', [
        { id: 1, group: 'g', title: 'c' },
        { id: 2, group: 'g', title: 'a' },
        { id: 3, group: 'g', title: 'b' }
      ]);
      const all = (await ds.read('T', { orderBy })).rows.map((r) => r.id);
      const seen: unknown[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 5; page++) {
        const res = await ds.read('T', {
          orderBy,
          limit: 1,
          ...(cursor !== undefined ? { cursor } : {})
        });
        seen.push(...res.rows.map((r) => r.id));
        if (!res.hasMore) break;
        cursor = res.nextCursor;
      }
      expect(seen).toEqual(all);
      expect(new Set(seen).size).toBe(3);
    }
  );

  it('hasMore is false on the last page, nextCursor is undefined', async () => {
    const ds = mkDs();
    await ds.write('T', [
      { id: 1, v: 1 },
      { id: 2, v: 2 },
      { id: 3, v: 3 }
    ]);
    const res = await ds.read('T', { orderBy: [{ v: 'asc' }], limit: 10 });
    expect(res.rows).toHaveLength(3);
    expect(res.hasMore).toBe(false);
    expect(res.nextCursor).toBeUndefined();
  });

  it('cursor + where compose — where re-applies on every page', async () => {
    const ds = mkDs();
    await ds.write(
      'T',
      Array.from({ length: 10 }, (_, i) => ({ id: i + 1, n: i + 1, keep: (i + 1) % 2 === 0 }))
    );
    let cursor: string | undefined;
    const seen: number[] = [];
    for (let i = 0; i < 4; i++) {
      const res = await ds.read('T', {
        where: { keep: { eq: true } },
        orderBy: [{ n: 'asc' }],
        limit: 2,
        ...(cursor !== undefined ? { cursor } : {})
      });
      seen.push(...(res.rows.map((r) => r.n) as number[]));
      if (!res.hasMore) break;
      cursor = res.nextCursor;
    }
    expect(seen).toEqual([2, 4, 6, 8, 10]);
  });

  // List element membership. Kept byte-parity with the pg suite.
  it('list: has — string element membership', async () => {
    const ds = mkDs();
    await ds.write('T', [
      { id: 1, tags: ['urgent', 'review'] },
      { id: 2, tags: ['done'] },
      { id: 3, tags: ['urgent', 'blocked'] },
      { id: 4, tags: [] }
    ]);
    expect(
      (await ds.read('T', { where: { tags: { has: 'urgent' } } })).rows.map((r) => r.id).sort()
    ).toEqual([1, 3]);
    expect(
      (await ds.read('T', { where: { tags: { has: 'done' } } })).rows.map((r) => r.id)
    ).toEqual([2]);
    expect((await ds.read('T', { where: { tags: { has: 'nope' } } })).rows).toEqual([]);
  });

  it('list: has — numeric element membership (native types, 10 ≠ "10")', async () => {
    const ds = mkDs();
    await ds.write('T', [
      { id: 1, scores: [1, 2, 10] },
      { id: 2, scores: [3] }
    ]);
    expect((await ds.read('T', { where: { scores: { has: 10 } } })).rows.map((r) => r.id)).toEqual([
      1
    ]);
    expect((await ds.read('T', { where: { scores: { has: '10' } } })).rows).toEqual([]);
  });
});

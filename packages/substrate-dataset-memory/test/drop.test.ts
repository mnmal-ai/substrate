import { beforeEach, describe, expect, it } from 'vitest';
import { MemoryDataset } from '../src/memory-dataset.js';

describe('MemoryDataset drop primitives', () => {
  let ds: MemoryDataset;
  beforeEach(() => {
    ds = new MemoryDataset({ namespace: 'sandbox' });
  });

  it('dropType removes every row of that type and leaves others intact', async () => {
    await ds.write('Foo', [
      { id: '1', name: 'a' },
      { id: '2', name: 'b' }
    ]);
    await ds.write('Bar', [{ id: '9', name: 'keep' }]);

    const result = await ds.dropType('Foo');

    expect(result.rowsDeleted).toBe(2);
    const foos = await ds.read('Foo', {});
    expect(foos.rows).toHaveLength(0);
    const bars = await ds.read('Bar', {});
    expect(bars.rows).toHaveLength(1);
  });

  it('dropType removes short-id allocations for that type', async () => {
    await ds.write('Foo', [{ id: '1' }]);
    const short = await ds.allocateShortId('Foo');
    await ds.bindShortId('Foo', short, '1');
    expect(await ds.resolveShortId('Foo', short)).toBe('1');

    const result = await ds.dropType('Foo');

    expect(result.shortIdsDeleted).toBeGreaterThanOrEqual(1);
    expect(await ds.resolveShortId('Foo', short)).toBeNull();
  });

  it('a rolled-back dropType does not reissue short-ids burned by an earlier rolled-back tx', async () => {
    await ds.write('Foo', [{ id: '1' }]);
    const kept = await ds.allocateShortId('Foo');
    await ds.bindShortId('Foo', kept, '1');

    const burned: number[] = [];
    await expect(
      ds.withTransaction(async (tx) => {
        await tx.write('Foo', [{ id: '2' }, { id: '3' }]);
        for (const rowId of ['2', '3']) {
          const s = await tx.allocateShortId('Foo');
          await tx.bindShortId('Foo', s, rowId);
          burned.push(s);
        }
        throw new Error('roll back the burn');
      })
    ).rejects.toThrow('roll back the burn');

    await expect(
      ds.withTransaction(async (tx) => {
        await tx.dropType('Foo');
        throw new Error('roll back the drop');
      })
    ).rejects.toThrow('roll back the drop');

    expect(await ds.resolveShortId('Foo', kept)).toBe('1');
    const next = await ds.allocateShortId('Foo');
    expect(burned).not.toContain(next);
    expect(next).toBeGreaterThan(Math.max(...burned));
  });

  it('dropType returns zeros when type has no rows', async () => {
    const result = await ds.dropType('Nonexistent');
    expect(result).toEqual({ rowsDeleted: 0, shortIdsDeleted: 0 });
  });

  it('dropType nukes archived / tombstoned rows too', async () => {
    await ds.write('Foo', [{ id: '1' }]);
    await ds.tombstone('Foo', ['1']);
    // Row is tombstoned (has _deletedAt) but still in storage.

    const result = await ds.dropType('Foo');

    expect(result.rowsDeleted).toBe(1);
  });

  it('dropNamespace removes every row across every type', async () => {
    await ds.write('Foo', [{ id: '1' }, { id: '2' }]);
    await ds.write('Bar', [{ id: '9' }]);

    const result = await ds.dropNamespace();

    expect(result.rowsDeleted).toBe(3);
    const foos = await ds.read('Foo', {});
    const bars = await ds.read('Bar', {});
    expect(foos.rows).toHaveLength(0);
    expect(bars.rows).toHaveLength(0);
  });

  it('dropNamespace rollback on throw: if the operation is run inside a tx that throws, storage is unchanged', async () => {
    await ds.write('Foo', [{ id: '1' }]);
    await expect(
      ds.withTransaction(async (tx) => {
        await tx.dropNamespace();
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');
    const foos = await ds.read('Foo', {});
    expect(foos.rows).toHaveLength(1);
  });
});

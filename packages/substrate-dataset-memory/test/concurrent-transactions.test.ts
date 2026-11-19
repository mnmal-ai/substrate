/**
 * Two requests' transactions on one memory dataset, interleaved: each commits
 * or rolls back on its own, as two pg transactions would.
 */

import { describe, expect, it } from 'vitest';
import { MemoryDataset } from '../src/index.js';

const tick = () => new Promise((r) => setTimeout(r, 10));

describe('MemoryDataset concurrent transactions', () => {
  it("one transaction's rollback does not erase another's committed write", async () => {
    const ds = new MemoryDataset({ namespace: 'ns' });
    const a = ds.withTransaction(async (tx) => {
      await tx.write('T', [{ id: 'a1' }]);
      await tick();
      await tick();
      throw new Error('a fails');
    });
    await tick();
    const b = ds.withTransaction(async (tx) => {
      await tx.write('T', [{ id: 'b1' }]);
      return 'b done';
    });
    await expect(a).rejects.toThrow('a fails');
    await expect(b).resolves.toBe('b done');
    const ids = (await ds.read('T', {})).rows.map((r) => r.id);
    expect(ids).toEqual(['b1']);
  });

  it('a transaction that fails partway rolls back its own writes while another is open', async () => {
    const ds = new MemoryDataset({ namespace: 'ns' });
    const a = ds.withTransaction(async (tx) => {
      await tx.write('T', [{ id: 'a1' }]);
      await tick();
      await tick();
    });
    await tick();
    const b = ds.withTransaction(async (tx) => {
      await tx.write('T', [{ id: 'b1' }]);
      throw new Error('b fails');
    });
    await a;
    await expect(b).rejects.toThrow('b fails');
    const ids = (await ds.read('T', {})).rows.map((r) => r.id);
    expect(ids).toEqual(['a1']);
  });

  it('a nested call joins the open transaction', async () => {
    const ds = new MemoryDataset({ namespace: 'ns' });
    await expect(
      ds.withTransaction(async (tx) => {
        await tx.write('T', [{ id: 'x' }]);
        await tx.withTransaction(async (inner) => inner.write('T', [{ id: 'y' }]));
        throw new Error('outer fails');
      })
    ).rejects.toThrow('outer fails');
    expect((await ds.read('T', {})).rows).toEqual([]);
  });
});

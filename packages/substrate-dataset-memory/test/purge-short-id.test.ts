/**
 * Purging a row drops its short id binding, as pg's short_ids cascade does,
 * so a row re-created under the same id gets and shows a new short id.
 */

import { describe, expect, it } from 'vitest';
import { MemoryDataset } from '../src/index.js';

async function seed(ds: MemoryDataset): Promise<number> {
  await ds.write('T', [{ id: 'x' }]);
  const sid = await ds.allocateShortId('T');
  await ds.bindShortId('T', sid, 'x');
  return sid;
}

describe('MemoryDataset.purge and short ids', () => {
  it('drops the binding, so a re-created row shows its new short id', async () => {
    const ds = new MemoryDataset({ namespace: 'ns' });
    const first = await seed(ds);
    await ds.purge('T', ['x']);
    expect(await ds.resolveShortId('T', first)).toBeNull();
    const second = await seed(ds);
    expect(second).not.toBe(first);
    expect((await ds.read('T', { id: 'x' })).rows[0]?.shortId).toBe(second);
    expect(await ds.resolveShortId('T', second)).toBe('x');
  });

  it('keeps the binding when the purge rolls back', async () => {
    const ds = new MemoryDataset({ namespace: 'ns' });
    const first = await seed(ds);
    await expect(
      ds.withTransaction(async (tx) => {
        await tx.purge('T', ['x']);
        throw new Error('roll back');
      })
    ).rejects.toThrow('roll back');
    expect(await ds.resolveShortId('T', first)).toBe('x');
    expect((await ds.read('T', { id: 'x' })).rows[0]?.shortId).toBe(first);
  });
});

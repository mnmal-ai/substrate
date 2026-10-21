import { describe, expect, it } from 'vitest';
import { MemoryDataset } from '../src/index.js';

const mkDs = (namespace = 'test'): MemoryDataset => new MemoryDataset({ namespace });

describe('MemoryDataset.withTransaction', () => {
  it('commits writes on resolve', async () => {
    const ds = mkDs();
    await ds.withTransaction(async (tx) => {
      await tx.write('Todo', [{ id: 1, title: 'a' }]);
      await tx.write('Todo', [{ id: 2, title: 'b' }]);
    });

    const { rows } = await ds.read('Todo', {});
    expect(rows).toHaveLength(2);
  });

  it('rolls back writes on synchronous throw inside fn', async () => {
    const ds = mkDs();
    await ds.write('Todo', [{ id: 'pre', title: 'survives' }]);

    await expect(
      ds.withTransaction(async (tx) => {
        await tx.write('Todo', [{ id: 1, title: 'gone' }]);
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');

    const { rows } = await ds.read('Todo', { includeDeleted: true });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe('pre');
  });

  it('rolls back writes on promise rejection', async () => {
    const ds = mkDs();
    await expect(
      ds.withTransaction(async (tx) => {
        await tx.write('Todo', [{ id: 1, title: 'gone' }]);
        return Promise.reject(new Error('async boom'));
      })
    ).rejects.toThrow('async boom');

    const { rows } = await ds.read('Todo', {});
    expect(rows).toHaveLength(0);
  });

  it('tx.namespace === outer ds.namespace', async () => {
    const ds = mkDs('claude');
    await ds.withTransaction(async (tx) => {
      expect(tx.namespace).toBe('claude');
    });
  });

  it('returned value propagates on resolve', async () => {
    const ds = mkDs();
    const result = await ds.withTransaction(async (tx) => {
      await tx.write('Todo', [{ id: 1, title: 'x' }]);
      return 42;
    });
    expect(result).toBe(42);
  });

  it('nested tx flattens — inner throw rolls back outer writes too', async () => {
    const ds = mkDs();
    await ds.write('Todo', [{ id: 'seed', title: 'survives' }]);

    await expect(
      ds.withTransaction(async (tx) => {
        await tx.write('Todo', [{ id: 1, title: 'outer' }]);
        await tx.withTransaction(async (tx2) => {
          await tx2.write('Todo', [{ id: 2, title: 'inner' }]);
          throw new Error('inner boom');
        });
      })
    ).rejects.toThrow('inner boom');

    const { rows } = await ds.read('Todo', { includeDeleted: true });
    // Only the seed survives — outer + inner writes both rolled back.
    expect(rows.map((r) => r.id)).toEqual(['seed']);
  });

  it('nested tx flattens — inner resolve, outer throw still rolls back inner', async () => {
    const ds = mkDs();
    await expect(
      ds.withTransaction(async (tx) => {
        await tx.withTransaction(async (tx2) => {
          await tx2.write('Todo', [{ id: 1, title: 'nested' }]);
        });
        throw new Error('outer boom');
      })
    ).rejects.toThrow('outer boom');

    const { rows } = await ds.read('Todo', {});
    expect(rows).toHaveLength(0);
  });

  it('tombstone inside tx rolls back on throw', async () => {
    const ds = mkDs();
    await ds.write('Todo', [{ id: 1, title: 'live' }]);

    await expect(
      ds.withTransaction(async (tx) => {
        await tx.tombstone('Todo', [1]);
        throw new Error('rollback');
      })
    ).rejects.toThrow('rollback');

    const { rows } = await ds.read('Todo', { id: 1 });
    expect(rows[0]?._deletedAt).toBeUndefined();
  });

  it('updateField inside tx rolls back on throw', async () => {
    const ds = mkDs();
    await ds.write('Todo', [{ id: 1, title: 'original' }]);

    await expect(
      ds.withTransaction(async (tx) => {
        await tx.updateField({ type: 'Todo', id: 1 }, 'title', 'mutated');
        throw new Error('rollback');
      })
    ).rejects.toThrow('rollback');

    const { rows } = await ds.read('Todo', { id: 1 });
    expect(rows[0]?.title).toBe('original');
  });

  it('purge inside tx rolls back on throw', async () => {
    const ds = mkDs();
    await ds.write('Todo', [{ id: 1, title: 'keep' }]);

    await expect(
      ds.withTransaction(async (tx) => {
        await tx.purge('Todo', [1]);
        throw new Error('rollback');
      })
    ).rejects.toThrow('rollback');

    const { rows } = await ds.read('Todo', { id: 1 });
    expect(rows[0]?.title).toBe('keep');
  });

  it('reads inside tx see tx writes', async () => {
    const ds = mkDs();
    await ds.withTransaction(async (tx) => {
      await tx.write('Todo', [{ id: 1, title: 'in-tx' }]);
      const { rows } = await tx.read('Todo', { id: 1 });
      expect(rows).toHaveLength(1);
      expect(rows[0]?.title).toBe('in-tx');
    });
  });

  it('commits after rollback leaves ds in a usable state', async () => {
    const ds = mkDs();
    await expect(
      ds.withTransaction(async (tx) => {
        await tx.write('Todo', [{ id: 1, title: 'doomed' }]);
        throw new Error('boom');
      })
    ).rejects.toThrow();

    // Second tx commits cleanly.
    await ds.withTransaction(async (tx) => {
      await tx.write('Todo', [{ id: 2, title: 'survives' }]);
    });

    const { rows } = await ds.read('Todo', {});
    expect(rows.map((r) => r.id)).toEqual([2]);
  });

  describe('shortId rollback', () => {
    it('rollback drops shortId bindings made inside the tx', async () => {
      const ds = mkDs();

      await expect(
        ds.withTransaction(async (tx) => {
          await tx.write('Todo', [{ id: 'uuid-a', title: 'gone' }]);
          const short = await tx.allocateShortId('Todo');
          await tx.bindShortId('Todo', short, 'uuid-a');
          expect(short).toBe(1);
          throw new Error('boom');
        })
      ).rejects.toThrow('boom');

      // Row is gone (existing rollback semantics).
      const { rows } = await ds.read('Todo', { includeDeleted: true });
      expect(rows).toHaveLength(0);

      // Binding is gone too — no stale pointer to the non-existent rowId.
      expect(await ds.resolveShortId('Todo', 1)).toBeNull();
      expect(await ds.getShortIdForRow('Todo', 'uuid-a')).toBeNull();
    });

    it('counter stays advanced after rollback (shortId is burned)', async () => {
      const ds = mkDs();

      await expect(
        ds.withTransaction(async (tx) => {
          const short = await tx.allocateShortId('Todo');
          expect(short).toBe(1);
          await tx.bindShortId('Todo', short, 'uuid-a');
          throw new Error('boom');
        })
      ).rejects.toThrow('boom');

      // Next allocation returns 2, not 1 — burned ids are never reused.
      expect(await ds.allocateShortId('Todo')).toBe(2);
    });

    it('commit preserves shortId bindings', async () => {
      const ds = mkDs();

      await ds.withTransaction(async (tx) => {
        await tx.write('Todo', [{ id: 'uuid-a', title: 'a' }]);
        const short = await tx.allocateShortId('Todo');
        await tx.bindShortId('Todo', short, 'uuid-a');
      });

      expect(await ds.resolveShortId('Todo', 1)).toBe('uuid-a');
      expect(await ds.getShortIdForRow('Todo', 'uuid-a')).toBe(1);
      const { rows } = await ds.read('Todo', { id: 'uuid-a' });
      expect(rows).toHaveLength(1);
    });

    it('nested tx: inner bindShortId rolls back when outer throws', async () => {
      const ds = mkDs();

      await expect(
        ds.withTransaction(async (tx) => {
          await tx.withTransaction(async (tx2) => {
            const short = await tx2.allocateShortId('Todo');
            await tx2.bindShortId('Todo', short, 'uuid-nested');
          });
          throw new Error('outer boom');
        })
      ).rejects.toThrow('outer boom');

      expect(await ds.resolveShortId('Todo', 1)).toBeNull();
      expect(await ds.getShortIdForRow('Todo', 'uuid-nested')).toBeNull();
      // Counter still advanced — burned.
      expect(await ds.allocateShortId('Todo')).toBe(2);
    });
  });
});

import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PgDataset, runMigrations } from '../src/index.js';

const POSTGRES_URL = process.env.POSTGRES_URL;

describe.skipIf(!POSTGRES_URL)('PgDataset.withTransaction', () => {
  let sql: Sql;
  let ds: PgDataset;

  beforeAll(async () => {
    sql = postgres(POSTGRES_URL as string);
    await runMigrations(sql);
  });

  afterAll(async () => {
    await sql.end();
  });

  beforeEach(async () => {
    await sql`TRUNCATE TABLE rows, short_ids`;
    ds = new PgDataset({ namespace: 'test_ns', sql });
  });

  it('commits writes on resolve', async () => {
    await ds.withTransaction(async (tx) => {
      await tx.write('Todo', [{ id: 1, title: 'a' }]);
      await tx.write('Todo', [{ id: 2, title: 'b' }]);
    });

    const { rows } = await ds.read('Todo', {});
    expect(rows).toHaveLength(2);
  });

  it('rolls back writes on throw inside fn', async () => {
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

  it('rolls back on promise rejection', async () => {
    await expect(
      ds.withTransaction(async (tx) => {
        await tx.write('Todo', [{ id: 1, title: 'gone' }]);
        return Promise.reject(new Error('async boom'));
      })
    ).rejects.toThrow('async boom');

    const { rows } = await ds.read('Todo', {});
    expect(rows).toHaveLength(0);
  });

  it('tx.namespace matches outer ds.namespace', async () => {
    await ds.withTransaction(async (tx) => {
      expect(tx.namespace).toBe('test_ns');
    });
  });

  it('returned value propagates on resolve', async () => {
    const result = await ds.withTransaction(async (tx) => {
      await tx.write('Todo', [{ id: 1, title: 'x' }]);
      return 'ok';
    });
    expect(result).toBe('ok');
  });

  it('nested tx flattens — inner throw rolls back outer writes too', async () => {
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
    expect(rows.map((r) => r.id).sort()).toEqual(['seed']);
  });

  it('nested tx flattens — inner resolve, outer throw still rolls back inner', async () => {
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
    await ds.withTransaction(async (tx) => {
      await tx.write('Todo', [{ id: 1, title: 'in-tx' }]);
      const { rows } = await tx.read('Todo', { id: 1 });
      expect(rows).toHaveLength(1);
      expect(rows[0]?.title).toBe('in-tx');
    });
  });

  it('commits after rollback leaves ds in a usable state', async () => {
    await expect(
      ds.withTransaction(async (tx) => {
        await tx.write('Todo', [{ id: 1, title: 'doomed' }]);
        throw new Error('boom');
      })
    ).rejects.toThrow();

    await ds.withTransaction(async (tx) => {
      await tx.write('Todo', [{ id: 2, title: 'survives' }]);
    });

    const { rows } = await ds.read('Todo', {});
    expect(rows.map((r) => r.id)).toEqual([2]);
  });
});

/**
 * A declared unique index refuses a colliding write with `unique_violation`,
 * naming the index and its fields, as the pg dataset does (Todo #1832). The pg
 * side and a pg/memory parity case are in substrate-dataset-pg's
 * unique-violation.test.ts.
 */

import { type IndexDecl, isResolverFrameError } from '@mnmal-ai/substrate-types';
import { describe, expect, it } from 'vitest';
import { MemoryDataset } from '../src/index.js';

const TYPE = 'Checkpoint';
const INDEX = 'cp_task_rev_uq';

function fixture(
  indexes: IndexDecl[] = [
    { fields: ['task', 'revision'], unique: true, where: 'live', name: INDEX }
  ]
) {
  return new MemoryDataset({
    namespace: 'uv',
    typeDefLookup: () => ({
      fields: {
        task: { kind: 'scalar', type: 'string' },
        revision: { kind: 'scalar', type: 'number' },
        archived: { kind: 'scalar', type: 'boolean' }
      },
      indexes
    })
  });
}

async function seeded() {
  const ds = fixture();
  await ds.write(TYPE, [{ task: 't1', revision: 1 }]);
  return ds;
}

const refusal = async (write: Promise<unknown>) => {
  const err = await write.then(
    () => undefined,
    (e: unknown) => e
  );
  expect(isResolverFrameError(err)).toBe(true);
  const e = err as { code: string; message: string; details?: Record<string, unknown> };
  expect(e.code).toBe('unique_violation');
  return e;
};

const count = async (ds: MemoryDataset) => (await ds.read(TYPE, {})).rows.length;

describe('a declared unique index conflict (memory)', () => {
  it('is refused as unique_violation naming the index and its fields', async () => {
    const ds = await seeded();
    const err = await refusal(ds.write(TYPE, [{ task: 't1', revision: 1 }]));
    expect(err.details).toEqual({ index: INDEX, fields: ['task', 'revision'] });
    expect(err.message).toContain(INDEX);
    expect(await count(ds)).toBe(1);
  });

  it('does not check a row that keeps its values, so a duplicate predating the index stands', async () => {
    // Written before the index was declared, as pg holds a pending field's values in `extra`.
    let indexes: IndexDecl[] = [];
    const ds = new MemoryDataset({
      namespace: 'uv',
      typeDefLookup: () => ({ fields: { code: { kind: 'scalar', type: 'string' } }, indexes })
    });
    await ds.write(TYPE, [
      { id: 'a', code: 'X' },
      { id: 'b', code: 'X' }
    ]);
    indexes = [{ fields: ['code'], unique: true, name: 'code_uq' }];
    await ds.write(TYPE, [{ id: 'a', code: 'X' }]);
    // Moving onto a held value is still refused, also beside a row that keeps it, in either order.
    await ds.write(TYPE, [{ id: 'c', code: 'Z' }]);
    await refusal(ds.write(TYPE, [{ id: 'c', code: 'X' }]));
    await refusal(
      ds.write(TYPE, [
        { id: 'a', code: 'X' },
        { id: 'c', code: 'X' }
      ])
    );
    await refusal(
      ds.write(TYPE, [
        { id: 'c', code: 'X' },
        { id: 'a', code: 'X' }
      ])
    );
    expect((await ds.read(TYPE, { ids: ['c'] })).rows[0]?.code).toBe('Z');
  });

  it('refuses a collision inside one write, landing none of its rows', async () => {
    const ds = fixture();
    await refusal(
      ds.write(TYPE, [
        { task: 't1', revision: 1 },
        { task: 't1', revision: 2 },
        { task: 't1', revision: 1 }
      ])
    );
    expect(await count(ds)).toBe(0);
  });

  it('is refused inside a transaction, which rolls back', async () => {
    const ds = await seeded();
    await refusal(
      ds.withTransaction(async (tx) => {
        await tx.write(TYPE, [{ task: 't2', revision: 1 }]);
        await tx.write(TYPE, [{ task: 't1', revision: 1 }]);
      })
    );
    expect(await count(ds)).toBe(1);
  });

  it('refuses patchRows, updateWhere, conditionalUpdate and updateField onto the indexed values', async () => {
    const ds = await seeded();
    const [row] = (await ds.write(TYPE, [{ task: 't1', revision: 2 }])).rows;
    const id = row?.id ?? '';
    await refusal(ds.patchRows(TYPE, [{ id, patch: { revision: 1 } }], null, new Date()));
    await refusal(ds.updateWhere(TYPE, { revision: { eq: 2 } }, { revision: 1 }, { maxMatch: 10 }));
    await refusal(ds.conditionalUpdate(TYPE, id, { revision: 2 }, { revision: 1 }));
    await refusal(ds.updateField({ type: TYPE, id }, 'revision', 1));
    expect((await ds.read(TYPE, { id })).rows[0]?.revision).toBe(2);
  });

  it('refuses a patchRows whose patches collide with each other, changing nothing', async () => {
    const ds = fixture();
    const { ids } = await ds.write(TYPE, [
      { task: 't1', revision: 1 },
      { task: 't1', revision: 2 },
      { task: 't1', revision: 3 }
    ]);
    await refusal(
      ds.patchRows(
        TYPE,
        [
          { id: ids[0] ?? '', patch: { revision: 7 } },
          { id: ids[1] ?? '', patch: { revision: 7 } }
        ],
        null,
        new Date()
      )
    );
    const revs = (await ds.read(TYPE, {})).rows.map((r) => r.revision).sort();
    expect(revs).toEqual([1, 2, 3]);
  });

  it('leaves non-colliding writes, rewrites of the same row, and tombstoned rows alone', async () => {
    const ds = await seeded();
    const [row] = (await ds.read(TYPE, {})).rows;
    await ds.write(TYPE, [{ task: 't1', revision: 2 }]);
    // An upsert of the row onto its own values is no collision.
    await ds.write(TYPE, [{ id: row?.id ?? '', task: 't1', revision: 1 }]);
    await ds.tombstone(TYPE, [row?.id ?? '']);
    // where: 'live' — the tombstoned row no longer holds (t1, 1).
    await ds.write(TYPE, [{ task: 't1', revision: 1 }]);
    expect(await count(ds)).toBe(2);
  });

  it('treats null and absent key values as distinct, as pg does', async () => {
    const ds = await seeded();
    await ds.write(TYPE, [
      { task: 't1', revision: null },
      { task: 't1', revision: null },
      { task: 't1' },
      { task: 't1' }
    ]);
    expect(await count(ds)).toBe(5);
  });

  it('honours a where record and names an unnamed index as pg generates it', async () => {
    const ds = fixture([{ fields: ['task'], unique: true, where: { archived: false } }]);
    await ds.write(TYPE, [
      { task: 't1', archived: true },
      { task: 't1', archived: true },
      { task: 't1', archived: false }
    ]);
    const err = await refusal(ds.write(TYPE, [{ task: 't1', archived: false }]));
    expect(err.details?.fields).toEqual(['task']);
    expect(err.details?.index).toMatch(/^rows_uv_checkpoint_task_[0-9a-f]{8}_uniq$/);
  });
});

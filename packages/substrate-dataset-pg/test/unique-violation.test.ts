/**
 * A write that collides with a declared unique index is refused with
 * `unique_violation`, naming the index and its fields, instead of surfacing as
 * a driver error (which a server turns into a bare `internal_error`). Inside a
 * transaction too, where the failed statement has aborted it.
 *
 * Skipped unless POSTGRES_URL is set.
 */

import { randomBytes } from 'node:crypto';
import { MemoryDataset } from '@mnmal-ai/substrate-dataset-memory';
import { type FieldDef, isResolverFrameError } from '@mnmal-ai/substrate-types';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PgDataset } from '../src/index.js';

const POSTGRES_URL = process.env.POSTGRES_URL;
const TYPE = 'Checkpoint';

let sql: Sql;

beforeAll(async () => {
  if (POSTGRES_URL) sql = postgres(POSTGRES_URL, { onnotice: () => {} });
});

afterAll(async () => {
  await sql?.end({ timeout: 5 });
});

async function fixture() {
  const ns = `uv_${randomBytes(4).toString('hex')}`;
  const index = `${ns}_task_rev_uq`;
  const ds = new PgDataset({
    namespace: ns,
    sql,
    typeDefLookup: () => ({
      fields: {
        task: { kind: 'scalar', type: 'string' },
        revision: { kind: 'scalar', type: 'number' }
      },
      indexes: [{ fields: ['task', 'revision'], unique: true, where: 'live', name: index }]
    })
  });
  await ds.ensureTypeStorage(TYPE);
  await ds.write(TYPE, [{ task: 't1', revision: 1 }]);
  return { ds, index };
}

const refusal = async (write: Promise<unknown>) => {
  const err = await write.then(
    () => undefined,
    (e: unknown) => e
  );
  expect(isResolverFrameError(err)).toBe(true);
  return err as { code: string; message: string; details?: Record<string, unknown> };
};

describe.skipIf(!POSTGRES_URL)('a declared unique index conflict (pg)', () => {
  it('is refused as unique_violation naming the index and its fields', async () => {
    const { ds, index } = await fixture();
    const err = await refusal(ds.write(TYPE, [{ task: 't1', revision: 1 }]));
    expect(err.code).toBe('unique_violation');
    expect(err.details).toEqual({ index, fields: ['task', 'revision'] });
    expect(err.message).toContain(index);
    expect((await ds.read(TYPE, {})).rows).toHaveLength(1);
  });

  it('is refused the same way inside a transaction', async () => {
    const { ds, index } = await fixture();
    const err = await refusal(
      ds.withTransaction((tx) => tx.write(TYPE, [{ task: 't1', revision: 1 }]))
    );
    expect(err.code).toBe('unique_violation');
    expect(err.details).toEqual({ index, fields: ['task', 'revision'] });
  });

  it('refuses a patchRows onto the indexed values the same way', async () => {
    const { ds, index } = await fixture();
    const [row] = (await ds.write(TYPE, [{ task: 't1', revision: 2 }])).rows;
    const err = await refusal(
      ds.patchRows(TYPE, [{ id: row?.id ?? '', patch: { revision: 1 } }], null, new Date())
    );
    expect(err.code).toBe('unique_violation');
    expect(err.details).toEqual({ index, fields: ['task', 'revision'] });
  });

  it('refuses an updateWhere onto the indexed values the same way', async () => {
    const { ds, index } = await fixture();
    await ds.write(TYPE, [{ task: 't1', revision: 2 }]);
    const err = await refusal(
      ds.updateWhere(TYPE, { revision: { eq: 2 } }, { revision: 1 }, { maxMatch: 10 })
    );
    expect(err.code).toBe('unique_violation');
    expect(err.details).toEqual({ index, fields: ['task', 'revision'] });
  });

  it('refuses a conditionalUpdate onto the indexed values the same way', async () => {
    const { ds, index } = await fixture();
    const [row] = (await ds.write(TYPE, [{ task: 't1', revision: 2 }])).rows;
    const err = await refusal(
      ds.conditionalUpdate(TYPE, row?.id ?? '', { revision: 2 }, { revision: 1 })
    );
    expect(err.code).toBe('unique_violation');
    expect(err.details).toEqual({ index, fields: ['task', 'revision'] });
  });

  it('leaves a non-colliding write alone', async () => {
    const { ds } = await fixture();
    await ds.write(TYPE, [{ task: 't1', revision: 2 }]);
    expect((await ds.read(TYPE, {})).rows).toHaveLength(2);
  });
});

/**
 * The memory dataset refuses the same writes with the same code and details
 * (Todo #1832): an unnamed index under pg's generated name, a `where` record,
 * tombstoned rows, and nulls, which are distinct in a pg unique index.
 */
describe.skipIf(!POSTGRES_URL)('a unique index conflict, pg and memory alike', () => {
  const fields: Record<string, FieldDef> = {
    task: { kind: 'scalar', type: 'string' },
    revision: { kind: 'scalar', type: 'number' },
    archived: { kind: 'scalar', type: 'boolean' }
  };
  const typeDefLookup = () => ({
    fields,
    indexes: [
      { fields: ['task', 'revision'], unique: true, where: 'live' as const },
      { fields: ['task'], unique: true, where: { archived: false } }
    ]
  });

  /** Each step's outcome: the refusal's code and details, or the live row count. */
  async function run(ds: PgDataset | MemoryDataset): Promise<unknown[]> {
    const out: unknown[] = [];
    const step = async (p: Promise<unknown>) => {
      out.push(
        await p.then(
          async () => (await ds.read(TYPE, {})).rows.length,
          (e: { code?: string; details?: unknown }) => ({ code: e.code, details: e.details })
        )
      );
    };
    const [first] = (await ds.write(TYPE, [{ task: 't1', revision: 1, archived: true }])).rows;
    await step(ds.write(TYPE, [{ task: 't1', revision: 1, archived: true }]));
    await step(
      ds.write(TYPE, [
        { task: 't1', revision: null, archived: true },
        { task: 't1', revision: null, archived: true },
        { task: 't1', archived: true }
      ])
    );
    await step(ds.write(TYPE, [{ task: 't2', revision: 1, archived: false }]));
    await step(ds.write(TYPE, [{ task: 't2', revision: 2, archived: false }]));
    await step(
      ds.updateWhere(TYPE, { task: { eq: 't2' } }, { task: 't1', revision: 1 }, { maxMatch: 10 })
    );
    await ds.tombstone(TYPE, [first?.id ?? '']);
    await step(ds.write(TYPE, [{ task: 't1', revision: 1, archived: true }]));
    return out;
  }

  it('agrees step by step', async () => {
    const ns = `uvp_${randomBytes(4).toString('hex')}`;
    const pg = new PgDataset({ namespace: ns, sql, typeDefLookup });
    await pg.ensureTypeStorage(TYPE);
    const mem = new MemoryDataset({ namespace: ns, typeDefLookup });
    const want = await run(pg);
    expect(await run(mem)).toEqual(want);
    expect(want).toEqual([
      {
        code: 'unique_violation',
        details: {
          index: expect.stringMatching(/_task_revision_[0-9a-f]{8}_uniq$/),
          fields: ['task', 'revision']
        }
      },
      4,
      5,
      {
        code: 'unique_violation',
        details: { index: expect.stringMatching(/_task_[0-9a-f]{8}_uniq$/), fields: ['task'] }
      },
      expect.objectContaining({ code: 'unique_violation' }),
      5
    ]);
  });
});

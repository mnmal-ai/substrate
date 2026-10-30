/**
 * A write that collides with a declared unique index is refused with
 * `unique_violation`, naming the index and its fields, instead of surfacing as
 * a driver error (which a server turns into a bare `internal_error`). Inside a
 * transaction too, where the failed statement has aborted it.
 *
 * Skipped unless POSTGRES_URL is set.
 */

import { randomBytes } from 'node:crypto';
import { isResolverFrameError } from '@mnmal-ai/substrate-types';
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

  it('leaves a non-colliding write alone', async () => {
    const { ds } = await fixture();
    await ds.write(TYPE, [{ task: 't1', revision: 2 }]);
    expect((await ds.read(TYPE, {})).rows).toHaveLength(2);
  });
});

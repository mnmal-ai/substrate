/**
 * Named unique partial indexes, declared on a type, are built on its storage
 * (on `tables`, its type table) and refuse a second live row as
 * `unique_violation`, whose details name the DECLARED index verbatim: cortext's
 * checkpoint resume keys on that name. Every layout.
 */

import { randomBytes } from 'node:crypto';
import type { FieldDef, IndexDecl } from '@mnmal-ai/substrate-types';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PgDataset } from '../src/index.js';
import { dropNamespace } from './_layout.js';

const POSTGRES_URL = process.env.POSTGRES_URL;
const hex = () => randomBytes(4).toString('hex');

let sql: Sql;
const namespaces: string[] = [];

beforeAll(async () => {
  if (POSTGRES_URL) sql = postgres(POSTGRES_URL, { onnotice: () => {} });
});

afterAll(async () => {
  for (const ns of namespaces) await dropNamespace(sql, ns);
  await sql?.end({ timeout: 5 });
});

/** A dataset over a fresh namespace whose `type` declares `fields` and `indexes`, storage built. */
async function declared(
  type: string,
  fields: Record<string, FieldDef>,
  indexes: IndexDecl[]
): Promise<PgDataset> {
  const ns = `tui_${hex()}`;
  namespaces.push(ns);
  const ds = new PgDataset({
    namespace: ns,
    sql,
    typeDefLookup: (t, n) => (t === type && n === ns ? { fields, indexes } : undefined)
  });
  await ds.ensureTypeStorage(type);
  return ds;
}

const refusal = (write: Promise<unknown>) =>
  write.then(
    () => {
      throw new Error('the write was not refused');
    },
    (e: unknown) => e as { code?: string; details?: Record<string, unknown> }
  );

describe.skipIf(!POSTGRES_URL)('named unique partial indexes', () => {
  it('named unique partial index on a test type rejects a second live row', async () => {
    const name = `rows_tui_key_${hex()}`;
    const ds = await declared(
      'Key',
      { kid: { kind: 'scalar', type: 'string' }, revokedAt: { kind: 'scalar', type: 'date' } },
      [{ name, fields: ['kid'], unique: true, where: { revokedAt: null } }]
    );
    expect((await ds.describeStorage('Key')).indexes.find((i) => i.name === name)).toMatchObject({
      unique: true,
      state: 'valid'
    });
    await ds.write('Key', [{ id: 'k1', kid: 'a' }]);
    expect(await refusal(ds.write('Key', [{ id: 'k2', kid: 'a' }]))).toMatchObject({
      code: 'unique_violation',
      details: { index: name, fields: ['kid'] }
    });
    // Outside the predicate, the same kid is allowed.
    await ds.write('Key', [{ id: 'k3', kid: 'a', revokedAt: '2026-01-01T00:00:00.000Z' }]);
  });

  describe('ExecutionCheckpoint-shaped unique live index', () => {
    const name = 'rows_execution_checkpoint_task_revision_unique';
    const type = 'ExecutionCheckpoint';
    let ds: PgDataset;

    beforeAll(async () => {
      ds = await declared(
        type,
        {
          task: { kind: 'crossRef', ns: 'x', type: 'Task', onDelete: 'set_null' },
          revision: { kind: 'scalar', type: 'number' }
        },
        [
          {
            name,
            fields: ['task', { field: 'revision', dir: 'desc' }],
            unique: true,
            where: 'live'
          }
        ]
      );
    });

    it('refuses a second live (task, revision), naming the declared index and its fields', async () => {
      await ds.write(type, [{ id: 'c1', task: 't1', revision: 1 }]);
      const err = await refusal(ds.write(type, [{ id: 'c2', task: 't1', revision: 1 }]));
      expect(err.code).toBe('unique_violation');
      expect(err.details?.index).toBe('rows_execution_checkpoint_task_revision_unique');
      expect(err.details?.fields).toEqual(['task', 'revision']);
      // Another revision of the task is a different key.
      await ds.write(type, [{ id: 'c3', task: 't1', revision: 2 }]);
    });

    it('allows a duplicate whose earlier row is soft-deleted', async () => {
      await ds.write(type, [{ id: 'd1', task: 't2', revision: 1 }]);
      await ds.tombstone(type, ['d1']);
      await ds.write(type, [{ id: 'd2', task: 't2', revision: 1 }]);
      const { rows } = await ds.read(type, { where: { task: { eq: 't2' } } });
      expect(rows.map((r) => r.id)).toEqual(['d2']);
    });
  });
});

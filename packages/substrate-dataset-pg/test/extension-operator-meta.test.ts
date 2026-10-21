/**
 * Extension-operator relevance order + _score/_vector stitching for
 * PgDataset. Substrate parity with the memory suite at
 * packages/substrate-dataset-memory/test/extension-operator-meta.test.ts.
 *
 * Verifies stitching survives the pg row materialization, that the page is
 * reordered to the operator's hit order (when no caller orderBy), and that the
 * legacy operator path leaves meta null. Pg-gated — skipped without POSTGRES_URL.
 */

import { clearExtensionOperators, registerExtensionOperator } from '@mnmal-ai/substrate-filter';
import type { FilterOperatorDef } from '@mnmal-ai/substrate-types';
import postgres, { type Sql } from 'postgres';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PgDataset, runMigrations } from '../src/index.js';

const POSTGRES_URL = process.env.POSTGRES_URL;

/** Operator returning the hits envelope. */
function hitsOp(hits: Array<{ id: string; score: number; vector?: number[] }>): FilterOperatorDef {
  return {
    validate: (v) => ({ ok: true, value: v }),
    execute: async () => ({ hits })
  };
}

describe.skipIf(!POSTGRES_URL)('PgDataset extension-operator meta', () => {
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
    ds = new PgDataset({ namespace: 'ext_ns', sql });
    await ds.write('Note', [
      { id: 'r1', title: 'one', archived: false },
      { id: 'r2', title: 'two', archived: false },
      { id: 'r3', title: 'three', archived: true }
    ]);
  });

  afterEach(() => {
    clearExtensionOperators();
  });

  it('rows follow relevance order when no orderBy is supplied', async () => {
    registerExtensionOperator(
      'sem',
      hitsOp([
        { id: 'r3', score: 0.9 },
        { id: 'r2', score: 0.8 },
        { id: 'r1', score: 0.7 }
      ])
    );
    const res = await ds.read('Note', { where: { sem: 'q' } });
    expect(res.rows.map((r) => r.id)).toEqual(['r3', 'r2', 'r1']);
  });

  it('explicit orderBy wins over relevance order', async () => {
    registerExtensionOperator(
      'sem',
      hitsOp([
        { id: 'r3', score: 0.9 },
        { id: 'r2', score: 0.8 },
        { id: 'r1', score: 0.7 }
      ])
    );
    const res = await ds.read('Note', {
      where: { sem: 'q' },
      orderBy: [{ id: 'asc' }]
    });
    expect(res.rows.map((r) => r.id)).toEqual(['r1', 'r2', 'r3']);
  });

  it('stitches _score and _vector onto materialized rows when projected', async () => {
    registerExtensionOperator(
      'sem',
      hitsOp([
        { id: 'r2', score: 0.8, vector: [4, 5, 6] },
        { id: 'r1', score: 0.7, vector: [1, 2, 3] }
      ])
    );
    const res = await ds.read('Note', {
      where: { sem: 'q' },
      fields: { _score: true, _vector: true }
    });
    expect(res.rows.map((r) => r.id)).toEqual(['r2', 'r1']);
    expect(res.rows[0]).toMatchObject({ id: 'r2', _score: 0.8, _vector: [4, 5, 6] });
    expect(res.rows[1]).toMatchObject({ id: 'r1', _score: 0.7, _vector: [1, 2, 3] });
  });

  it('does not stitch _score/_vector when not projected', async () => {
    registerExtensionOperator('sem', hitsOp([{ id: 'r1', score: 0.7, vector: [1] }]));
    const res = await ds.read('Note', { where: { sem: 'q' } });
    expect('_score' in res.rows[0]!).toBe(false);
    expect('_vector' in res.rows[0]!).toBe(false);
  });

  it('relevance order among the AND-intersection survivors', async () => {
    registerExtensionOperator(
      'sem',
      hitsOp([
        { id: 'r3', score: 0.9 },
        { id: 'r2', score: 0.8 },
        { id: 'r1', score: 0.7 }
      ])
    );
    const res = await ds.read('Note', {
      where: { sem: 'q', archived: { eq: false } }
    });
    expect(res.rows.map((r) => r.id)).toEqual(['r2', 'r1']);
  });

  it('refuses a legacy bare-array result rather than silently dropping order', async () => {
    registerExtensionOperator('legacy', {
      validate: (v) => ({ ok: true, value: v }),
      execute: async () => [{ row: { id: 'r3' }, score: 0.9 }]
    });
    await expect(ds.read('Note', { where: { legacy: 'q' } })).rejects.toThrow(
      /extension operator 'legacy' must resolve to \{ hits/
    );
  });
});

/**
 * archived + project read-path routing.
 *
 * Verifies that WHERE filters and ORDER BY clauses on `archived` and `project`,
 * when declared in `promotedColumns`, route to the dedicated columns with no
 * body fallback, while reads return the body as stored.
 */

import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PgDataset, runMigrations } from '../src/index.js';
import { addTestPromotedColumns, dropTestPromotedColumns, TEST_PROMOTED } from './_promoted.js';

const POSTGRES_URL = process.env.POSTGRES_URL;

describe.skipIf(!POSTGRES_URL)('PgDataset: archived + project read-path routing', () => {
  let sql: Sql;
  let ds: PgDataset;

  beforeAll(async () => {
    sql = postgres(POSTGRES_URL as string);
    await runMigrations(sql);
    await addTestPromotedColumns(sql);
  });

  afterAll(async () => {
    await dropTestPromotedColumns(sql);
    await sql.end();
  });

  beforeEach(async () => {
    await sql`TRUNCATE TABLE rows, short_ids`;
    ds = new PgDataset({ namespace: 'test_route', sql, promotedColumns: TEST_PROMOTED });
  });

  // ---- where: archived ----

  it('where { archived: { eq: false } } returns only non-archived rows', async () => {
    await ds.write('Memo', [
      { id: 'a1', archived: false, label: 'live' },
      { id: 'a2', archived: true, label: 'gone' },
      { id: 'a3', archived: false, label: 'also live' }
    ]);
    const result = await ds.read('Memo', { where: { archived: { eq: false } } });
    const ids = result.rows.map((r) => r.id).sort();
    expect(ids).toEqual(['a1', 'a3']);
  });

  it('where { archived: { eq: true } } returns only archived rows', async () => {
    await ds.write('Memo', [
      { id: 'b1', archived: false },
      { id: 'b2', archived: true }
    ]);
    const result = await ds.read('Memo', { where: { archived: { eq: true } } });
    expect(result.rows.map((r) => r.id)).toEqual(['b2']);
  });

  // ---- where: project ----

  it('where { project: { eq: "substrate" } } returns only substrate-scoped rows', async () => {
    await ds.write('Memo', [
      { id: 'c1', project: 'substrate' },
      { id: 'c2', project: 'other' },
      { id: 'c3', project: null }
    ]);
    const result = await ds.read('Memo', { where: { project: { eq: 'substrate' } } });
    expect(result.rows.map((r) => r.id)).toEqual(['c1']);
  });

  it('where { project: { eq: null } } returns only cross-cutting rows (project=null and project-absent)', async () => {
    await ds.write('Memo', [
      { id: 'd1', project: 'substrate' },
      { id: 'd2', project: null }, // explicit null
      { id: 'd3', label: 'no project key' } // absent
    ]);
    const result = await ds.read('Memo', { where: { project: { eq: null } } });
    const ids = result.rows.map((r) => r.id).sort();
    expect(ids).toEqual(['d2', 'd3']);
  });

  it('where { project: { in: ["substrate", null] } } returns substrate + cross-cutting rows', async () => {
    await ds.write('Memo', [
      { id: 'e1', project: 'substrate' },
      { id: 'e2', project: 'other' },
      { id: 'e3', project: null },
      { id: 'e4', label: 'no project key' }
    ]);
    const result = await ds.read('Memo', { where: { project: { in: ['substrate', null] } } });
    const ids = result.rows.map((r) => r.id).sort();
    expect(ids).toEqual(['e1', 'e3', 'e4']);
  });

  // ---- composite (cold-start hook hot-path) ----

  it('where { archived: { eq: false }, project: { in: ["substrate", null] } } — cold-start filter shape', async () => {
    await ds.write('Memo', [
      { id: 'f1', archived: false, project: 'substrate' },
      { id: 'f2', archived: true, project: 'substrate' },
      { id: 'f3', archived: false, project: 'other' },
      { id: 'f4', archived: false, project: null }
    ]);
    const result = await ds.read('Memo', {
      where: { archived: { eq: false }, project: { in: ['substrate', null] } }
    });
    const ids = result.rows.map((r) => r.id).sort();
    expect(ids).toEqual(['f1', 'f4']);
  });

  // ---- orderBy ----

  it('orderBy: { archived: "asc" } sorts via column (false < true, NULLS LAST)', async () => {
    await ds.write('Memo', [
      { id: 'k1', archived: true },
      { id: 'k2', archived: false },
      { id: 'k3', archived: false }
    ]);
    const result = await ds.read('Memo', {
      orderBy: [{ archived: 'asc' }, { id: 'asc' }]
    });
    expect(result.rows.map((r) => r.id)).toEqual(['k2', 'k3', 'k1']);
  });

  it('orderBy: { project: "asc" } sorts via column (lexical, NULLS LAST)', async () => {
    await ds.write('Memo', [
      { id: 'l1', project: 'substrate' },
      { id: 'l2', project: 'alpha' },
      { id: 'l3', project: null }
    ]);
    const result = await ds.read('Memo', {
      orderBy: [{ project: 'asc' }, { id: 'asc' }]
    });
    expect(result.rows.map((r) => r.id)).toEqual(['l2', 'l1', 'l3']);
  });

  // ---- reads return the body ----

  // The column answers filters; the read returns the body as stored. A row
  // whose body lacks the key while its column holds a value reads without
  // the key — no column merge, no phantom keys.

  it('reads the body as stored, not the column', async () => {
    await ds.write('Memo', [{ id: 'm1', archived: true, project: 'substrate' }]);
    await sql`
        UPDATE rows SET body = body - 'archived' - 'project'
        WHERE namespace = 'test_route' AND id = 'm1'
      `;
    // The column still answers the filter...
    const result = await ds.read('Memo', { where: { archived: { eq: true } } });
    expect(result.rows.map((r) => r.id)).toEqual(['m1']);
    // ...but the row is the body.
    expect(result.rows[0]).not.toHaveProperty('archived');
    expect(result.rows[0]).not.toHaveProperty('project');
  });

  it('a fields hint projects from the body, not the column', async () => {
    await ds.write('Memo', [{ id: 'm2', archived: true, project: 'substrate' }]);
    await sql`
        UPDATE rows SET body = body - 'project'
        WHERE namespace = 'test_route' AND id = 'm2'
      `;
    const result = await ds.read('Memo', {
      where: { id: { eq: 'm2' } },
      fields: { id: true, archived: true, project: true }
    });
    const { _metadata, ...row } = result.rows[0] as Record<string, unknown>;
    expect(row).toEqual({ id: 'm2', archived: true, project: null });
  });

  it('adds no phantom promoted keys to a body that never had them', async () => {
    await ds.write('Memo', [{ id: 'm3', label: 'plain' }]);
    const result = await ds.read('Memo', { where: { id: { eq: 'm3' } } });
    const { _metadata, ...row } = result.rows[0] as Record<string, unknown>;
    expect(row).toEqual({ id: 'm3', label: 'plain' });
  });
});

/**
 * archived + project body→column mirror, write-path.
 *
 * Verifies that every write path on PgDataset that touches `body`
 * mirrors `body.archived` and `body.project` to their dedicated columns.
 *
 * Three paths covered:
 *   - write() upsert  (raw create + raw update via INSERT...ON CONFLICT)
 *   - conditionalUpdate()
 *   - updateField()
 *
 * The read side is covered by `read-archived-project-routing.test.ts`.
 */

import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PgDataset, runMigrations } from '../src/index.js';
import { addTestPromotedColumns, dropTestPromotedColumns, TEST_PROMOTED } from './_promoted.js';

const POSTGRES_URL = process.env.POSTGRES_URL;

describe.skipIf(!POSTGRES_URL)('PgDataset: archived + project body→column mirror', () => {
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
    ds = new PgDataset({ namespace: 'test_mirror', sql, promotedColumns: TEST_PROMOTED });
  });

  // ---- write() upsert ----

  it('write() create: body.archived=true mirrors to archived column', async () => {
    await ds.write('Memo', [{ id: 'a', archived: true, project: 'substrate' }]);
    const rows = await sql<{ archived: boolean | null; project: string | null }[]>`
      SELECT archived, project FROM rows
      WHERE namespace = 'test_mirror' AND type = 'Memo' AND id = 'a'
    `;
    expect(rows[0]).toEqual({ archived: true, project: 'substrate' });
  });

  it('write() create: body without archived gets DEFAULT false; project stays NULL', async () => {
    await ds.write('Memo', [{ id: 'b', label: 'no flags' }]);
    const rows = await sql<{ archived: boolean | null; project: string | null }[]>`
      SELECT archived, project FROM rows
      WHERE namespace = 'test_mirror' AND type = 'Memo' AND id = 'b'
    `;
    expect(rows[0]).toEqual({ archived: false, project: null });
  });

  it('write() create: body.project=null mirrors to NULL column (cross-cutting marker)', async () => {
    await ds.write('Memo', [{ id: 'c', archived: false, project: null }]);
    const rows = await sql<{ archived: boolean | null; project: string | null }[]>`
      SELECT archived, project FROM rows
      WHERE namespace = 'test_mirror' AND type = 'Memo' AND id = 'c'
    `;
    expect(rows[0]).toEqual({ archived: false, project: null });
  });

  it('write() update: partial update preserves columns when keys absent from body', async () => {
    await ds.write('Memo', [{ id: 'd', archived: false, project: 'substrate' }]);
    await ds.write('Memo', [{ id: 'd', label: 'patched' }]);
    const rows = await sql<{ archived: boolean | null; project: string | null }[]>`
      SELECT archived, project FROM rows
      WHERE namespace = 'test_mirror' AND type = 'Memo' AND id = 'd'
    `;
    expect(rows[0]).toEqual({ archived: false, project: 'substrate' });
  });

  it('write() update: archived=true overrides existing archived=false', async () => {
    await ds.write('Memo', [{ id: 'e', archived: false, project: 'substrate' }]);
    await ds.write('Memo', [{ id: 'e', archived: true }]);
    const rows = await sql<{ archived: boolean | null; project: string | null }[]>`
      SELECT archived, project FROM rows
      WHERE namespace = 'test_mirror' AND type = 'Memo' AND id = 'e'
    `;
    expect(rows[0]).toEqual({ archived: true, project: 'substrate' });
  });

  // ---- conditionalUpdate() ----

  it('conditionalUpdate(): updates archived column when archived in updates', async () => {
    await ds.write('Memo', [{ id: 'f', archived: false, project: 'substrate' }]);
    const result = await ds.conditionalUpdate('Memo', 'f', {}, { archived: true });
    expect(result.matched).toBe(true);
    const rows = await sql<{ archived: boolean | null; project: string | null }[]>`
      SELECT archived, project FROM rows
      WHERE namespace = 'test_mirror' AND type = 'Memo' AND id = 'f'
    `;
    expect(rows[0]).toEqual({ archived: true, project: 'substrate' });
  });

  it('conditionalUpdate(): partial updates leave columns alone when archived/project absent', async () => {
    await ds.write('Memo', [{ id: 'g', archived: false, project: 'substrate' }]);
    const result = await ds.conditionalUpdate('Memo', 'g', {}, { label: 'cu-patched' });
    expect(result.matched).toBe(true);
    const rows = await sql<{ archived: boolean | null; project: string | null }[]>`
      SELECT archived, project FROM rows
      WHERE namespace = 'test_mirror' AND type = 'Memo' AND id = 'g'
    `;
    expect(rows[0]).toEqual({ archived: false, project: 'substrate' });
  });

  it('conditionalUpdate(): project=null updates column to NULL', async () => {
    await ds.write('Memo', [{ id: 'h', project: 'substrate' }]);
    const result = await ds.conditionalUpdate('Memo', 'h', {}, { project: null });
    expect(result.matched).toBe(true);
    const rows = await sql<{ project: string | null }[]>`
      SELECT project FROM rows
      WHERE namespace = 'test_mirror' AND type = 'Memo' AND id = 'h'
    `;
    expect(rows[0]?.project).toBeNull();
  });

  it("conditionalUpdate(): archived='false' casts to false, as write() does", async () => {
    await ds.write('Memo', [{ id: 'f2', archived: true }]);
    await ds.conditionalUpdate('Memo', 'f2', {}, { archived: 'false' });
    const rows = await sql<{ archived: boolean | null }[]>`
      SELECT archived FROM rows
      WHERE namespace = 'test_mirror' AND type = 'Memo' AND id = 'f2'
    `;
    expect(rows[0]?.archived).toBe(false);
  });

  // ---- updateField() ----

  it('updateField(archived, true) writes column + body', async () => {
    await ds.write('Memo', [{ id: 'i', archived: false, project: 'substrate' }]);
    await ds.updateField({ ns: 'test_mirror', type: 'Memo', id: 'i' }, 'archived', true);
    const rows = await sql<{ archived: boolean | null; body: { archived?: unknown } }[]>`
      SELECT archived, body FROM rows
      WHERE namespace = 'test_mirror' AND type = 'Memo' AND id = 'i'
    `;
    expect(rows[0]?.archived).toBe(true);
    expect(rows[0]?.body.archived).toBe(true);
  });

  it('updateField(project, "other") writes column + body', async () => {
    await ds.write('Memo', [{ id: 'j', project: 'substrate' }]);
    await ds.updateField({ ns: 'test_mirror', type: 'Memo', id: 'j' }, 'project', 'other');
    const rows = await sql<{ project: string | null; body: { project?: unknown } }[]>`
      SELECT project, body FROM rows
      WHERE namespace = 'test_mirror' AND type = 'Memo' AND id = 'j'
    `;
    expect(rows[0]?.project).toBe('other');
    expect(rows[0]?.body.project).toBe('other');
  });

  it('updateField(project, null) writes column = NULL + body[project] = null', async () => {
    await ds.write('Memo', [{ id: 'k', project: 'substrate' }]);
    await ds.updateField({ ns: 'test_mirror', type: 'Memo', id: 'k' }, 'project', null);
    const rows = await sql<{ project: string | null; body: { project?: unknown } }[]>`
      SELECT project, body FROM rows
      WHERE namespace = 'test_mirror' AND type = 'Memo' AND id = 'k'
    `;
    expect(rows[0]?.project).toBeNull();
    expect(rows[0]?.body.project).toBeNull();
  });

  it("updateField(archived, 'false') casts to false, as write() does", async () => {
    await ds.write('Memo', [{ id: 'i2', archived: true }]);
    await ds.updateField({ ns: 'test_mirror', type: 'Memo', id: 'i2' }, 'archived', 'false');
    const rows = await sql<{ archived: boolean | null }[]>`
      SELECT archived FROM rows
      WHERE namespace = 'test_mirror' AND type = 'Memo' AND id = 'i2'
    `;
    expect(rows[0]?.archived).toBe(false);
  });

  it('updateField on unrelated field does not touch archived/project columns', async () => {
    await ds.write('Memo', [{ id: 'l', archived: false, project: 'substrate' }]);
    await ds.updateField({ ns: 'test_mirror', type: 'Memo', id: 'l' }, 'label', 'unrelated');
    const rows = await sql<{ archived: boolean | null; project: string | null }[]>`
      SELECT archived, project FROM rows
      WHERE namespace = 'test_mirror' AND type = 'Memo' AND id = 'l'
    `;
    expect(rows[0]).toEqual({ archived: false, project: 'substrate' });
  });
});

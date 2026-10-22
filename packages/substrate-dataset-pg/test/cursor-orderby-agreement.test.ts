/**
 * Keyset pagination must return the same rows as an unpaginated read.
 *
 * That holds only if the ORDER BY expression and the cursor comparison read
 * the SAME source for every field kind (a promoted field's column, not its
 * body copy), and if the cursor honours the `NULLS LAST` that ORDER BY emits:
 * a bare `expr > $1` is NULL for a NULL key, dropping those rows from every
 * later page. The NULL half applies to any field kind, so the cases span all
 * three.
 *
 * The fixtures deliberately contain body/column divergence and nulls: with
 * fully-populated, normally-written rows both expressions coincide and the
 * NULLS-LAST branch is never reached, so neither defect would show.
 */

import { MemoryDataset } from '@mnmal-ai/substrate-dataset-memory';
import type { FieldDef, Row } from '@mnmal-ai/substrate-types';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PgDataset, runMigrations } from '../src/index.js';
import { addTestPromotedColumns, dropTestPromotedColumns, TEST_PROMOTED } from './_promoted.js';

const POSTGRES_URL = process.env.POSTGRES_URL;

describe.skipIf(!POSTGRES_URL)('keyset pagination agrees with the unpaginated read', () => {
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
    ds = new PgDataset({ namespace: 'cursor_agree', sql, promotedColumns: TEST_PROMOTED });
  });

  /** Walk every page, returning the ids in order. */
  async function paginate(
    field: string,
    dir: 'asc' | 'desc',
    limit: number,
    fields?: Record<string, boolean>
  ): Promise<string[]> {
    const seen: string[] = [];
    let cursor: string | undefined;
    // Bounded so a cursor that fails to advance cannot spin forever; any real
    // fixture here needs far fewer pages than this.
    for (let page = 0; page < 20; page++) {
      const res = await ds.read('Memo', {
        orderBy: [{ [field]: dir }],
        limit,
        ...(fields === undefined ? {} : { fields }),
        ...(cursor === undefined ? {} : { cursor })
      });
      seen.push(...res.rows.map((r) => String(r.id)));
      const next = (res as { nextCursor?: string | null }).nextCursor;
      if (next === undefined || next === null || res.rows.length === 0) break;
      cursor = next;
    }
    return seen;
  }

  async function fullRead(
    field: string,
    dir: 'asc' | 'desc',
    fields?: Record<string, boolean>
  ): Promise<string[]> {
    const res = await ds.read('Memo', {
      orderBy: [{ [field]: dir }],
      ...(fields === undefined ? {} : { fields })
    });
    return res.rows.map((r) => String(r.id));
  }

  for (const dir of ['asc', 'desc'] as const) {
    it(`promoted field with a NULL column: pages match the full read (${dir})`, async () => {
      await ds.write('Memo', [
        { id: 'm1', status: 'aaa' },
        { id: 'm2', status: 'bbb' },
        { id: 'm3', status: 'ccc' },
        { id: 'm4', status: 'ddd' }
      ]);
      // The state a host migration creates: column added to a populated table,
      // no backfill. Body keeps its value, the column is NULL.
      await sql`UPDATE rows SET status = NULL WHERE id IN ('m2','m3')`;

      const full = await fullRead('status', dir);
      const paged = await paginate('status', dir, 2);

      expect(paged).toEqual(full);
      expect(paged).toHaveLength(4);
    });

    it(`plain body field with null values: pages match the full read (${dir})`, async () => {
      // No promoted column involved: the NULLS-LAST half, which applies to
      // every field kind.
      await ds.write('Memo', [
        { id: 'b1', label: 'aaa' },
        { id: 'b2', label: null },
        { id: 'b3', label: 'ccc' },
        { id: 'b4', label: null },
        { id: 'b5', label: 'eee' }
      ]);

      const full = await fullRead('label', dir);
      const paged = await paginate('label', dir, 2);

      expect(paged).toEqual(full);
      expect(paged).toHaveLength(5);
    });

    it(`promoted field, all columns populated: unchanged behaviour (${dir})`, async () => {
      // Control: the ordinary path, so a regression there cannot hide behind
      // the two cases above.
      await ds.write('Memo', [
        { id: 'c1', status: 'aaa' },
        { id: 'c2', status: 'bbb' },
        { id: 'c3', status: 'ccc' }
      ]);

      const full = await fullRead('status', dir);
      const paged = await paginate('status', dir, 2);

      expect(paged).toEqual(full);
      expect(paged).toHaveLength(3);
    });
  }

  it('paginates a null-bearing sort key identically to the memory backend', async () => {
    // Null handling lives in each SUBSTRATE's own cursor compiler, so only a
    // substrate-vs-substrate comparison can pin it (transport parity cannot).
    //
    // A plain body field, because `status` is a promoted COLUMN on pg and an
    // ordinary body key in memory: comparing those would be comparing two
    // different things and calling the difference a bug.
    const rows: Row[] = [
      { id: 'p1', label: 'aaa' },
      { id: 'p2', label: null },
      { id: 'p3', label: 'ccc' },
      { id: 'p4', label: null },
      { id: 'p5', label: 'eee' }
    ];
    const mem = new MemoryDataset({ namespace: 'cursor_agree' });
    await mem.write('Memo', rows);
    await ds.write('Memo', rows);

    async function pageAll(dataset: { read: PgDataset['read'] }): Promise<string[]> {
      const seen: string[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 20; page++) {
        const res = await dataset.read('Memo', {
          orderBy: [{ label: 'asc' }],
          limit: 2,
          ...(cursor === undefined ? {} : { cursor })
        });
        seen.push(...res.rows.map((r) => String(r.id)));
        const next = (res as { nextCursor?: string | null }).nextCursor;
        if (next === undefined || next === null || res.rows.length === 0) break;
        cursor = next;
      }
      return seen;
    }

    const pgPages = await pageAll(ds);
    const memPages = await pageAll(mem as unknown as { read: PgDataset['read'] });

    expect(pgPages).toEqual(memPages);
    expect(pgPages).toHaveLength(5);
  });

  it('a promoted field with a NULL column is sorted by the COLUMN, not the body', async () => {
    // Pins the source of truth rather than only the pagination invariant: the
    // two could agree while both read the wrong expression.
    await ds.write('Memo', [
      { id: 'z1', status: 'zzz' },
      { id: 'z2', status: 'aaa' }
    ]);
    await sql`UPDATE rows SET status = NULL WHERE id = 'z2'`;

    // Body says z2 sorts first ('aaa' < 'zzz'); the column says z2 is NULL and
    // therefore sorts LAST. Column wins.
    expect(await fullRead('status', 'asc')).toEqual(['z1', 'z2']);
  });

  /**
   * The sort field is NOT projected.
   *
   * The cases above read the full body, so the cursor can take the sort value
   * off the materialized row. With `fields: { id: true }` a body-stored sort
   * value is absent from the row; the cursor must still carry it, or page two
   * matches nothing and a prefix is reported as the complete read.
   *
   * Promoted and metadata fields are CONTROLS: they are read from columns, so
   * they do not exercise the body path.
   */
  for (const dir of ['asc', 'desc'] as const) {
    it(`body field NOT in the projection: pages match the full read (${dir})`, async () => {
      await ds.write('Memo', [
        { id: 'p1', label: 'aaa' },
        { id: 'p2', label: 'bbb' },
        { id: 'p3', label: 'ccc' },
        { id: 'p4', label: 'ddd' },
        { id: 'p5', label: 'eee' }
      ]);

      const projection = { id: true };
      const full = await fullRead('label', dir, projection);
      const paged = await paginate('label', dir, 2, projection);

      expect(paged).toEqual(full);
      // The discriminating assertion: a lost cursor value stops after page one.
      expect(paged).toHaveLength(5);
    });

    it(`body field NOT projected, with nulls: pages match the full read (${dir})`, async () => {
      // Both at once: an unprojected sort key AND the NULLS-LAST branch.
      await ds.write('Memo', [
        { id: 'q1', label: 'aaa' },
        { id: 'q2', label: null },
        { id: 'q3', label: 'ccc' },
        { id: 'q4', label: null },
        { id: 'q5', label: 'eee' }
      ]);

      const projection = { id: true };
      const full = await fullRead('label', dir, projection);
      const paged = await paginate('label', dir, 2, projection);

      expect(paged).toEqual(full);
      expect(paged).toHaveLength(5);
    });

    it(`promoted field NOT in the projection stays correct (${dir})`, async () => {
      await ds.write('Memo', [
        { id: 'r1', status: 'aaa' },
        { id: 'r2', status: 'bbb' },
        { id: 'r3', status: 'ccc' },
        { id: 'r4', status: 'ddd' }
      ]);

      const projection = { id: true };
      const full = await fullRead('status', dir, projection);
      const paged = await paginate('status', dir, 2, projection);

      expect(paged).toEqual(full);
      expect(paged).toHaveLength(4);
    });

    it(`metadata field with no _metadata projected stays correct (${dir})`, async () => {
      await ds.write('Memo', [
        { id: 's1', label: 'aaa' },
        { id: 's2', label: 'bbb' },
        { id: 's3', label: 'ccc' },
        { id: 's4', label: 'ddd' }
      ]);

      const projection = { id: true };
      const full = await fullRead('createdAt', dir, projection);
      const paged = await paginate('createdAt', dir, 2, projection);

      expect(paged).toEqual(full);
      expect(paged).toHaveLength(4);
    });
  }
});

describe.skipIf(!POSTGRES_URL)('keyset pagination over sub-millisecond timestamps', () => {
  let sql: Sql;
  // The cursor used to carry the sort key as a JS Date, which keeps
  // milliseconds only, so `.123456` came back as `.123` and the next page
  // started at (and re-served) the cursor row itself.
  const dueAtIsDate = (_type: string, field: string): FieldDef | undefined =>
    field === 'dueAt' ? { kind: 'scalar', type: 'date' } : undefined;

  beforeAll(async () => {
    sql = postgres(POSTGRES_URL as string);
    await runMigrations(sql);
  });
  afterAll(async () => {
    await sql.end();
  });

  for (const dir of ['asc', 'desc'] as const) {
    it(`pages a microsecond-precision date field without repeats (${dir})`, async () => {
      await sql`TRUNCATE TABLE rows, short_ids`;
      const ds = new PgDataset({ namespace: 'cursor_usec', sql, fieldDefLookup: dueAtIsDate });
      await ds.write('Memo', [
        { id: 'a', dueAt: '2026-10-21T10:00:00.123456Z' },
        { id: 'b', dueAt: '2026-10-21T10:00:00.123789Z' },
        { id: 'c', dueAt: '2026-10-21T10:00:00.124001Z' }
      ] as Row[]);

      const seen: string[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 10; page++) {
        const res = await ds.read('Memo', {
          orderBy: [{ dueAt: dir }],
          limit: 1,
          ...(cursor === undefined ? {} : { cursor })
        });
        seen.push(...res.rows.map((r) => String(r.id)));
        const next = (res as { nextCursor?: string | null }).nextCursor;
        if (next === undefined || next === null || res.rows.length === 0) break;
        cursor = next;
      }
      expect(seen).toEqual(dir === 'asc' ? ['a', 'b', 'c'] : ['c', 'b', 'a']);
    });
  }

  it('pages createdAt the same way when it carries microseconds', async () => {
    await sql`TRUNCATE TABLE rows, short_ids`;
    const ds = new PgDataset({ namespace: 'cursor_usec', sql });
    await ds.write('Memo', [{ id: 'a' }, { id: 'b' }, { id: 'c' }] as Row[]);
    // Writes through a path that stamps now() carry microseconds.
    await sql`
      UPDATE rows
      SET created_at = '2026-10-21T10:00:00.123456Z'::timestamptz
        + (CASE id::text WHEN 'a' THEN 1 WHEN 'b' THEN 2 ELSE 3 END) * interval '1 microsecond'
      WHERE namespace = 'cursor_usec'`;
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page++) {
      const res = await ds.read('Memo', {
        orderBy: [{ createdAt: 'asc' }],
        limit: 1,
        ...(cursor === undefined ? {} : { cursor })
      });
      seen.push(...res.rows.map((r) => String(r.id)));
      const next = (res as { nextCursor?: string | null }).nextCursor;
      if (next === undefined || next === null || res.rows.length === 0) break;
      cursor = next;
    }
    expect(seen).toEqual(['a', 'b', 'c']);
  });
});

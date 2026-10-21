/**
 * A promoted column and a plain body field must answer the SAME operator the
 * same way.
 *
 * Which storage path a field takes is an internal decision — `archived`,
 * `project`, `status` and `priority` get dedicated columns; everything else is
 * JSONB body extraction. A caller cannot see that, so the two paths owe
 * identical semantics for identical predicates.
 *
 * `substrate-filter-parity.test.ts` compares memory vs pg; this compares the
 * two storage paths within pg. It is a table over EVERY operator, not just
 * `neq`, because a shared helper means a defect in one operator can hide
 * another (`neq` and `nin` on either path).
 *
 * The fixtures carry nulls deliberately: with no NULLs,
 * `IS NOT NULL AND x IS DISTINCT FROM y` and `x IS DISTINCT FROM y` agree on
 * every row, so the nulls are the test.
 */

import type { Row, WhereClause } from '@mnmal-ai/substrate-types';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PgDataset, runMigrations } from '../src/index.js';
import { addTestPromotedColumns, dropTestPromotedColumns, TEST_PROMOTED } from './_promoted.js';

const POSTGRES_URL = process.env.POSTGRES_URL;

/** `status` is body-promoted; `label` is an ordinary body key. Same values. */
const ROWS: Row[] = [
  { id: 'r1', status: 'alpha', label: 'alpha' },
  { id: 'r2', status: 'beta', label: 'beta' },
  { id: 'r3', status: null, label: null },
  { id: 'r4', status: 'gamma', label: 'gamma' },
  { id: 'r5', status: 'beta', label: 'beta' }
];

/**
 * Every operator `scalar.string` declares in `PgDataset.capabilities`,
 * plus the two null forms. Driven off the declared set on purpose: a capability
 * declaration is a promise, and an operator added there without being added
 * here would go unpaired.
 */
const CASES: Array<{ name: string; predicate: Record<string, unknown> }> = [
  { name: "eq 'beta'", predicate: { eq: 'beta' } },
  { name: 'eq null', predicate: { eq: null } },
  { name: "neq 'beta'", predicate: { neq: 'beta' } },
  { name: 'neq null', predicate: { neq: null } },
  { name: "gt 'alpha'", predicate: { gt: 'alpha' } },
  { name: "gte 'beta'", predicate: { gte: 'beta' } },
  { name: "lt 'gamma'", predicate: { lt: 'gamma' } },
  { name: "lte 'beta'", predicate: { lte: 'beta' } },
  { name: "between ['alpha','beta']", predicate: { between: ['alpha', 'beta'] } },
  { name: "contains 'et'", predicate: { contains: 'et' } },
  { name: "startsWith 'b'", predicate: { startsWith: 'b' } },
  { name: "endsWith 'a'", predicate: { endsWith: 'a' } },
  { name: "in ['alpha','gamma']", predicate: { in: ['alpha', 'gamma'] } },
  { name: "nin ['alpha','gamma']", predicate: { nin: ['alpha', 'gamma'] } }
];

describe.skipIf(!POSTGRES_URL)(
  'promoted column and body field answer operators identically',
  () => {
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
      ds = new PgDataset({ namespace: 'promoted_parity', sql, promotedColumns: TEST_PROMOTED });
      await ds.write('Memo', ROWS);
    });

    async function idsFor(field: string, predicate: Record<string, unknown>): Promise<string[]> {
      const where = { [field]: predicate } as unknown as WhereClause;
      const res = await ds.read('Memo', { where });
      return res.rows.map((r) => String(r.id)).sort();
    }

    for (const { name, predicate } of CASES) {
      it(`${name} — promoted matches body`, async () => {
        const promoted = await idsFor('status', predicate);
        const body = await idsFor('label', predicate);

        expect({ field: 'status', ids: promoted }).toEqual({ field: 'status', ids: body });
      });
    }

    it('eq and neq partition the rows, on BOTH paths', async () => {
      // With `eq: null` a legitimate filter in this store, `eq: x` and `neq: x`
      // must together cover every row exactly once — null rows included.
      for (const field of ['status', 'label']) {
        const eq = await idsFor(field, { eq: 'beta' });
        const neq = await idsFor(field, { neq: 'beta' });

        expect([...eq, ...neq].sort()).toEqual(['r1', 'r2', 'r3', 'r4', 'r5']);
        expect(eq.filter((id) => neq.includes(id))).toEqual([]);
      }
    });

    it('the fixture actually contains the nulls the cases depend on', async () => {
      // Guards the guard: if the write path stopped persisting a null `status`,
      // every case above would still pass while testing nothing about nulls.
      const [row] = await sql`SELECT status, body ->> 'label' AS label
                            FROM rows WHERE id = 'r3'`;
      expect(row?.status).toBeNull();
      expect(row?.label).toBeNull();
    });
  }
);

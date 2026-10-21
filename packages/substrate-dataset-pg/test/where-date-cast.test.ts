/**
 * A `date`-declared body field filtered with an ISO-STRING operand must cast
 * `(body ->> field)::timestamptz`, not text-compare.
 *
 * The filter validator permits a Date OR an ISO string operand on a date field.
 * Operand-type inference alone treats a string operand as text, so comparisons
 * become lexical — wrong across timezone offsets / mixed precision. When the
 * dataset is wired with a `fieldDefLookup` declaring the field as `date`, the
 * WHERE builder casts ::timestamptz, as the orderBy resolver does.
 *
 * Each case uses operands where lexical and chronological order DISAGREE, so a
 * regression to text comparison fails loudly. A control without the lookup
 * pins the operand-inference path.
 *
 * Skipped when POSTGRES_URL isn't set.
 */

import type { FieldDef } from '@mnmal-ai/substrate-types';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PgDataset, runMigrations } from '../src/index.js';

const POSTGRES_URL = process.env.POSTGRES_URL;

// `eventAt` is a date field; everything else is undeclared (→ no cast).
const dateLookup = (_type: string, field: string): FieldDef | undefined =>
  field === 'eventAt' ? { kind: 'scalar', type: 'date' } : undefined;

describe.skipIf(!POSTGRES_URL)('PgDataset — date-field WHERE cast', () => {
  let sql: Sql;

  beforeAll(async () => {
    sql = postgres(POSTGRES_URL as string);
    await runMigrations(sql);
  });

  afterAll(async () => {
    await sql.end();
  });

  beforeEach(async () => {
    await sql`TRUNCATE TABLE rows, short_ids`;
  });

  // Instants: a = 2026-01-01T00:00:00Z (written as +05:00 offset),
  //           b = 2026-01-01T10:00:00Z. Lexically "T05:00:00+05:00" sorts
  //           AFTER "T02:00:00Z", but chronologically a (00:00Z) is BEFORE it.
  const seed = (ds: PgDataset) =>
    ds.write('E', [
      { id: 'a', eventAt: '2026-01-01T05:00:00+05:00' },
      { id: 'b', eventAt: '2026-01-01T10:00:00Z' }
    ]);

  it('gt with an ISO-string operand compares chronologically (declared date)', async () => {
    const ds = new PgDataset({ namespace: 'd185', sql, fieldDefLookup: dateLookup });
    await seed(ds);
    const rows = (await ds.read('E', { where: { eventAt: { gt: '2026-01-01T02:00:00Z' } } })).rows;
    // a's instant (00:00Z) is NOT after 02:00Z → only b. Text compare would
    // wrongly include a ("...T05..." > "...T02...").
    expect(rows.map((r) => r.id)).toEqual(['b']);
  });

  it('eq with an ISO-string operand matches by instant, not by string (declared date)', async () => {
    const ds = new PgDataset({ namespace: 'd185', sql, fieldDefLookup: dateLookup });
    await seed(ds);
    // Same instant as row a (00:00Z), different string form. Text compare misses it.
    const rows = (await ds.read('E', { where: { eventAt: { eq: '2026-01-01T00:00:00Z' } } })).rows;
    expect(rows.map((r) => r.id)).toEqual(['a']);
  });

  it('between with ISO-string bounds compares chronologically (declared date)', async () => {
    const ds = new PgDataset({ namespace: 'd185', sql, fieldDefLookup: dateLookup });
    await seed(ds);
    const rows = (
      await ds.read('E', {
        where: { eventAt: { between: ['2025-12-31T00:00:00Z', '2026-01-01T05:00:00Z'] } }
      })
    ).rows;
    // a (00:00Z) is inside the window; b (10:00Z) is past the upper bound.
    expect(rows.map((r) => r.id)).toEqual(['a']);
  });

  it('control: without a fieldDefLookup, a string operand text-compares (legacy behaviour)', async () => {
    const ds = new PgDataset({ namespace: 'd185', sql }); // no lookup wired
    await seed(ds);
    const rows = (await ds.read('E', { where: { eventAt: { gt: '2026-01-01T02:00:00Z' } } })).rows;
    // Operand-inference path: string operand → text compare. Lexically both
    // "T05:00:00+05:00" and "T10:00:00Z" sort after "T02:00:00Z" → both match.
    // The cast only engages with the lookup.
    expect(rows.map((r) => r.id).sort()).toEqual(['a', 'b']);
  });
});

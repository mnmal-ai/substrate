/**
 * A handle made by `forNamespace` casts body-field orderBy by its own
 * namespace's definitions, not by the handle it was made on. Skipped unless
 * POSTGRES_URL is set.
 */

import type { FieldDef } from '@mnmal-ai/substrate-types';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PgDataset, runMigrations } from '../src/index.js';
import { clearNamespace, dropNamespace } from './_layout.js';

const POSTGRES_URL = process.env.POSTGRES_URL;
const OTHER = 'kfdns_other';
const numberDef: FieldDef = { kind: 'scalar', type: 'number' };
const fieldDefLookupFor =
  (namespace: string) =>
  (_type: string, field: string): FieldDef | undefined =>
    namespace === OTHER && field === 'rank' ? numberDef : undefined;

describe.skipIf(!POSTGRES_URL)('PgDataset.forNamespace field definitions', () => {
  let sql: Sql;

  beforeAll(async () => {
    sql = postgres(POSTGRES_URL as string, { onnotice: () => {} });
    await runMigrations(sql);
    await dropNamespace(sql, OTHER);
  });

  beforeEach(async () => {
    await clearNamespace(sql, OTHER);
  });

  afterAll(async () => {
    await dropNamespace(sql, OTHER);
    await sql.end();
  });

  it("sorts a number field by the sibling namespace's definitions", async () => {
    const parent = new PgDataset({
      namespace: 'kfdns_parent',
      sql,
      fieldDefLookup: fieldDefLookupFor('kfdns_parent'),
      fieldDefLookupFor
    });
    const other = parent.forNamespace(OTHER);
    await other.write('Item', [{ rank: 10 }, { rank: 9 }]);
    const { rows } = await other.read('Item', { orderBy: [{ rank: 'asc' }] });
    expect(rows.map((r) => r.rank)).toEqual([9, 10]);
  });

  it("a scoped-transaction handle sorts a number field by its own namespace's definitions", async () => {
    const parent = new PgDataset({
      namespace: 'kfdns_parent',
      sql,
      fieldDefLookup: fieldDefLookupFor('kfdns_parent'),
      fieldDefLookupFor
    });
    await parent.forNamespace(OTHER).write('Item', [{ rank: 10 }, { rank: 9 }]);
    const ranks = await parent.withScopedTransaction?.(['kfdns_parent', OTHER], async (handles) => {
      const other = handles.datasets.get(OTHER);
      const { rows } = (await other?.read('Item', { orderBy: [{ rank: 'asc' }] })) ?? { rows: [] };
      return rows.map((r) => r.rank);
    });
    expect(ranks).toEqual([9, 10]);
  });
});

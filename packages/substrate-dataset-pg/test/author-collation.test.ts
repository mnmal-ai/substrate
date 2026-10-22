/**
 * Author columns sort and range-compare by byte order, as body text and the
 * memory dataset do, whatever the database collation (en_US puts
 * 'coda-claude' before 'Rich-claude'; byte order puts it after).
 *
 * Skipped when POSTGRES_URL is absent.
 */

import { MemoryDataset } from '@mnmal-ai/substrate-dataset-memory';
import type { Dataset, Row, RowMetadata } from '@mnmal-ai/substrate-types';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PgDataset, runMigrations } from '../src/index.js';

const POSTGRES_URL = process.env.POSTGRES_URL;

function by(id: string): RowMetadata {
  const at = '2026-10-20T00:00:00.000Z';
  const actor = { kind: 'agent' as const, id };
  return { createdAt: at, updatedAt: at, createdBy: actor, updatedBy: actor };
}

const ROWS: Row[] = [
  { id: 'r1', _metadata: by('coda-claude') },
  { id: 'r2', _metadata: by('Rich-claude') }
];

describe.skipIf(!POSTGRES_URL)('author columns compare by byte order', () => {
  let sql: Sql;
  let pg: PgDataset;
  const mem = new MemoryDataset({ namespace: 'author_collation' });

  beforeAll(async () => {
    sql = postgres(POSTGRES_URL as string, { onnotice: () => {} });
    await runMigrations(sql);
    await sql`DELETE FROM rows WHERE namespace = 'author_collation'`;
    pg = new PgDataset({ namespace: 'author_collation', sql });
    await pg.write('Note', ROWS);
    await mem.write('Note', ROWS);
  });
  afterAll(async () => {
    await sql`DELETE FROM rows WHERE namespace = 'author_collation'`;
    await sql.end();
  });

  const ids = async (ds: Dataset, params: Parameters<Dataset['read']>[1]): Promise<string[]> =>
    (await ds.read('Note', params)).rows.map((r) => String(r.id));

  it('orderBy createdById agrees with memory', async () => {
    const params = { orderBy: [{ createdById: 'asc' as const }] };
    expect(await ids(pg, params)).toEqual(['r2', 'r1']);
    expect(await ids(mem, params)).toEqual(['r2', 'r1']);
  });

  it('a range on updatedById agrees with memory', async () => {
    const params = { where: { updatedById: { gt: 'Z' } } };
    expect(await ids(pg, params)).toEqual(['r1']);
    expect(await ids(mem, params)).toEqual(['r1']);
  });
});

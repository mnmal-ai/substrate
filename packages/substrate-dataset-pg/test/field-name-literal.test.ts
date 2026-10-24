/**
 * Field names are inlined into SQL as string literals. Under
 * `standard_conforming_strings = off` a backslash escapes the next character
 * inside '…', so a name carrying `\'` must still read as itself and never
 * break out of the literal.
 *
 * Skipped when POSTGRES_URL isn't set.
 */

import type { Row } from '@mnmal-ai/substrate-types';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PgDataset, runMigrations } from '../src/index.js';

const POSTGRES_URL = process.env.POSTGRES_URL;

describe.skipIf(!POSTGRES_URL)('inlined field-name literals', () => {
  let sql: Sql;
  const NAME = "a\\' ) OR true --";

  beforeAll(async () => {
    sql = postgres(POSTGRES_URL as string, {
      max: 1,
      connection: { standard_conforming_strings: 'off' }
    });
    await runMigrations(sql);
  });

  afterAll(async () => {
    await sql.end();
  });

  beforeEach(async () => {
    await sql`TRUNCATE TABLE rows, short_ids`;
  });

  it('runs with standard_conforming_strings off', async () => {
    const [row] = await sql`SHOW standard_conforming_strings`;
    expect(row?.standard_conforming_strings).toBe('off');
  });

  it('a name with a backslash and a quote matches only its own rows', async () => {
    const ds = new PgDataset({ namespace: 'lit_ns', sql });
    const rows: Row[] = [
      { id: '1', [NAME]: 'v' },
      { id: '2', [NAME]: 'w' },
      { id: '3', other: 'v' }
    ];
    await ds.write('L', rows);
    const ids = async (where: Record<string, unknown>) =>
      (await ds.read('L', { where })).rows.map((r) => r.id).sort();
    expect(await ids({ [NAME]: { eq: 'v' } })).toEqual(['1']);
    expect(await ids({ [NAME]: { gt: 'v' } })).toEqual(['2']);
    expect(await ids({ [NAME]: { contains: 'w' } })).toEqual(['2']);
    const sorted = (await ds.read('L', { orderBy: [{ [NAME]: 'desc' }] })).rows.map((r) => r.id);
    expect(sorted).toEqual(['2', '1', '3']);
  });
});

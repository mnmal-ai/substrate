/**
 * A first write through a stale cached miss only creates (Todo #1886): when
 * another process created the table meanwhile with a newer definition, this
 * process's older one neither orphans the newer fields nor adds its own. B's
 * pool is deaf, as in promotion-stale-descriptor.test.ts.
 */

import { randomBytes } from 'node:crypto';
import { field } from '@mnmal-ai/substrate-sdk';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PgDataset } from '../src/index.js';
import { tableCacheFor } from '../src/type-table.js';
import { dropNamespace } from './_layout.js';

const POSTGRES_URL = process.env.POSTGRES_URL;

describe.skipIf(!POSTGRES_URL)('a first write through a stale cached miss (pg)', () => {
  let sqlA: Sql;
  let sqlB: Sql;
  const ns = `wc_${randomBytes(4).toString('hex')}`;

  beforeAll(() => {
    sqlA = postgres(POSTGRES_URL as string, { onnotice: () => {} });
    sqlB = postgres(POSTGRES_URL as string, { onnotice: () => {} });
    tableCacheFor(sqlB).listening = Promise.resolve(true);
  });
  afterAll(async () => {
    await dropNamespace(sqlA, ns);
    await sqlA.end({ timeout: 5 });
    await sqlB.end({ timeout: 5 });
  });

  it("creates nothing over the newer table: A's field stays, B's own is not added", async () => {
    const newer = { fields: { title: field.string(), rank: field.number() } };
    const older = { fields: { title: field.string(), legacy: field.string() } };
    const a = new PgDataset({ namespace: ns, sql: sqlA, typeDefLookup: () => newer });
    const b = new PgDataset({ namespace: ns, sql: sqlB, typeDefLookup: () => older });

    await b.read('Note', {}); // B caches "no table", and never hears otherwise
    await a.write('Note', [{ id: 'n1', title: 'a', rank: 1 }]);
    await b.write('Note', [{ id: 'n2', title: 'b' }]);

    const fields = await sqlA<Array<{ field: string; state: string }>>`
      SELECT field, state FROM substrate_type_fields
      WHERE namespace = ${ns} AND type = 'Note' ORDER BY field`;
    expect(fields).toEqual([
      { field: 'rank', state: 'column' },
      { field: 'title', state: 'column' }
    ]);
    expect((await a.read('Note', { ids: ['n2'] })).rows).toHaveLength(1);
  });
});

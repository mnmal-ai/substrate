/**
 * Audit B3 / M3 (Todo #1891): a process whose catalog notification is late
 * reads through a stale table descriptor. Every read checks the catalog
 * version of each table it decodes in its own statement; a stale one reloads
 * and runs again, so a field promoted (and backfilled out of `extra`) unseen
 * never reads as missing.
 *
 * Two pools stand in for two processes; B's is deaf, as in
 * promotion-stale-descriptor.test.ts.
 */

import { randomBytes } from 'node:crypto';
import { field } from '@mnmal-ai/substrate-sdk';
import type { FieldDef, Row } from '@mnmal-ai/substrate-types';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PgDataset } from '../src/index.js';
import { tableCacheFor } from '../src/type-table.js';
import { dropNamespace } from './_layout.js';

const POSTGRES_URL = process.env.POSTGRES_URL;

type Def = { fields: Record<string, FieldDef> };

describe.skipIf(!POSTGRES_URL)('a read through a stale table descriptor (pg)', () => {
  let sqlA: Sql;
  let sqlB: Sql;
  let ns: string;
  let defs: Record<string, Def>;
  let a: PgDataset;
  let b: PgDataset;
  const namespaces: string[] = [];
  const lookup = {
    typeDefLookup: (type: string) => defs[type],
    fieldDefLookup: (type: string, f: string) => defs[type]?.fields[f]
  };

  beforeAll(() => {
    sqlA = postgres(POSTGRES_URL as string, { onnotice: () => {} });
    sqlB = postgres(POSTGRES_URL as string, { onnotice: () => {} });
    tableCacheFor(sqlB).listening = Promise.resolve(true);
  });

  afterAll(async () => {
    for (const n of namespaces) await dropNamespace(sqlA, n);
    await sqlA.end({ timeout: 5 });
    await sqlB.end({ timeout: 5 });
  });

  beforeEach(() => {
    ns = `sr_${randomBytes(4).toString('hex')}`;
    namespaces.push(ns);
    defs = {
      Note: { fields: { title: field.string() } },
      Tag: { fields: { name: field.string(), note: field.crossRef(ns, 'Note') } }
    };
    a = new PgDataset({ namespace: ns, sql: sqlA, ...lookup });
    b = new PgDataset({ namespace: ns, sql: sqlB, ...lookup });
  });

  /** `rank` pending with n1.rank = 1 in extra; B caches that descriptor; A promotes it. */
  async function promotedBehindB(): Promise<void> {
    await a.write('Note', [
      { id: 'n1', title: 'a' },
      { id: 'n2', title: 'b' }
    ]);
    await a.write('Tag', [{ id: 't1', name: 'x', note: 'n1' }]);
    defs.Note = { fields: { title: field.string(), rank: field.number() } };
    await a.ensureTypeStorage('Note', { newFields: 'pending' });
    await a.write('Note', [{ id: 'n1', rank: 1 }]);
    // B caches `rank` pending (and Tag), and reads it from `extra`.
    expect((await b.read('Note', { ids: ['n1'] })).rows.map((r: Row) => r.rank)).toEqual([1]);
    await b.read('Tag', {});
    expect(tableCacheFor(sqlB).tables.get(`${ns}/Note`)?.pending).toEqual(['rank']);
    expect(
      (await a.promotePendingFields({ lockTimeoutMs: 2000, batchRows: 100, namespace: ns })).map(
        (e) => e.kind
      )
    ).toEqual(['promoted']);
  }

  it('a read by id returns the promoted value, and B then holds the column descriptor', async () => {
    await promotedBehindB();
    expect((await b.read('Note', { ids: ['n1'] })).rows.map((r: Row) => r.rank)).toEqual([1]);
    expect(tableCacheFor(sqlB).tables.get(`${ns}/Note`)?.column('rank')?.state).toBe('column');
  });

  it('a filter on the promoted field matches, and a page is not empty', async () => {
    await promotedBehindB();
    const res = await b.read('Note', { where: { rank: { eq: 1 } }, limit: 100 });
    expect(res.rows.map((r: Row) => r.id)).toEqual(['n1']);
  });

  it('a count and an aggregate see the promoted value', async () => {
    await promotedBehindB();
    expect((await b.read('Note', { where: { rank: { eq: 1 } }, count: true })).count).toBe(1);
    const agg = await b.read('Note', { aggregate: { top: { max: 'rank' } } });
    expect(agg.groups).toEqual([{ top: 1 }]);
  });

  it('a walk whose far type is stale reads it through the current descriptor', async () => {
    await promotedBehindB();
    const res = await b.read('Tag', {
      where: { _walk: { out: 'note', where: { rank: { eq: 1 } } } }
    });
    expect(res.rows.map((r: Row) => r.id)).toEqual(['t1']);
  });

  it('inside a transaction the stale copy is reloaded too', async () => {
    await promotedBehindB();
    const rank = await b.withTransaction(
      async (tx) => (await tx.read('Note', { ids: ['n1'] })).rows[0]?.rank
    );
    expect(rank).toBe(1);
  });
});

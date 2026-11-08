/**
 * A read that names its `fields` fetches row metadata and the short id only
 * when it asks for them: the statement selects neither, and the rows carry
 * neither. A read without `fields` keeps both, since internal readers
 * (backfills, migrations, policy row filters) rely on whole rows.
 */

import { randomBytes } from 'node:crypto';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PgDataset } from '../src/index.js';
import { readsRowMetadata, readsShortId } from '../src/pg-sql.js';
import { clearNamespace } from './_layout.js';

const POSTGRES_URL = process.env.POSTGRES_URL;
const TYPE = 'Thing';
const ns = `rpp_${randomBytes(4).toString('hex')}`;
const meta = {
  createdAt: '2026-04-25T00:00:00.000Z',
  updatedAt: '2026-04-25T00:00:00.000Z',
  createdBy: { kind: 'agent' as const, id: 'a1' },
  updatedBy: { kind: 'agent' as const, id: 'a1' }
};

describe('readsRowMetadata / readsShortId', () => {
  it('reads both when fields is absent', () => {
    expect(readsRowMetadata(undefined)).toBe(true);
    expect(readsShortId(undefined)).toBe(true);
  });
  it('reads neither for a plain field list', () => {
    expect(readsRowMetadata({ name: true, id: true })).toBe(false);
    expect(readsShortId({ name: true })).toBe(false);
  });
  it.each([
    '_metadata',
    'createdAt',
    'updatedAt',
    'createdBy',
    'updatedBy',
    'createdById',
    'updatedByKind',
    'seq'
  ])('reads metadata for %s', (k) =>
    expect(readsRowMetadata({ name: true, [k]: true })).toBe(true)
  );
  it('reads the short id when asked', () => expect(readsShortId({ shortId: true })).toBe(true));
});

describe.skipIf(!POSTGRES_URL)('read projection pushdown (pg)', () => {
  let sql: Sql;
  let traced: Sql;
  let sent: string[] = [];
  let ds: PgDataset;

  beforeAll(async () => {
    sql = postgres(POSTGRES_URL as string, { onnotice: () => {} });
    traced = postgres(POSTGRES_URL as string, {
      onnotice: () => {},
      debug: (_c, query) => {
        sent.push(query);
      }
    });
    ds = new PgDataset({ namespace: ns, sql: traced });
    await ds.write(TYPE, [{ id: 't1', name: 'x', _metadata: meta }]);
    await sql`INSERT INTO short_ids (namespace, type, short_id, row_id) VALUES (${ns}, ${TYPE}, 7, 't1')`;
  });
  beforeEach(() => {
    sent = [];
  });
  afterAll(async () => {
    await clearNamespace(sql, ns);
    await traced.end({ timeout: 5 });
    await sql.end({ timeout: 5 });
  });

  const page = () => sent.filter((q) => /\bFROM\b/.test(q) && q.includes('r.deleted_at'));

  it('a field list without metadata or shortId fetches neither', async () => {
    const { rows } = await ds.read(TYPE, { fields: { name: true } });
    expect(rows).toEqual([{ id: 't1', name: 'x' }]);
    expect(page()).toHaveLength(1);
    expect(page()[0]).not.toMatch(/created_at|short_id/);
  });

  it('_metadata in the field list fetches it, still without the short id', async () => {
    const { rows } = await ds.read(TYPE, { fields: { name: true, _metadata: true } });
    expect(rows[0]?._metadata).toEqual(meta);
    expect(rows[0]).not.toHaveProperty('shortId');
    expect(page()[0]).toMatch(/created_at/);
    expect(page()[0]).not.toMatch(/short_id/);
  });

  it('a metadata column name in the field list fetches the metadata', async () => {
    const { rows } = await ds.read(TYPE, { fields: { name: true, createdBy: true } });
    expect(rows[0]?._metadata).toEqual(meta);
  });

  it('shortId in the field list fetches it, without the metadata', async () => {
    const { rows } = await ds.read(TYPE, { fields: { name: true, shortId: true } });
    expect(rows[0]).toEqual({ id: 't1', name: 'x', shortId: 7 });
    expect(page()[0]).not.toMatch(/created_at/);
  });

  it('a read without fields keeps the whole row', async () => {
    const { rows } = await ds.read(TYPE, {});
    expect(rows[0]).toMatchObject({ id: 't1', name: 'x', shortId: 7, _metadata: meta });
  });
});

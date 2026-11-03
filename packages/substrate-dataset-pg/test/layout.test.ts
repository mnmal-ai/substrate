/**
 * Storage layout: a fresh database gets the tables baseline, and a schema
 * holding an old layout's `rows` is detected and refused before anything
 * changes. Names stay within pg's identifier limit. Each pg test runs in a
 * throwaway schema of its own.
 */

import { randomBytes } from 'node:crypto';
import postgres, { type Sql } from 'postgres';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  detectLayout,
  runMigrations,
  typeTableName,
  UnsupportedStoreLayoutError
} from '../src/index.js';
import { hashedName } from '../src/layout.js';

const POSTGRES_URL = process.env.POSTGRES_URL;

describe('typeTableName', () => {
  it('names a type table readably when the names are already clean', () => {
    expect(typeTableName('cortext', 'todo')).toBe('t__cortext__todo');
  });

  it('stays within 63 bytes for a 60-char namespace and a 60-char type, and is stable', () => {
    const ns = 'n'.repeat(60);
    const type = 't'.repeat(60);
    const name = typeTableName(ns, type);
    expect(Buffer.byteLength(name)).toBeLessThanOrEqual(63);
    expect(typeTableName(ns, type)).toBe(name);
    expect(typeTableName(ns, 'u'.repeat(60))).not.toBe(name);
  });

  it('appends a hash when sanitising changed a name', () => {
    expect(typeTableName('A-b', 'T')).toMatch(/^t__a_b__t_[0-9a-f]{8}$/);
    expect(typeTableName('a-b', 'T')).not.toBe(typeTableName('a_b', 'T'));
  });

  it('cuts a hashed name to the length it is given, room for a suffix', () => {
    const long = 'x'.repeat(80);
    expect(hashedName(long, long)).toHaveLength(63);
    expect(`${hashedName(long, long, 57)}__swap`).toHaveLength(63);
  });
});

describe.skipIf(!POSTGRES_URL)('storage layout', () => {
  let sql: Sql;
  let schema: string;

  beforeEach(async () => {
    schema = `substrate_layout_${randomBytes(4).toString('hex')}`;
    // One connection, so the SET below reaches every query, the migration runner's included.
    sql = postgres(POSTGRES_URL as string, { max: 1, onnotice: () => {} });
    await sql.unsafe(`CREATE SCHEMA ${schema}`);
    await sql.unsafe(`SET search_path TO ${schema}`);
  });

  afterEach(async () => {
    await sql.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await sql.end({ timeout: 5 });
  });

  const relations = () =>
    sql`SELECT relname::text AS name FROM pg_class
        WHERE relnamespace = current_schema()::regnamespace ORDER BY 1`;

  it('reports absent before any migration', async () => {
    expect(await detectLayout(sql)).toBe('absent');
  });

  it('builds a fresh database as type tables, with no rows', async () => {
    await runMigrations(sql);
    expect(await detectLayout(sql)).toBe('tables');
    expect(await sql`SELECT to_regclass('rows') AS r`).toEqual([{ r: null }]);
    const ledger = await sql<{ version: string }[]>`SELECT version FROM migrations`;
    expect(ledger.map((r) => r.version)).toEqual(['0001t_tables_baseline']);
  });

  for (const [layout, ddl] of [
    ['legacy', 'CREATE TABLE rows (namespace text, type text, id text, body jsonb)'],
    [
      'partitioned',
      'CREATE TABLE rows (namespace text, type text, id text, body jsonb) PARTITION BY LIST (namespace)'
    ]
  ] as const) {
    it(`detects a ${layout} rows and refuses to migrate it, changing nothing`, async () => {
      await sql.unsafe(ddl);
      expect(await detectLayout(sql)).toBe(layout);
      const before = await relations();
      const err = await runMigrations(sql).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(UnsupportedStoreLayoutError);
      expect((err as UnsupportedStoreLayoutError).layout).toBe(layout);
      expect((err as Error).message).toContain('`substrate-admin migrate-store`');
      expect(await relations()).toEqual(before);
    });
  }
});

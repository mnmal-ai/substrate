/**
 * Type-table catalog lookups stay scoped when same-named objects exist
 * elsewhere. On a clean schema a scoped and an unscoped lookup agree, so this
 * suite plants DECOYS with the exact names the real lookups match on: a
 * same-named type table, with a same-named, marked engine index of another
 * shape, in another schema; and the same type under another namespace in the
 * store's own catalog. The store must still see only its own.
 */

import { randomBytes } from 'node:crypto';
import type { FieldDef } from '@mnmal-ai/substrate-types';
import postgres, { type Sql } from 'postgres';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PgDataset, runMigrations, typeIndexesOf } from '../src/index.js';
import { reconcileTypeIndexes } from '../src/index-reconciler.js';
import { typeTableName } from '../src/layout.js';
import { generatedIdentifier } from '../src/migrate.js';
import { ensureTypeTable, loadTypeTable, typeTableOf } from '../src/type-table.js';

const POSTGRES_URL = process.env.POSTGRES_URL;
const NS = 'scoped';
const OTHER_NS = 'scoped_other';
const TYPE = 'thing';
const fields: Record<string, FieldDef> = {
  ref: { kind: 'crossRef', ns: NS, type: 'X', onDelete: 'set_null' },
  title: { kind: 'scalar', type: 'string' }
};

describe.skipIf(!POSTGRES_URL)('type-table catalog lookups are scoped, proven by decoys', () => {
  let sql: Sql;
  let own: string;
  let decoy: string;
  const table = typeTableName(NS, TYPE);
  const derived = generatedIdentifier(NS, TYPE, 'ref', 'idx');

  const dataset = (namespace: string) =>
    new PgDataset({
      namespace,
      sql,
      typeDefLookup: (type) => (type === TYPE ? { fields, indexes: [] } : undefined)
    });

  beforeEach(async () => {
    const hex = randomBytes(4).toString('hex');
    own = `substrate_scope_${hex}`;
    decoy = `substrate_scope_decoy_${hex}`;
    // One connection, so the SET below reaches every query, the migration runner's included.
    sql = postgres(POSTGRES_URL as string, { max: 1, onnotice: () => {} });
    await sql.unsafe(`CREATE SCHEMA ${own}`);
    await sql.unsafe(`CREATE SCHEMA ${decoy}`);
    await sql.unsafe(`SET search_path TO ${own}`);
    await runMigrations(sql);

    // Decoy 1: the type's table and its derived index, by name, in another
    // schema, marked as the engine's, but keyed on another column.
    await sql.unsafe(
      `CREATE TABLE ${decoy}.${table} (id text, deleted_at timestamptz, other text)`
    );
    await sql.unsafe(`CREATE INDEX ${derived} ON ${decoy}.${table} (other)`);
    await sql.unsafe(`COMMENT ON INDEX ${decoy}.${derived} IS 'substrate: reconciled'`);
    // Decoy 2: the next type's preferred table name, taken in the other schema only.
    await sql.unsafe(`CREATE TABLE ${decoy}.${typeTableName(NS, 'next')} (id text)`);

    // The real type, and the same type under another namespace.
    for (const ns of [NS, OTHER_NS]) {
      const ds = dataset(ns);
      await ds.write(TYPE, [{ id: 'a', ref: 'r', title: 't' }]);
      await ds.ensureTypeStorage(TYPE);
    }
  });

  afterEach(async () => {
    await sql.unsafe(`DROP SCHEMA IF EXISTS ${own} CASCADE`);
    await sql.unsafe(`DROP SCHEMA IF EXISTS ${decoy} CASCADE`);
    await sql.end({ timeout: 5 });
  });

  it('the decoys are visible to an unscoped lookup, or this file proves nothing', async () => {
    const tables = await sql<{ s: string }[]>`
      SELECT relnamespace::regnamespace::text AS s FROM pg_class WHERE relname = ${table}`;
    expect(tables.map((r) => r.s).sort()).toEqual([decoy, own].sort());
    const indexes = await sql<{ s: string }[]>`
      SELECT schemaname AS s FROM pg_indexes WHERE indexname = ${derived}`;
    expect(indexes.map((r) => r.s).sort()).toEqual([decoy, own].sort());
  });

  it('loadTypeTable resolves the type to its own table and catalog only', async () => {
    const loaded = await loadTypeTable(sql, NS, TYPE);
    expect(loaded?.from).toBe(`"${table}"`);
    expect(loaded?.columns().map((c) => c.field)).toEqual(['ref', 'title']);
    const other = await typeTableOf(sql, OTHER_NS, TYPE);
    expect(other).toBe(typeTableName(OTHER_NS, TYPE));
  });

  it('describeStorage and typeIndexesOf report the real indexes, never the decoy or the other namespace', async () => {
    const storage = await dataset(NS).describeStorage(TYPE);
    expect(storage.table).toBe(table);
    expect(storage.indexes.find((i) => i.name === derived)).toMatchObject({ state: 'valid' });
    const held = await typeIndexesOf(sql, NS, TYPE);
    expect(held.every((i) => i.table === table)).toBe(true);
    expect(held.find((i) => i.name === derived)?.engineOwned).toBe(true);
    expect(held.some((i) => i.name === generatedIdentifier(OTHER_NS, TYPE, 'ref', 'idx'))).toBe(
      false
    );
  });

  it('reconcileTypeIndexes leaves the real derived index unchanged, neither swapping nor conflicting', async () => {
    const states = await reconcileTypeIndexes(sql, {
      namespace: NS,
      type: TYPE,
      fields,
      indexes: [],
      orderedBy: { createdAt: 'desc' }
    });
    expect(states.find((s) => s.name === derived)).toMatchObject({
      state: 'valid',
      outcome: 'unchanged'
    });
    const [decoyIndex] = await sql<{ def: string }[]>`
      SELECT indexdef AS def FROM pg_indexes WHERE schemaname = ${decoy} AND indexname = ${derived}`;
    expect(decoyIndex?.def).toContain('(other)');
  });

  it("a name taken only in another schema does not push a new type's table onto a hashed name", async () => {
    await ensureTypeTable(sql, {
      namespace: NS,
      type: 'next',
      fields: {},
      newFields: 'column',
      enforceUuidCheck: false
    });
    expect(await typeTableOf(sql, NS, 'next')).toBe(typeTableName(NS, 'next'));
  });
});

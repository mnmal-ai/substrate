/**
 * `typeStats` and `typeIndexesOf`: per-type row and index statistics for the
 * index advisor, with each index attributed to its type by marker, generated
 * suffix and the type's own table, never by name prefix, which folds and
 * truncates.
 */

import { randomBytes } from 'node:crypto';
import type { FieldDef, IndexDecl } from '@mnmal-ai/substrate-types';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PgDataset, typeIndexesOf } from '../src/index.js';
import { generatedIdentifier } from '../src/migrate.js';

const POSTGRES_URL = process.env.POSTGRES_URL;

const fields: Record<string, FieldDef> = {
  ref: { kind: 'crossRef', ns: 'other', type: 'Target', onDelete: 'set_null' },
  label: { kind: 'scalar', type: 'string' }
};

const hex = () => randomBytes(4).toString('hex');

const engineIndexes = async (sql: Sql, ns: string, type: string) =>
  (await typeIndexesOf(sql, ns, type)).filter((i) => i.engineOwned);

let sql: Sql;

beforeAll(async () => {
  if (POSTGRES_URL) sql = postgres(POSTGRES_URL, { onnotice: () => {} });
});

afterAll(async () => {
  await sql?.end({ timeout: 5 });
});

/** A dataset over `ns` whose `type` declares `fields`, with its storage and indexes built. */
async function typeWithStorage(
  ns: string,
  type: string,
  indexes: IndexDecl[] = []
): Promise<PgDataset> {
  const ds = new PgDataset({
    namespace: ns,
    sql,
    typeDefLookup: (t, n) => (t === type && n === ns ? { fields, indexes } : undefined)
  });
  await ds.ensureTypeStorage(type);
  return ds;
}

describe.skipIf(!POSTGRES_URL)('typeStats', () => {
  it('reports live rows and the type indexes, flagging the engine-owned ones', async () => {
    const ns = `ts_${hex()}`;
    // Rows first, so the partial index is built over them and counts them
    // exactly; one built on an empty share keeps reltuples 0 on PG 18.
    const ds = new PgDataset({
      namespace: ns,
      sql,
      typeDefLookup: (t, n) => (t === 'T' && n === ns ? { fields, indexes: [] } : undefined)
    });
    await ds.write('T', [
      { id: 'a', ref: 'x', label: 'one' },
      { id: 'b', ref: 'y', label: 'two' }
    ]);
    await ds.ensureTypeStorage('T');
    const derived = generatedIdentifier(ns, 'T', 'ref', 'idx');
    // Engine-shaped name, but no marker: not the engine's.
    const lookalike = `rows_ts_lookalike_${hex()}_idx`;
    const [own] = await typeIndexesOf(sql, ns, 'T');
    const table = own?.table as string;
    await sql.unsafe(`CREATE INDEX ${lookalike} ON "${table}" (f_label)`);
    await sql.unsafe(`VACUUM (ANALYZE) "${table}"`);

    const stats = (await ds.typeStats()).find((s) => s.namespace === ns && s.type === 'T');
    expect((await engineIndexes(sql, ns, 'T')).map((i) => i.name)).toContain(derived);
    expect((await engineIndexes(sql, ns, 'T')).map((i) => i.name)).not.toContain(lookalike);
    // Documented contract: a type is absent (unknown) or has liveRows >= 1, never 0.
    // A type table counts exactly, so the type must be present.
    expect(stats?.liveRows).toBeGreaterThanOrEqual(1);
    expect(stats?.insertsTotal).toBeGreaterThanOrEqual(0);
    expect(stats?.updatesTotal).toBeGreaterThanOrEqual(0);
    expect(stats?.deletesTotal).toBeGreaterThanOrEqual(0);
    // Every timestamp parses, so the advisor can measure a window from it.
    for (const i of stats?.indexes ?? []) {
      expect(i.lastScanAt === null || !Number.isNaN(Date.parse(i.lastScanAt)), i.name).toBe(true);
    }
    const byName = new Map(stats?.indexes.map((i) => [i.name, i]));
    expect(byName.get(derived)).toMatchObject({ engineOwned: true, unique: false });
    expect(byName.get(derived)?.sizeBytes).toBeGreaterThan(0);
    expect(byName.get(lookalike)).toMatchObject({ engineOwned: false });
    await sql.unsafe(`DROP INDEX ${lookalike}`);
  });

  it('gives two types whose folded names collide disjoint index lists', async () => {
    const base = `ts_${hex()}`;
    // Both fold to the generated-name prefix `rows_<base>_a_b_c_`.
    const one = { ns: `${base}_a`, type: 'b_c' };
    const two = { ns: `${base}_a_b`, type: 'c' };
    await typeWithStorage(one.ns, one.type, [{ fields: ['label'] }]);
    await typeWithStorage(two.ns, two.type, [{ fields: ['label'] }]);

    const names = async (t: { ns: string; type: string }) =>
      (await engineIndexes(sql, t.ns, t.type)).map((i) => i.name);
    const a = await names(one);
    const b = await names(two);
    expect(a).toContain(generatedIdentifier(one.ns, one.type, 'ref', 'idx'));
    expect(b).toContain(generatedIdentifier(two.ns, two.type, 'ref', 'idx'));
    expect(a.length).toBeGreaterThanOrEqual(2);
    expect(a.filter((n) => b.includes(n))).toEqual([]);
  });

  it('finds a long-named type indexes despite the truncated name', async () => {
    const ns = `ts_${hex()}`;
    const type = `AVeryLongTypeNameThatPushesTheGeneratedIndexNamePastTheLimit${hex()}`;
    await typeWithStorage(ns, type);
    const derived = generatedIdentifier(ns, type, 'ref', 'idx');
    expect(derived).not.toContain(type.toLowerCase());
    const names = (await engineIndexes(sql, ns, type)).map((i) => i.name);
    expect(names).toContain(derived);
    // Partitioned and tables add the created/updated/deleted base indexes, truncated alike.
    expect(names).toHaveLength(4);
  });

  it('typeStats reports each type table', async () => {
    const ns = `ts_${hex()}`;
    const one = await typeWithStorage(ns, 'One');
    const two = await typeWithStorage(ns, 'Two');
    await one.write('One', [{ id: 'a', ref: 'x' }]);
    await two.write('Two', [
      { id: 'b', ref: 'y' },
      { id: 'c', ref: 'z' }
    ]);
    for (const t of ['One', 'Two']) {
      const [row] = await sql<Array<{ table_name: string }>>`
        SELECT table_name FROM substrate_type_tables WHERE namespace = ${ns} AND type = ${t}`;
      await sql.unsafe(`VACUUM (ANALYZE) "${row?.table_name}"`);
    }
    const stats = (await one.typeStats()).filter((s) => s.namespace === ns);
    expect(stats.map((s) => [s.type, s.liveRows]).sort()).toEqual([
      ['One', 1],
      ['Two', 2]
    ]);
    for (const s of stats) {
      expect(s.indexes.map((i) => i.name)).toContain(generatedIdentifier(ns, s.type, 'ref', 'idx'));
    }
  });
});

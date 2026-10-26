/**
 * `typeStats` and `typeIndexesOf`: per-type row and index statistics for the
 * index advisor, with each index attributed to its type by marker, generated
 * suffix and the type's own scope (partition or predicate), never by name
 * prefix, which folds and truncates.
 */

import { randomBytes } from 'node:crypto';
import type { FieldDef, IndexDecl } from '@mnmal-ai/substrate-types';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { engineIndexesOf, PgDataset, type StorageLayout, typeIndexesOf } from '../src/index.js';
import { generatedIdentifier } from '../src/migrate.js';

const POSTGRES_URL = process.env.POSTGRES_URL;
const LAYOUT = (process.env.SUBSTRATE_STORAGE_LAYOUT ?? 'legacy') as StorageLayout;

const fields: Record<string, FieldDef> = {
  ref: { kind: 'crossRef', ns: 'other', type: 'Target', onDelete: 'set_null' },
  label: { kind: 'scalar', type: 'string' }
};

const hex = () => randomBytes(4).toString('hex');

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
    const ds = await typeWithStorage(ns, 'T');
    await ds.write('T', [
      { id: 'a', ref: 'x', label: 'one' },
      { id: 'b', ref: 'y', label: 'two' }
    ]);
    const derived = generatedIdentifier(ns, 'T', 'ref', 'idx');
    // Engine-shaped name, but no marker: not the engine's.
    const lookalike = `rows_ts_lookalike_${hex()}_idx`;
    const [own] = await typeIndexesOf(sql, ns, 'T', LAYOUT);
    const table = own?.table ?? 'rows';
    const scope = LAYOUT === 'legacy' ? `WHERE namespace = '${ns}' AND type = 'T'` : '';
    await sql.unsafe(`CREATE INDEX ${lookalike} ON ${table} ((body->>'label')) ${scope}`);
    await sql.unsafe(`ANALYZE ${table}`);

    const stats = (await ds.typeStats()).find((s) => s.namespace === ns && s.type === 'T');
    expect(stats?.liveRows).toBeGreaterThanOrEqual(1);
    expect(stats?.insertsTotal).toBeGreaterThanOrEqual(0);
    const byName = new Map(stats?.indexes.map((i) => [i.name, i]));
    expect(byName.get(derived)).toMatchObject({ engineOwned: true, unique: false });
    expect(byName.get(derived)?.sizeBytes).toBeGreaterThan(0);
    expect(byName.get(lookalike)).toMatchObject({ engineOwned: false });
    expect((await engineIndexesOf(sql, ns, 'T', LAYOUT)).map((i) => i.name)).toContain(derived);
    expect((await engineIndexesOf(sql, ns, 'T', LAYOUT)).map((i) => i.name)).not.toContain(
      lookalike
    );
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
      (await engineIndexesOf(sql, t.ns, t.type, LAYOUT)).map((i) => i.name);
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
    const names = (await engineIndexesOf(sql, ns, type, LAYOUT)).map((i) => i.name);
    expect(names).toContain(derived);
    // Partitioned adds the created/updated/deleted base indexes, truncated alike.
    expect(names).toHaveLength(LAYOUT === 'partitioned' ? 4 : 1);
  });

  it.skipIf(LAYOUT !== 'legacy')('splits rows statistics by a sampled share', async () => {
    const ns = `ts_${hex()}`;
    const ds = new PgDataset({ namespace: ns, sql });
    const n = 30_000;
    await sql`
      INSERT INTO rows (namespace, type, id, body)
      SELECT ${ns}, 'Big', g::text, '{}'::jsonb FROM generate_series(1, ${n}) g`;
    await sql`ANALYZE rows`;
    const big = (await ds.typeStats()).find((s) => s.namespace === ns && s.type === 'Big');
    // A block sample: an estimate, not a count.
    expect(big?.liveRows).toBeGreaterThan(n / 2);
    expect(big?.liveRows).toBeLessThan(n * 2);
    await sql`DELETE FROM rows WHERE namespace = ${ns}`;
  });
});

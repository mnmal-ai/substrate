/**
 * `typeStats` and `typeIndexesOf`: per-type row and index statistics for the
 * index advisor, with each index attributed to its type by marker, generated
 * suffix and the type's own scope (partition or predicate), never by name
 * prefix, which folds and truncates.
 */

import { randomBytes } from 'node:crypto';
import type { FieldDef, IndexDecl } from '@mnmal-ai/substrate-types';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PgDataset, type StorageLayout, typeIndexesOf } from '../src/index.js';
import { generatedIdentifier, runMigrations } from '../src/migrate.js';

const POSTGRES_URL = process.env.POSTGRES_URL;
const LAYOUT = (process.env.SUBSTRATE_STORAGE_LAYOUT ?? 'legacy') as StorageLayout;

const fields: Record<string, FieldDef> = {
  ref: { kind: 'crossRef', ns: 'other', type: 'Target', onDelete: 'set_null' },
  label: { kind: 'scalar', type: 'string' }
};

const hex = () => randomBytes(4).toString('hex');

const engineIndexes = async (sql: Sql, ns: string, type: string, layout: StorageLayout) =>
  (await typeIndexesOf(sql, ns, type, layout)).filter((i) => i.engineOwned);

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
    const [own] = await typeIndexesOf(sql, ns, 'T', LAYOUT);
    const table = own?.table ?? 'rows';
    const scope = LAYOUT === 'legacy' ? `WHERE namespace = '${ns}' AND type = 'T'` : '';
    await sql.unsafe(`CREATE INDEX ${lookalike} ON ${table} ((body->>'label')) ${scope}`);
    // The index was built over the rows above, so VACUUM sees them; ANALYZE
    // alone only samples a large shared `rows`, which can miss a 2-row type.
    await sql.unsafe(`VACUUM (ANALYZE) ${table}`);

    const stats = (await ds.typeStats()).find((s) => s.namespace === ns && s.type === 'T');
    expect((await engineIndexes(sql, ns, 'T', LAYOUT)).map((i) => i.name)).toContain(derived);
    expect((await engineIndexes(sql, ns, 'T', LAYOUT)).map((i) => i.name)).not.toContain(lookalike);
    // Documented contract: a type is absent (unknown) or has liveRows >= 1, never 0.
    // A legacy share can be sampled past this 2-row type when `rows` is large;
    // partitioned counts exactly, so there the type must be present.
    if (stats || LAYOUT === 'partitioned') expect(stats?.liveRows).toBeGreaterThanOrEqual(1);
    if (!stats) return void (await sql.unsafe(`DROP INDEX ${lookalike}`));
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
      (await engineIndexes(sql, t.ns, t.type, LAYOUT)).map((i) => i.name);
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
    const names = (await engineIndexes(sql, ns, type, LAYOUT)).map((i) => i.name);
    expect(names).toContain(derived);
    // Partitioned adds the created/updated/deleted base indexes, truncated alike.
    expect(names).toHaveLength(LAYOUT === 'partitioned' ? 4 : 1);
  });

  it.skipIf(LAYOUT !== 'legacy')(
    'takes a large legacy type from its partial index and the rest from a sample',
    async () => {
      const ns = `ts_${hex()}`;
      const small = await typeWithStorage(ns, 'Small');
      await small.write('Small', [{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
      // A rebuild sets the partial index's reltuples to its exact row count.
      const derived = generatedIdentifier(ns, 'Small', 'ref', 'idx');
      const n = 30_000;
      await insertAndFlush(sql, ns, 'Big', n);
      // Analyzed since the inserts, so index counts are fresh; the rebuild makes
      // the partial index's reltuples its exact row count.
      await sql`ANALYZE rows`;
      await sql.unsafe(`REINDEX INDEX ${derived}`);

      const stats = await small.typeStats();
      const big = stats.find((s) => s.namespace === ns && s.type === 'Big');
      // A block sample: an estimate, not a count.
      expect(big?.liveRows).toBeGreaterThan(n / 2);
      expect(big?.liveRows).toBeLessThan(n * 2);
      expect(stats.find((s) => s.namespace === ns && s.type === 'Small')?.liveRows).toBe(3);
      await sql`DELETE FROM rows WHERE namespace = ${ns}`;
    },
    60_000
  );

  it.skipIf(LAYOUT !== 'legacy')(
    'samples a large never-analyzed rows table, trusting no stale index row count',
    async () => {
      const schema = `ts_fresh_${hex()}`;
      await sql.unsafe(`CREATE SCHEMA ${schema}`);
      const url = new URL(POSTGRES_URL as string);
      url.searchParams.set('options', `-c search_path=${schema},public`);
      const statements: string[] = [];
      const fresh = postgres(url.toString(), {
        onnotice: () => {},
        debug: (_conn, query) => void statements.push(query)
      });
      try {
        await runMigrations(fresh, { layout: 'legacy' });
        await fresh`ALTER TABLE rows SET (autovacuum_enabled = false)`;
        // Its derived index built on the empty table: reltuples 0 until ANALYZE.
        const ds = new PgDataset({
          namespace: 'fresh',
          sql: fresh,
          typeDefLookup: (t, n) => (t === 'Big' && n === 'fresh' ? { fields } : undefined)
        });
        await ds.ensureTypeStorage('Big');
        const n = 30_000;
        await insertAndFlush(fresh, 'fresh', 'Big', n);
        // The build analyzed the empty table: its index count is 0, now stale.
        const [rel] = await fresh<Array<{ indexRows: number; changed: number }>>`
          SELECT (SELECT reltuples::float8 FROM pg_class
                  WHERE relname = ${generatedIdentifier('fresh', 'Big', 'ref', 'idx')}
                    AND relnamespace = current_schema()::regnamespace) AS "indexRows",
                 s.n_mod_since_analyze::float8 AS changed
          FROM pg_stat_user_tables s WHERE s.relid = 'rows'::regclass`;
        expect(rel?.indexRows).toBe(0);
        expect(rel?.changed).toBeGreaterThanOrEqual(n);

        statements.length = 0;
        const big = (await ds.typeStats()).find((s) => s.type === 'Big');
        expect(statements.some((q) => q.includes('TABLESAMPLE SYSTEM'))).toBe(true);
        expect(big?.liveRows).toBeGreaterThan(n / 2);
        expect(big?.liveRows).toBeLessThan(n * 2);
      } finally {
        await fresh.end({ timeout: 5 });
        await sql.unsafe(`DROP SCHEMA ${schema} CASCADE`);
      }
    },
    60_000
  );
});

/** Inserts `n` rows of `ns`/`type`, then flushes this backend's statistics so `n_live_tup` shows them. */
async function insertAndFlush(db: Sql, ns: string, type: string, n: number): Promise<void> {
  const conn = await db.reserve();
  try {
    await conn`
      INSERT INTO rows (namespace, type, id, body)
      SELECT ${ns}, ${type}, g::text, '{}'::jsonb FROM generate_series(1, ${n}) g`;
    await conn`SELECT pg_stat_force_next_flush()`;
    await conn`SELECT 1`;
  } finally {
    conn.release();
  }
  // Flushed: the next read of the statistics, in a new transaction, sees them.
  await vi.waitFor(
    async () => {
      const [s] = await db<Array<{ live: number }>>`
        SELECT n_live_tup::float8 AS live FROM pg_stat_user_tables WHERE relid = 'rows'::regclass`;
      expect(s?.live).toBeGreaterThanOrEqual(n);
    },
    { timeout: 10_000, interval: 50 }
  );
}

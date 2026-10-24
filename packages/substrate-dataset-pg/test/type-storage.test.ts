/**
 * `ensureTypeStorage` on the partitioned layout: a type's rows move out of the
 * DEFAULT partition into a partition of their own, once, without being lost,
 * duplicated or seen twice, and keep their short ids. On legacy it is a no-op.
 */

import { randomBytes } from 'node:crypto';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PgDataset, partitionName } from '../src/index.js';

const POSTGRES_URL = process.env.POSTGRES_URL;
const LAYOUT = process.env.SUBSTRATE_STORAGE_LAYOUT ?? 'legacy';

const freshNs = () => `ts_${randomBytes(4).toString('hex')}`;

let sql: Sql;

beforeAll(async () => {
  if (POSTGRES_URL) sql = postgres(POSTGRES_URL, { onnotice: () => {} });
});

afterAll(async () => {
  await sql?.end({ timeout: 5 });
});

/** Relname of the partition of `parent` bounded by `value`, or by DEFAULT when null. */
async function partitionOf(parent: string, value: string | null): Promise<string | undefined> {
  const bound = value === null ? 'DEFAULT' : `FOR VALUES IN ('${value.replace(/'/g, "''")}')`;
  const [row] = await sql<Array<{ relname: string }>>`
    SELECT c.relname FROM pg_inherits i
    JOIN pg_class c ON c.oid = i.inhrelid
    JOIN pg_class p ON p.oid = i.inhparent
    WHERE p.relname = ${parent} AND p.relnamespace = current_schema()::regnamespace
      AND pg_get_expr(c.relpartbound, c.oid) = ${bound}`;
  return row?.relname;
}

async function countIn(rel: string, ns: string, type: string): Promise<number> {
  const [row] = await sql.unsafe<Array<{ n: number }>>(
    `SELECT count(*)::int AS n FROM "${rel}" WHERE namespace = $1 AND type = $2`,
    [ns, type]
  );
  return row?.n ?? 0;
}

async function writeWithShortIds(ds: PgDataset, type: string, ids: string[]): Promise<void> {
  await ds.write(
    type,
    ids.map((id) => ({ id, title: id }))
  );
  for (const id of ids) await ds.bindShortId(type, await ds.allocateShortId(type), id);
}

describe.skipIf(!POSTGRES_URL || LAYOUT !== 'partitioned')(
  'ensureTypeStorage (partitioned)',
  () => {
    it('moves rows written before the type partition into it, keeping count and short ids', async () => {
      const ns = freshNs();
      const ds = new PgDataset({ namespace: ns, sql });
      await ds.ensureTypeStorage('Other');
      await writeWithShortIds(ds, 'T', ['a', 'b', 'c']);

      const nsPart = await partitionOf('rows', ns);
      expect(nsPart).toBeDefined();
      const nsDefault = await partitionOf(nsPart as string, null);
      expect(await countIn(nsDefault as string, ns, 'T')).toBe(3);
      const before = await ds.read('T', { orderBy: [{ id: 'asc' }] });
      expect(before.rows).toHaveLength(3);

      await ds.ensureTypeStorage('T');

      const typePart = await partitionOf(nsPart as string, 'T');
      expect(typePart).toBe(partitionName(ns, 'T'));
      expect(await countIn(typePart as string, ns, 'T')).toBe(3);
      expect(await countIn(nsDefault as string, ns, 'T')).toBe(0);
      const after = await ds.read('T', { orderBy: [{ id: 'asc' }] });
      expect(after.rows.map((r) => [r.id, r.shortId])).toEqual(
        before.rows.map((r) => [r.id, r.shortId])
      );
      expect(after.rows.every((r) => typeof r.shortId === 'number')).toBe(true);
    });

    it('creates the namespace partition and moves rows written before it, keeping short ids', async () => {
      const ns = freshNs();
      const ds = new PgDataset({ namespace: ns, sql });
      await writeWithShortIds(ds, 'T', ['a', 'b']);
      await writeWithShortIds(ds, 'U', ['x']);
      expect(await partitionOf('rows', ns)).toBeUndefined();
      expect(await countIn('rows__default', ns, 'T')).toBe(2);
      const before = await ds.read('T', { orderBy: [{ id: 'asc' }] });

      await ds.ensureTypeStorage('T');

      const nsPart = await partitionOf('rows', ns);
      expect(nsPart).toBe(partitionName(ns));
      expect(await countIn('rows__default', ns, 'T')).toBe(0);
      expect(await countIn('rows__default', ns, 'U')).toBe(0);
      expect(await countIn(partitionName(ns, 'T'), ns, 'T')).toBe(2);
      const nsDefault = await partitionOf(nsPart as string, null);
      expect(await countIn(nsDefault as string, ns, 'U')).toBe(1);

      const after = await ds.read('T', { orderBy: [{ id: 'asc' }] });
      expect(after.rows.map((r) => [r.id, r.shortId])).toEqual(
        before.rows.map((r) => [r.id, r.shortId])
      );
      expect((await ds.read('U', {})).rows.map((r) => r.shortId)).toEqual([expect.any(Number)]);
      const [sids] = await sql<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM short_ids WHERE namespace = ${ns}`;
      expect(sids?.n).toBe(3);
    });

    it('is idempotent: a second call creates nothing and moves nothing', async () => {
      const ns = freshNs();
      const ds = new PgDataset({ namespace: ns, sql });
      await ds.write('T', [{ id: 'a' }]);
      await ds.ensureTypeStorage('T');
      const relsBefore =
        await sql`SELECT relname FROM pg_class WHERE relname LIKE ${`%${ns}%`} ORDER BY 1`;
      await ds.ensureTypeStorage('T');
      const relsAfter =
        await sql`SELECT relname FROM pg_class WHERE relname LIKE ${`%${ns}%`} ORDER BY 1`;
      expect(relsAfter).toEqual(relsBefore);
      expect((await ds.read('T', {})).rows).toHaveLength(1);
    });

    it('loses and duplicates nothing under concurrent ensures and writes', async () => {
      const ns = freshNs();
      const ds = new PgDataset({ namespace: ns, sql });
      await ds.ensureTypeStorage('Other');
      await ds.write('T', [{ id: 'p0' }, { id: 'p1' }, { id: 'p2' }]);

      const writes = Array.from({ length: 50 }, (_, i) => ds.write('T', [{ id: `w${i}`, n: i }]));
      await Promise.all([
        ds.ensureTypeStorage('T'),
        ...writes.slice(0, 25),
        ds.ensureTypeStorage('T'),
        ...writes.slice(25)
      ]);

      const [row] = await sql<Array<{ n: number; d: number }>>`
      SELECT count(*)::int AS n, count(DISTINCT id)::int AS d FROM rows
      WHERE namespace = ${ns} AND type = 'T'`;
      expect(row).toEqual({ n: 53, d: 53 });
      expect((await ds.read('T', { limit: 1000 })).rows).toHaveLength(53);
      const nsPart = await partitionOf('rows', ns);
      expect(await countIn(partitionName(ns, 'T'), ns, 'T')).toBe(53);
      expect(await countIn((await partitionOf(nsPart as string, null)) as string, ns, 'T')).toBe(0);
    });

    it('never shows a reader a count other than before or after the move', async () => {
      const ns = freshNs();
      const ds = new PgDataset({ namespace: ns, sql });
      await ds.write(
        'T',
        Array.from({ length: 200 }, (_, i) => ({ id: `r${i}` }))
      );
      const readerSql = postgres(POSTGRES_URL as string, { max: 4 });
      const reader = new PgDataset({ namespace: ns, sql: readerSql });
      const seen = new Set<number>();
      let moving = true;
      const sample = (async () => {
        while (moving) {
          const { rows } = await reader.read('T', { limit: 1000 });
          seen.add(rows.length);
        }
      })();
      await ds.ensureTypeStorage('T');
      moving = false;
      await sample;
      await readerSql.end({ timeout: 5 });
      expect([...seen]).toEqual([200]);
    });

    it('warns about DEFAULT partitions holding rows until the move drains them', async () => {
      const ns = freshNs();
      const ds = new PgDataset({ namespace: ns, sql });
      await ds.write('T', [{ id: 'a' }, { id: 'b' }]);
      expect(await ds.storageWarnings()).toContain(`rows__default holds 2 rows of ${ns}/T`);
      await ds.ensureTypeStorage('T');
      expect((await ds.storageWarnings()).filter((w) => w.includes(ns))).toEqual([]);
    });

    it('finds partitions by bound, so colliding names never share or confuse a partition', async () => {
      // partitionName('default') is the root DEFAULT's name; ('a_','b') and ('a','_b') fold alike.
      const tag = randomBytes(3).toString('hex');
      const pairs: Array<[string, string]> = [
        ['default', 'T'],
        [`c${tag}_`, 'b'],
        [`c${tag}`, '_b']
      ];
      expect(partitionName(pairs[1]?.[0] as string, 'b')).toBe(
        partitionName(pairs[2]?.[0] as string, '_b')
      );
      for (const [ns, type] of pairs) {
        const ds = new PgDataset({ namespace: ns, sql });
        await ds.write(type, [{ id: `${ns}-1` }]);
        await ds.ensureTypeStorage(type);
      }
      const typeParts = new Set<string>();
      for (const [ns, type] of pairs) {
        const ds = new PgDataset({ namespace: ns, sql });
        expect((await ds.read(type, {})).rows.map((r) => r.id)).toEqual([`${ns}-1`]);
        const nsPart = await partitionOf('rows', ns);
        expect(nsPart).toBeDefined();
        expect(nsPart).not.toBe('rows__default');
        const typePart = await partitionOf(nsPart as string, type);
        expect(typePart).toBeDefined();
        expect(await countIn(typePart as string, ns, type)).toBe(1);
        typeParts.add(typePart as string);
        await ds.ensureTypeStorage(type);
      }
      expect(typeParts.size).toBe(3);
      expect(await partitionOf('rows', null)).toBe('rows__default');
    });
  }
);

describe.skipIf(!POSTGRES_URL || LAYOUT !== 'partitioned')('ensureTypeStorage lock waits', () => {
  it('never stalls other namespaces behind a move queued on an open transaction', async () => {
    const [other, moving, third] = [freshNs(), freshNs(), freshNs()];
    await new PgDataset({ namespace: other, sql }).ensureTypeStorage('T');
    await new PgDataset({ namespace: third, sql }).ensureTypeStorage('T');
    await new PgDataset({ namespace: third, sql }).write('T', [{ id: 'a' }]);
    const ds = new PgDataset({ namespace: moving, sql });
    await ds.write('T', [{ id: 'm' }]);

    const blocker = await sql.reserve();
    const readerSql = postgres(POSTGRES_URL as string, {
      max: 2,
      connection: { statement_timeout: 3000 }
    });
    try {
      await blocker`BEGIN`;
      await blocker`SELECT count(*) FROM rows WHERE namespace = ${other}`;
      // The namespace-level move needs ACCESS EXCLUSIVE on `rows`, which the blocker holds off.
      const ensured = ds.ensureTypeStorage('T');
      ensured.catch(() => {}); // awaited below; keeps an early failure from going unhandled
      const reader = new PgDataset({ namespace: third, sql: readerSql });
      const until = Date.now() + 1500;
      let slowest = 0;
      while (Date.now() < until) {
        const start = Date.now();
        expect((await reader.read('T', {})).rows).toHaveLength(1);
        slowest = Math.max(slowest, Date.now() - start);
      }
      expect(slowest).toBeLessThan(1500);
      await blocker`COMMIT`;
      await ensured;
      expect(await partitionOf('rows', moving)).toBe(partitionName(moving));
      expect((await ds.read('T', {})).rows.map((r) => r.id)).toEqual(['m']);
    } finally {
      blocker.release();
      await readerSql.end({ timeout: 5 });
    }
  });
});

describe.skipIf(!POSTGRES_URL || LAYOUT !== 'legacy')('ensureTypeStorage (legacy)', () => {
  it('is a no-op that creates nothing', async () => {
    const ns = freshNs();
    const ds = new PgDataset({ namespace: ns, sql });
    await ds.write('T', [{ id: 'a' }]);
    const before =
      await sql`SELECT count(*)::int AS n FROM pg_class WHERE relnamespace = current_schema()::regnamespace`;
    await ds.ensureTypeStorage('T');
    const after =
      await sql`SELECT count(*)::int AS n FROM pg_class WHERE relnamespace = current_schema()::regnamespace`;
    expect(after).toEqual(before);
    expect(await ds.storageWarnings()).toEqual([]);
    expect((await ds.read('T', {})).rows).toHaveLength(1);
  });
});

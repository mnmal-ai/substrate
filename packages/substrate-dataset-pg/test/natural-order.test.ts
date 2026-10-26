/**
 * Natural order over pg: a query with no `orderBy` reads in the type's
 * `orderedBy`, newest-first by `createdAt` when the type declares none. The
 * memory twin is substrate-core/test/natural-order.test.ts.
 *
 * The `defineNamespace` refusals need no database and always run.
 */

import { Engine, MemoryEdgesStore, type NamespaceConfig, Registry } from '@mnmal-ai/substrate-core';
import { MemoryDatasetRegistry } from '@mnmal-ai/substrate-dataset-memory';
import { defineNamespace, field, type TypeInput } from '@mnmal-ai/substrate-sdk';
import type { OrderedBy, Row, RowMetadata } from '@mnmal-ai/substrate-types';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../src/migrate.js';
import { PgDataset } from '../src/pg-dataset.js';

const POSTGRES_URL = process.env.POSTGRES_URL;
const NS = 'test_natural_order';

const fields = {
  boughtOn: field.date(),
  rating: field.number(),
  label: field.string()
};

describe('defineNamespace orderedBy', () => {
  const define = (orderedBy: OrderedBy) =>
    defineNamespace('shop', { Item: { fields, orderedBy } satisfies TypeInput });

  it('throws for an unknown field', () => {
    expect(() => define({ nope: 'asc' })).toThrow(/unknown field 'nope'/);
  });

  it('throws for more than one key', () => {
    expect(() => define({ boughtOn: 'asc', rating: 'desc' })).toThrow(/exactly one field/);
  });

  it('throws for a string field', () => {
    expect(() => define({ label: 'asc' })).toThrow(/field 'label' is string/);
  });

  it('accepts a date or number field and the createdAt / updatedAt columns', () => {
    for (const orderedBy of [
      { boughtOn: 'asc' },
      { rating: 'desc' },
      { createdAt: 'asc' },
      { updatedAt: 'desc' }
    ] as const) {
      expect(() => define(orderedBy)).not.toThrow();
    }
  });
});

describe.skipIf(!POSTGRES_URL)('natural order (pg)', () => {
  let sql: ReturnType<typeof postgres>;
  const statements: string[] = [];

  beforeAll(async () => {
    if (!POSTGRES_URL) return;
    sql = postgres(POSTGRES_URL, {
      onnotice: () => {},
      debug: (_conn, query) => void statements.push(query)
    });
    await runMigrations(sql);
  });

  beforeEach(async () => {
    await sql`DELETE FROM rows WHERE namespace = ${NS}`;
    statements.length = 0;
  });

  afterAll(async () => {
    if (!POSTGRES_URL) return;
    await sql`DELETE FROM rows WHERE namespace = ${NS}`;
    await sql.end();
  });

  function engineFor(orderedBy?: OrderedBy): { engine: Engine; ds: PgDataset } {
    const ds = new PgDataset({ namespace: NS, sql });
    const registry = new Registry();
    const edges = new MemoryEdgesStore({ now: () => new Date() });
    defineNamespace(NS, {
      Item: { fields, ...(orderedBy !== undefined ? { orderedBy } : {}) }
    }).install({ registry, dataset: ds, edges });
    const datasets = new MemoryDatasetRegistry();
    datasets.set(NS, ds);
    const engine = new Engine({
      namespaces: new Map<string, NamespaceConfig>([[NS, { registry }]]),
      datasets,
      edges
    });
    return { engine, ds };
  }

  async function page(
    engine: Engine,
    params: Record<string, unknown> = {}
  ): Promise<{ ids: string[]; hasMore: boolean; nextCursor?: string }> {
    const env = await engine.query({
      frame: { [`${NS}/Item`]: { params, fields: { id: true } } },
      ctx: { identity: null }
    });
    expect(env.errors).toBeUndefined();
    const pg = env._pagination?.[`${NS}/Item`];
    return {
      ids: (env.data[`${NS}/Item`] as Row[]).map((r) => String(r.id)),
      hasMore: pg?.hasMore === true,
      ...(typeof pg?.nextCursor === 'string' ? { nextCursor: pg.nextCursor } : {})
    };
  }

  const meta = (createdAt: string): RowMetadata => ({
    createdAt,
    updatedAt: createdAt,
    createdBy: null,
    updatedBy: null
  });

  it('reads newest-first by createdAt when no orderBy and no orderedBy', async () => {
    const { engine, ds } = engineFor();
    for (const [i, id] of ['a', 'b', 'c'].entries()) {
      await ds.write('Item', [{ id, _metadata: meta(`2026-10-25T00:00:0${i}.000Z`) }]);
    }
    expect((await page(engine)).ids).toEqual(['c', 'b', 'a']);
  });

  it('reads in the declared orderedBy', async () => {
    const { engine, ds } = engineFor({ boughtOn: 'asc' });
    await ds.write('Item', [
      { id: 'b', boughtOn: '2026-01-02T00:00:00.000Z' },
      { id: 'c', boughtOn: '2026-01-01T00:00:00.000Z' },
      { id: 'a', boughtOn: '2026-01-02T00:00:00.000Z' }
    ]);
    expect((await page(engine)).ids).toEqual(['c', 'a', 'b']);
  });

  it('an explicit orderBy wins and natural order is not added', async () => {
    const { engine, ds } = engineFor({ boughtOn: 'asc' });
    await ds.write('Item', [
      { id: 'a', rating: 1, boughtOn: '2026-01-01T00:00:00.000Z' },
      { id: 'c', rating: 5, boughtOn: '2026-01-03T00:00:00.000Z' },
      { id: 'b', rating: 5, boughtOn: '2026-01-02T00:00:00.000Z' }
    ]);
    statements.length = 0;
    expect((await page(engine, { orderBy: [{ rating: 'desc' }] })).ids).toEqual(['b', 'c', 'a']);

    // Every key the compiler emits ends `NULLS LAST`; one ORDER BY per line.
    const orderBys = statements
      .flatMap((q) => [...q.matchAll(/ORDER BY ([^\n]+)/g)])
      .map((m) =>
        (m[1] as string)
          .split(/NULLS LAST\s*,?/)
          .map((k) => k.trim())
          .filter((k) => k !== '')
      );
    expect(orderBys.length).toBeGreaterThan(0);
    for (const keys of orderBys) {
      expect(keys).toHaveLength(2);
      expect(keys[0]).toMatch(/(rating'|__sort_0).* DESC$/);
      expect(keys[1]).toMatch(/\bid ASC$/);
    }
  });

  it('rows missing the orderedBy field sort last and page exactly once', async () => {
    const { engine, ds } = engineFor({ boughtOn: 'asc' });
    const rows = Array.from({ length: 25 }, (_, i) => {
      const id = `r${String(i).padStart(2, '0')}`;
      return i % 5 === 0
        ? { id }
        : { id, boughtOn: `2026-01-${String(i + 1).padStart(2, '0')}T00:00:00.000Z` };
    });
    await ds.write('Item', rows);
    const missing = rows.filter((r) => !('boughtOn' in r)).map((r) => r.id);

    const walked: string[] = [];
    let cursor: string | undefined;
    for (let n = 0; n < 10; n++) {
      const got = await page(engine, { limit: 7, ...(cursor ? { cursor } : {}) });
      walked.push(...got.ids);
      if (!got.hasMore) break;
      cursor = got.nextCursor;
    }
    expect([...walked].sort()).toEqual(rows.map((r) => r.id));
    expect(new Set(walked).size).toBe(25);
    expect(walked.slice(-5)).toEqual(missing);
  });
});

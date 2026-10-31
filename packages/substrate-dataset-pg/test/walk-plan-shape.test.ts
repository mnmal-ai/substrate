/**
 * The plan shapes walks compile to (Todos #1812, #1813), on a few thousand
 * seeded rows: a pick, a latest/min aggregate and a nested latest-N list over
 * an indexed order are index-order probes that read a handful of neighbours,
 * never every neighbour of the hub. Each read is also differential against
 * the memory reference, with ties and nulls in the fixture.
 *
 * Assertions read `EXPLAIN (ANALYZE)`'s row counts per loop on the walk scans
 * (aliases `w<n>`, or `w<n>_<k>` on a partition), never costs, so a plan
 * choice between equivalent probes does not break them.
 */

import { createHash, randomBytes } from 'node:crypto';
import { MemoryDataset } from '@mnmal-ai/substrate-dataset-memory';
import type { FieldDef, IndexDecl, ReadParams } from '@mnmal-ai/substrate-types';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PgDataset } from '../src/index.js';
import { walkComparers } from './_walk-helpers.js';

const POSTGRES_URL = process.env.POSTGRES_URL;
const PARTITIONED = process.env.SUBSTRATE_TEST_LAYOUT === 'partitioned';
const NS = `wshape_${randomBytes(4).toString('hex')}`;

const num: FieldDef = { kind: 'scalar', type: 'number' };
const date: FieldDef = { kind: 'scalar', type: 'date' };
const ref = (type: string): FieldDef => ({ kind: 'crossRef', ns: NS, type, onDelete: 'set_null' });
const TYPES: Record<string, { fields: Record<string, FieldDef>; indexes?: IndexDecl[] }> = {
  Hub: { fields: { ask: num } },
  // One ascending and one descending (hub, order) index: a probe must use either.
  Nbr: {
    fields: { hub: ref('Hub'), at: date, price: num },
    indexes: [{ fields: ['hub', 'at'] }, { fields: ['hub', { field: 'price', dir: 'desc' }] }]
  }
};
const typeDef = (type: string) => (Object.hasOwn(TYPES, type) ? TYPES[type] : undefined);
const fieldDefLookup = (type: string, field: string): FieldDef | undefined => {
  const fields = typeDef(type)?.fields;
  return fields !== undefined && Object.hasOwn(fields, field) ? fields[field] : undefined;
};

const names = new Map<string, string>();
function u(name: string): string {
  const h = createHash('sha1').update(name).digest('hex');
  const id = `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
  names.set(id, name);
  return id;
}

/** Hubs h0–h7 hold 400 neighbours each, h8 6 with no `at` or price, h9 none. */
const PER_HUB = 400;
function fixture() {
  // Asks tie in threes and h9 has none, so a derived key ties and goes null.
  const hubs = Array.from({ length: 10 }, (_, h) => ({
    id: u(`h${h}`),
    ...(h === 9 ? {} : { ask: (h % 3) * 10 })
  }));
  const nbrs: Array<Record<string, unknown>> = [];
  for (let h = 0; h < 8; h++) {
    for (let i = 0; i < PER_HUB; i++) {
      // Two neighbours share each instant, and each price is held ~4 times: ties at the top.
      const at = new Date(Date.UTC(2026, 9, 1) + (i % 200) * 3_600_000).toISOString();
      nbrs.push({
        id: u(`n${h}_${i}`),
        hub: u(`h${h}`),
        ...(i % 37 === 0 ? {} : { at }),
        ...(i % 41 === 0 ? {} : { price: (i * 7) % 101 })
      });
    }
  }
  for (let i = 0; i < 6; i++) nbrs.push({ id: u(`n8_${i}`), hub: u('h8') });
  return { Hub: hubs, Nbr: nbrs };
}

let sql: Sql;
let pg: PgDataset;
let mem: MemoryDataset;
let sent: Array<{ query: string; parameters: unknown[]; types: number[] }> = [];
const { same } = walkComparers(
  () => ({ pg, mem }),
  (id) => names.get(id) ?? id
);

beforeAll(async () => {
  if (!POSTGRES_URL || !PARTITIONED) return;
  sql = postgres(POSTGRES_URL, { onnotice: () => {} });
  const traced = postgres(POSTGRES_URL, {
    onnotice: () => {},
    debug: (_c, query, parameters, types) => {
      sent.push({ query, parameters: parameters as unknown[], types: types as number[] });
    }
  });
  pg = new PgDataset({ namespace: NS, sql: traced, fieldDefLookup, typeDefLookup: typeDef });
  for (const type of Object.keys(TYPES)) await pg.ensureTypeStorage(type);
  mem = new MemoryDataset({ namespace: NS, fieldDefLookup, walkReference: true });
  for (const [type, rows] of Object.entries(fixture())) {
    await pg.write(type, rows as never);
    await mem.write(type, rows as never);
  }
  await sql`ANALYZE rows`;
}, 120_000);

afterAll(async () => {
  if (!POSTGRES_URL || !PARTITIONED) return;
  await sql`DELETE FROM rows WHERE namespace = ${NS}`;
  await sql.end({ timeout: 5 });
});

type PlanNode = Record<string, unknown> & { Plans?: PlanNode[] };
const nodes = (n: PlanNode): PlanNode[] => [n, ...(n.Plans ?? []).flatMap(nodes)];

/** `EXPLAIN (ANALYZE)` of the page statement the last read sent, as a custom plan. */
async function analyzed(): Promise<PlanNode[]> {
  const page = [...sent].reverse().find((s) => /FROM rows r/.test(s.query));
  if (page === undefined) throw new Error('no page statement was sent');
  const conn = await sql.reserve();
  try {
    const typeNames = await conn<Array<{ t: string }>>`
      SELECT CASE oid WHEN 0 THEN 'unknown' ELSE format_type(oid, NULL) END AS t
      FROM unnest(${page.types}::oid[]) WITH ORDINALITY u(oid, k) ORDER BY k`;
    const list = (xs: string[]) => (xs.length === 0 ? '' : `(${xs.join(', ')})`);
    const literals = page.parameters.map((p) => `'${String(p).replace(/'/g, "''")}'`);
    await conn.unsafe(`PREPARE shape_stmt${list(typeNames.map((n) => n.t))} AS ${page.query}`);
    await conn.unsafe('SET plan_cache_mode = force_custom_plan');
    const [row] = await conn.unsafe(
      `EXPLAIN (ANALYZE, FORMAT JSON) EXECUTE shape_stmt${list(literals)}`
    );
    const plan = (row as Record<string, Array<{ Plan: PlanNode }>>)['QUERY PLAN']?.[0]?.Plan;
    if (plan === undefined) throw new Error('no plan');
    return nodes(plan);
  } finally {
    await conn.unsafe('DEALLOCATE ALL');
    await conn.unsafe('RESET plan_cache_mode');
    conn.release();
  }
}

/** The walk table scans: the far rows a walk reads. */
const walkScans = (plan: PlanNode[]) =>
  plan.filter((n) => n['Relation Name'] !== undefined && /^w\d+(_\d+)?$/.test(String(n.Alias)));

/**
 * Reads `params` through both datasets, then asserts no walk scan read more
 * than `bound` rows per loop: those it returned plus those its filter removed,
 * so a scan of the neighbourhood that filters down to a few rows still fails.
 */
async function probes(params: ReadParams, bound: number): Promise<PlanNode[]> {
  sent = [];
  await same('Hub', { limit: 20, ...params });
  const plan = await analyzed();
  const scans = walkScans(plan);
  expect(scans.length).toBeGreaterThan(0);
  for (const s of scans) {
    expect(s['Node Type'], JSON.stringify(s)).not.toBe('Seq Scan');
    const read = Number(s['Actual Rows']) + Number(s['Rows Removed by Filter'] ?? 0);
    expect(read, JSON.stringify(s)).toBeLessThanOrEqual(bound);
  }
  return plan;
}

/** Every walk scan's loops, summed: how many times a read ran a neighbour lookup. */
const lookups = (plan: PlanNode[]) =>
  walkScans(plan).reduce((n, s) => n + Number(s['Actual Loops']), 0);

const IN = `${NS}/Nbr.hub`;
const HUBS = 10;

describe.skipIf(!POSTGRES_URL || !PARTITIONED)('walk plan shapes (pg)', () => {
  it('a pick is an index probe in either index direction, ties and nulls as memory', async () => {
    // Latest by `at` on the ascending index; max and min price on the descending one.
    for (const pick of [{ latest: 'at' }, { max: 'price' }, { min: 'price' }]) {
      for (const where of [undefined, { price: { gte: 50 } }]) {
        await probes(
          { where: { _walk: { in: IN, pick, ...(where === undefined ? {} : { where }) } } },
          8
        );
      }
    }
    // h8's neighbours have no `at`: its pick is the least id among the nulls.
    await probes(
      { where: { _walk: { in: IN, pick: { latest: 'at' }, where: { at: { eq: null } } } } },
      8
    );
  }, 60_000);

  it('a latest or date min/max aggregate is an index probe', async () => {
    await probes(
      {
        agg: {
          lp: { in: IN, latest: { by: 'at', value: 'price' } },
          first: { in: IN, min: 'at' },
          last: { in: IN, max: 'at' },
          top: { in: IN, latest: { by: 'price', value: 'at' } }
        }
      } as unknown as ReadParams,
      8
    );
  }, 60_000);

  it('a nested latest-N list on an index in its order reads N rows, not the neighbourhood', async () => {
    for (const limit of [1, 5]) {
      await probes(
        {
          nested: {
            top: {
              _walk: { in: IN },
              fields: { price: true, at: true },
              orderBy: [{ price: 'desc' }],
              limit
            }
          }
        } as unknown as ReadParams,
        // The look-ahead row, plus the ties at the cut (each price is held ~4 times).
        limit + 1 + 4
      );
    }
  }, 60_000);
  it('a filtered latest aggregate picks among the rows its where keeps', async () => {
    // The where drops each hub's top price and its newest rows: filter, then pick.
    await same('Hub', {
      agg: {
        cheap: { in: IN, where: { price: { lt: 90 } }, latest: { by: 'price', value: 'at' } },
        early: {
          in: IN,
          where: { at: { lt: '2026-10-05T00:00:00Z' } },
          latest: { by: 'at', value: 'price' }
        },
        none: { in: IN, where: { price: { gt: 1000 } }, latest: { by: 'at', value: 'price' } }
      }
    } as unknown as ReadParams);
  }, 60_000);

  it('nested lists at the cut, across tied keys, and inside a nested row', async () => {
    const list = (fields: Record<string, unknown>, orderBy: unknown[], limit: number) =>
      ({ top: { _walk: { in: IN }, fields, orderBy, limit } }) as unknown as NonNullable<
        ReadParams['nested']
      >;
    // h8 holds exactly 6: a limit of 6 is not cut there.
    const rows = await same('Hub', {
      limit: 20,
      nested: list({ price: true }, [{ at: 'desc' }], 6)
    });
    const h8 = rows.find((r) => names.get(String(r.id)) === 'h8');
    expect(h8?.top).toHaveLength(6);
    expect(h8).not.toHaveProperty('_truncated');
    // Ties on price straddle the cut; the second key and the id break them.
    for (const limit of [1, 3, 5]) {
      await same('Hub', {
        limit: 20,
        nested: list({ price: true, at: true }, [{ price: 'desc' }, { at: 'asc' }], limit)
      });
    }
    // A list in each listed row (back to the hub), itself cut.
    await same('Hub', {
      limit: 20,
      nested: list(
        {
          price: true,
          back: { _walk: { out: 'hub' }, fields: { ask: true }, limit: 1 },
          sib: { _walk: { out: 'hub' }, fields: {}, limit: 0 }
        },
        [{ price: 'desc' }],
        3
      )
    });
  }, 60_000);

  it('a cut nested list is read once per hub, not again for its _truncated flag', async () => {
    const plan = await probes(
      {
        nested: {
          top: {
            _walk: { in: IN },
            fields: { price: true },
            orderBy: [{ price: 'desc' }],
            limit: 2
          }
        }
      } as unknown as ReadParams,
      2 + 1 + 4
    );
    expect(lookups(plan)).toBeLessThanOrEqual(HUBS);
  }, 60_000);

  it('aggregates over one hop and where share one scan per hub', async () => {
    const where = { at: { gte: '2026-10-05T00:00:00Z' } };
    const plan = await probes(
      {
        agg: {
          n: { in: IN, where, count: true },
          avg: { in: IN, where, avg: 'price' },
          hi: { in: IN, where, max: 'price' },
          all: { in: IN, count: true }
        }
      } as unknown as ReadParams,
      PER_HUB
    );
    // One scan for the three windowed aggregates, one for the unwindowed count.
    expect(lookups(plan)).toBeLessThanOrEqual(2 * HUBS);
  }, 60_000);

  it('a derived order evaluates its operands once per matched row', async () => {
    const agg = { lp: { in: IN, latest: { by: 'at', value: 'price' } } };
    for (const dir of ['asc', 'desc'] as const) {
      const plan = await probes(
        {
          agg,
          derive: { m: { diff: ['_agg.lp', '$.ask'] } },
          orderBy: [{ $m: dir }],
          limit: 3
        } as unknown as ReadParams,
        8
      );
      // A pick is at most three probes (max, the rows at it, the null tail): once per hub
      // for the order, and once per hub at most for the projected `_agg`.
      expect(lookups(plan)).toBeLessThanOrEqual(2 * 3 * HUBS);
    }
  }, 60_000);
  it('one _agg mixing a pick with shared aggregates over different wheres', async () => {
    const early = { at: { lt: '2026-10-05T00:00:00Z' } };
    const late = { at: { gte: '2026-10-05T00:00:00Z' } };
    await same('Hub', {
      agg: {
        lp: { in: IN, latest: { by: 'at', value: 'price' } },
        n: { in: IN, count: true },
        // price is absent on some neighbours: sum and avg skip them, count does not.
        sum: { in: IN, sum: 'price' },
        en: { in: IN, where: early, count: true },
        eavg: { in: IN, where: early, avg: 'price' },
        ln: { in: IN, where: late, count: true },
        lhi: { in: IN, where: late, max: 'price' }
      }
    } as unknown as ReadParams);
  }, 60_000);

  it('derive pages agree with memory as a later key and beside a shortId join', async () => {
    const base = {
      agg: { lp: { in: IN, latest: { by: 'at', value: 'price' } } },
      derive: { m: { diff: ['_agg.lp', '$.ask'] } }
    };
    const variants = [
      { orderBy: [{ ask: 'desc' }, { $m: 'asc' }] },
      { orderBy: [{ $m: 'desc' }] },
      // A shortId key forces the short_ids join, where derive is inlined. Rows written
      // straight to a dataset have no shortId on either side, so it orders as a tie.
      { orderBy: [{ $m: 'asc' }, { shortId: 'asc' }] }
    ];
    for (const v of variants) {
      const params = { ...base, ...v } as unknown as ReadParams;
      const full = (await same('Hub', params)).map((r) => names.get(String(r.id)));
      for (const limit of [1, 3]) {
        const paged = async (ds: PgDataset | MemoryDataset) => {
          const ids: unknown[] = [];
          let cursor: string | undefined;
          do {
            const res = await ds.read('Hub', { ...params, limit, ...(cursor ? { cursor } : {}) });
            ids.push(...res.rows.map((r) => names.get(String(r.id))));
            cursor = res.nextCursor;
          } while (cursor !== undefined);
          return ids;
        };
        expect(await paged(pg), JSON.stringify(v)).toEqual(await paged(mem));
        expect(await paged(pg), JSON.stringify(v)).toEqual(full);
      }
    }
  }, 60_000);
});

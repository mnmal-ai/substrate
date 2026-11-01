/**
 * The plan shapes walks compile to (Todos #1812, #1813, #1815), on a few thousand
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
import type { FieldDef, IndexDecl, ReadParams, WhereClause } from '@mnmal-ai/substrate-types';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PgDataset } from '../src/index.js';
import { walkComparers } from './_walk-helpers.js';

const POSTGRES_URL = process.env.POSTGRES_URL;
const PARTITIONED = process.env.SUBSTRATE_TEST_LAYOUT === 'partitioned';
const NS = `wshape_${randomBytes(4).toString('hex')}`;

const num: FieldDef = { kind: 'scalar', type: 'number' };
const date: FieldDef = { kind: 'scalar', type: 'date' };
const indexedDate: FieldDef = { kind: 'scalar', type: 'date', indexed: true };
const ref = (type: string): FieldDef => ({ kind: 'crossRef', ns: NS, type, onDelete: 'set_null' });
const TYPES: Record<
  string,
  {
    fields: Record<string, FieldDef>;
    indexes?: IndexDecl[];
    orderedBy?: Record<string, 'asc' | 'desc'>;
  }
> = {
  Hub: { fields: { ask: num } },
  // Many seeds share each hub (#1815).
  Seed: { fields: { hub: ref('Hub'), ask: num } },
  // A window on an indexed date (#1815).
  Obs: { fields: { hub: ref('Hub'), at: indexedDate, price: num } },
  // A natural order with ties, served by the eager (hub, rank, id) index (#1821).
  Lst: { fields: { hub: ref('Hub'), rank: num }, orderedBy: { rank: 'asc' } },
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
  // SEEDS_PER_HUB seeds on every hub (h9's has no neighbours), five with no
  // hub and three on a hub that does not exist.
  const seeds: Array<Record<string, unknown>> = [];
  for (let h = 0; h < HUBS; h++) {
    for (let i = 0; i < SEEDS_PER_HUB; i++) {
      seeds.push({ id: u(`s${h}_${i}`), hub: u(`h${h}`), ask: (i % 5) * 20 });
    }
  }
  for (let i = 0; i < 5; i++) seeds.push({ id: u(`s_none_${i}`), ask: 0 });
  for (let i = 0; i < 3; i++) seeds.push({ id: u(`s_gone_${i}`), hub: u('h_gone'), ask: 0 });
  // h0–h7 hold 30 reads over 10 days, some without `at` or price; h8's are
  // all before the window; five in it have no hub.
  const obs: Array<Record<string, unknown>> = [];
  for (let h = 0; h < 8; h++) {
    for (let i = 0; i < 30; i++) {
      obs.push({
        id: u(`o${h}_${i}`),
        hub: u(`h${h}`),
        ...(i % 11 === 0 ? {} : { at: day(i % 10) }),
        ...(i % 7 === 0 ? {} : { price: (i * 13 + h) % 50 })
      });
    }
  }
  for (let i = 0; i < 4; i++) obs.push({ id: u(`o8_${i}`), hub: u('h8'), at: day(0), price: i });
  for (let i = 0; i < 5; i++) obs.push({ id: u(`o_none_${i}`), at: day(9), price: i });
  // Ranks tie in pairs; h8 holds 2, h9 none. As many per hub as Nbr's order of
  // magnitude, so the planner reads a hub's list by the index, not a seq scan.
  const lst: Array<Record<string, unknown>> = [];
  for (let h = 0; h < 9; h++) {
    for (let i = 0; i < (h === 8 ? 2 : LST_PER_HUB); i++) {
      lst.push({ id: u(`l${h}_${i}`), hub: u(`h${h}`), ...(i % 5 === 4 ? {} : { rank: i >> 1 }) });
    }
  }
  return { Hub: hubs, Nbr: nbrs, Seed: seeds, Obs: obs, Lst: lst };
}

const SEEDS_PER_HUB = 20;
const LST_PER_HUB = 200;
/** Midnight UTC `n` days after the first of the window's month. */
const day = (n: number) => new Date(Date.UTC(2026, 9, 20 + n)).toISOString();

let sql: Sql;
let pg: PgDataset;
let mem: MemoryDataset;
let sent: Array<{ query: string; parameters: unknown[]; types: number[] }> = [];
const { same, sameResult } = walkComparers(
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
const OBS = `${NS}/Obs.hub`;
const HUBS = 10;

/** The scans of one far type's rows: its partition, `rows__<ns>__<type>` folded, then hashed. */
const scansOf = (plan: PlanNode[], type: string) => {
  const partition = new RegExp(`__${type.toLowerCase()}(_[0-9a-f]{8})?$`);
  return walkScans(plan).filter((n) => partition.test(String(n['Relation Name'])));
};
/** Loops summed over a far type's scans: how many times the read looked it up. */
const loopsOf = (plan: PlanNode[], type: string) =>
  scansOf(plan, type).reduce((n, s) => n + Number(s['Actual Loops']), 0);

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

  it('a latest aggregate is one top-1 per hub, never a max() over its neighbours (#1819)', async () => {
    /** No Aggregate node reads a walk scan: a max(key) over the hub would. */
    const noNeighbourAggregate = (plan: PlanNode[]) => {
      for (const n of plan.filter((p) => p['Node Type'] === 'Aggregate')) {
        expect(walkScans(nodes(n)), JSON.stringify(n)).toHaveLength(0);
      }
    };
    // `at` on the ascending index (read backward), `price` on the descending one (forward).
    for (const [by, value] of [
      ['at', 'price'],
      ['price', 'at']
    ]) {
      const plan = await probes(
        { agg: { lp: { in: IN, latest: { by, value } } } } as unknown as ReadParams,
        8
      );
      noNeighbourAggregate(plan);
      // One probe per hub, plus the null tail where no key is present (h8, h9).
      // A max(key) and then the rows at it is two per hub.
      expect(lookups(plan)).toBeLessThanOrEqual(HUBS + 2);
    }
    // Inside derive: ordering every hub, then projecting the page's.
    for (const by of ['at', 'price']) {
      const plan = await probes(
        {
          agg: { lp: { in: IN, latest: { by, value: 'price' } } },
          derive: { m: { diff: ['_agg.lp', '$.ask'] } },
          orderBy: [{ $m: 'desc' }],
          limit: 3
        } as unknown as ReadParams,
        8
      );
      noNeighbourAggregate(plan);
      expect(lookups(plan)).toBeLessThanOrEqual(2 * (HUBS + 2));
    }
  }, 60_000);

  it('a latest aggregate keeps ties, nulls and the empty hub as memory, in both index directions', async () => {
    // Ties: two neighbours per instant, each price ~4 times. Nulls: some rows
    // lack `at` or price, and h8 has neither. Empty: h9.
    for (const by of ['at', 'price']) {
      const lp = { in: IN, latest: { by, value: by === 'at' ? 'price' : 'at' } };
      await same('Hub', { agg: { lp } } as unknown as ReadParams);
      // Only the null-keyed rows: the least id among them, on h8 and every hub.
      await same('Hub', {
        agg: { lp: { ...lp, where: { [by]: { eq: null } } } }
      } as unknown as ReadParams);
      // In derive, as an order: a numeric value, so the order is real.
      const num = { in: IN, latest: { by, value: 'price' } };
      for (const dir of ['asc', 'desc'] as const) {
        const rows = await same('Hub', {
          agg: { lp: num },
          derive: { m: { diff: ['_agg.lp', '$.ask'] } },
          orderBy: [{ $m: dir }]
        } as unknown as ReadParams);
        const m = rows.flatMap((r) => {
          const lp = (r._agg as Record<string, unknown> | undefined)?.lp;
          return typeof lp === 'number' && typeof r.ask === 'number' ? [lp - r.ask] : [];
        });
        expect(new Set(m).size, JSON.stringify(rows)).toBeGreaterThanOrEqual(2);
      }
      await same('Hub', {
        where: { _agg: { in: IN, latest: { by, value: 'price' } }, gte: 50 }
      } as unknown as ReadParams);
    }
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
      // A latest is one top-1 per hub, plus the null tail where no key is present
      // (h8, h9): once for the order, and at most once more for the projected `_agg`.
      expect(lookups(plan)).toBeLessThanOrEqual(2 * (HUBS + 2));
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

  describe('#1815: shared forms', () => {
    const shared = (pick: Record<string, unknown>, where?: unknown) => ({
      _walk: {
        out: 'hub',
        where: { _walk: { in: IN, pick, ...(where === undefined ? {} : { where }) } }
      }
    });
    const overAsk = { price: { gte: { $ref: '$.ask' } } };

    it('a pick many seeds share is probed once per hub, not once per seed', async () => {
      sent = [];
      const { count } = await sameResult('Seed', {
        count: true,
        where: shared({ latest: 'at' }, overAsk) as WhereClause
      });
      expect(count).toBeGreaterThan(0);
      expect(count).toBeLessThan(HUBS * SEEDS_PER_HUB);
      const plan = await analyzed();
      // Per hub (h0–h9, the missing one and no hub): the max probe, the rows at it,
      // and only where neither has a key, the null tail. Per seed it would be 200+.
      expect(loopsOf(plan, 'Nbr')).toBeGreaterThan(0);
      expect(loopsOf(plan, 'Nbr')).toBeLessThanOrEqual(3 * (HUBS + 2));
      for (const s of scansOf(plan, 'Nbr')) expect(s['Node Type']).not.toBe('Seq Scan');
    }, 60_000);

    it('a shared pick answers as memory: seeds with no hub, a hub with no neighbours, ties and nulls', async () => {
      for (const pick of [{ latest: 'at' }, { max: 'price' }, { min: 'price' }]) {
        for (const where of [undefined, overAsk, { at: { eq: null } }]) {
          const w = shared(pick, where) as WhereClause;
          for (const params of [
            { count: true, where: w },
            // With a plain seed conjunct, which narrows the hubs computed.
            { count: true, where: { AND: [{ ask: { gte: 40 } }, w] } as WhereClause },
            // A page of every seed, and one of a few (the per-seed form).
            { where: w },
            { where: w, limit: 7 }
          ] as ReadParams[]) {
            if (params.count === true) await sameResult('Seed', params);
            else await same('Seed', params);
          }
        }
      }
      // A hub with no neighbours (h9), or none at all: no pick, so no match, and none passes `none`.
      const rows = await same('Seed', { where: shared({ latest: 'at' }) as WhereClause });
      const hit = new Set(rows.map((r) => String(names.get(String(r.id)))));
      expect([...hit].some((n) => /^s(9|_none|_gone)/.test(n))).toBe(false);
      expect(hit.has('s0_0')).toBe(true);
    }, 120_000);

    it('a shared pick answers as memory beside other conjuncts, binds, a second pick and other quantifiers', async () => {
      const pAt = { _walk: { in: IN, pick: { latest: 'at' }, where: overAsk } };
      const pMax = {
        _walk: { in: IN, pick: { max: 'price' }, where: { at: { gte: '2026-10-05T00:00:00Z' } } }
      };
      const hubWalk = (where: unknown, extra: Record<string, unknown> = {}) => ({
        _walk: { out: 'hub', where, ...extra }
      });
      const wheres = [
        // The hub where's other conjuncts: a bind and the comparison reading it.
        hubWalk({
          AND: [
            { _walk: { in: IN, as: 'n', where: { price: { gte: 40 } } } },
            { ask: { lte: { $ref: 'n.price' } } },
            pAt
          ]
        }),
        // Two picks of one hub.
        hubWalk({ AND: [pAt, pMax] }),
        // Not shared: none and all.
        hubWalk(pAt, { quantifier: 'none' }),
        hubWalk(pAt, { quantifier: 'all' }),
        // A selective non-plain seed conjunct narrows the hubs computed.
        { AND: [{ _walk: { out: 'hub', where: { ask: { gte: 10 } } } }, hubWalk(pAt)] },
        { AND: [{ _agg: { out: 'hub', count: true }, gte: 1 }, hubWalk(pMax)] },
        // A seed-level bind, and the comparison reading it, stay out of the hub filter.
        {
          AND: [
            { _walk: { out: 'hub', as: 'H' } },
            { ask: { lte: { $ref: 'H.ask' } } },
            hubWalk(pAt)
          ]
        }
      ] as unknown as WhereClause[];
      for (const where of wheres) {
        await sameResult('Seed', { count: true, where });
        await same('Seed', { where });
      }
    }, 120_000);

    it('a cursor chain whose limit, and so form, changes between pages agrees with memory', async () => {
      const where = shared({ latest: 'at' }, overAsk) as WhereClause;
      const chain = async (ds: PgDataset | MemoryDataset, limits: number[]) => {
        const ids: unknown[] = [];
        let cursor: string | undefined;
        let i = 0;
        do {
          const limit = limits[i++ % limits.length] as number;
          const res = await ds.read('Seed', { where, limit, ...(cursor ? { cursor } : {}) });
          ids.push(...res.rows.map((r) => names.get(String(r.id))));
          cursor = res.nextCursor;
        } while (cursor !== undefined);
        return ids;
      };
      // 7 is per seed, 2000 per hub; the cursor carries over.
      for (const limits of [[7, 2000], [2000], [7]]) {
        expect(await chain(pg, limits)).toEqual(await chain(mem, limits));
      }
    }, 120_000);

    const window = { at: { gte: day(7) } };
    const windowRead = (w: Record<string, unknown> = window, extra: Record<string, unknown> = {}) =>
      ({
        where: { _walk: { in: OBS, where: w } },
        agg: {
          n: { in: OBS, where: w, count: true },
          avg: { in: OBS, where: w, avg: 'price' },
          sum: { in: OBS, where: w, sum: 'price' },
          hi: { in: OBS, where: w, max: 'price' }
        },
        ...extra
      }) as unknown as ReadParams;

    it('a frame _agg over its seeds window is one aggregate pass, not one per seed', async () => {
      sent = [];
      const rows = await same('Hub', windowRead());
      expect(rows.length).toBeGreaterThan(1);
      const plan = await analyzed();
      // The window CTE reads Obs once; per seed it is a semi-join scan plus one scan per hub.
      expect(loopsOf(plan, 'Obs')).toBe(1);
    }, 60_000);

    it('a window answers as memory: empty, null keys and dates, under NOT, bounded, paged', async () => {
      // Nothing in the window: no seed, and nothing to join.
      expect(await same('Hub', windowRead({ at: { gte: day(30) } }))).toEqual([]);
      // A closed window, and one holding the hubless and the undated reads' instants.
      await same('Hub', windowRead({ at: { gte: day(2), lt: day(5) } }));
      await same('Hub', windowRead({ at: { lte: day(9) } }));
      // The window's walk again under NOT: `id IN` its keys must stay two-valued.
      const w = { _walk: { in: OBS, where: window } };
      await same('Hub', {
        ...windowRead(),
        where: { AND: [w, { OR: [{ NOT: w }, { ask: { gte: 10 } }] }] }
      } as unknown as ReadParams);
      // A page over the max page (group-by) and a page of three (per seed), with a cursor.
      await same('Hub', windowRead(window, { limit: 2000 }));
      for (const limit of [3, 2000]) {
        const paged = async (ds: PgDataset | MemoryDataset) => {
          const ids: unknown[] = [];
          let cursor: string | undefined;
          do {
            const res = await ds.read('Hub', {
              ...windowRead(window, { limit }),
              ...(cursor ? { cursor } : {})
            });
            ids.push(...res.rows.map((r) => [names.get(String(r.id)), r._agg]));
            cursor = res.nextCursor;
          } while (cursor !== undefined);
          return ids;
        };
        expect(await paged(pg)).toEqual(await paged(mem));
      }
      // `ids` and a plain conjunct narrow the window's keys to the seeds.
      await same('Hub', { ...windowRead(), ids: [u('h0'), u('h3'), u('h8')] });
      await same('Hub', {
        ...windowRead(),
        where: { AND: [{ ask: { gte: 10 } }, { _walk: { in: OBS, where: window } }] }
      } as unknown as ReadParams);
      // Beside a per-seed pick and a `$ref` aggregate over the same window.
      await same('Hub', {
        ...windowRead(),
        agg: {
          ...(windowRead().agg ?? {}),
          last: { in: OBS, where: window, latest: { by: 'at', value: 'price' } },
          over: { in: OBS, where: { ...window, price: { gte: { $ref: '$.ask' } } }, count: true }
        }
      } as unknown as ReadParams);
    }, 120_000);
  });

  describe("#1821: a nested list in its far type's natural order", () => {
    const natural = (limit: number) =>
      ({
        top: {
          _walk: { in: `${NS}/Lst.hub` },
          fields: { rank: true },
          // What the engine gives a list with no orderBy.
          orderBy: [{ rank: 'asc' }],
          limit
        }
      }) as unknown as NonNullable<ReadParams['nested']>;

    it('ties break by id, and the cut and _truncated agree with memory', async () => {
      for (const limit of [1, 2, 3, 12, LST_PER_HUB, LST_PER_HUB + 1]) {
        const rows = await same('Hub', { nested: natural(limit) });
        const h0 = rows.find((r) => names.get(String(r.id)) === 'h0');
        expect(h0?.top).toHaveLength(Math.min(limit, LST_PER_HUB));
      }
    }, 60_000);

    it('reads its rows through the eager (crossRef, natural order, id) index', async () => {
      // The look-ahead row, plus the tie at the cut, plus the unranked rows sorted last.
      await probes({ nested: natural(3) } as unknown as ReadParams, 3 + 1 + 1 + 3);
    }, 60_000);
  });
});

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
  const hubs = Array.from({ length: 10 }, (_, h) => ({ id: u(`h${h}`), ask: h * 10 }));
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

/** The walk scans: the far rows a walk reads. */
const walkScans = (plan: PlanNode[]) =>
  plan.filter((n) => /Scan/.test(String(n['Node Type'])) && /^w\d+(_\d+)?$/.test(String(n.Alias)));

/** Reads `params` through both datasets, then asserts no walk scan read more than `bound` rows per loop. */
async function probes(params: ReadParams, bound: number): Promise<PlanNode[]> {
  sent = [];
  await same('Hub', { limit: 20, ...params });
  const plan = await analyzed();
  const scans = walkScans(plan);
  expect(scans.length).toBeGreaterThan(0);
  for (const s of scans) {
    expect(s['Node Type'], JSON.stringify(s)).not.toBe('Seq Scan');
    expect(Number(s['Actual Rows']), JSON.stringify(s)).toBeLessThanOrEqual(bound);
  }
  return plan;
}

const IN = `${NS}/Nbr.hub`;

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
});

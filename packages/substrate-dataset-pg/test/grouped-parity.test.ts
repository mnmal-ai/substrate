/**
 * Grouped reads (`groupBy`, `countDistinct`, `having`, `offset`, expression
 * aggregates): memory and pg return the same groups through the engine.
 */

import { Engine, MemoryEdgesStore, type NamespaceConfig, Registry } from '@mnmal-ai/substrate-core';
import { MemoryDataset, MemoryDatasetRegistry } from '@mnmal-ai/substrate-dataset-memory';
import { defineNamespace, field } from '@mnmal-ai/substrate-sdk';
import type { Dataset, FieldDef, Identity } from '@mnmal-ai/substrate-types';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../src/migrate.js';
import { PgDataset } from '../src/pg-dataset.js';
import { dropNamespace } from './_layout.js';

const POSTGRES_URL = process.env.POSTGRES_URL;
const NS = 'test_grouped';

const hit: Record<string, FieldDef> = {
  region: field.number({ nullable: true }),
  user: field.int64({ nullable: true }),
  phrase: field.string({ nullable: true }),
  w: field.number({ nullable: true }),
  at: field.date({ nullable: true })
};
const lookup = (type: string, f: string): FieldDef | undefined =>
  type === 'Hit' ? hit[f] : undefined;

const WRITER: Identity = { kind: 'system', id: 'test', grants: { '*': ['read', 'mutate'] } };
const MAX = '9223372036854775807';

function engineOver(ds: Dataset): Engine {
  const registry = new Registry();
  const edges = new MemoryEdgesStore({ now: () => new Date() });
  defineNamespace(NS, { Hit: { fields: hit } }).install({ registry, dataset: ds, edges });
  const datasets = new MemoryDatasetRegistry();
  datasets.set(NS, ds);
  return new Engine({
    namespaces: new Map<string, NamespaceConfig>([[NS, { registry }]]),
    datasets,
    edges
  });
}

const PHRASES = ['', 'foo', 'bar', 'foobar', 'aaab', null];
function rows(): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (let i = 0; i < 200; i++) {
    out.push({
      region: i % 7,
      user: `${9007199254740993n + BigInt(i % 13)}`,
      phrase: PHRASES[i % 6],
      w: i % 11 === 0 ? null : ((i * 37) % 101) / 4,
      at: `2024-01-${String((i % 28) + 1).padStart(2, '0')}T${String(i % 24).padStart(2, '0')}:00:00.${String(i % 1000).padStart(3, '0')}${i % 7}56Z`
    });
  }
  // A group whose aggregated columns are all null.
  for (let i = 0; i < 3; i++) out.push({ region: 99, phrase: 'x' });
  // Three identical int64 values past 2^53: their avg must round the same on both.
  for (let i = 0; i < 3; i++) out.push({ region: 97, user: '15011998757901659' });
  // Two int64 values at the top of the range, in a group of their own.
  for (let i = 0; i < 2; i++) out.push({ region: 98, user: MAX });
  return out;
}

async function seed(engine: Engine): Promise<void> {
  const env = await engine.mutate({
    frame: {
      [`${NS}/createHit`]: rows().map((params) => ({ params, fields: { id: true } }))
    },
    ctx: { identity: WRITER }
  });
  expect(env.errors).toBeUndefined();
}

interface Out {
  groups?: Array<Record<string, unknown>>;
  truncated?: boolean;
  errors?: Array<{ code?: string; message: string }>;
}
async function read(engine: Engine, params: Record<string, unknown>): Promise<Out> {
  const env = await engine.query({
    frame: { [`${NS}/Hit`]: { params, fields: { id: true } } },
    ctx: { identity: null }
  });
  const data = env.data[`${NS}/Hit`] as Out | undefined;
  return {
    ...(data ?? {}),
    ...(env.errors ? { errors: env.errors as never } : {})
  };
}

/** Float avg/sum may differ in the last bits between engines: equal within 1e-12 relative. */
function closeTo(a: unknown, b: unknown): void {
  if (typeof a === 'number' && typeof b === 'number') {
    expect(Math.abs(a - b) <= 1e-12 * Math.max(Math.abs(a), Math.abs(b))).toBe(true);
  } else expect(a).toEqual(b);
}

const cnt = { c: { count: true } };

describe('grouped reads on memory and pg', () => {
  let sql: ReturnType<typeof postgres> | undefined;
  const engines: Array<[string, Engine]> = [];
  let sorted: ReturnType<typeof postgres> | undefined;
  let streaming: Engine | undefined;

  beforeAll(async () => {
    const memory = engineOver(
      new MemoryDataset({ namespace: NS, fieldDefLookup: lookup, walkReference: true })
    );
    await seed(memory);
    engines.push(['memory', memory]);
    if (!POSTGRES_URL) return;
    sql = postgres(POSTGRES_URL, { onnotice: () => {} });
    await runMigrations(sql);
    await dropNamespace(sql, NS);
    const pg = engineOver(
      new PgDataset({
        namespace: NS,
        sql,
        fieldDefLookup: lookup,
        typeDefLookup: () => ({ fields: hit })
      })
    );
    await seed(pg);
    engines.push(['pg', pg]);
    // The same store through a connection that cannot hash-aggregate: groups then
    // stream out of a GroupAggregate, and a LIMIT stops pulling them early.
    sorted = postgres(POSTGRES_URL, {
      onnotice: () => {},
      connection: { enable_hashagg: 'off' } as Record<string, string>
    });
    streaming = engineOver(
      new PgDataset({
        namespace: NS,
        sql: sorted,
        fieldDefLookup: lookup,
        typeDefLookup: () => ({ fields: hit })
      })
    );
  });

  afterAll(async () => {
    if (sql === undefined) return;
    await dropNamespace(sql, NS);
    await sorted?.end({ timeout: 5 });
    await sql.end();
  });

  /** Runs `params` on every engine; the groups agree (`approx` outputs within 1e-12). */
  async function same(params: Record<string, unknown>, approx: string[] = []): Promise<Out> {
    const [first, ...rest] = await Promise.all(engines.map(([, e]) => read(e, params)));
    expect(first?.errors).toBeUndefined();
    for (const o of rest) {
      expect(o.errors).toBeUndefined();
      expect(o.truncated).toEqual(first?.truncated);
      expect(o.groups?.length).toBe(first?.groups?.length);
      (o.groups ?? []).forEach((g, i) => {
        const f = (first?.groups ?? [])[i] ?? {};
        for (const k of Object.keys(f)) {
          if (approx.includes(k)) closeTo(g[k], f[k]);
          else expect(g[k], k).toEqual(f[k]);
        }
        expect(Object.keys(g).sort()).toEqual(Object.keys(f).sort());
      });
    }
    return first as Out;
  }

  it('query 7: a filtered count', async () => {
    const out = await same({ where: { region: { neq: 0 } }, aggregate: cnt });
    expect(out.groups).toEqual([{ c: 179 }]);
  });

  it('query 8: group by a field, ordered by an aggregate', async () => {
    const out = await same({
      groupBy: { region: 'region' },
      aggregate: cnt,
      orderBy: [{ c: 'desc' }],
      limit: 10
    });
    expect(out.groups?.[0]?.c).toBeGreaterThanOrEqual(out.groups?.[1]?.c as number);
  });

  it('query 9: countDistinct over an int64 with sum and avg', async () => {
    const out = await same(
      {
        groupBy: { region: 'region' },
        aggregate: {
          s: { sum: 'w' },
          c: { count: true },
          a: { avg: 'w' },
          u: { countDistinct: 'user' }
        },
        orderBy: [{ u: 'desc' }],
        limit: 10
      },
      ['s', 'a']
    );
    expect(out.groups?.length).toBeGreaterThan(3);
  });

  it('query 13: countDistinct by a string key, filtered', async () => {
    await same({
      where: { phrase: { neq: '' } },
      groupBy: { phrase: 'phrase' },
      aggregate: { u: { countDistinct: 'user' } },
      orderBy: [{ u: 'desc' }],
      limit: 10
    });
  });

  it('query 15: group by an int64', async () => {
    const out = await same({
      groupBy: { user: 'user' },
      aggregate: cnt,
      orderBy: [{ c: 'desc' }],
      limit: 10
    });
    expect(typeof out.groups?.[0]?.user).toBe('bigint');
  });

  it('query 18: two keys with no order is a valid shape, not a fixed answer', async () => {
    const outs = await Promise.all(
      engines.map(([, e]) =>
        read(e, { groupBy: { user: 'user', phrase: 'phrase' }, aggregate: cnt, limit: 10 })
      )
    );
    for (const o of outs) {
      expect(o.errors).toBeUndefined();
      expect(o.groups).toHaveLength(10);
      expect(Object.keys(o.groups?.[0] ?? {}).sort()).toEqual(['c', 'phrase', 'user']);
    }
  });

  it('query 27: avg of a function, having and order by an aggregate', async () => {
    const out = await same(
      {
        groupBy: { region: 'region' },
        aggregate: { l: { avg: { length: ['phrase'] } }, c: { count: true } },
        having: { gt: ['c', 5] },
        orderBy: [{ l: 'desc' }],
        limit: 25
      },
      ['l']
    );
    expect(out.groups?.every((g) => (g.c as number) > 5)).toBe(true);
  });

  it('query 28: group by a regexp replacement', async () => {
    await same(
      {
        groupBy: { k: { regexpReplace: ['phrase', { lit: '^(f)o+.*$' }, { lit: '\\1' }] } },
        aggregate: { l: { avg: { length: ['phrase'] } }, c: { count: true } },
        orderBy: [{ l: 'desc' }],
        limit: 25
      },
      ['l']
    );
  });

  it('query 35: a constant key beside a field', async () => {
    await same({
      groupBy: { one: 1, phrase: 'phrase' },
      aggregate: cnt,
      orderBy: [{ c: 'desc' }],
      limit: 10
    });
  });

  it('groups by a date truncation and orders by default (keys ascending)', async () => {
    const out = await same({
      groupBy: { day: { dateTrunc: [{ lit: 'day' }, 'at'] }, region: 'region' },
      aggregate: { mn: { min: 'at' }, mx: { max: 'at' } },
      limit: 1000
    });
    expect(out.groups?.[0]?.mn).toMatch(/\.\d{6}Z$/);
  });

  it('offset 3, limit 2 slices the same groups and says truncated', async () => {
    const out = await same({ groupBy: { region: 'region' }, aggregate: cnt, offset: 3, limit: 2 });
    expect(out.groups).toHaveLength(2);
    expect(out.truncated).toBe(true);
  });

  it('offset past the end is no groups, and an empty read has none', async () => {
    const past = await same({
      groupBy: { region: 'region' },
      aggregate: cnt,
      offset: 500,
      limit: 5
    });
    expect(past.groups).toEqual([]);
    const none = await same({
      where: { region: { eq: -1 } },
      groupBy: { region: 'region' },
      aggregate: cnt
    });
    expect(none.groups).toEqual([]);
  });

  it('an ungrouped aggregate over no rows is one group', async () => {
    const out = await same({
      where: { region: { eq: -1 } },
      aggregate: { c: { count: true }, s: { sum: 'user' }, d: { countDistinct: 'phrase' } }
    });
    expect(out.groups).toEqual([{ c: 0, s: null, d: 0 }]);
  });

  it('an all-null group: count 0, sum/avg/min/max null', async () => {
    const out = await same({
      where: { region: { eq: 99 } },
      groupBy: { region: 'region' },
      aggregate: {
        c: { count: true },
        cnt: { count: 'w' },
        s: { sum: 'w' },
        a: { avg: 'w' },
        mn: { min: 'w' },
        mx: { max: 'w' },
        d: { countDistinct: 'w' }
      }
    });
    expect(out.groups).toEqual([
      { region: 99, c: 3, cnt: 0, s: null, a: null, mn: null, mx: null, d: 0 }
    ]);
  });

  it('having drops the same groups, on an aggregate or a key, and one not otherwise used', async () => {
    const all = await same({ groupBy: { region: 'region' }, aggregate: cnt });
    const kept = await same({
      groupBy: { region: 'region' },
      aggregate: { c: { count: true }, m: { max: 'w' } },
      having: { and: [{ gt: ['c', 5] }, { neq: ['region', 99] }] }
    });
    expect((kept.groups?.length ?? 0) < (all.groups?.length ?? 0)).toBe(true);
  });

  it('int64 sum is exact; past the range it raises the same code on both', async () => {
    const exact = await same({
      where: { region: { eq: 0 } },
      aggregate: { s: { sum: 'user' }, a: { avg: 'user' } }
    });
    expect(typeof exact.groups?.[0]?.s).toBe('bigint');
    const outs = await Promise.all(
      engines.map(([, e]) =>
        read(e, { where: { region: { eq: 98 } }, aggregate: { s: { sum: 'user' } } })
      )
    );
    for (const o of outs) {
      expect(o.errors?.[0]?.code).toBe('value_out_of_range');
      expect(o.errors?.[0]?.message).toContain('bigint out of range');
    }
    expect(new Set(outs.map((o) => o.errors?.[0]?.code)).size).toBe(1);
  });

  it('int64 avg is float8(exact sum) / count: identical on both engines', async () => {
    const out = await same({
      where: { region: { eq: 97 } },
      aggregate: { a: { avg: 'user' } }
    });
    expect(out.groups).toEqual([{ a: Number(3n * 15011998757901659n) / 3 }]);
  });

  it('an int64 overflow raises even when having drops that group', async () => {
    const outs = await Promise.all(
      engines.map(([, e]) =>
        read(e, {
          where: { region: { in: [0, 98] } },
          groupBy: { region: 'region' },
          aggregate: { s: { sum: 'user' } },
          having: { neq: ['region', 98] },
          limit: 1
        })
      )
    );
    for (const o of outs) {
      expect(o.errors?.[0]?.code).toBe('value_out_of_range');
      expect(o.errors?.[0]?.message).toBe('bigint out of range');
    }
  });

  it('an ungrouped date min/max is the canonical microsecond text on both', async () => {
    const out = await same({ aggregate: { mn: { min: 'at' }, mx: { max: 'at' } } });
    expect(out.groups?.[0]?.mn).toMatch(/\.\d{6}Z$/);
    expect(out.groups?.[0]?.mx).toMatch(/\.\d{6}Z$/);
  });

  it('refuses count of a non-true literal, and a group key that is only null', async () => {
    for (const params of [
      { aggregate: { c: { count: 1 } } },
      { aggregate: { c: { count: false } } },
      { groupBy: { k: null }, aggregate: cnt }
    ]) {
      for (const [, e] of engines) {
        const o = await read(e, params);
        expect(o.errors, JSON.stringify(params)).toBeDefined();
      }
    }
  });

  it('an int64 overflow in the last group raises even when LIMIT is reached first', async () => {
    // Groups 0, 1 and 98 ascending: 98 overflows and sorts last, so limit 1 (LIMIT 2) never pulls it.
    const params = {
      where: { region: { in: [0, 1, 98] } },
      groupBy: { region: 'region' },
      aggregate: { s: { sum: 'user' } },
      limit: 1
    };
    const outs = await Promise.all(
      [...engines.map(([, e]) => e), ...(streaming ? [streaming] : [])].map((e) => read(e, params))
    );
    for (const o of outs) expect(o.errors?.[0]?.code).toBe('value_out_of_range');
    // The same through int64 arithmetic in an aggregate argument.
    const arith = await Promise.all(
      [...engines.map(([, e]) => e), ...(streaming ? [streaming] : [])].map((e) =>
        read(e, {
          where: { region: { in: [0, 1, 98] } },
          groupBy: { region: 'region' },
          aggregate: { m: { max: { add: ['user', 1] } } },
          limit: 1
        })
      )
    );
    for (const o of arith) expect(o.errors?.[0]?.code).toBe('value_out_of_range');
  });

  it('a float overflow in a group key raises the same code and message on both', async () => {
    const outs = await Promise.all(
      engines.map(([, e]) =>
        read(e, {
          where: { w: { gt: 20 } },
          groupBy: { k: { mul: ['w', 1e307] } },
          aggregate: cnt,
          limit: 1
        })
      )
    );
    for (const o of outs) {
      expect(o.errors?.[0]?.code).toBe('value_out_of_range');
      expect(o.errors?.[0]?.message).toBe('value out of range: overflow');
    }
  });

  it('having arithmetic raises for every group, even past a LIMIT', async () => {
    // Groups 0, 1 and 98 ascending; 98's max is 2^63-1, so m + 1 overflows and sorts last.
    const params = {
      where: { region: { in: [0, 1, 98] } },
      groupBy: { region: 'region' },
      aggregate: { m: { max: 'user' } },
      having: { gt: [{ add: ['m', 1] }, 0] },
      limit: 1
    };
    const outs = await Promise.all(
      [...engines.map(([, e]) => e), ...(streaming ? [streaming] : [])].map((e) => read(e, params))
    );
    // memory, plus pg and pg without hash aggregation (groups stream out under the LIMIT) when pg runs.
    expect(outs).toHaveLength(streaming ? 3 : 1);
    for (const o of outs) {
      expect(o.errors?.[0]?.code).toBe('value_out_of_range');
      expect(o.errors?.[0]?.message).toBe('bigint out of range');
    }
  });

  it('min and max of a metadata date work with and without groupBy', async () => {
    // Each engine stamps its own createdAt, so the values differ; the shape and form must not.
    for (const params of [
      { aggregate: { lo: { min: 'createdAt' }, hi: { max: 'updatedAt' } } },
      { groupBy: { region: 'region' }, aggregate: { lo: { min: 'createdAt' } }, limit: 3 }
    ]) {
      const outs = await Promise.all(engines.map(([, e]) => read(e, params)));
      for (const o of outs) {
        expect(o.errors).toBeUndefined();
        expect(o.groups?.[0]?.lo).toMatch(/^\d{4}-\d\d-\d\dT[\d:]+\.\d{6}Z$/);
      }
      for (const o of outs) expect(o.groups?.length).toBe(outs[0]?.groups?.length);
    }
  });

  it('a metadata date is a usable aggregate argument with groupBy; count of a lit/int64 is refused', async () => {
    const rows = await Promise.all(
      engines.map(([, e]) =>
        read(e, {
          groupBy: { region: 'region' },
          aggregate: { lo: { min: 'createdAt' }, n: { count: true } },
          limit: 3
        })
      )
    );
    for (const o of rows) {
      expect(o.errors).toBeUndefined();
      expect(o.groups).toHaveLength(3);
    }
    for (const params of [
      { aggregate: { c: { count: { lit: 'x' } } } },
      { aggregate: { c: { count: { int64: '1' } } } }
    ]) {
      for (const [, e] of engines) {
        expect((await read(e, params)).errors, JSON.stringify(params)).toBeDefined();
      }
    }
  });

  it('refuses a group name that is also an aggregate name, and orderBy off the outputs', async () => {
    for (const params of [
      { groupBy: { c: 'region' }, aggregate: cnt },
      { groupBy: { region: 'region' }, aggregate: cnt, orderBy: [{ id: 'asc' }] },
      { groupBy: { region: 'region' }, aggregate: cnt, having: { add: ['c', 1] } }
    ]) {
      for (const [, e] of engines) {
        const o = await read(e, params);
        expect(o.errors, JSON.stringify(params)).toBeDefined();
      }
    }
  });
});

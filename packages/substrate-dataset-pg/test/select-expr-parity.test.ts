/**
 * Computed `select`, `where.$expr` and the case-sensitive `like` / `notLike`
 * operators: memory and pg answer every read identically, through the engine.
 */

import { Engine, MemoryEdgesStore, type NamespaceConfig, Registry } from '@mnmal-ai/substrate-core';
import { MemoryDataset, MemoryDatasetRegistry } from '@mnmal-ai/substrate-dataset-memory';
import { defineNamespace, field } from '@mnmal-ai/substrate-sdk';
import type { Dataset, FieldDef, Identity, Row } from '@mnmal-ai/substrate-types';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../src/migrate.js';
import { PgDataset } from '../src/pg-dataset.js';
import { dropNamespace } from './_layout.js';

const POSTGRES_URL = process.env.POSTGRES_URL;
const NS = 'test_select_expr';

const types: Record<string, Record<string, FieldDef>> = {
  Page: {
    url: field.string(),
    width: field.number({ nullable: true }),
    big: field.int64({ nullable: true }),
    seen: field.date({ nullable: true })
  },
  Hit: {
    page: field.crossRef(NS, 'Page'),
    n: field.number({ nullable: true }),
    at: field.date({ nullable: true })
  }
};
const lookup = (type: string, f: string): FieldDef | undefined =>
  Object.hasOwn(types, type) ? types[type]?.[f] : undefined;

const WRITER: Identity = { kind: 'system', id: 'test', grants: { '*': ['read', 'mutate'] } };

function engineOver(ds: Dataset): Engine {
  const registry = new Registry();
  const edges = new MemoryEdgesStore({ now: () => new Date() });
  defineNamespace(NS, {
    Page: { fields: types.Page as Record<string, FieldDef> },
    Hit: { fields: types.Hit as Record<string, FieldDef> }
  }).install({ registry, dataset: ds, edges });
  const datasets = new MemoryDatasetRegistry();
  datasets.set(NS, ds);
  return new Engine({
    namespaces: new Map<string, NamespaceConfig>([[NS, { registry }]]),
    datasets,
    edges
  });
}

const PAGES: Array<Record<string, unknown>> = [
  {
    url: 'https://www.Google.com/a',
    width: 100,
    big: '9007199254740993',
    seen: '2024-03-05T10:20:30.123456Z'
  },
  { url: 'https://google.com/b', width: 5, big: 7, seen: '2024-03-05T10:20:30.123999Z' },
  { url: 'a%b', width: 1, big: null, seen: null },
  { url: 'axb', width: 2, big: -3, seen: '2023-01-01T00:00:00.000Z' },
  { url: 'https://example.org/a/long/path', width: null, big: null, seen: null }
];
const HITS: Array<[string, number]> = [
  ['https://www.Google.com/a', 3],
  ['https://google.com/b', 1]
];

async function seed(engine: Engine): Promise<void> {
  const ids = new Map<string, string>();
  for (const p of PAGES) {
    const env = await engine.mutate({
      frame: { [`${NS}/createPage`]: { params: p, fields: { id: true } } },
      ctx: { identity: WRITER }
    });
    expect(env.errors).toBeUndefined();
    ids.set(p.url as string, String((env.data[`${NS}/createPage`] as Row).id));
  }
  for (const [url, count] of HITS) {
    for (let i = 0; i < count; i++) {
      const env = await engine.mutate({
        frame: {
          [`${NS}/createHit`]: {
            params: { page: ids.get(url), n: i, at: `2024-01-0${i + 1}T00:00:00.${i}23456Z` },
            fields: { id: true }
          }
        },
        ctx: { identity: WRITER }
      });
      expect(env.errors).toBeUndefined();
    }
  }
}

type Out = { rows: Row[]; errors?: Array<{ code?: string; message: string }>; page?: unknown };
async function read(
  engine: Engine,
  params: Record<string, unknown>,
  fields: Record<string, unknown> = { id: true, url: true }
): Promise<Out> {
  const env = await engine.query({
    frame: { [`${NS}/Page`]: { params, fields } },
    ctx: { identity: null }
  });
  // Memory ignores the field hint, so compare only the keys asked for (ids differ per store).
  const keys = Object.keys(fields).filter((k) => k !== 'id' && k !== '_agg');
  const asked = (r: Row) => Object.fromEntries(keys.map((k) => [k, r[k] ?? null]));
  return {
    rows: ((env.data[`${NS}/Page`] ?? []) as Row[]).map(asked) as Row[],
    ...(env.errors ? { errors: env.errors as never } : {}),
    page: env._pagination?.[`${NS}/Page`]
  };
}
const urls = (o: Out) => o.rows.map((r) => String(r.url));

describe('select, $expr and like on memory and pg', () => {
  let sql: ReturnType<typeof postgres> | undefined;
  const engines: Array<[string, Engine]> = [];

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
        typeDefLookup: (type) => ({ fields: types[type] as Record<string, FieldDef> })
      })
    );
    await seed(pg);
    engines.push(['pg', pg]);
  });

  afterAll(async () => {
    if (sql === undefined) return;
    await dropNamespace(sql, NS);
    await sql.end();
  });

  /** Runs `params` on every engine and returns the one answer they share. */
  async function same(params: Record<string, unknown>, fields?: Record<string, unknown>) {
    const [first, ...rest] = await Promise.all(engines.map(([, e]) => read(e, params, fields)));
    expect(first?.errors).toBeUndefined();
    for (const o of rest) expect(o).toEqual(first);
    return first as Out;
  }

  it('select adds computed keys, identically', async () => {
    const out = await same(
      {
        select: { l: { length: ['url'] }, w1: { add: ['width', 1] } },
        orderBy: [{ url: 'asc' }]
      },
      { url: true, l: true, w1: true }
    );
    expect(out.rows.map((r) => [r.url, r.l, r.w1])).toEqual([
      ['a%b', 3, 2],
      ['axb', 3, 3],
      ['https://example.org/a/long/path', 31, null],
      ['https://google.com/b', 20, 6],
      ['https://www.Google.com/a', 24, 101]
    ]);
  });

  it('select covers int64, date, string and boolean results', async () => {
    const out = await same(
      {
        select: {
          b2: { add: ['big', 1] },
          day: { dateTrunc: [{ lit: 'day' }, 'seen'] },
          up: { upper: ['url'] },
          wide: { gt: ['width', 4] }
        },
        orderBy: [{ url: 'asc' }]
      },
      { url: true, b2: true, day: true, up: true, wide: true }
    );
    expect(out.rows[3]).toMatchObject({
      b2: 8n,
      day: '2024-03-05T00:00:00.000000Z',
      up: 'HTTPS://GOOGLE.COM/B',
      wide: true
    });
    expect(out.rows[4]?.b2).toBe(9007199254740994n);
    expect(out.rows[2]).toMatchObject({ b2: null, day: null, wide: null });
  });

  it('where.$expr filters on a computed condition', async () => {
    const out = await same({
      where: { $expr: { gt: [{ length: ['url'] }, 10] } },
      orderBy: [{ url: 'asc' }]
    });
    expect(urls(out)).toEqual([
      'https://example.org/a/long/path',
      'https://google.com/b',
      'https://www.Google.com/a'
    ]);
  });

  it('$expr beside a field filter and under NOT keeps null rows out of the match', async () => {
    const both = await same({
      where: { url: { startsWith: 'https' }, $expr: { gt: ['width', 50] } }
    });
    expect(urls(both)).toEqual(['https://www.Google.com/a']);
    const not = await same({
      where: { NOT: { $expr: { gt: ['width', 50] } } },
      orderBy: [{ url: 'asc' }]
    });
    expect(urls(not)).toEqual([
      'a%b',
      'axb',
      'https://example.org/a/long/path',
      'https://google.com/b'
    ]);
  });

  it('orderBy a select name, with a cursor across pages', async () => {
    const params = { select: { l: { length: ['url'] } }, orderBy: [{ l: 'desc' }] };
    const full = await same(params, { url: true, l: true });
    expect(urls(full)).toEqual([
      'https://example.org/a/long/path',
      'https://www.Google.com/a',
      'https://google.com/b',
      'a%b',
      'axb'
    ]);
    for (const [, e] of engines) {
      const walked: string[] = [];
      let cursor: string | undefined;
      for (let i = 0; i < 6; i++) {
        const o = await read(
          e,
          { ...params, limit: 2, ...(cursor ? { cursor } : {}) },
          { url: true }
        );
        walked.push(...urls(o));
        const p = o.page as { hasMore?: boolean; nextCursor?: string } | undefined;
        if (p?.hasMore !== true) break;
        cursor = p.nextCursor;
      }
      expect(walked).toEqual(urls(full));
    }
  });

  it('orders by an int64, a date and a string select, with cursors', async () => {
    for (const select of [
      { k: { add: ['big', 1] } },
      { k: { dateTrunc: [{ lit: 'hour' }, 'seen'] } },
      { k: { lower: ['url'] } },
      { k: { gt: ['width', 4] } }
    ]) {
      const params = { select, orderBy: [{ k: 'desc' }] };
      const full = await same(params, { url: true, k: true });
      for (const [, e] of engines) {
        const walked: string[] = [];
        let cursor: string | undefined;
        for (let i = 0; i < 6; i++) {
          const o = await read(
            e,
            { ...params, limit: 2, ...(cursor ? { cursor } : {}) },
            { url: true }
          );
          walked.push(...urls(o));
          const p = o.page as { hasMore?: boolean; nextCursor?: string } | undefined;
          if (p?.hasMore !== true) break;
          cursor = p.nextCursor;
        }
        expect(walked, JSON.stringify(select)).toEqual(urls(full));
      }
    }
  });

  // Each engine stamps its own createdAt, so these compare what does not depend on the instant.
  it('createdAt and seq read in expressions: select, $expr and a day group', async () => {
    const year = new Date().getUTCFullYear();
    const sel = await same(
      { select: { y: { extract: [{ lit: 'year' }, 'createdAt'] } }, orderBy: [{ url: 'asc' }] },
      { id: true, url: true, y: true }
    );
    expect(sel.rows.map((r) => r.y)).toEqual(Array(5).fill(year));
    const after = await same({
      where: { $expr: { gt: ['createdAt', 'seen'] } },
      orderBy: [{ url: 'asc' }]
    });
    expect(urls(after)).toEqual(['axb', 'https://google.com/b', 'https://www.Google.com/a']);
    const none = await same({
      where: { $expr: { lt: [{ extract: [{ lit: 'year' }, 'updatedAt'] }, 2000] } }
    });
    expect(none.rows).toEqual([]);
    for (const [name, e] of engines) {
      const env = await e.query({
        frame: {
          [`${NS}/Page`]: {
            params: {
              aggregate: { n: { count: true } },
              groupBy: { day: { dateTrunc: [{ lit: 'day' }, 'createdAt'] } }
            },
            fields: { id: true }
          }
        },
        ctx: { identity: null }
      });
      expect(env.errors, name).toBeUndefined();
      const groups = (env.data[`${NS}/Page`] as { groups: Array<Record<string, unknown>> }).groups;
      // All five rows were written moments apart: one day, barring a midnight in between.
      expect(
        groups.reduce((n, g) => n + Number(g.n), 0),
        name
      ).toBe(5);
      for (const g of groups) expect(g.day, name).toMatch(/^\d{4}-\d\d-\d\dT00:00:00\.000000Z$/);
    }
  });

  it('a select that overflows raises on the page and as the order key, not for a filtered-out row', async () => {
    // Postgres computes a non-order select only for the page, so the row must sit on it.
    const big = { select: { d: { mul: ['width', 1e307] } } };
    for (const [name, e] of engines) {
      const page = await read(e, { ...big, where: { width: { eq: 100 } } }, { id: true, d: true });
      expect(page.errors?.[0]?.code, `${name} page`).toBe('value_out_of_range');
      const lead = await read(e, { ...big, orderBy: [{ d: 'asc' }] }, { id: true, d: true });
      expect(lead.errors?.[0]?.code, `${name} order key`).toBe('value_out_of_range');
      const filtered = await read(
        e,
        { ...big, where: { width: { lt: 10 } }, orderBy: [{ url: 'asc' }] },
        { id: true, d: true }
      );
      expect(filtered.errors, `${name} filtered out`).toBeUndefined();
    }
  });

  it('like is case-sensitive and differs from contains', async () => {
    const like = await same({ where: { url: { like: '%Google%' } } });
    expect(urls(like)).toEqual(['https://www.Google.com/a']);
    const contains = await same({
      where: { url: { contains: 'google' } },
      orderBy: [{ url: 'asc' }]
    });
    expect(urls(contains)).toEqual(['https://google.com/b', 'https://www.Google.com/a']);
    const not = await same({ where: { url: { notLike: '%Google%' } }, orderBy: [{ url: 'asc' }] });
    expect(urls(not)).toEqual([
      'a%b',
      'axb',
      'https://example.org/a/long/path',
      'https://google.com/b'
    ]);
  });

  it('like treats a backslash as escaping a wildcard', async () => {
    expect(urls(await same({ where: { url: { like: 'a\\%b' } } }))).toEqual(['a%b']);
    expect(
      urls(await same({ where: { url: { like: 'a_b' } }, orderBy: [{ url: 'asc' }] }))
    ).toEqual(['a%b', 'axb']);
  });

  it('a like operand ending in an escape is refused on both datasets', async () => {
    for (const [, e] of engines) {
      const o = await read(e, { where: { url: { like: 'a\\' } } });
      expect(o.errors?.[0]?.message ?? '', 'refused').toMatch(/must not end with escape/);
    }
  });

  it('select reads a frame _agg by name, and orders by it', async () => {
    const out = await same(
      { select: { v: '_agg.n' }, orderBy: [{ v: 'desc' }, { url: 'asc' }] },
      { url: true, v: true, _agg: { n: { in: `${NS}/Hit.page`, count: true } } }
    );
    expect(out.rows.map((r) => [r.url, r.v])).toEqual([
      ['https://www.Google.com/a', 3],
      ['https://google.com/b', 1],
      ['a%b', 0],
      ['axb', 0],
      ['https://example.org/a/long/path', 0]
    ]);
  });

  it('a date select equals the plain read of that field on each engine, microseconds kept', async () => {
    const out = await same(
      { select: { s: 'seen' }, orderBy: [{ url: 'asc' }] },
      { url: true, seen: true, s: true }
    );
    // A plain read gives the stored text, which may omit trailing zeros ('.000Z'); the select is
    // always the microsecond form. Same instant on both, and the same text where all six digits are stored.
    const instant = (v: unknown) => (v == null ? null : new Date(String(v)).getTime());
    for (const r of out.rows) {
      expect(instant(r.s)).toEqual(instant(r.seen));
      if (/\.\d{6}Z$/.test(String(r.seen))) expect(r.s).toEqual(r.seen);
    }
    expect(out.rows.map((r) => r.s)).toEqual([
      null,
      '2023-01-01T00:00:00.000000Z',
      null,
      '2024-03-05T10:20:30.123999Z',
      '2024-03-05T10:20:30.123456Z'
    ]);
  });

  it('orders a date select by instant across mixed precisions, with a cursor', async () => {
    const params = { select: { s: 'seen' }, orderBy: [{ s: 'desc' }] };
    const full = await same(params, { url: true, s: true });
    // .123999 is after .123456 though both print as .123.
    expect(urls(full).slice(0, 3)).toEqual([
      'https://google.com/b',
      'https://www.Google.com/a',
      'axb'
    ]);
    for (const [, e] of engines) {
      const walked: string[] = [];
      let cursor: string | undefined;
      for (let i = 0; i < 6; i++) {
        const o = await read(
          e,
          { ...params, limit: 1, ...(cursor ? { cursor } : {}) },
          { url: true }
        );
        walked.push(...urls(o));
        const p = o.page as { hasMore?: boolean; nextCursor?: string } | undefined;
        if (p?.hasMore !== true) break;
        cursor = p.nextCursor;
      }
      expect(walked).toEqual(urls(full));
    }
  });

  it('a date _agg select keeps microseconds and orders by instant', async () => {
    const out = await same(
      { select: { t: '_agg.t' }, orderBy: [{ t: 'desc' }, { url: 'asc' }] },
      { url: true, t: true, _agg: { t: { in: `${NS}/Hit.page`, max: 'at' } } }
    );
    expect(out.rows.slice(0, 2).map((r) => [r.url, r.t])).toEqual([
      ['https://www.Google.com/a', '2024-01-03T00:00:00.223456Z'],
      ['https://google.com/b', '2024-01-01T00:00:00.023456Z']
    ]);
    expect(out.rows[2]?.t).toBeNull();
  });
});

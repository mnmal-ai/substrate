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
    seen: '2024-03-05T10:20:30.123Z'
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
  const asked = (r: Row) => Object.fromEntries(keys.map((k) => [k, r[k]]));
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
      day: '2024-03-05T00:00:00.000Z',
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

  it('a date select reads out to the millisecond on both engines, however precise the stored date', async () => {
    const out = await same(
      { select: { s: 'seen' }, orderBy: [{ url: 'asc' }] },
      { url: true, s: true }
    );
    expect(out.rows.map((r) => r.s)).toEqual([
      null,
      '2023-01-01T00:00:00.000Z',
      null,
      '2024-03-05T10:20:30.123Z',
      '2024-03-05T10:20:30.123Z'
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

  it('a date _agg select is read out to the millisecond and orders by instant', async () => {
    const out = await same(
      { select: { t: '_agg.t' }, orderBy: [{ t: 'desc' }, { url: 'asc' }] },
      { url: true, t: true, _agg: { t: { in: `${NS}/Hit.page`, max: 'at' } } }
    );
    expect(out.rows.slice(0, 2).map((r) => [r.url, r.t])).toEqual([
      ['https://www.Google.com/a', '2024-01-03T00:00:00.223Z'],
      ['https://google.com/b', '2024-01-01T00:00:00.023Z']
    ]);
    expect(out.rows[2]?.t).toBeNull();
  });
});

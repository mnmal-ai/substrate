/**
 * The shared walk forms (Todo #1815) and nested natural order (#1821) through
 * the engine, on pg and on the memory reference side by side: the same frame
 * answers the same on both, the pg plan names the form it compiled, a row
 * policy on the far type refuses the frame alike on both, and a nested list
 * with no orderBy reads in the far type's natural order. Walks need the
 * partitioned layout.
 */

import { createHash, randomBytes } from 'node:crypto';
import { Engine, MemoryEdgesStore, type NamespaceConfig, Registry } from '@mnmal-ai/substrate-core';
import { MemoryDataset, MemoryDatasetRegistry } from '@mnmal-ai/substrate-dataset-memory';
import type {
  FieldDef,
  OrderedBy,
  PackEnvelope,
  Policy,
  ReadParams,
  ReadResult,
  Row
} from '@mnmal-ai/substrate-types';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PgDataset } from '../src/index.js';
import { dropNamespace, TABLES } from './_layout.js';
import { strip } from './_walk-helpers.js';

const POSTGRES_URL = process.env.POSTGRES_URL;
/** Walks run on the partitioned and `tables` layouts; legacy refuses them. */
const WALK_LAYOUT = process.env.SUBSTRATE_TEST_LAYOUT === 'partitioned' || TABLES;
const NS = `wform_${randomBytes(4).toString('hex')}`;

const num: FieldDef = { kind: 'scalar', type: 'number' };
const ref = (type: string): FieldDef => ({ kind: 'crossRef', ns: NS, type, onDelete: 'set_null' });
const TYPES: Record<string, { fields: Record<string, FieldDef>; orderedBy?: OrderedBy }> = {
  Hub: { fields: { ask: num } },
  Seed: { fields: { hub: ref('Hub'), ask: num } },
  Sale: { fields: { hub: ref('Hub'), at: { kind: 'scalar', type: 'date' }, price: num } },
  Obs: {
    fields: { hub: ref('Hub'), at: { kind: 'scalar', type: 'date', indexed: true }, price: num }
  },
  Lst: { fields: { hub: ref('Hub'), rank: num }, orderedBy: { rank: 'asc' } }
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
const day = (n: number) => new Date(Date.UTC(2026, 9, 20 + n)).toISOString();

function fixture(): Record<string, Array<Record<string, unknown>>> {
  const out: Record<string, Array<Record<string, unknown>>> = {
    Hub: [],
    Seed: [],
    Sale: [],
    Obs: [],
    Lst: []
  };
  for (let h = 0; h < 6; h++) {
    out.Hub?.push({ id: u(`h${h}`), ask: h * 10 });
    for (let i = 0; i < 8; i++)
      out.Seed?.push({ id: u(`s${h}_${i}`), hub: u(`h${h}`), ask: i * 5 });
    // h5 has no sales, reads or listings.
    if (h === 5) continue;
    for (let i = 0; i < 6; i++) {
      out.Sale?.push({
        id: u(`x${h}_${i}`),
        hub: u(`h${h}`),
        at: day(i % 3),
        price: (i * 7 + h) % 40
      });
      out.Obs?.push({
        id: u(`o${h}_${i}`),
        hub: u(`h${h}`),
        ...(i === 5 ? {} : { at: day(i) }),
        price: i + h
      });
      out.Lst?.push({ id: u(`l${h}_${i}`), hub: u(`h${h}`), ...(i === 5 ? {} : { rank: i >> 1 }) });
    }
  }
  out.Seed?.push({ id: u('s_none'), ask: 0 });
  out.Obs?.push({ id: u('o_none'), at: day(4), price: 1 });
  return out;
}

let sql: Sql;
const policies: Record<string, Policy | undefined> = {};

/** An engine over `ds`, every type read through it as the autocrud list resolver does. */
function engineOver(ds: PgDataset | MemoryDataset): Engine {
  const registry = new Registry();
  for (const [name, def] of Object.entries(TYPES)) {
    registry.register(name, {
      fields: def.fields,
      ...(def.orderedBy !== undefined ? { orderedBy: def.orderedBy } : {}),
      policy: (ctx, args) => (policies[name] ?? (() => ({ allow: true })))(ctx, args),
      resolver: async (_ctx, args): Promise<ReadResult> => {
        const fields = (args.fields ?? {}) as Record<string, unknown>;
        const isNested = (v: unknown) => typeof v === 'object' && v !== null && '_walk' in v;
        const nested = Object.fromEntries(Object.entries(fields).filter(([, v]) => isNested(v)));
        const agg = fields._agg;
        return ds.read(name, {
          ...(args.params ?? {}),
          ...(Object.keys(nested).length > 0 ? { nested } : {}),
          ...(agg !== undefined ? { agg } : {})
        } as ReadParams);
      }
    });
  }
  const datasets = new MemoryDatasetRegistry();
  datasets.set(NS, ds);
  return new Engine({
    namespaces: new Map<string, NamespaceConfig>([[NS, { registry }]]),
    datasets,
    edges: new MemoryEdgesStore({ now: () => new Date() })
  });
}
let onPg: Engine;
let onMem: Engine;

beforeAll(async () => {
  if (!POSTGRES_URL || !WALK_LAYOUT) return;
  sql = postgres(POSTGRES_URL, { onnotice: () => {} });
  const pg = new PgDataset({ namespace: NS, sql, fieldDefLookup, typeDefLookup: typeDef });
  for (const type of Object.keys(TYPES)) await pg.ensureTypeStorage(type);
  const mem = new MemoryDataset({ namespace: NS, fieldDefLookup, walkReference: true });
  for (const [type, rows] of Object.entries(fixture())) {
    await pg.write(type, rows as never);
    await mem.write(type, rows as never);
  }
  if (!TABLES) await sql`ANALYZE rows`;
  onPg = engineOver(pg);
  onMem = engineOver(mem);
}, 120_000);

afterAll(async () => {
  if (!POSTGRES_URL || !WALK_LAYOUT) return;
  await dropNamespace(sql, NS);
  await sql.end({ timeout: 5 });
});

const ctx = { identity: null };
const key = (type: string) => `${NS}/${type}`;
/** A row as both stores answer it: no `_metadata`/`shortId`, ids named, nested lists' ids too. */
const named = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(named)
    : typeof v === 'object' && v !== null
      ? Object.fromEntries(
          Object.entries(v).map(([k, x]) => [
            k,
            k === 'id' ? (names.get(String(x)) ?? x) : named(x)
          ])
        )
      : v;

/** Runs `frame` on both engines, asserts the same data and errors, and returns pg's envelope. */
async function both(type: string, entry: Record<string, unknown>): Promise<PackEnvelope> {
  const frame = { [key(type)]: entry };
  const [p, m] = await Promise.all([
    onPg.query({ frame, ctx } as never),
    onMem.query({ frame, ctx } as never)
  ]);
  const view = (env: PackEnvelope) => {
    const d = env.data[key(type)];
    return {
      data: named(Array.isArray(d) ? (d as Row[]).map(strip) : d),
      // Cursors carry each store's own createdAt, so only `hasMore` is compared.
      hasMore: env._pagination?.[key(type)]?.hasMore,
      errors: env.errors?.map(({ code, path }) => ({ code, path }))
    };
  };
  expect(view(p), JSON.stringify(entry)).toEqual(view(m));
  return p;
}
const planOf = (env: PackEnvelope, type: string) => env._diagnostics?.[key(type)]?.plan ?? [];
const formAt = (env: PackEnvelope, type: string, path: string[]) =>
  planOf(env, type).find((c) => JSON.stringify(c.path) === JSON.stringify(path))?.form;

const HUB_PICK = {
  _walk: {
    out: 'hub',
    where: {
      _walk: {
        in: `${NS}/Sale.hub`,
        pick: { latest: 'at' },
        where: { price: { gte: { $ref: '$.ask' } } }
      }
    }
  }
};
const W = { at: { gte: day(2) } };
const OBS = `${NS}/Obs.hub`;
const WINDOW = {
  params: { where: { _walk: { in: OBS, where: W } }, limit: 5000 },
  fields: {
    id: true,
    _agg: {
      n: { in: OBS, where: W, count: true },
      avg: { in: OBS, where: W, avg: 'price' },
      hi: { in: OBS, where: W, max: 'price' }
    }
  }
};

describe.skipIf(!POSTGRES_URL || !WALK_LAYOUT)(
  'walk forms through the engine (pg = memory)',
  () => {
    it('a shared pick: per-hub on a count and a page of every seed, per-seed on a short page', async () => {
      const path = ['where', '_walk', 'where', '_walk'];
      const count = await both('Seed', { params: { count: true, where: HUB_PICK } });
      expect(formAt(count, 'Seed', path)).toBe('per-hub');
      const all = await both('Seed', {
        params: { where: HUB_PICK, limit: 5000 },
        fields: { id: true }
      });
      expect(formAt(all, 'Seed', path)).toBe('per-hub');
      const page = await both('Seed', {
        params: { where: HUB_PICK, limit: 4 },
        fields: { id: true }
      });
      expect(formAt(page, 'Seed', path)).toBe('per-seed');
    }, 60_000);

    it('a window: group-by for every seed, per-seed for a short page, the same answers', async () => {
      const all = await both('Hub', WINDOW);
      for (const n of ['n', 'avg', 'hi']) {
        expect(formAt(all, 'Hub', ['fields', '_agg', n])).toBe('group-by');
      }
      const page = await both('Hub', { ...WINDOW, params: { ...WINDOW.params, limit: 2 } });
      expect(formAt(page, 'Hub', ['fields', '_agg', 'n'])).toBe('per-seed');
      // An empty window.
      const none = { at: { gte: day(30) } };
      await both('Hub', {
        params: { where: { _walk: { in: OBS, where: none } }, limit: 5000 },
        fields: { id: true, _agg: { n: { in: OBS, where: none, count: true } } }
      });
    }, 60_000);

    it('a row policy on the far type refuses the shared forms alike on both', async () => {
      const rowPolicy: Policy = () => ({
        allow: true,
        obligations: [{ kind: 'row-filter', predicate: () => true } as never]
      });
      try {
        policies.Sale = rowPolicy;
        const pick = await both('Seed', { params: { count: true, where: HUB_PICK } });
        expect(pick.errors?.[0]?.code).toBe('row_policy_blocks_walk');
        policies.Sale = undefined;
        policies.Obs = rowPolicy;
        const window = await both('Hub', WINDOW);
        expect(window.errors?.[0]?.code).toBe('row_policy_blocks_walk');
        policies.Obs = undefined;
        policies.Lst = rowPolicy;
        const list = await both('Hub', {
          params: {},
          fields: { id: true, top: { _walk: { in: `${NS}/Lst.hub` }, fields: { rank: true } } }
        });
        expect(list.errors?.[0]?.code).toBe('row_policy_blocks_walk');
      } finally {
        for (const t of Object.keys(policies)) policies[t] = undefined;
      }
    }, 60_000);

    it("a nested list with no orderBy reads in the far type's natural order, ties by id (#1821)", async () => {
      for (const limit of [1, 2, 3, 5, 6]) {
        const env = await both('Hub', {
          params: {},
          fields: {
            id: true,
            top: { _walk: { in: `${NS}/Lst.hub` }, fields: { rank: true }, limit }
          }
        });
        const h0 = (env.data[key('Hub')] as Row[]).find((r) => names.get(String(r.id)) === 'h0');
        const ranks = ((h0?.top ?? []) as Array<{ rank: number | null }>).map((l) => l.rank);
        // rank ascending, the unranked last.
        expect(ranks).toEqual([0, 0, 1, 1, 2, null].slice(0, limit));
        expect(h0?._truncated).toEqual(limit < 6 ? { top: true } : undefined);
        // The plan names that order, served by the eager (hub, rank, id) index.
        expect(
          planOf(env, 'Hub').find((c) => c.path.join('.') === 'fields.top.orderBy')
        ).toMatchObject({ kind: 'order', served: true });
      }
    }, 60_000);
  }
);

/**
 * Month and week groupings through `runAsk` over Postgres: the engine's
 * `dateTrunc` buckets are cut into labels, and an ISO week is labelled by its
 * Monday. Skipped unless POSTGRES_URL is set.
 */

import { randomBytes } from 'node:crypto';
import {
  defineNamespace,
  field,
  type NlOutcome,
  type Query,
  type SubstrateRequest
} from '@mnmal-ai/substrate/sdk';
import {
  compose,
  MemoryDataset,
  type MemoryEdgesStore,
  MemorySubstrateServer,
  PgDataset,
  PgEdgesStore
} from '@mnmal-ai/substrate/testing';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NlEngineAccess } from '../access.js';
import type { NlEvent } from '../ask/events.js';
import { runAsk } from '../ask/run.js';
import { PackService } from '../pack/service.js';

const POSTGRES_URL = process.env.POSTGRES_URL;
const TYPES = { Sale: { fields: { price: field.number(), soldAt: field.date() } } };
const RULINGS = { timeField: { Sale: 'soldAt' } };
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
// Tuesday, Sunday, Monday, Monday.
const SALES = [
  ['2026-09-29', 10],
  ['2026-10-04', 20],
  ['2026-10-05', 30],
  ['2026-11-02', 40]
].map(([day, price], i) => ({ id: id(i + 1), price, soldAt: `${day}T12:00:00.000Z` }));

const http: SubstrateRequest = {
  method: 'POST',
  path: '/substrate/v1/nl',
  headers: {},
  query: {},
  params: {},
  body: null
};
const ctx = {
  identity: { kind: 'system' as const, id: 'test', grants: { '*': ['read', 'mutate'] } },
  now: new Date(),
  headers: {},
  meta: {}
};

/** A namespace of its own on Postgres holding `sales`, and `ask` over it. */
async function mount(sql: Sql, sales: object[]) {
  const ns = `nlt_${randomBytes(4).toString('hex')}`;
  const nsDef = defineNamespace(ns, TYPES, { annotations: { nl: RULINGS } });
  const edges = new PgEdgesStore({ sql });
  const dataset = new PgDataset({
    namespace: ns,
    sql,
    edgesStore: edges,
    fieldDefLookup: (type, f) => nsDef.types?.[type]?.fields[f],
    typeDefLookup: (type) => nsDef.types?.[type]
  });
  await dataset.ensureTypeStorage('Sale');
  await dataset.write('Sale', sales as never);
  const composed = await compose({
    server: new MemorySubstrateServer(),
    dataset: new MemoryDataset({ namespace: 'default' }),
    datasets: { [ns]: dataset },
    edges: edges as unknown as MemoryEdgesStore,
    coordinators: [{ name: `${ns}-pg`, contractVersion: '*', namespaces: [nsDef] }] as never,
    systemActor: 'test'
  });
  const engine: NlEngineAccess = {
    federatedSchema: () => composed.engine.federatedSchema(),
    operators: (n) => composed.engine.datasetFor(n)?.capabilities.operators,
    query: (frame: Query) => composed.engine.query({ frame, ctx }) as never
  };
  const packs = new PackService({ engine });
  const ask = async (question: string): Promise<NlOutcome> => {
    const served = await packs.get(ns, http);
    if (served === undefined) throw new Error('no pack');
    let outcome: NlOutcome | undefined;
    for await (const ev of runAsk({ namespace: ns, question }, http, {
      pack: served.pack,
      engine,
      now: () => new Date('2026-11-19T12:00:00Z')
    }) as AsyncGenerator<NlEvent>) {
      if (ev.event === 'outcome') outcome = ev.outcome;
    }
    if (outcome === undefined) throw new Error(`no outcome for ${question}`);
    return outcome;
  };
  return { ask, stop: () => composed.stop() };
}

describe.skipIf(!POSTGRES_URL)('NL time groupings over pg', () => {
  let sql: Sql;
  const stops: (() => Promise<void>)[] = [];
  let ask: (question: string) => Promise<NlOutcome>;

  beforeAll(async () => {
    sql = postgres(POSTGRES_URL as string, { onnotice: () => {} });
    const m = await mount(sql, SALES);
    stops.push(m.stop);
    ask = m.ask;
  });

  afterAll(async () => {
    for (const stop of stops) await stop();
    await sql?.end({ timeout: 5 });
  });

  it('groups a count and a sum by month and week on Postgres', async () => {
    const count = await ask('how many sales per month');
    const sum = await ask('total price of sales per week');
    expect(count.kind === 'rows' && count.aggregate).toMatchObject({
      fn: 'count',
      field: '*',
      groups: [
        { key: '2026-09', value: 1 },
        { key: '2026-10', value: 2 },
        { key: '2026-11', value: 1 }
      ]
    });
    expect(sum.kind === 'rows' && sum.aggregate).toMatchObject({
      groups: [
        { key: '2026-09-28', value: 30 },
        { key: '2026-10-05', value: 30 },
        { key: '2026-11-02', value: 40 }
      ]
    });
  });

  describe('with a sale in 2025', () => {
    let askYears: (question: string) => Promise<NlOutcome>;

    beforeAll(async () => {
      const late2025 = { id: id(5), price: 50, soldAt: '2025-12-30T12:00:00.000Z' };
      const m = await mount(sql, [...SALES, late2025]);
      stops.push(m.stop);
      askYears = m.ask;
    });

    it('counts per month within a year on Postgres', async () => {
      const perMonth = await askYears('how many sales per month in 2026');
      const lastYear = await askYears('how many sales in 2025');
      expect(perMonth.kind === 'rows' && perMonth.aggregate).toMatchObject({
        groups: [
          { key: '2026-09', value: 1 },
          { key: '2026-10', value: 2 },
          { key: '2026-11', value: 1 }
        ]
      });
      expect(lastYear.kind === 'rows' && lastYear.count).toBe(1);
    });
  });
});

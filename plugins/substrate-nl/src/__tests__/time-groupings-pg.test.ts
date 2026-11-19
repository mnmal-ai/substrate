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
const NS = `nlt_${randomBytes(4).toString('hex')}`;
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

describe.skipIf(!POSTGRES_URL)('NL time groupings over pg', () => {
  let sql: Sql;
  let composed: Awaited<ReturnType<typeof compose>>;
  let ask: (question: string) => Promise<NlOutcome>;

  beforeAll(async () => {
    sql = postgres(POSTGRES_URL as string, { onnotice: () => {} });
    const nsDef = defineNamespace(NS, TYPES, { annotations: { nl: RULINGS } });
    const edges = new PgEdgesStore({ sql });
    const dataset = new PgDataset({
      namespace: NS,
      sql,
      edgesStore: edges,
      fieldDefLookup: (type, f) => nsDef.types?.[type]?.fields[f],
      typeDefLookup: (type) => nsDef.types?.[type]
    });
    await dataset.ensureTypeStorage('Sale');
    await dataset.write('Sale', SALES as never);
    composed = await compose({
      server: new MemorySubstrateServer(),
      dataset: new MemoryDataset({ namespace: 'default' }),
      datasets: { [NS]: dataset },
      edges: edges as unknown as MemoryEdgesStore,
      coordinators: [{ name: `${NS}-pg`, contractVersion: '*', namespaces: [nsDef] }] as never,
      systemActor: 'test'
    });
    const engine: NlEngineAccess = {
      federatedSchema: () => composed.engine.federatedSchema(),
      operators: (ns) => composed.engine.datasetFor(ns)?.capabilities.operators,
      query: (frame: Query) => composed.engine.query({ frame, ctx }) as never
    };
    const packs = new PackService({ engine });
    ask = async (question) => {
      const served = await packs.get(NS, http);
      if (served === undefined) throw new Error('no pack');
      let outcome: NlOutcome | undefined;
      for await (const ev of runAsk({ namespace: NS, question }, http, {
        pack: served.pack,
        engine,
        now: () => new Date('2026-11-19T12:00:00Z')
      }) as AsyncGenerator<NlEvent>) {
        if (ev.event === 'outcome') outcome = ev.outcome;
      }
      if (outcome === undefined) throw new Error(`no outcome for ${question}`);
      return outcome;
    };
  });

  afterAll(async () => {
    await composed?.stop();
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
});

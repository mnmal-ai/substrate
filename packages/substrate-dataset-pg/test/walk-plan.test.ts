/**
 * The walk plan (typed edge walks goal 7) against pg's real `indexPlan`: an
 * engine walk read on pg reports each clause served or unserved from the
 * reconciler's own desired indexes, the derived crossRef index and a declared
 * `(cert, observedAt DESC)`. Walks need the partitioned layout.
 */

import { randomBytes } from 'node:crypto';
import { Engine, MemoryEdgesStore, type NamespaceConfig, Registry } from '@mnmal-ai/substrate-core';
import { MemoryDatasetRegistry } from '@mnmal-ai/substrate-dataset-memory';
import type { FieldDef, IndexDecl, ReadParams, ReadResult } from '@mnmal-ai/substrate-types';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PgDataset } from '../src/index.js';

const POSTGRES_URL = process.env.POSTGRES_URL;
const PARTITIONED = process.env.SUBSTRATE_TEST_LAYOUT === 'partitioned';
const NS = `wplan_${randomBytes(4).toString('hex')}`;

const ref = (type: string, extra: Partial<FieldDef> = {}): FieldDef =>
  ({ kind: 'crossRef', ns: NS, type, onDelete: 'set_null', ...extra }) as FieldDef;
const TYPES: Record<string, { fields: Record<string, FieldDef>; indexes?: IndexDecl[] }> = {
  Cert: { fields: { grade: { kind: 'scalar', type: 'number' } } },
  Observation: {
    fields: {
      cert: ref('Cert'),
      observedAt: { kind: 'scalar', type: 'date' },
      price: { kind: 'scalar', type: 'number' }
    },
    indexes: [{ fields: ['cert', { field: 'observedAt', dir: 'desc' }] }]
  },
  Note: { fields: { cert: ref('Cert', { indexed: false } as Partial<FieldDef>) } }
};
const typeDef = (type: string) => (Object.hasOwn(TYPES, type) ? TYPES[type] : undefined);

let sql: Sql;
let pg: PgDataset;
let engine: Engine;

beforeAll(async () => {
  if (!POSTGRES_URL || !PARTITIONED) return;
  sql = postgres(POSTGRES_URL, { onnotice: () => {} });
  pg = new PgDataset({
    namespace: NS,
    sql,
    fieldDefLookup: (type, field) => {
      const fields = typeDef(type)?.fields;
      return fields !== undefined && Object.hasOwn(fields, field) ? fields[field] : undefined;
    },
    typeDefLookup: typeDef
  });
  for (const type of Object.keys(TYPES)) await pg.ensureTypeStorage(type);
  const registry = new Registry();
  for (const [name, def] of Object.entries(TYPES)) {
    registry.register(name, {
      fields: def.fields,
      policy: () => ({ allow: true }),
      resolver: async (_ctx, args): Promise<ReadResult> =>
        pg.read(name, (args.params ?? {}) as ReadParams)
    });
  }
  const datasets = new MemoryDatasetRegistry();
  datasets.set(NS, pg);
  engine = new Engine({
    namespaces: new Map<string, NamespaceConfig>([[NS, { registry }]]),
    datasets,
    edges: new MemoryEdgesStore({ now: () => new Date() }),
    walksEnabled: true
  });
});

afterAll(async () => {
  if (!POSTGRES_URL || !PARTITIONED) return;
  await sql`DELETE FROM rows WHERE namespace = ${NS}`;
  await sql.end({ timeout: 5 });
});

describe.skipIf(!POSTGRES_URL || !PARTITIONED)('walk plan from pg indexPlan', () => {
  it('marks hops, declared and derived index service, and recommends the missing index', async () => {
    const OBS = `${NS}/Observation.cert`;
    const key = `${NS}/Cert`;
    const env = await engine.query({
      frame: {
        [key]: {
          params: {
            where: {
              _walk: {
                in: OBS,
                where: { observedAt: { gte: '2026-10-01T00:00:00Z' }, price: { gte: 5 } }
              }
            }
          },
          fields: {
            id: true,
            recent: {
              _walk: { in: OBS },
              fields: { id: true },
              orderBy: [{ observedAt: 'desc' }],
              limit: 3
            },
            natural: {
              _walk: { in: OBS },
              fields: { id: true },
              orderBy: [{ createdAt: 'desc' }],
              limit: 3
            },
            notes: { _walk: { in: `${NS}/Note.cert` }, fields: { id: true } }
          }
        }
      },
      ctx: { identity: null }
    });
    expect(env.errors).toBeUndefined();
    expect(env._diagnostics?.[key]?.plan).toEqual([
      { path: ['where', '_walk'], kind: 'hop', served: true },
      { path: ['where', '_walk', 'where', 'observedAt'], kind: 'filter', served: true },
      {
        path: ['where', '_walk', 'where', 'price'],
        kind: 'filter',
        served: false,
        recommend: { fields: ['cert', 'price'] }
      },
      { path: ['fields', 'recent', '_walk'], kind: 'hop', served: true },
      { path: ['fields', 'recent', 'orderBy'], kind: 'order', served: true },
      { path: ['fields', 'natural', '_walk'], kind: 'hop', served: true },
      { path: ['fields', 'natural', 'orderBy'], kind: 'order', served: true },
      // `indexed: false`: no derived index serves the hop.
      {
        path: ['fields', 'notes', '_walk'],
        kind: 'hop',
        served: false,
        recommend: { fields: ['cert'] }
      }
    ]);
  });
});

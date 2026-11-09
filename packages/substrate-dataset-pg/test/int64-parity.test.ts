/**
 * `int64` on memory and pg: the same rows come back as the same bigints, and
 * the same filters and orders select the same ids, past 2^53.
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
const NS = 'test_int64_parity';

const fields = { n: field.int64({ nullable: true }), label: field.string() };
const lookup = (_type: string, f: string): FieldDef | undefined =>
  (fields as Record<string, FieldDef>)[f];

const WRITER: Identity = { kind: 'system', id: 'test', grants: { '*': ['read', 'mutate'] } };

const MAX = '9223372036854775807';
const MIN = '-9223372036854775808';
const BEYOND_SAFE = '9007199254740993';

function engineOver(ds: Dataset): Engine {
  const registry = new Registry();
  const edges = new MemoryEdgesStore({ now: () => new Date() });
  defineNamespace(NS, { Big: { fields } }).install({ registry, dataset: ds, edges });
  const datasets = new MemoryDatasetRegistry();
  datasets.set(NS, ds);
  return new Engine({
    namespaces: new Map<string, NamespaceConfig>([[NS, { registry }]]),
    datasets,
    edges
  });
}

/** Writes the fixture rows through the engine and returns `label -> id`. */
async function seed(engine: Engine): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const values: Array<[string, string | number | null]> = [
    ['max', MAX],
    ['min', MIN],
    ['beyond', BEYOND_SAFE],
    ['seven', 7],
    ['none', null]
  ];
  for (const [label, n] of values) {
    const env = await engine.mutate({
      frame: { [`${NS}/createBig`]: { params: { label, n }, fields: { id: true } } },
      ctx: { identity: WRITER }
    });
    expect(env.errors).toBeUndefined();
    out.set(label, String((env.data[`${NS}/createBig`] as Row).id));
  }
  return out;
}

async function read(engine: Engine, params: Record<string, unknown> = {}): Promise<Row[]> {
  const env = await engine.query({
    frame: { [`${NS}/Big`]: { params, fields: { id: true, n: true, label: true } } },
    ctx: { identity: null }
  });
  expect(env.errors).toBeUndefined();
  return env.data[`${NS}/Big`] as Row[];
}

const labels = (rows: Row[]) => rows.map((r) => String(r.label));

describe('int64 field kind', () => {
  it('a write that is not an int64 is refused', async () => {
    const engine = engineOver(new MemoryDataset({ namespace: NS, fieldDefLookup: lookup }));
    for (const n of ['007', '9223372036854775808', 1.5, 2 ** 53]) {
      const env = await engine.mutate({
        frame: { [`${NS}/createBig`]: { params: { label: 'x', n }, fields: { id: true } } },
        ctx: { identity: WRITER }
      });
      expect(env.errors?.[0]?.code).toBe('invalid_field_type');
    }
  });

  // Memory always; pg too when POSTGRES_URL is set.
  describe('memory and pg agree', () => {
    let sql: ReturnType<typeof postgres> | undefined;
    const engines: Engine[] = [];

    beforeAll(async () => {
      const memory = engineOver(new MemoryDataset({ namespace: NS, fieldDefLookup: lookup }));
      await seed(memory);
      engines.push(memory);
      if (!POSTGRES_URL) return;
      sql = postgres(POSTGRES_URL, { onnotice: () => {} });
      await runMigrations(sql);
      await dropNamespace(sql, NS);
      const pg = engineOver(
        new PgDataset({
          namespace: NS,
          sql,
          fieldDefLookup: lookup,
          typeDefLookup: () => ({ fields })
        })
      );
      await seed(pg);
      engines.push(pg);
    });

    afterAll(async () => {
      if (sql === undefined) return;
      await dropNamespace(sql, NS);
      await sql.end();
    });

    it('reads identical bigints', async () => {
      const byLabel = async (e: Engine) =>
        Object.fromEntries((await read(e)).map((r) => [r.label, r.n]));
      const expected = {
        max: 2n ** 63n - 1n,
        min: -(2n ** 63n),
        beyond: 9007199254740993n,
        seven: 7n
      };
      for (const e of engines) {
        const got = await byLabel(e);
        expect(got).toMatchObject(expected);
        expect(got.none ?? null).toBeNull();
      }
    });

    it('filters select the same rows', async () => {
      const wheres: Array<[Record<string, unknown>, string[]]> = [
        [{ n: { gt: '9007199254740992' } }, ['beyond', 'max']],
        [{ n: { eq: BEYOND_SAFE } }, ['beyond']],
        [{ n: { eq: '9007199254740992' } }, []],
        [{ n: { lt: 8 } }, ['min', 'seven']],
        [{ n: { gte: MAX } }, ['max']],
        [{ n: { between: [MIN, 7] } }, ['min', 'seven']],
        [{ n: { in: [MAX, 7, '9007199254740992'] } }, ['max', 'seven']],
        [{ n: { nin: [MAX, 7] } }, ['beyond', 'min', 'none']],
        [{ n: { eq: null } }, ['none']]
      ];
      for (const [where, expected] of wheres) {
        for (const e of engines) {
          expect(labels(await read(e, { where })).sort(), JSON.stringify(where)).toEqual(expected);
        }
      }
    });

    it('orders identically, and pages by cursor without losing a row', async () => {
      const expected = ['max', 'beyond', 'seven', 'min', 'none'];
      for (const e of engines) {
        expect(labels(await read(e, { orderBy: [{ n: 'desc' }] }))).toEqual(expected);
        expect(labels(await read(e, { orderBy: [{ n: 'asc' }] }))).toEqual([
          'min',
          'seven',
          'beyond',
          'max',
          'none'
        ]);
        const walked: string[] = [];
        let cursor: string | undefined;
        for (let i = 0; i < 6; i++) {
          const env = await e.query({
            frame: {
              [`${NS}/Big`]: {
                params: { orderBy: [{ n: 'desc' }], limit: 2, ...(cursor ? { cursor } : {}) },
                fields: { id: true, label: true }
              }
            },
            ctx: { identity: null }
          });
          expect(env.errors).toBeUndefined();
          walked.push(...labels(env.data[`${NS}/Big`] as Row[]));
          const page = env._pagination?.[`${NS}/Big`];
          if (page?.hasMore !== true) break;
          cursor = page.nextCursor;
        }
        expect(walked).toEqual(expected);
      }
    });
  });
});

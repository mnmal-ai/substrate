/**
 * `int16` and `int32` on memory and pg: values read back as plain numbers,
 * filters and orders select the same ids, and an expression or sum over one is
 * an exact int64, as the expression checker types it.
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
const WRITER: Identity = { kind: 'system', id: 'test', grants: { '*': ['read', 'mutate'] } };

const KINDS = [
  { kind: 'int16', bits: 15, pgType: 'smallint' },
  { kind: 'int32', bits: 31, pgType: 'integer' }
] as const;

describe.each(KINDS)('$kind field kind', ({ kind, bits, pgType }) => {
  const NS = `test_${kind}_parity`;
  const fields = {
    n: field[kind]({ nullable: true, indexed: true }),
    g: field.string(),
    label: field.string()
  };
  const lookup = (_type: string, f: string): FieldDef | undefined =>
    (fields as Record<string, FieldDef>)[f];

  const MAX = 2 ** bits - 1;
  const MIN = -(2 ** bits);

  function engineOver(ds: Dataset): Engine {
    const registry = new Registry();
    const edges = new MemoryEdgesStore({ now: () => new Date() });
    defineNamespace(NS, { Small: { fields } }).install({ registry, dataset: ds, edges });
    const datasets = new MemoryDatasetRegistry();
    datasets.set(NS, ds);
    return new Engine({
      namespaces: new Map<string, NamespaceConfig>([[NS, { registry }]]),
      datasets,
      edges
    });
  }

  async function seed(engine: Engine): Promise<void> {
    const values: Array<[string, string, number | null]> = [
      ['max', 'a', MAX],
      ['max2', 'a', MAX],
      ['min', 'b', MIN],
      ['seven', 'b', 7],
      ['neg', 'b', -3],
      ['none', 'c', null]
    ];
    const env = await engine.mutate({
      frame: {
        [`${NS}/createSmall`]: values.map(([label, g, n]) => ({
          params: { label, g, n },
          fields: { id: true }
        }))
      },
      ctx: { identity: WRITER }
    });
    expect(env.errors).toBeUndefined();
  }

  async function query(engine: Engine, params: Record<string, unknown>) {
    const env = await engine.query({
      frame: { [`${NS}/Small`]: { params, fields: { id: true, n: true, label: true } } },
      ctx: { identity: null }
    });
    return env;
  }

  async function read(engine: Engine, params: Record<string, unknown> = {}): Promise<Row[]> {
    const env = await query(engine, params);
    expect(env.errors).toBeUndefined();
    return env.data[`${NS}/Small`] as Row[];
  }

  const labels = (rows: Row[]) => rows.map((r) => String(r.label));

  it('a write that is not an int32 is refused', async () => {
    const engine = engineOver(new MemoryDataset({ namespace: NS, fieldDefLookup: lookup }));
    for (const n of [1.5, MAX + 1, MIN - 1, '7', Number.NaN]) {
      const env = await engine.mutate({
        frame: {
          [`${NS}/createSmall`]: { params: { label: 'x', g: 'x', n }, fields: { id: true } }
        },
        ctx: { identity: WRITER }
      });
      expect(env.errors?.[0]?.code, String(n)).toBe('invalid_field_type');
    }
  });

  it('a filter operand that is not an int32 is refused', async () => {
    const engine = engineOver(new MemoryDataset({ namespace: NS, fieldDefLookup: lookup }));
    for (const v of [1.5, MAX + 1, '7']) {
      const env = await query(engine, { where: { n: { gt: v } } });
      expect(env.errors?.[0]?.message, String(v)).toMatch(new RegExp(`expected an ${kind}`));
    }
  });

  // Memory always; pg too when POSTGRES_URL is set.
  describe('memory and pg agree', () => {
    let sql: ReturnType<typeof postgres> | undefined;
    const engines: Engine[] = [];

    beforeAll(async () => {
      const memory = engineOver(
        new MemoryDataset({ namespace: NS, fieldDefLookup: lookup, walkReference: true })
      );
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

    it('stores an integer column on pg', async () => {
      if (sql === undefined) return;
      const [col] = await sql<Array<{ t: string }>>`
        SELECT format_type(a.atttypid, a.atttypmod) AS t
        FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
        JOIN pg_namespace s ON s.oid = c.relnamespace
        WHERE s.nspname = current_schema() AND c.relname LIKE ${`%${NS}%`} AND a.attname = 'f_n'`;
      expect(col?.t).toBe(pgType);
    });

    it('reads identical plain numbers', async () => {
      for (const e of engines) {
        const byLabel = Object.fromEntries((await read(e)).map((r) => [r.label, r.n ?? null]));
        expect(byLabel).toEqual({ max: MAX, max2: MAX, min: MIN, seven: 7, neg: -3, none: null });
      }
    });

    it('filters and orders alike', async () => {
      const cases: Array<[Record<string, unknown>, string[]]> = [
        [
          { where: { n: { gt: 0 } }, orderBy: [{ n: 'asc' }, { label: 'asc' }] },
          ['seven', 'max', 'max2']
        ],
        [{ where: { n: { in: [MIN, 7] } }, orderBy: [{ n: 'asc' }] }, ['min', 'seven']],
        [{ where: { n: { eq: null } } }, ['none']],
        [{ where: { n: { lte: -3 } }, orderBy: [{ n: 'desc' }] }, ['neg', 'min']]
      ];
      for (const [params, want] of cases) {
        for (const e of engines)
          expect(labels(await read(e, params)), JSON.stringify(params)).toEqual(want);
      }
    });

    it('sums exactly past its range, as an int64', async () => {
      const params = {
        groupBy: { g: 'g' },
        aggregate: { s: { sum: 'n' }, t: { sum: { add: ['n', 1] } }, m: { max: 'n' } },
        orderBy: [{ g: 'asc' }]
      };
      for (const e of engines) {
        const env = await e.query({
          frame: { [`${NS}/Small`]: { params, fields: { id: true } } },
          ctx: { identity: null }
        });
        expect(env.errors).toBeUndefined();
        const groups = (env.data[`${NS}/Small`] as { groups: unknown[] }).groups;
        expect(groups).toEqual([
          { g: 'a', s: 2n * BigInt(MAX), t: 2n * BigInt(MAX) + 2n, m: BigInt(MAX) },
          { g: 'b', s: BigInt(MIN) + 4n, t: BigInt(MIN) + 7n, m: 7n },
          { g: 'c', s: null, t: null, m: null }
        ]);
      }
    });

    it('an expression over it is integer arithmetic', async () => {
      for (const e of engines) {
        const rows = await read(e, { where: { $expr: { eq: [{ add: ['n', 1] }, MAX + 1] } } });
        expect(labels(rows).sort()).toEqual(['max', 'max2']);
      }
    });
  });
});

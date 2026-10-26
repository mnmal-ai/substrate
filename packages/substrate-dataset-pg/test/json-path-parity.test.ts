/**
 * Json path predicates: memory and pg must return the SAME rows, or both
 * refuse. The fixture is deliberately mixed-type — operator-dictated
 * data is typed by conversation — and each row below exists to break one
 * plausible pg compilation.
 */

import { MemoryDataset } from '@mnmal-ai/substrate-dataset-memory';
import type { Row, WhereClause } from '@mnmal-ai/substrate-types';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  deriveListIndexMigration,
  PgDataset,
  runDerivedMigrations,
  runMigrations
} from '../src/index.js';
import { generatedIdentifier } from '../src/migrate.js';
import { buildWhere } from '../src/pg-sql.js';

const POSTGRES_URL = process.env.POSTGRES_URL;
const PARTITIONED = process.env.SUBSTRATE_STORAGE_LAYOUT === 'partitioned';
const NS = 'jpath_ns';

const ROWS: Row[] = [
  {
    id: '1',
    values: { year: 1995, done: true, genre: 'jazz', tags: ['jazz', 'live'], contains: 'x' }
  },
  { id: '2', values: { year: '1995', done: 'true', genre: 'Jazz Fusion', tags: ['rock'] } }, // strings, not numbers/booleans
  { id: '3', values: { year: 'unknown', done: false, tags: { '0': 'jazz' } } }, // would crash an unguarded ::numeric
  { id: '4', values: { year: null, genre: 'rock' } }, // explicit null
  { id: '5', values: {} }, // absent
  { id: '6', values: { year: 2001, nested: { deep: { k: 7 } } } },
  { id: '7', values: null }, // the json field itself is null
  { id: '8', other: 1 } // no json field at all: (body -> 'values') is SQL NULL
];
const ALL = ['1', '2', '3', '4', '5', '6', '7', '8'];
const not = (ids: string[]): string[] => ALL.filter((i) => !ids.includes(i));

type Outcome = { kind: 'rows'; ids: string[] } | { kind: 'refused' };

describe.skipIf(!POSTGRES_URL)('json path parity', () => {
  let sql: Sql;
  let pg: PgDataset;
  let mem: MemoryDataset;

  beforeAll(async () => {
    sql = postgres(POSTGRES_URL as string);
    await runMigrations(sql);
  });
  afterAll(async () => {
    await sql.end();
  });
  beforeEach(async () => {
    await sql`TRUNCATE TABLE rows, short_ids`;
    pg = new PgDataset({ namespace: NS, sql });
    mem = new MemoryDataset({ namespace: NS });
    await pg.write('J', ROWS);
    await mem.write('J', ROWS);
  });

  const run = async (
    ds: { read: (t: string, p: { where: WhereClause }) => Promise<{ rows: Row[] }> },
    where: WhereClause
  ): Promise<Outcome> => {
    try {
      const { rows } = await ds.read('J', { where });
      return { kind: 'rows', ids: rows.map((r) => String(r.id)).sort() };
    } catch {
      return { kind: 'refused' };
    }
  };
  const y = (pred: Record<string, unknown>): WhereClause => ({
    values: { path: ['year'], ...pred }
  });

  const mustAgree: Array<[string, WhereClause, string[]]> = [
    ['eq number is strict', y({ eq: 1995 }), ['1']],
    ['eq string is strict', y({ eq: '1995' }), ['2']],
    ['eq null = absent or null', y({ eq: null }), ['4', '5', '7', '8']],
    ['neq number', y({ neq: 1995 }), not(['1'])],
    ['neq null', y({ neq: null }), ['1', '2', '3', '6']],
    ['in', y({ in: [1995, 2001] }), ['1', '6']],
    ['in with null', y({ in: [1995, null] }), ['1', '4', '5', '7', '8']],
    ['in []', y({ in: [] }), []],
    ['in with many members', y({ in: [...Array.from({ length: 40 }, (_, i) => i), 1995] }), ['1']],
    ['nin', y({ nin: [1995] }), not(['1'])],
    ['nin []', y({ nin: [] }), ALL],
    ['gt number skips strings, never errors', y({ gt: 1990 }), ['1', '6']],
    ['gte + lt', y({ gte: 1995, lt: 2000 }), ['1']],
    ['between numbers', y({ between: [1990, 2000] }), ['1']],
    ['gt string compares strings only', y({ gt: '1990' }), ['2', '3']],
    ['contains is case-insensitive', { values: { path: ['genre'], contains: 'JAZZ' } }, ['1', '2']],
    ['startsWith', { values: { path: ['genre'], startsWith: 'ro' } }, ['4']],
    ['endsWith', { values: { path: ['genre'], endsWith: 'ION' } }, ['2']],
    ['boolean eq is strict', { values: { path: ['done'], eq: true } }, ['1']],
    ['has needs an array', { values: { path: ['tags'], has: 'jazz' } }, ['1']],
    [
      '"0" is an object key, never an array index',
      { values: { path: ['tags', '0'], eq: 'jazz' } },
      ['3']
    ],
    ['a data key named contains', { values: { path: ['contains'], eq: 'x' } }, ['1']],
    ['three levels deep', { values: { path: ['nested', 'deep', 'k'], gt: 5 } }, ['6']],
    ['hop through a scalar is absent', { values: { path: ['year', 'x'], eq: null } }, ALL],
    ['NOT around a guarded range', { NOT: y({ gt: 1990 }) }, not(['1', '6'])],
    [
      'NOT around a guarded text op',
      { NOT: { values: { path: ['genre'], contains: 'jazz' } } },
      not(['1', '2'])
    ],
    [
      'AND of two paths',
      { AND: [y({ gte: 1990 }), { values: { path: ['done'], eq: true } }] },
      ['1']
    ],
    ['NOT around containment on a row with no json field', { NOT: y({ eq: 1995 }) }, not(['1'])],
    [
      'OR of two paths',
      { OR: [y({ eq: 2001 }), { values: { path: ['genre'], eq: 'rock' } }] },
      ['4', '6']
    ]
  ];

  for (const [name, where, expected] of mustAgree) {
    it(`both backends apply: ${name}`, async () => {
      const want = { kind: 'rows', ids: expected.slice().sort() };
      expect(await run(pg, where), 'pg').toEqual(want);
      expect(await run(mem, where), 'memory').toEqual(want);
    });
  }

  const mustRefuse: Array<[string, WhereClause]> = [
    ['empty path', { values: { path: [], eq: 1 } }],
    ['non-string segment', { values: { path: [1], eq: 1 } } as WhereClause],
    ['path with no operator', { values: { path: ['year'] } }],
    ['range on a boolean', y({ gt: true })],
    ['eq on an object', y({ eq: { a: 1 } })],
    ['unknown operator', y({ bogus: 1 })],
    ['mixed-type between', y({ between: [1, 'b'] })],
    ['Date operand', y({ gt: new Date('2020-01-01') })],
    // pg would read NaN as null (JSON.stringify) and return the explicit-null row.
    ['NaN operand', y({ eq: Number.NaN })],
    ['Infinity in a range', y({ lt: Number.POSITIVE_INFINITY })],
    // Past this pg's bind-parameter ceiling would throw while memory answered.
    ['in past the member cap', y({ in: Array.from({ length: 10_001 }, (_, i) => i) })]
  ];

  for (const [name, where] of mustRefuse) {
    it(`both backends refuse: ${name}`, async () => {
      expect(await run(pg, where), 'pg').toEqual({ kind: 'refused' });
      expect(await run(mem, where), 'memory').toEqual({ kind: 'refused' });
    });
  }

  // `field.json({ indexed: true })` derives the same per-field GIN a list
  // field gets (there is no whole-body GIN), so the containment must be
  // written against `(body -> field)` to match it. On the partitioned layout
  // the reconciler builds it on the type's partition, under the same name.
  it('eq and has are served by the derived per-field GIN', async () => {
    if (PARTITIONED) {
      await new PgDataset({
        namespace: NS,
        sql,
        typeDefLookup: () => ({
          fields: { values: { kind: 'scalar', type: 'json', indexed: true } }
        })
      }).ensureTypeStorage('J');
    } else {
      await runDerivedMigrations(sql, [
        deriveListIndexMigration({ namespace: NS, type: 'J', field: 'values' })
      ]);
    }
    await pg.write(
      'J',
      Array.from({ length: 2000 }, (_, i) => ({
        id: `bulk${i}`,
        values: { year: i, tags: [`t${i}`] }
      }))
    );
    await sql`ANALYZE rows`;
    for (const where of [
      y({ eq: 7 }),
      { values: { path: ['tags'], has: 't7' } }
    ] as WhereClause[]) {
      const plan = await sql.begin(async (tx) => {
        await tx`SET LOCAL enable_seqscan = off`;
        const frag = buildWhere(
          tx,
          where,
          () => null,
          () => undefined
        );
        return tx`EXPLAIN SELECT id FROM rows
                  WHERE namespace = ${NS} AND type = 'J' AND deleted_at IS NULL AND ${frag!}`;
      });
      const text = plan.map((r) => String(r['QUERY PLAN'])).join('\n');
      expect(text, text).toContain(generatedIdentifier(NS, 'J', 'values', 'gin'));
    }
  });
});

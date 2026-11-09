/**
 * The Postgres expression compiler against the memory evaluator: every case of
 * the shared corpus, and every accepted regex against a set of subjects, must
 * give the same answer on both engines.
 */

import { evalExpr } from '@mnmal-ai/substrate-filter';
import type { Expr, ExprType } from '@mnmal-ai/substrate-types';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EXPR_CORPUS } from '../../substrate-filter/test/fixtures/expr-corpus.js';
import { ACCEPTED } from '../../substrate-filter/test/fixtures/regex-corpus.js';
import { compileExprTyped } from '../src/pg-sql/expression.js';
import { utcTextSql } from '../src/pg-sql/primitives.js';
import type { ColumnKind, TypeTable } from '../src/type-table.js';

const POSTGRES_URL = process.env.POSTGRES_URL;
const KINDS: Record<string, ColumnKind> = {
  s: 'text',
  n: 'number',
  d: 'date',
  big: 'int64',
  i: 'int64',
  x: 'number'
};
const SQL_TYPE: Partial<Record<ColumnKind, string>> = {
  text: 'text COLLATE "C"',
  number: 'float8',
  date: 'timestamptz',
  int64: 'bigint'
};

const table: TypeTable = {
  namespace: 'ns',
  type: 'Scratch',
  from: 'expr_scratch',
  jsonb: 'extra',
  column: (f) =>
    Object.hasOwn(KINDS, f)
      ? { field: f, column: f, kind: KINDS[f] as ColumnKind, state: 'column' }
      : undefined,
  columns: () => [],
  pending: [],
  orphaned: [],
  version: '0'
};
const ctx = {
  table,
  alias: 'r',
  fieldType: (f: string): ExprType | undefined => (f === 'constructor' ? 'string' : undefined)
};

describe.skipIf(!POSTGRES_URL)('expression compiler parity', () => {
  let sql: postgres.Sql;
  beforeAll(async () => {
    sql = postgres(POSTGRES_URL as string, { max: 1, onnotice: () => {} });
    await sql.unsafe(
      `CREATE TEMP TABLE expr_scratch (id int, ${Object.entries(KINDS)
        .map(([f, k]) => `${f} ${SQL_TYPE[k]}`)
        .join(', ')}, extra jsonb NOT NULL DEFAULT '{}')`
    );
  });
  afterAll(() => sql?.end());

  /** Runs `expr` over `row` on pg and returns the value as the evaluator would. */
  async function onPg(expr: Expr, row: Record<string, unknown>): Promise<unknown> {
    await sql.unsafe('DELETE FROM expr_scratch');
    const cols = Object.keys(row).filter((k) => Object.hasOwn(KINDS, k));
    const vals = cols.map((k) => (row[k] === null || row[k] === undefined ? null : String(row[k])));
    await sql.unsafe(
      `INSERT INTO expr_scratch (id${cols.map((c) => `, ${c}`).join('')}) VALUES (1${cols.map((_, i) => `, $${i + 1}`).join('')})`,
      vals as string[]
    );
    const { fragment, type } = compileExprTyped(sql, expr, ctx);
    const out = type === 'date' ? sql.unsafe(utcTextSql('v', 'MS')) : sql.unsafe('v');
    const [r] = await sql`SELECT ${out} AS v FROM (SELECT ${fragment} AS v FROM expr_scratch r) q`;
    const v = (r as { v: unknown }).v;
    return type === 'int64' && v !== null ? BigInt(v as string) : v;
  }

  for (const c of EXPR_CORPUS) {
    it(c.name, async () => {
      expect(evalExpr(c.expr, c.row)).toEqual(c.expected);
      expect(await onPg(c.expr, c.row)).toEqual(c.expected);
    });
  }

  const EXTRA: Array<[string, Expr, Record<string, unknown>]> = [
    [
      'int64 beside number compares exactly',
      { gt: ['big', 9223372036854775000] },
      { big: 9223372036854775800n }
    ],
    ['int64 equals int literal', { eq: ['i', 5] }, { i: 5n }],
    [
      'case unifies int64 and a literal',
      { case: [[{ isNull: ['n'] }, 'i'], 0] } as Expr,
      { i: 5n }
    ],
    ['large mul within range', { mul: [1e150, 1e150] }, {}],

    ['int64 below a tie-rounded double', { lt: ['big', 2 ** 63] }, { big: 9223372036854775807n }],
    [
      'double beside an int64 above 2^53',
      { lt: [9007199254740992, 'big'] },
      { big: 9007199254740993n }
    ],
    ['div int64 operands', { div: ['big', 'i'] }, { big: 9223372036854775800n, i: 3n }],
    ['string compare is byte order', { lt: [{ lit: 'Z' }, { lit: 'a' }] }, {}],
    ['upper of a C-collated column', { upper: ['s'] }, { s: 'àb' }],

    [
      'regexpReplace without a match',
      { regexpReplace: [{ lit: 'abc' }, { lit: 'z' }, { lit: 'y' }] },
      {}
    ],
    ['in over strings', { in: ['s', { lit: 'a' }, { lit: 'b' }] }, { s: 'b' }]
  ];
  for (const [name, expr, row] of EXTRA) {
    it(`extra: ${name}`, async () => {
      expect(await onPg(expr, row)).toEqual(evalExpr(expr, row));
    });
  }

  it('random doubles: add, sub, mul and div agree bit for bit', async () => {
    let seed = 7;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const pick = () => (rnd() < 0.5 ? -1 : 1) * rnd() * 10 ** Math.floor(rnd() * 40 - 20);
    for (let k = 0; k < 150; k++) {
      const [p, q] = [pick(), pick()];
      for (const fn of ['add', 'sub', 'mul', 'div']) {
        const expr: Expr = { [fn]: [p, q] };
        expect(await onPg(expr, {}), `${fn} ${p} ${q}`).toEqual(evalExpr(expr, {}));
      }
    }
  });

  it('float8 overflow and underflow raise on both engines', async () => {
    for (const [expr, msg] of [
      [{ mul: [1e200, 1e200] }, 'value out of range: overflow'],
      [{ mul: [1e-200, 1e-200] }, 'value out of range: underflow']
    ] as Array<[Expr, string]>) {
      expect(() => evalExpr(expr, {})).toThrow(msg);
      await expect(onPg(expr, {})).rejects.toThrow(msg);
    }
  });

  it('mod is int64 only, with a zero divisor null', async () => {
    expect(await onPg({ mod: ['big', 7] }, { big: 9223372036854775800n })).toBe(
      evalExpr({ mod: ['big', 7] }, { big: 9223372036854775800n })
    );
    expect(await onPg({ mod: ['i', 'i'] }, { i: 0n })).toBeNull();
  });

  it('an aggregate output keeps its own aggregate: div(sum, count) over groups', async () => {
    await sql.unsafe('DELETE FROM expr_scratch');
    await sql.unsafe('INSERT INTO expr_scratch (id, x) SELECT 1, g FROM generate_series(1, 10) g');
    const outputs = new Map([
      ['s', sql`sum(r.x)`],
      ['c', sql`count(*)`]
    ]);
    const { fragment } = compileExprTyped(
      sql,
      { div: ['s', 'c'] },
      { ...ctx, outputs, fieldType: (f) => (f === 's' || f === 'c' ? 'number' : undefined) }
    );
    const rows = await sql`SELECT ${fragment} AS v FROM expr_scratch r GROUP BY r.id`;
    expect(rows.map((r) => r.v)).toEqual([5.5]);
  });

  it('a trailing LIKE escape in a non-literal pattern raises too', async () => {
    const expr: Expr = { like: [{ lit: 'a' }, 's'] };
    expect(() => evalExpr(expr, { s: 'a\\' })).toThrow('must not end with escape');
    await expect(onPg(expr, { s: 'a\\' })).rejects.toThrow('must not end with escape');
    expect(await onPg(expr, { s: 'a%' })).toBe(true);
  });

  it('int64 overflow raises', async () => {
    await expect(onPg({ add: [{ int64: '9223372036854775807' }, 1] }, {})).rejects.toThrow(
      /out of range/
    );
  });

  it('a trailing LIKE escape raises the same message on both engines', async () => {
    const expr: Expr = { like: [{ lit: 'a' }, { lit: 'a\\' }] };
    expect(() => evalExpr(expr, {})).toThrow('LIKE pattern must not end with escape character');
    await expect(onPg(expr, {})).rejects.toThrow('LIKE pattern must not end with escape character');
  });

  const SUBJECTS = [
    '',
    'ab',
    'abab',
    'aab',
    'a\nb',
    'https://www.example.com/x',
    'x{2}',
    '😀',
    'xx',
    'a.b',
    '-a',
    'line one\nline two'
  ];
  it('every accepted regex matches the same subjects on both engines', async () => {
    for (const pattern of ACCEPTED) {
      for (const subject of SUBJECTS) {
        const expr: Expr = { regexpMatch: [{ lit: subject }, { lit: pattern }] };
        expect(
          await onPg(expr, {}),
          `${JSON.stringify(pattern)} on ${JSON.stringify(subject)}`
        ).toBe(evalExpr(expr, {}));
      }
    }
  });
});

/**
 * Memory vs pg substrate parity for where-clauses.
 *
 * `apps/substrate/test/cross-server-parity.test.ts` compares two TRANSPORTS over
 * the SAME dataset, so it cannot see a divergence between SUBSTRATES; this
 * file covers that axis. A silently dropped predicate returns every row, and a
 * silently failing one returns `[]`, which is indistinguishable from a true
 * negative.
 *
 * The rule this pins: for any where-clause, both substrates must return the
 * SAME row set, or both must REFUSE. Never one of each, and never a silent
 * answer to a filter that could not be applied.
 */

import { MemoryDataset } from '@mnmal-ai/substrate-dataset-memory';
import type { FieldDef, Row, RowMetadata, WhereClause } from '@mnmal-ai/substrate-types';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PgDataset, runMigrations } from '../src/index.js';
import { addTestPromotedColumns, dropTestPromotedColumns, TEST_PROMOTED } from './_promoted.js';

const POSTGRES_URL = process.env.POSTGRES_URL;

/**
 * `project`, `status` and `priority` are body-PROMOTED columns on pg (they get
 * real columns, not JSONB body extraction) and plain body fields in memory.
 * That asymmetry is exactly where the operator support drifted apart, so the
 * fixtures exercise promoted and non-promoted string fields side by side.
 */
const md = (id: string): RowMetadata => ({
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  createdBy: { kind: 'agent', id },
  updatedBy: { kind: 'agent', id }
});

const ROWS: Row[] = [
  {
    id: '1',
    _metadata: md('alice'),
    project: 'substrate',
    status: 'open',
    priority: 'high',
    title: 'alpha',
    owner: 'rich',
    meta: { region: 'eu-west', tier: { name: 'gold' } }
  },
  {
    id: '2',
    _metadata: md('bob'),
    project: 'labs',
    status: 'open',
    priority: 'low',
    title: 'beta',
    owner: 'labs',
    meta: { region: 'us-east', tier: { name: 'silver' } }
  },
  {
    id: '3',
    _metadata: md('alice'),
    project: 'holomap',
    status: 'done',
    priority: 'high',
    title: 'gamma',
    owner: 'rich',
    meta: { region: 'eu-west', tier: { name: 'gold' } }
  }
];

type Outcome = { kind: 'rows'; ids: string[] } | { kind: 'refused' };

describe.skipIf(!POSTGRES_URL)('backend filter parity', () => {
  let sql: Sql;
  let pg: PgDataset;
  let mem: MemoryDataset;

  beforeAll(async () => {
    sql = postgres(POSTGRES_URL as string);
    await runMigrations(sql);
    await addTestPromotedColumns(sql);
  });

  afterAll(async () => {
    await dropTestPromotedColumns(sql);
    await sql.end();
  });

  beforeEach(async () => {
    await sql`TRUNCATE TABLE rows, short_ids`;
    pg = new PgDataset({ namespace: 'parity_ns', sql, promotedColumns: TEST_PROMOTED });
    mem = new MemoryDataset({ namespace: 'parity_ns' });
    await pg.write('P', ROWS);
    await mem.write('P', ROWS);
  });

  const run = async (
    ds: { read: (t: string, p: { where: WhereClause }) => Promise<{ rows: Row[] }> },
    where: WhereClause
  ): Promise<Outcome> => {
    try {
      const { rows } = await ds.read('P', { where });
      return { kind: 'rows', ids: rows.map((r) => String(r.id)).sort() };
    } catch {
      return { kind: 'refused' };
    }
  };

  /**
   * Filters both substrates must APPLY, agreeing on the result. The string
   * operators on `project` / `status` / `priority` exercise pg's promoted-column
   * path, where a dropped predicate would match every row.
   */
  const mustAgree: Array<[string, WhereClause, string[]]> = [
    ['project eq', { project: { eq: 'substrate' } }, ['1']],
    ['project in', { project: { in: ['substrate', 'labs'] } }, ['1', '2']],
    ['project contains — the reported bug', { project: { contains: 'ubs' } }, ['1']],
    ['project contains, no match', { project: { contains: 'no-such-project' } }, []],
    ['project startsWith', { project: { startsWith: 'ho' } }, ['3']],
    ['project endsWith', { project: { endsWith: 'bs' } }, ['2']],
    ['project gt', { project: { gt: 'substrate' } }, []],
    ['project gte', { project: { gte: 'substrate' } }, ['1']],
    ['project between', { project: { between: ['a', 'sz'] } }, ['1', '2', '3']],
    ['status contains', { status: { contains: 'pen' } }, ['1', '2']],
    ['priority startsWith', { priority: { startsWith: 'hi' } }, ['1', '3']],
    // Non-promoted body fields — a control, so a regression here is
    // distinguishable from a promoted-column one.
    ['title contains (body field)', { title: { contains: 'et' } }, ['2']],
    ['owner in (body field)', { owner: { in: ['rich'] } }, ['1', '3']],
    // Empty-array membership: separate pg builders (id, promoted, shortId) each
    // handle it, and dropping the predicate would match everything.
    ['in: [] matches nothing', { project: { in: [] } }, []],
    ['id in: [] matches nothing', { id: { in: [] } }, []],
    ['nin: [] excludes nothing', { project: { nin: [] } }, ['1', '2', '3']],
    // crossRef membership. Stored as a plain id, so membership is as
    // meaningful as equality.
    ['owner nin', { owner: { nin: ['labs'] } }, ['1', '3']],
    // `neq` on a crossRef-shaped field — the same predicate as `nin: ['x']`.
    ['owner neq', { owner: { neq: 'labs' } }, ['1', '3']],
    // Nested-struct sub-clauses. The validator permits these (it recurses on
    // `kind === 'struct'`), so both substrates must honour them.
    ['struct eq', { meta: { region: { eq: 'eu-west' } } }, ['1', '3']],
    ['struct contains', { meta: { region: { contains: 'us-' } } }, ['2']],
    ['struct in', { meta: { region: { in: ['us-east'] } } }, ['2']],
    ['struct, two levels deep', { meta: { tier: { name: { eq: 'silver' } } } }, ['2']],
    [
      'struct sub-clauses AND together',
      { meta: { region: { eq: 'eu-west' }, tier: { name: { eq: 'gold' } } } },
      ['1', '3']
    ],
    [
      'struct alongside a top-level field',
      { project: { eq: 'substrate' }, meta: { region: { eq: 'eu-west' } } },
      ['1']
    ],
    ['struct with no match', { meta: { region: { eq: 'ap-south' } } }, []],
    // A field key beside a combinator ANDs with it; it is not dropped.
    [
      'field key beside OR',
      {
        project: { eq: 'substrate' },
        OR: [{ status: { eq: 'open' } }, { status: { eq: 'done' } }]
      },
      ['1']
    ],
    // LIKE wildcards in an id operand are literal: `_` is not "any character".
    ['id contains a wildcard', { id: { contains: '_' } }, []],
    ['id startsWith %', { id: { startsWith: '%' } }, []],
    // Byte order, whatever the database collation: every lowercase title sorts
    // after 'B'.
    ['body string gt', { title: { gt: 'B' } }, ['1', '2', '3']],
    ['body string between', { title: { between: ['B', 'b'] } }, ['1']],
    // A number operand against a string value is a non-match, not a cast error.
    ['number eq on a string field', { owner: { eq: 5 } }, []],
    ['number neq on a string field', { owner: { neq: 5 } }, ['1', '2', '3']],
    ['mixed number and string in', { owner: { in: [5, 'rich'] } }, ['1', '3']],
    ['mixed number and string nin', { owner: { nin: [5, 'rich'] } }, ['2']],
    // Metadata columns: empty membership and null elements, as on body fields.
    ['metadata in: [] matches nothing', { createdById: { in: [] } }, []],
    ['metadata nin: [] excludes nothing', { createdById: { nin: [] } }, ['1', '2', '3']],
    ['metadata in: [] under OR', { OR: [{ createdById: { in: [] } }] }, []],
    ['metadata in', { createdById: { in: ['alice'] } }, ['1', '3']],
    ['metadata nin', { createdById: { nin: ['alice'] } }, ['2']],
    ['metadata in: [null] on a set column', { createdById: { in: [null] } }, []],
    ['metadata in with a null element', { createdById: { in: [null, 'bob'] } }, ['2']],
    ['metadata in with only a number', { createdById: { in: [5] } }, []],
    ['metadata timestamp in: []', { createdAt: { in: [] } }, []],
    ['metadata timestamp nin: []', { createdAt: { nin: [] } }, ['1', '2', '3']]
  ];

  for (const [name, where, expected] of mustAgree) {
    it(`both backends apply: ${name}`, async () => {
      const p = await run(pg, where);
      const m = await run(mem, where);
      expect(p, 'pg refused a filter it should apply').toEqual({
        kind: 'rows',
        ids: expected.slice().sort()
      });
      expect(m, 'memory refused a filter it should apply').toEqual({
        kind: 'rows',
        ids: expected.slice().sort()
      });
    });
  }

  /**
   * Filters neither substrate can honour. The contract is REFUSAL — not an
   * empty list, not an unfiltered list.
   */
  const mustRefuse: Array<[string, WhereClause]> = [
    ['unknown operator on a promoted column', { project: { bogusOp: 'x' } } as WhereClause],
    ['unknown operator on a body field', { title: { bogusOp: 'x' } } as WhereClause],
    ['bare value instead of a predicate object', { project: 'substrate' } as WhereClause],
    ['in given a string', { project: { in: 'substrate' } } as WhereClause],
    ['between given one element', { project: { between: ['a'] } } as WhereClause],
    ['contains given a number', { title: { contains: 42 } } as WhereClause],
    // A typo INSIDE a struct sub-clause is still a bad operator, not a deeper
    // struct — the bare operand gives it away on both substrates.
    [
      'bad operator inside a struct sub-clause',
      { meta: { region: { bogusOp: 'x' } } } as WhereClause
    ]
  ];

  for (const [name, where] of mustRefuse) {
    it(`both backends refuse: ${name}`, async () => {
      const p = await run(pg, where);
      const m = await run(mem, where);
      expect(p, 'pg answered a filter it cannot honour').toEqual({ kind: 'refused' });
      expect(m, 'memory answered a filter it cannot honour').toEqual({ kind: 'refused' });
    });
  }

  /**
   * The empty-collection case, which the per-row evaluator cannot reach. It is
   * the more dangerous half, not the lesser one: `[]` from a collection that
   * really is empty is the most believable result there is, so a filter that
   * silently could not be applied leaves nothing at all to notice.
   */
  it('both backends refuse an unhonourable filter even when there is nothing to filter', async () => {
    await sql`TRUNCATE TABLE rows, short_ids`;
    const emptyPg = new PgDataset({ namespace: 'parity_ns', sql, promotedColumns: TEST_PROMOTED });
    const emptyMem = new MemoryDataset({ namespace: 'parity_ns' });

    for (const where of [
      { project: { in: 'substrate' } },
      { project: { between: ['a'] } },
      { title: { contains: 42 } },
      { project: { bogusOp: 'x' } }
    ] as WhereClause[]) {
      expect(await run(emptyPg, where), 'pg answered on an empty table').toEqual({
        kind: 'refused'
      });
      expect(await run(emptyMem, where), 'memory answered on an empty store').toEqual({
        kind: 'refused'
      });
    }
  });

  /**
   * The exact boundary of substrate-level refusal, pinned so it stays a
   * decision rather than becoming a surprise.
   *
   * `{ project: { bogusOp: { eq: 'x' } } }` is structurally identical to the
   * legitimate nested-struct filter `{ address: { city: { eq: 'x' } } }`.
   * Two things can still resolve it, and memory uses whichever it has:
   *
   *   a ROW    — 'substrate' is a string, so no nested struct can apply, so those
   *              keys were operators and none is recognised. Refused.
   *   NOTHING  — an empty collection offers no value to contradict the struct
   *              reading, so memory declines to guess rather than break every
   *              struct filter.
   *
   * pg refuses either way: `project` is a promoted column, which cannot be
   * struct-nested, so its keys are read as operators.
   *
   * The empty-collection asymmetry is acceptable ONLY because the filter
   * validator, which holds the schema and so can always decide, rejects unknown
   * operators upstream on every path it runs.
   */
  it('resolves an operator-shaped typo from the row, and defers to the validator without one', async () => {
    const where = { project: { bogusOp: { eq: 'x' } } } as WhereClause;

    // With rows present, both substrates decide it.
    expect(await run(pg, where)).toEqual({ kind: 'refused' });
    expect(await run(mem, where)).toEqual({ kind: 'refused' });

    // With nothing to decide against, memory defers.
    await sql`TRUNCATE TABLE rows, short_ids`;
    expect(
      await run(
        new PgDataset({ namespace: 'parity_ns', sql, promotedColumns: TEST_PROMOTED }),
        where
      )
    ).toEqual({
      kind: 'refused'
    });
    expect(await run(new MemoryDataset({ namespace: 'parity_ns' }), where)).toEqual({
      kind: 'rows',
      ids: []
    });
  });

  it('pg refuses a non-number shortId operand rather than dropping it', async () => {
    for (const op of ['eq', 'neq', 'gt', 'gte', 'lt', 'lte']) {
      expect(await run(pg, { shortId: { [op]: '5' } } as WhereClause), op).toEqual({
        kind: 'refused'
      });
    }
    expect(await run(pg, { shortId: { between: [1, '9'] } } as WhereClause)).toEqual({
      kind: 'refused'
    });
  });

  /**
   * Wrong-shaped stored values under declared kinds: `n` is a number field and
   * `at` a date field, and `e1` holds a string in `n` and an impossible day in `at`. Such a value reads as
   * NULL on pg (substrate_num / substrate_ts) and never matches on either
   * substrate, inside a NOT included.
   */
  describe('wrong-shaped values under declared kinds', () => {
    const lookup = (_type: string, field: string): FieldDef | undefined =>
      field === 'n'
        ? { kind: 'scalar', type: 'number' }
        : field === 'at'
          ? { kind: 'scalar', type: 'date' }
          : undefined;
    const EDGE_ROWS: Row[] = [
      { id: 'e1', n: 'abc', at: '2026-02-30 10:00', "o'neil": 'x' },
      { id: 'e2', n: 5, at: '2026-10-24T10:00:00Z' },
      { id: 'e3', n: 0.5, at: '2026-10-23T10:00:00Z' }
    ];
    let epg: PgDataset;
    let emem: MemoryDataset;

    beforeEach(async () => {
      epg = new PgDataset({ namespace: 'parity_edge', sql, fieldDefLookup: lookup });
      emem = new MemoryDataset({ namespace: 'parity_edge', fieldDefLookup: lookup });
      await epg.write('E', EDGE_ROWS);
      await emem.write('E', EDGE_ROWS);
    });

    const edgeCases: Array<[string, WhereClause, string[]]> = [
      ['number gt over a string value', { n: { gt: 1 } }, ['e2']],
      ['NOT number gt over a string value', { NOT: { n: { gt: 1 } } }, ['e1', 'e3']],
      ['impossible date under gte', { at: { gte: '2026-10-24T00:00:00Z' } }, ['e2']],
      [
        'NOT impossible date under gte',
        { NOT: { at: { gte: '2026-10-24T00:00:00Z' } } },
        ['e1', 'e3']
      ],
      ['impossible date under eq', { at: { eq: '2026-10-24T10:00:00Z' } }, ['e2']],
      ['quoted field name', { "o'neil": { eq: 'x' } }, ['e1']],
      // Operands read as stored values do: no offset is UTC.
      ['date-only operand', { at: { gt: '2026-10-24' } }, ['e2']],
      ['offset-less operand', { at: { lt: '2026-10-23 22:00' } }, ['e3']]
    ];

    for (const [name, where, expected] of edgeCases) {
      it(`both backends apply: ${name}`, async () => {
        for (const ds of [epg, emem]) {
          const { rows } = await ds.read('E', { where });
          expect(rows.map((r) => String(r.id)).sort(), ds === epg ? 'pg' : 'memory').toEqual(
            expected
          );
        }
      });
    }

    // A wrong-shaped value sorts as NULL: last, in both directions.
    const sorts: Array<[string, 'asc' | 'desc', string[]]> = [
      ['n', 'asc', ['e3', 'e2', 'e1']],
      ['n', 'desc', ['e2', 'e3', 'e1']],
      ['at', 'asc', ['e3', 'e2', 'e1']],
      ['at', 'desc', ['e2', 'e3', 'e1']]
    ];
    for (const [field, dir, expected] of sorts) {
      it(`both backends sort ${field} ${dir} with a wrong-shaped value last`, async () => {
        for (const ds of [epg, emem]) {
          const { rows } = await ds.read('E', { orderBy: [{ [field]: dir }] });
          expect(
            rows.map((r) => r.id),
            ds === epg ? 'pg' : 'memory'
          ).toEqual(expected);
        }
      });
    }
  });

  it('both backends sort body strings in byte order', async () => {
    const rows: Row[] = [
      { id: 's1', title: 'b' },
      { id: 's2', title: 'C' },
      { id: 's3', title: 'a' }
    ];
    await pg.write('S', rows);
    await mem.write('S', rows);
    for (const ds of [pg, mem]) {
      const { rows: out } = await ds.read('S', { orderBy: [{ title: 'asc' }] });
      expect(out.map((r) => r.id)).toEqual(['s2', 's3', 's1']);
    }
  });

  it('refusal carries an actionable code and names the field', async () => {
    await expect(
      pg.read('P', { where: { project: { bogusOp: 'x' } } as WhereClause })
    ).rejects.toMatchObject({
      code: 'unsupported_filter',
      details: { field: 'project', operator: 'bogusOp' }
    });
    await expect(
      mem.read('P', { where: { title: { bogusOp: 'x' } } as WhereClause })
    ).rejects.toMatchObject({
      code: 'unsupported_filter',
      details: { field: 'title', operator: 'bogusOp' }
    });
  });
});

/**
 * Null-bearing parity.
 *
 * The fixture above carries no NULLs, so it cannot see null handling — e.g.
 * `<> ALL(...)` evaluates to NULL, and so excludes, when the left side is
 * NULL, while the in-memory evaluator's `!operand.some(...)` admits it. A
 * separate fixture keeps the expected ids in `mustAgree` unchanged.
 *
 * The property under test is a PARTITION: `eq`/`neq` and `in`/`nin` must each
 * cover every row exactly once, on both substrates. A null row falling through
 * both halves is the shape of every bug this block guards.
 */
describe.skipIf(!POSTGRES_URL)('backend filter parity over NULL values', () => {
  let sql: Sql;
  let pg: PgDataset;
  let mem: MemoryDataset;

  const NULL_ROWS: Row[] = [
    { id: 'n1', project: 'substrate', owner: 'rich' },
    { id: 'n2', project: null, owner: null },
    { id: 'n3', project: 'labs', owner: 'labs' }
  ];

  beforeAll(async () => {
    sql = postgres(POSTGRES_URL as string);
    await runMigrations(sql);
    await addTestPromotedColumns(sql);
  });
  afterAll(async () => {
    await dropTestPromotedColumns(sql);
    await sql.end();
  });
  beforeEach(async () => {
    await sql`TRUNCATE TABLE rows, short_ids`;
    pg = new PgDataset({ namespace: 'parity_null_ns', sql, promotedColumns: TEST_PROMOTED });
    mem = new MemoryDataset({ namespace: 'parity_null_ns' });
    await pg.write('P', NULL_ROWS);
    await mem.write('P', NULL_ROWS);
  });

  const ids = async (
    ds: { read: (t: string, p: { where: WhereClause }) => Promise<{ rows: Row[] }> },
    where: WhereClause
  ): Promise<string[]> => {
    const { rows } = await ds.read('P', { where });
    return rows.map((r) => String(r.id)).sort();
  };

  // `project` is a body-PROMOTED column on pg and a plain body key in memory;
  // `owner` is a plain body key on both. Both are exercised because the two pg
  // storage paths handle nulls by different routes.
  const cases: Array<[string, WhereClause, string[]]> = [
    ['project neq admits null', { project: { neq: 'substrate' } }, ['n2', 'n3']],
    ['project nin admits null', { project: { nin: ['substrate'] } }, ['n2', 'n3']],
    ['project eq null', { project: { eq: null } }, ['n2']],
    ['project neq null', { project: { neq: null } }, ['n1', 'n3']],
    ['project in excludes null', { project: { in: ['substrate', 'labs'] } }, ['n1', 'n3']],
    ['owner neq admits null (body field)', { owner: { neq: 'rich' } }, ['n2', 'n3']],
    ['owner nin admits null (body field)', { owner: { nin: ['rich'] } }, ['n2', 'n3']],
    ['owner in with null (body field)', { owner: { in: ['rich', null] } }, ['n1', 'n2']],
    ['owner nin with null (body field)', { owner: { nin: ['rich', null] } }, ['n3']],
    ['project in with null', { project: { in: ['substrate', null] } }, ['n1', 'n2']]
  ];

  for (const [name, where, expected] of cases) {
    it(`${name} — both backends`, async () => {
      expect(await ids(pg, where)).toEqual(expected);
      expect(await ids(mem, where)).toEqual(expected);
    });
  }

  it('eq/neq and in/nin each partition every row, on both backends', async () => {
    for (const [label, ds] of [
      ['pg', pg],
      ['memory', mem]
    ] as const) {
      const eq = await ids(ds, { project: { eq: 'substrate' } });
      const neq = await ids(ds, { project: { neq: 'substrate' } });
      expect({ label, ids: [...eq, ...neq].sort() }).toEqual({
        label,
        ids: ['n1', 'n2', 'n3']
      });

      const inSet = await ids(ds, { project: { in: ['substrate'] } });
      const ninSet = await ids(ds, { project: { nin: ['substrate'] } });
      expect({ label, ids: [...inSet, ...ninSet].sort() }).toEqual({
        label,
        ids: ['n1', 'n2', 'n3']
      });
    }
  });
});

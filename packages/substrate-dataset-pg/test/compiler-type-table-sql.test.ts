/**
 * The SQL the compiler emits over a `TypeTable` (typed-tables Task 10): a
 * column field compares on its column, a `promoting` or `orphaned` one on its
 * `extra` key while present (the precedence `decodeRow` reads by), everything
 * else on `extra`, and a walk reads each far type from its own table. On
 * `rowsTypeTable` the text is today's, which the existing SQL suites pin.
 *
 * Pure: nothing connects to a database.
 */

import type { FieldDef, WhereClause } from '@mnmal-ai/substrate-types';
import postgres from 'postgres';
import { afterAll, describe, expect, it } from 'vitest';
import { columnName, typeTableName } from '../src/layout.js';
import { resolvePromotedColumns } from '../src/pg-sql/primitives.js';
import { buildRowProjection } from '../src/pg-sql/projection.js';
import { buildOrderBy, buildSortKeyProjection } from '../src/pg-sql/sorting.js';
import { tableLookup, walkScope, walkTypes } from '../src/pg-sql/walk.js';
import { buildWhere } from '../src/pg-sql/where.js';
import { decodeRow } from '../src/row-codec.js';
import { ident } from '../src/type-storage.js';
import {
  type ColumnKind,
  rowsTypeTable,
  type TypedColumn,
  type TypeTable
} from '../src/type-table.js';

const sql = postgres('postgres://nobody@127.0.0.1:1/none');
afterAll(() => sql.end());

interface QueryParts {
  strings: readonly string[];
  args: readonly unknown[];
}
const isQuery = (v: unknown): v is QueryParts =>
  typeof v === 'object' && v !== null && 'strings' in v && 'args' in v;
/** Fragment → SQL text, with every bound value shown as `$`. */
function render(q: unknown): string {
  if (!isQuery(q)) return '$';
  let out = q.strings[0] ?? '';
  for (let i = 1; i < q.strings.length; i++) {
    const v = q.args[i - 1];
    out +=
      Array.isArray(v) && v.length > 0 && isQuery(v[0])
        ? v.map((x) => ` ${render(x)}`).join('')
        : render(v);
    out += q.strings[i];
  }
  return out;
}

const NS = 'ns';

/** A type table as `loadTypeTable` describes one. */
function typed(
  type: string,
  cols: Array<[string, ColumnKind, TypedColumn['state']?]>,
  pending: string[] = []
): TypeTable {
  const columns: TypedColumn[] = cols.map(([field, kind, state = 'column']) => ({
    field,
    column: columnName(field),
    kind,
    state
  }));
  const byField = new Map(columns.map((c) => [c.field, c]));
  return {
    namespace: NS,
    type,
    from: ident(typeTableName(NS, type)),
    jsonb: 'extra',
    scope: () => null,
    column: (f) => byField.get(f),
    columns: () => columns,
    pending,
    orphaned: columns.filter((c) => c.state === 'orphaned').map((c) => c.field)
  };
}

const OBS = typed('Obs', [
  ['title', 'text'],
  ['price', 'number'],
  ['observedAt', 'date'],
  ['cert', 'crossRef'],
  ['status', 'text', 'promoting'],
  ['gone', 'text', 'orphaned']
]);
const CERT = typed('Cert', [['grade', 'number']]);
const AT = columnName('observedAt');

const CERT_REF: FieldDef = { kind: 'crossRef', ns: NS, type: 'Cert', onDelete: 'set_null' };
const fieldDef = (t: string, f: string): FieldDef | undefined =>
  t === 'Obs' && f === 'cert' ? CERT_REF : undefined;
const castFor = (f: string) => (f === 'observedAt' ? 'timestamptz' : null);
const where = (w: unknown, table: TypeTable = OBS) =>
  render(buildWhere(sql, w as WhereClause, castFor, table));

describe('a type table compiles against its columns', () => {
  it('eq on a text column → f_title = $1::text with no body', () => {
    const text = where({ title: { eq: 'x' } });
    expect(text).toContain('f_title = $::text');
    expect(text).not.toContain('body');
    expect(text).not.toContain('extra');
    expect(text).not.toContain('COLLATE');
  });

  it('range on a number column → f_price > $1', () => {
    const text = where({ price: { gt: 5 } });
    expect(text).toContain('f_price > $');
    expect(text).not.toContain('substrate_num');
    // Never NULL for an absent price, so a caller's NOT stays sound.
    expect(text).toContain('f_price IS NOT NULL AND');
  });

  it('date range → f_observedat >= $1::text::timestamptz', () => {
    expect(where({ observedAt: { gte: '2026-01-01' } })).toContain(`${AT} >= $::text::timestamptz`);
  });

  it('json path stays extra -> meta, and an undeclared field reads extra', () => {
    const text = where({ meta: { path: ['a'], eq: 1 } });
    expect(text).toContain(`extra -> 'meta'`);
    expect(text).not.toContain('body');
    expect(where({ note: { eq: 'n' } })).toContain(`((extra ->> 'note') COLLATE "C") = $`);
  });

  it('an operand of another type never matches, and neq admits it', () => {
    expect(where({ price: { eq: 'five' } })).toBe('((FALSE))');
    expect(where({ price: { neq: 'five' } })).toBe('((TRUE))');
    expect(where({ title: { contains: 'a' } })).toContain(`(f_title COLLATE "default") ILIKE $`);
  });

  it('promoting field → CASE WHEN extra ? key THEN extra cast ELSE column END (F13)', () => {
    expect(where({ status: { eq: 'open' } })).toContain(
      `CASE WHEN extra ? 'status' THEN ((extra ->> 'status') COLLATE "C") ELSE f_status END = $::text`
    );
  });

  it('orphaned column is projected and read like a promoting one (F35)', () => {
    expect(where({ gone: { eq: 'g' } })).toContain(
      `CASE WHEN extra ? 'gone' THEN ((extra ->> 'gone') COLLATE "C") ELSE f_gone END = $::text`
    );
    const whole = render(buildRowProjection(sql, OBS, undefined));
    expect(whole).toContain('r.f_gone');
    const subset = render(buildRowProjection(sql, OBS, { gone: true }));
    expect(subset).toContain('r.f_gone');
    expect(subset).not.toContain('r.f_title');
    // The extra key wins over the column on read, as in the filter.
    expect(decodeRow(OBS, { f_gone: 'column', extra: { gone: 'extra' } })).toEqual({
      gone: 'extra'
    });
  });

  it('sorts on the column, and projects a date sort key as text', () => {
    const order: Array<[string, 'asc' | 'desc']> = [
      ['price', 'desc'],
      ['observedAt', 'asc'],
      ['id', 'asc']
    ];
    expect(render(buildOrderBy(sql, order, castFor, OBS)).replace(/\s+/g, ' ')).toBe(
      `ORDER BY f_price DESC NULLS LAST , ${AT} ASC NULLS LAST , id ASC NULLS LAST`
    );
    const { fragment } = buildSortKeyProjection(sql, order, castFor, OBS);
    expect(render(sql`SELECT 1${fragment}`)).toContain(`(${AT})::text AS $`);
  });
});

describe('a walk reads each type from its own table', () => {
  const tableFor = tableLookup([OBS, CERT]);
  const scope = (type: string) => walkScope(NS, type, 'r', fieldDef, tableFor);

  it('walk hop FROM the far table, joined on near.f_cert', () => {
    const out = render(
      buildWhere(
        sql,
        { _walk: { out: 'cert', where: { grade: { gt: 1 } } } } as WhereClause,
        castFor,
        OBS,
        scope('Obs')
      )
    );
    expect(out).toContain(`FROM ${CERT.from} w1 WHERE`);
    // Uncollated, so the far id's (default-collation) index serves the probe.
    expect(out).toContain(`w1.deleted_at IS NULL AND w1.id::text = (r.f_cert COLLATE "default")`);
    expect(out).toContain('w1.f_grade > $');
    expect(out).not.toContain('namespace');
    const inbound = render(
      buildWhere(sql, { _walk: { in: 'ns/Obs.cert' } } as WhereClause, castFor, CERT, scope('Cert'))
    );
    expect(inbound).toContain(`FROM ${OBS.from} w1 WHERE`);
    expect(inbound).toContain(`w1.f_cert = (r.id::text COLLATE "C")`);
  });

  it('tableFor on a type not preloaded throws, naming the type (F19)', () => {
    expect(() => tableLookup([OBS])('Cert')).toThrow(/'Cert'/);
    const partial = walkScope(NS, 'Obs', 'r', fieldDef, tableLookup([OBS]));
    expect(() =>
      buildWhere(sql, { _walk: { out: 'cert' } } as WhereClause, castFor, OBS, partial)
    ).toThrow(/'Cert'/);
  });

  it('walkTypes finds the seed and every far type to preload', () => {
    const types = walkTypes(
      {
        where: { AND: [{ _walk: { out: 'cert' } }] },
        agg: { n: { in: 'ns/Sale.obs', count: true } },
        nested: {
          x: {
            _walk: { in: 'ns/Note.obs' },
            fields: { _agg: { m: { in: 'ns/Tag.note', count: true } } }
          }
        }
      },
      'Obs',
      fieldDef
    );
    expect([...types].sort()).toEqual(['Cert', 'Note', 'Obs', 'Sale', 'Tag']);
  });
});

describe('the old layouts keep their promoted columns (F20)', () => {
  const promoted = resolvePromotedColumns({
    project: { column: 'project', kind: 'text' },
    archived: { column: 'archived', kind: 'boolean' }
  });
  const ROWS = rowsTypeTable(NS, 'T', promoted);

  it(`rowsTypeTable with a promoted column emits today's COLLATE "C" and boolean absent→false SQL`, () => {
    expect(ROWS.column('project')).toBeUndefined();
    const text = where({ project: { eq: 'p' }, archived: { eq: false } }, ROWS);
    // The column is NOT NULL DEFAULT false, so `= FALSE` matches a row that never set it.
    expect(text).toBe('( (r.project COLLATE "C" = $::text) AND (r.archived = FALSE))');
    expect(render(buildOrderBy(sql, [['project', 'asc']], castFor, ROWS))).toBe(
      'ORDER BY r.project COLLATE "C" ASC NULLS LAST'
    );
    expect(where({ other: { eq: 'o' } }, ROWS)).toBe(`((((body ->> 'other') COLLATE "C") = $))`);
  });
});

describe('a date column reads the same whatever the session TimeZone', () => {
  it('is projected as UTC text in the toISOString grammar, at microseconds', () => {
    const text = render(buildRowProjection(sql, OBS, undefined));
    expect(text).toContain(
      `to_char(r.${AT} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS ${AT}`
    );
    expect(text).toContain('r.extra AS extra');
    // A projected subset keeps `$raw`, which overlays any column it shields.
    expect(render(buildRowProjection(sql, OBS, { observedAt: true }))).toMatch(
      /jsonb_each\(r\.extra\) e WHERE e\.key = ANY\(\$::text\[\]\)/
    );
  });

  it('decodeRow reads that text as the canonical form a Date gives', () => {
    for (const iso of ['2026-01-02T03:04:05.678000Z', '0150-03-04T00:00:00.000000Z']) {
      const fromText = decodeRow(OBS, { [AT]: iso, extra: {} });
      expect(fromText).toEqual({ observedAt: new Date(iso).toISOString() });
      expect(fromText.observedAt).toBe(`${iso.slice(0, 23)}Z`);
    }
  });
});

/**
 * The SQL the compiler emits over a `TypeTable` (typed-tables Task 10): a
 * column field compares on its column, a `promoting` or `orphaned` one on its
 * `extra` key while present (the precedence `decodeRow` reads by), everything
 * else on `extra`, and a walk reads each far type from its own table.
 *
 * Pure: nothing connects to a database.
 */

import type { FieldDef, WhereClause } from '@mnmal-ai/substrate-types';
import postgres from 'postgres';
import { afterAll, describe, expect, it } from 'vitest';
import { columnName, ident, typeTableName } from '../src/layout.js';
import { buildFrameAggregate, buildNested, prepareWindows } from '../src/pg-sql/aggregate.js';
import { buildRowProjection } from '../src/pg-sql/projection.js';
import { buildOrderBy, buildSortKeyProjection } from '../src/pg-sql/sorting.js';
import {
  prepareSharedPicks,
  tableLookup,
  walkScope,
  walkTypes,
  withCtes
} from '../src/pg-sql/walk.js';
import { buildWhere } from '../src/pg-sql/where.js';
import { decodeRow } from '../src/row-codec.js';

import type { ColumnKind, TypedColumn, TypeTable } from '../src/type-table.js';

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
  ['gone', 'text', 'orphaned'],
  ['qty', 'number', 'promoting'],
  ['seenAt', 'date', 'promoting'],
  ['flag', 'boolean', 'promoting']
]);
const CERT = typed('Cert', [
  ['grade', 'number'],
  ['spec', 'crossRef']
]);
const SPEC = typed('Spec', [['tier', 'number']]);
const SALE = typed('Sale', [
  ['spec', 'crossRef'],
  ['at', 'date'],
  ['price', 'number']
]);
const AT = columnName('observedAt');
const SEEN = columnName('seenAt');

const ref = (type: string): FieldDef => ({ kind: 'crossRef', ns: NS, type, onDelete: 'set_null' });
const FIELDS: Record<string, Record<string, FieldDef>> = {
  Obs: {
    cert: ref('Cert'),
    price: { kind: 'scalar', type: 'number' },
    observedAt: { kind: 'scalar', type: 'date', indexed: true }
  },
  Cert: { spec: ref('Spec') },
  Sale: { spec: ref('Spec'), at: { kind: 'scalar', type: 'date' } }
};
const fieldDef = (t: string, f: string): FieldDef | undefined => FIELDS[t]?.[f];
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

  it('a null check stays the bare column test, with $raw as a filter (ruling A)', () => {
    // `f_price IS NULL` first, so the column's index still serves it.
    expect(where({ price: { eq: null } })).toBe(
      `(((f_price IS NULL AND (extra -> '$raw' ? 'price') IS NOT TRUE)))`
    );
    expect(where({ price: { neq: null } })).toBe(
      `(((f_price IS NOT NULL OR (extra -> '$raw' ? 'price') IS TRUE)))`
    );
    // A promoting field reads its JSON value, `$raw` overlaid.
    expect(where({ qty: { eq: null } })).toMatch(
      /^\(\(COALESCE\(extra -> '\$raw' -> 'qty', .*\) IS NULL\)\)$/
    );
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

describe('every column kind and state', () => {
  it('a crossRef column compares bare for equality and in "C" byte order for ranges and sorts', () => {
    expect(where({ cert: { eq: 'c' } })).toContain('f_cert = $::text');
    expect(where({ cert: { gt: 'c' } })).toContain('(f_cert COLLATE "C") > $::text');
    expect(render(buildOrderBy(sql, [['cert', 'asc']], castFor, OBS))).toBe(
      'ORDER BY (f_cert COLLATE "C") ASC NULLS LAST'
    );
  });

  it('a promoting number is numeric in both branches, a date compares as an instant', () => {
    expect(where({ qty: { gt: 1 } })).toContain(
      `CASE WHEN extra ? 'qty' THEN substrate_num(extra -> 'qty') ELSE f_qty::text::numeric END > $`
    );
    expect(where({ seenAt: { gte: '2026-01-01' } })).toContain(
      `CASE WHEN extra ? 'seenAt' THEN substrate_ts(extra -> 'seenAt') ELSE ${SEEN} END >= $::text::timestamptz`
    );
  });

  it("a promoting boolean's extra branch never raises: a non-boolean reads NULL", () => {
    expect(where({ flag: { eq: true } })).toContain(
      `CASE WHEN extra ? 'flag' THEN CASE WHEN jsonb_typeof(extra -> 'flag') = 'boolean' THEN (extra -> 'flag')::boolean END ELSE f_flag END = TRUE`
    );
  });

  it('sum is exact: numeric over a number column and over a promoting one', () => {
    const s = walkScope(NS, 'Obs', 'r', fieldDef, tableLookup([OBS]));
    const text = render(
      buildFrameAggregate(
        sql,
        { p: { sum: 'price' }, q: { sum: 'qty' } },
        undefined,
        sql`TRUE`,
        undefined,
        s
      )
    );
    expect(text).toContain('sum(r.f_price::text::numeric)');
    expect(text).toContain(
      `sum(CASE WHEN r.extra ? 'qty' THEN substrate_num(r.extra -> 'qty') ELSE r.f_qty::text::numeric END)`
    );
  });

  it('a nested list reads each field as jsonb: to_jsonb, a date as UTC ms text, $raw over all, null as absent', () => {
    const s = walkScope(NS, 'Cert', 'r', fieldDef, tableLookup([CERT, OBS]));
    const text = render(
      buildNested(
        sql,
        {
          _walk: { in: 'ns/Obs.cert' },
          fields: { title: true, observedAt: true, status: true, note: true }
        } as never,
        CERT,
        s
      )
    );
    expect(text).toContain(`FROM ${OBS.from} w1 WHERE`);
    expect(text).toContain(
      `CASE WHEN jsonb_typeof(w1.extra -> 'id') IN ('number', 'string') THEN w1.extra -> 'id' ELSE to_jsonb(w1.id) END`
    );
    expect(text).toContain(`COALESCE(w1.extra -> '$raw' -> 'title', to_jsonb(w1.f_title))`);
    expect(text).toContain(
      `COALESCE(w1.extra -> '$raw' -> 'observedAt', to_jsonb(to_char(w1.${AT} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')))`
    );
    expect(text).toContain(
      `COALESCE(w1.extra -> '$raw' -> 'status', CASE WHEN w1.extra ? 'status' THEN NULLIF((w1.extra -> 'status'), 'null'::jsonb) ELSE to_jsonb(w1.f_status) END)`
    );
    expect(text).toContain(`(w1.extra -> 'note')`);
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
    // Bare: a crossRef column has `id`'s collation, so an index on either side serves it.
    expect(out).toContain(`w1.deleted_at IS NULL AND w1.id = r.f_cert AND`);
    expect(out).toContain('w1.f_grade > $');
    expect(out).not.toContain('namespace');
    const inbound = render(
      buildWhere(sql, { _walk: { in: 'ns/Obs.cert' } } as WhereClause, castFor, CERT, scope('Cert'))
    );
    expect(inbound).toContain(`FROM ${OBS.from} w1 WHERE`);
    expect(inbound).toContain(`w1.deleted_at IS NULL AND w1.f_cert = r.id)`);
  });

  it('the window key and its seed semi-join are bare crossRef columns', () => {
    const s = walkScope(NS, 'Cert', 'r', fieldDef, tableLookup([CERT, OBS]));
    const w = { observedAt: { gte: '2026-10-29T00:00:00Z' } };
    const p = {
      where: { _walk: { in: 'ns/Obs.cert', where: w } },
      agg: { n: { in: 'ns/Obs.cert', where: w, count: true } }
    } as never;
    const base = { clauses: [sql`r.id = ANY('{a,b}')`], ids: true };
    const joins = render(
      prepareWindows(sql, p, base, castFor, CERT, s, (t, f) => t === 'Obs' && f === 'observedAt')
    );
    const ctes = render(withCtes(sql, s));
    expect(ctes).toContain('SELECT w1.f_cert AS __k');
    expect(ctes).toContain(`w1.f_cert IN (SELECT r.id FROM ${CERT.from} r WHERE`);
    expect(joins).toContain('LEFT JOIN win_w1 ON');
  });

  it("a shared pick's hubs are the bare crossRef column, joined bare", () => {
    const s = walkScope(NS, 'Cert', 'r', fieldDef, tableLookup([CERT, SPEC, SALE]));
    const p = {
      count: true,
      where: {
        _walk: { out: 'spec', where: { _walk: { in: 'ns/Sale.spec', pick: { latest: 'at' } } } }
      }
    } as never;
    const joins = render(prepareSharedPicks(sql, p, { clauses: [], ids: false }, castFor, CERT, s));
    const ctes = render(withCtes(sql, s));
    expect(ctes).toContain(`SELECT DISTINCT r.f_spec AS id FROM ${CERT.from} r`);
    expect(ctes).toContain('w1.f_spec = h.id');
    expect(joins).toMatch(/LEFT JOIN pick_w\d+ ON pick_w\d+\.__hub = r\.f_spec$/);
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

describe('a date column reads the same whatever the session TimeZone', () => {
  it('is projected as UTC text in the toISOString grammar, at microseconds', () => {
    const text = render(buildRowProjection(sql, OBS, undefined));
    expect(text).toContain(
      `to_char(r.${AT} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS ${AT}`
    );
    expect(text).toContain('r.extra AS extra');
    // A projected subset keeps `id` and `$raw` (which overlays any column it shields), a
    // key at a time with no per-row subquery (#1864); a `column` field's `extra` key is unread.
    const pick =
      /CASE WHEN r\.extra \? \$::text THEN jsonb_build_object\(\$::text, r\.extra -> \$::text\) ELSE '\{\}'::jsonb END/g;
    const columnOnly = render(buildRowProjection(sql, OBS, { observedAt: true }));
    expect(columnOnly.match(pick)).toHaveLength(2);
    expect(columnOnly).not.toContain('jsonb_each');
    // A `promoting` field may still be in `extra`, so it is picked too.
    expect(render(buildRowProjection(sql, OBS, { status: true })).match(pick)).toHaveLength(3);
  });

  it('decodeRow reads that text as the canonical form a Date gives', () => {
    for (const iso of ['2026-01-02T03:04:05.678000Z', '0150-03-04T00:00:00.000000Z']) {
      const fromText = decodeRow(OBS, { [AT]: iso, extra: {} });
      expect(fromText).toEqual({ observedAt: new Date(iso).toISOString() });
      expect(fromText.observedAt).toBe(`${iso.slice(0, 23)}Z`);
    }
  });
});

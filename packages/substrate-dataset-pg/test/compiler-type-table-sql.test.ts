/**
 * The SQL the compiler emits over a `TypeTable` (typed-tables Task 10): a
 * column field compares on its column, a `promoting` or `orphaned` one on its
 * `extra` key while present (the precedence `decodeRow` reads by), everything
 * else on `extra`, and a walk reads each far type from its own table.
 *
 * Pure: nothing connects to a database.
 */

import type { TypeRef } from '@mnmal-ai/substrate-filter';
import type { FieldDef, WhereClause } from '@mnmal-ai/substrate-types';
import postgres from 'postgres';
import { afterAll, describe, expect, it } from 'vitest';
import { columnName, ident, typeTableName } from '../src/layout.js';
import { buildNested, buildWalkColumns, prepareWindows } from '../src/pg-sql/aggregate.js';
import { buildGroupedRead } from '../src/pg-sql/grouped.js';
import { buildRowProjection } from '../src/pg-sql/projection.js';
import {
  buildOrderBy,
  buildSortKeyProjection,
  resolveBodyOrderByCast
} from '../src/pg-sql/sorting.js';
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
  pending: string[] = [],
  namespace = NS
): TypeTable {
  const columns: TypedColumn[] = cols.map(([field, kind, state = 'column']) => ({
    field,
    column: columnName(field),
    kind,
    state
  }));
  const byField = new Map(columns.map((c) => [c.field, c]));
  return {
    namespace,
    type,
    from: ident(typeTableName(namespace, type)),
    jsonb: 'extra',
    column: (f) => byField.get(f),
    columns: () => columns,
    pending,
    orphaned: columns.filter((c) => c.state === 'orphaned').map((c) => c.field),
    version: '0'
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
/** {@link fieldDef} as a walk scope asks it, by type in its namespace. */
const refDef = (t: TypeRef, f: string) => (t.ns === NS ? fieldDef(t.type, f) : undefined);
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

  it('an operand of another type compares the $raw-overlaid value; one that fits keeps the column', () => {
    const raw = `COALESCE(COALESCE(extra -> '$raw' -> 'price', to_jsonb(f_price)) = ANY($::text[]::jsonb[]), FALSE)`;
    expect(where({ price: { eq: 'five' } })).toBe(`((${raw}))`);
    expect(where({ price: { neq: 'five' } })).toBe(`((NOT ${raw}))`);
    expect(where({ price: { eq: 5 } })).toBe('(((f_price IS NOT NULL AND f_price = $)))');
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
    const text = render(
      buildGroupedRead(
        sql,
        { aggregate: { p: { sum: 'price' }, q: { sum: 'qty' } } },
        sql`TRUE`,
        sql``,
        OBS,
        (f) => fieldDef('Obs', f)
      ).statement
    );
    expect(text).toContain('sum(r.f_price::text::numeric)');
    expect(text).toContain(
      `sum(CASE WHEN r.extra ? 'qty' THEN substrate_num(r.extra -> 'qty') ELSE r.f_qty::text::numeric END)`
    );
  });

  it('a nested list reads each field as jsonb: to_jsonb, a date as UTC ms text, $raw over all, null as absent', () => {
    const s = walkScope(NS, 'Cert', 'r', refDef, tableLookup([CERT, OBS]));
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
  const scope = (type: string) => walkScope(NS, type, 'r', refDef, tableFor);

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
    const s = walkScope(NS, 'Cert', 'r', refDef, tableLookup([CERT, OBS]));
    const w = { observedAt: { gte: '2026-10-29T00:00:00Z' } };
    const p = {
      where: { _walk: { in: 'ns/Obs.cert', where: w } },
      agg: { n: { in: 'ns/Obs.cert', where: w, count: true } }
    } as never;
    const base = { clauses: [sql`r.id = ANY('{a,b}')`], ids: true };
    const joins = render(
      prepareWindows(
        sql,
        p,
        base,
        castFor,
        CERT,
        s,
        (t, f) => t.type === 'Obs' && f === 'observedAt'
      )
    );
    const ctes = render(withCtes(sql, s));
    expect(ctes).toContain('SELECT w1.f_cert AS __k');
    expect(ctes).toContain(`w1.f_cert IN (SELECT r.id FROM ${CERT.from} r WHERE`);
    expect(joins).toContain('LEFT JOIN win_w1 ON');
  });

  it("a shared pick's hubs are the bare crossRef column, joined bare", () => {
    const s = walkScope(NS, 'Cert', 'r', refDef, tableLookup([CERT, SPEC, SALE]));
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
    expect(() => tableLookup([OBS])({ ns: NS, type: 'Cert' })).toThrow(/'Cert'/);
    const partial = walkScope(NS, 'Obs', 'r', refDef, tableLookup([OBS]));
    expect(() =>
      buildWhere(sql, { _walk: { out: 'cert' } } as WhereClause, castFor, OBS, partial)
    ).toThrow(/'Cert'/);
  });

  it('single-namespace walks and a nested list compile byte for byte to the SQL pinned here', () => {
    const s = walkScope(NS, 'Cert', 'r', refDef, tableLookup([CERT, OBS, SPEC, SALE]));
    const w = {
      AND: [
        { _walk: { in: 'ns/Obs.cert', as: 'o', where: { price: { gt: 1 } } } },
        { _walk: { in: 'ns/Obs.cert', where: { observedAt: { gt: { $ref: 'o.observedAt' } } } } },
        {
          _walk: { out: 'spec', where: { _walk: { in: 'ns/Sale.spec', pick: { latest: 'at' } } } }
        },
        { _walk: { in: 'ns/Obs.cert', quantifier: 'none', where: { title: { eq: 'x' } } } },
        { _agg: { in: 'ns/Obs.cert', count: true }, gte: 3 }
      ]
    } as unknown as WhereClause;
    const text = render(buildWhere(sql, w, castFor, CERT, s));
    expect(text).toBe(
      `( (EXISTS (SELECT 1 FROM ${SPEC.from} w3 WHERE w3.deleted_at IS NULL AND w3.id = r.f_spec AND (EXISTS (SELECT 1 FROM ((SELECT w4.* FROM ${SALE.from} w4 WHERE w4.deleted_at IS NULL AND w4.f_spec = w3.id AND w4.f_at = (SELECT max(w4.f_at) FROM ${SALE.from} w4 WHERE w4.deleted_at IS NULL AND w4.f_spec = w3.id) ORDER BY w4.id COLLATE "C" ASC LIMIT 1) UNION ALL (SELECT w4.* FROM ${SALE.from} w4 WHERE w4.deleted_at IS NULL AND w4.f_spec = w3.id AND w4.f_at IS NULL ORDER BY w4.id COLLATE "C" ASC LIMIT 1) LIMIT 1) w4)))) AND (NOT EXISTS (SELECT 1 FROM ${OBS.from} w5 WHERE w5.deleted_at IS NULL AND w5.f_cert = r.id AND (((w5.f_title IS NOT NULL AND w5.f_title = $::text))))) AND EXISTS (SELECT 1 FROM (SELECT (SELECT to_jsonb(count(*)) FROM ${OBS.from} w6 WHERE (w6.deleted_at IS NULL AND w6.f_cert = r.id)) AS v) w7 WHERE ( w7.v IS NOT NULL AND w7.v <> 'null'::jsonb AND (substrate_num(w7.v)::float8 IS NOT NULL AND '3'::float8 IS NOT NULL AND substrate_num(w7.v)::float8 >= '3'::float8))) AND EXISTS (SELECT 1 FROM ${OBS.from} w1 WHERE ( w1.deleted_at IS NULL AND w1.f_cert = r.id AND (((w1.f_price IS NOT NULL AND w1.f_price > $))) AND (EXISTS (SELECT 1 FROM ${OBS.from} w2 WHERE w2.deleted_at IS NULL AND w2.f_cert = r.id AND (((w2.${AT} IS NOT NULL AND w1.${AT} IS NOT NULL AND w2.${AT} > w1.${AT}))))))))`
    );
    const nested = render(
      buildNested(
        sql,
        { _walk: { in: 'ns/Obs.cert' }, fields: { title: true, cert: true } } as never,
        CERT,
        s
      )
    );
    expect(nested).toBe(
      `(SELECT COALESCE(jsonb_agg( jsonb_build_object( 'id'::text, CASE WHEN jsonb_typeof(w8.extra -> 'id') IN ('number', 'string') THEN w8.extra -> 'id' ELSE to_jsonb(w8.id) END , $::text, COALESCE(w8.extra -> '$raw' -> 'title', to_jsonb(w8.f_title))) || jsonb_strip_nulls( jsonb_build_object( $::text, COALESCE(w8.extra -> '$raw' -> 'cert', to_jsonb(w8.f_cert)))) ORDER BY  w8.id COLLATE "C" ASC NULLS LAST), '[]'::jsonb) FROM (SELECT w8.* FROM ${OBS.from} w8 WHERE (w8.deleted_at IS NULL AND w8.f_cert = r.id) ORDER BY  w8.id COLLATE "C" ASC NULLS LAST ) w8)`
    );
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
      { ns: 'ns', type: 'Obs' },
      refDef
    );
    expect(types.map((t) => t.type).sort()).toEqual(['Cert', 'Note', 'Obs', 'Sale', 'Tag']);
  });
});

describe('a walk across namespaces reads each far type from its own namespace', () => {
  const APP = 'app';
  // `ns/Payment` references `app/Invoice` and its own namespace's same-named `ns/Invoice`.
  const INVOICE = typed('Invoice', [['number', 'text']], [], APP);
  const OWN = typed('Invoice', [['number', 'text']]);
  const PAYMENT = typed('Payment', [
    ['invoice', 'crossRef'],
    ['own', 'crossRef'],
    ['amount', 'number']
  ]);
  // `due` lives in `extra`: app declares it a date, ns a number.
  const DEFS: Record<string, Record<string, Record<string, FieldDef>>> = {
    [NS]: {
      Payment: {
        invoice: { kind: 'crossRef', ns: APP, type: 'Invoice', onDelete: 'set_null' },
        own: ref('Invoice'),
        amount: { kind: 'scalar', type: 'number' }
      },
      Invoice: { due: { kind: 'scalar', type: 'number' } }
    },
    [APP]: { Invoice: { due: { kind: 'scalar', type: 'date' } } }
  };
  const def = (r: TypeRef, f: string) => DEFS[r.ns]?.[r.type]?.[f];
  const tables = tableLookup([PAYMENT, OWN, INVOICE]);
  const scope = (type: string, ns = NS) => walkScope(ns, type, 'r', def, tables);
  const rowCast = (r: TypeRef) => (f: string) => resolveBodyOrderByCast(def(r, f));
  const payment = { ns: NS, type: 'Payment' };
  const invoice = { ns: APP, type: 'Invoice' };
  const fromPayment = (w: unknown) =>
    render(buildWhere(sql, w as WhereClause, rowCast(payment), PAYMENT, scope('Payment')));

  it('the same-named types are two tables, named by layout.ts', () => {
    expect(INVOICE.from).toBe(ident(typeTableName(APP, 'Invoice')));
    expect(INVOICE.from).not.toBe(OWN.from);
    expect(tables(invoice)).toBe(INVOICE);
    expect(tables({ ns: NS, type: 'Invoice' })).toBe(OWN);
    expect(() => tables({ ns: 'other', type: 'Invoice' })).toThrow(/'Invoice'.*'other'/);
  });

  it("an out hop joins the crossRef's namespace's table on its id", () => {
    const out = fromPayment({ _walk: { out: 'invoice', where: { number: { eq: 'A-1' } } } });
    expect(out).toContain(
      `FROM ${INVOICE.from} w1 WHERE w1.deleted_at IS NULL AND w1.id = r.f_invoice AND`
    );
    expect(out).not.toContain(OWN.from);
  });

  it("an in hop reads its written namespace's table by the crossRef", () => {
    const inbound = render(
      buildWhere(
        sql,
        { _walk: { in: 'ns/Payment.invoice' } } as WhereClause,
        rowCast(invoice),
        INVOICE,
        scope('Invoice', APP)
      )
    );
    expect(inbound).toContain(
      `FROM ${PAYMENT.from} w1 WHERE w1.deleted_at IS NULL AND w1.f_invoice = r.id)`
    );
  });

  it("each far row's fields cast by its own namespace's definitions", () => {
    const both = fromPayment({
      AND: [
        { _walk: { out: 'invoice', where: { due: { gte: '2026-01-01T00:00:00Z' } } } },
        { _walk: { out: 'own', where: { due: { gte: 5 } } } }
      ]
    });
    expect(both).toContain(`FROM ${INVOICE.from} w1`);
    expect(both).toContain(`substrate_ts(w1.extra -> 'due')`);
    expect(both).toContain(`FROM ${OWN.from} w2`);
    expect(both).toContain(`substrate_num(w2.extra -> 'due')`);
  });

  it('a walk back into the seed namespace reads the seed namespace again', () => {
    const back = fromPayment({
      _walk: {
        out: 'invoice',
        where: { _walk: { in: 'ns/Payment.invoice', where: { _walk: { out: 'own' } } } }
      }
    });
    expect(back).toContain(`FROM ${INVOICE.from} w1`);
    expect(back).toContain(
      `FROM ${PAYMENT.from} w2 WHERE w2.deleted_at IS NULL AND w2.f_invoice = w1.id`
    );
    expect(back).toContain(`FROM ${OWN.from} w3 WHERE w3.deleted_at IS NULL AND w3.id = w2.f_own`);
  });

  it('a nested list and an _agg read the far table', () => {
    const nested = render(
      buildNested(
        sql,
        { _walk: { out: 'invoice' }, fields: { number: true, due: true } } as never,
        PAYMENT,
        scope('Payment')
      )
    );
    expect(nested).toContain(`FROM ${INVOICE.from} w1 WHERE`);
    const cols = buildWalkColumns(
      sql,
      { paid: { in: 'ns/Payment.invoice', sum: 'amount' } } as never,
      {},
      INVOICE,
      scope('Invoice', APP)
    );
    expect(render(cols?.select)).toContain(`FROM ${PAYMENT.from} w1 WHERE`);
    // A latest pick asks the far type's (crossRef, key) index direction in its own namespace.
    const s = scope('Invoice', APP);
    const asked: TypeRef[] = [];
    s.indexDir = (t) => {
      asked.push(t);
      return undefined;
    };
    const last = buildWalkColumns(
      sql,
      { last: { in: 'ns/Payment.invoice', latest: { by: 'amount', value: 'amount' } } } as never,
      {},
      INVOICE,
      s
    );
    expect(render(last?.select)).toContain(`FROM ${PAYMENT.from} w1 WHERE`);
    expect(asked).toEqual([payment]);
  });

  it("a window and a shared pick read their far tables, asking each far type's indexes in its namespace", () => {
    const s = scope('Invoice', APP);
    const w = { amount: { gte: 10 } };
    const p = {
      where: { _walk: { in: 'ns/Payment.invoice', where: w } },
      agg: { n: { in: 'ns/Payment.invoice', where: w, count: true } }
    } as never;
    const asked: TypeRef[] = [];
    const joins = render(
      prepareWindows(sql, p, { clauses: [], ids: false }, rowCast(invoice), INVOICE, s, (t, f) => {
        asked.push(t);
        return f === 'amount';
      })
    );
    expect(asked).toContainEqual(payment);
    expect(render(withCtes(sql, s))).toContain(`SELECT w1.f_invoice AS __k`);
    expect(render(withCtes(sql, s))).toContain(`FROM ${PAYMENT.from} w1 WHERE`);
    expect(joins).toContain('LEFT JOIN win_w1 ON');

    const hub = scope('Payment');
    const picks = {
      count: true,
      where: {
        _walk: {
          out: 'invoice',
          where: { _walk: { in: 'ns/Payment.invoice', pick: { latest: 'amount' } } }
        }
      }
    } as never;
    prepareSharedPicks(sql, picks, { clauses: [], ids: false }, rowCast(payment), PAYMENT, hub);
    const ctes = render(withCtes(sql, hub));
    expect(ctes).toContain(`JOIN ${INVOICE.from} w`);
    expect(ctes).toContain(
      `FROM ${PAYMENT.from} w1 WHERE w1.deleted_at IS NULL AND w1.f_invoice = h.id`
    );
  });

  it('walkTypes names each far type with its namespace, same-named ones apart', () => {
    const types = walkTypes(
      {
        where: {
          _walk: {
            out: 'invoice',
            where: { _walk: { in: 'ns/Payment.invoice', where: { _walk: { out: 'own' } } } }
          }
        }
      },
      payment,
      def
    );
    expect(types).toEqual([payment, invoice, { ns: NS, type: 'Invoice' }]);
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
    const general = render(buildRowProjection(sql, OBS, { gone: true }));
    expect(general).toMatch(/jsonb_each\(r\.extra\) e WHERE e\.key = ANY\(\$::text\[\]\)/);
    expect(general).not.toContain('?|');
    // Column fields only: `id` and `$raw` are probed for a row holding either, with no subquery.
    const columnsOnly = render(buildRowProjection(sql, OBS, { observedAt: true }));
    expect(columnsOnly).toContain('CASE WHEN r.extra ?| $::text[] THEN');
    expect(columnsOnly).not.toMatch(/SELECT/i);
  });

  it('decodeRow reads that text as the canonical form a Date gives', () => {
    for (const iso of ['2026-01-02T03:04:05.678000Z', '0150-03-04T00:00:00.000000Z']) {
      const fromText = decodeRow(OBS, { [AT]: iso, extra: {} });
      expect(fromText).toEqual({ observedAt: new Date(iso).toISOString() });
      expect(fromText.observedAt).toBe(`${iso.slice(0, 23)}Z`);
    }
  });
});

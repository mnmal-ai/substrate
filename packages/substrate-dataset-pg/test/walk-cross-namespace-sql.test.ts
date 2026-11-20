/**
 * A walk that crosses into another namespace on the same store reads each far
 * type from that namespace's own table and casts its fields by that
 * namespace's definitions. A walk that stays in one namespace compiles to the
 * same SQL whether or not other namespaces are wired, and keeps that SQL beside
 * a crossing walk. Skipped unless POSTGRES_URL is set.
 */

import { randomBytes, randomUUID } from 'node:crypto';
import {
  type FieldDef,
  type ReadParams,
  type Row,
  UnsupportedFilterError
} from '@mnmal-ai/substrate-types';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PgDataset, runMigrations } from '../src/index.js';
import { ident, typeTableName } from '../src/layout.js';
import { generatedIdentifier } from '../src/migrate.js';
import { dropNamespace, relationOf } from './_layout.js';

const POSTGRES_URL = process.env.POSTGRES_URL;
const tag = randomBytes(4).toString('hex');
const APP = `xwalk_app_${tag}`;
const EXT = `xwalk_ext_${tag}`;

const str: FieldDef = { kind: 'scalar', type: 'string' };
const num: FieldDef = { kind: 'scalar', type: 'number' };
const date: FieldDef = { kind: 'scalar', type: 'date' };
const ref = (ns: string, type: string): FieldDef => ({
  kind: 'crossRef',
  ns,
  type,
  onDelete: 'set_null'
});

type Defs = Record<string, Record<string, Record<string, FieldDef>>>;
/** What each type's table is created with. */
const COLUMNS: Defs = {
  [APP]: { Invoice: { number: str, total: num } },
  [EXT]: {
    Payment: { invoice: ref(APP, 'Invoice'), own: ref(EXT, 'Invoice'), amount: num },
    Invoice: { number: str }
  }
};
/**
 * The declared fields: `due` also, kept in `extra`, so only the field
 * definitions say how it compares, and the two namespaces say differently.
 */
const FIELDS: Defs = {
  [APP]: { Invoice: { ...COLUMNS[APP]?.Invoice, due: num } },
  [EXT]: { Payment: { ...COLUMNS[EXT]?.Payment }, Invoice: { ...COLUMNS[EXT]?.Invoice, due: date } }
};
const fieldDefLookupFor = (ns: string) => (type: string, field: string) =>
  FIELDS[ns]?.[type]?.[field];
const typeDefLookup = (type: string, ns: string) => {
  const fields = COLUMNS[ns]?.[type];
  return fields === undefined ? undefined : { fields };
};

const I1 = randomUUID();
const I2 = randomUUID();
const P1 = randomUUID();
const P2 = randomUUID();

const ids = (rows: Row[]) => rows.map((r) => String(r.id)).sort();

/** `text` from `open` (an opening parenthesis) to the parenthesis that closes it. */
function balanced(text: string, open: number): string {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '(') depth++;
    else if (text[i] === ')' && --depth === 0) return text.slice(open, i + 1);
  }
  throw new Error(`unbalanced from ${open}`);
}

describe.skipIf(!POSTGRES_URL)('a walk across namespaces (pg)', () => {
  let sql: Sql;
  let traced: Sql;
  let app: PgDataset;
  let ext: PgDataset;
  let sent: string[] = [];
  const args = new Map<string, unknown[]>();
  let appInvoice: string;
  let extInvoice: string;
  let extPayment: string;

  /** The page statement the last read sent: the one reading its seed rows as `r`. */
  const page = (): string => {
    const found = [...sent].reverse().find((q) => /FROM "t__[^"]+" r\b/.test(q));
    if (found === undefined) throw new Error('no page statement was sent');
    return found.replace(/\s+/g, ' ');
  };
  const read = async (ds: PgDataset, type: string, params: ReadParams) => {
    sent = [];
    return (await ds.read(type, params)).rows;
  };

  beforeAll(async () => {
    sql = postgres(POSTGRES_URL as string, { onnotice: () => {} });
    await runMigrations(sql);
    traced = postgres(POSTGRES_URL as string, {
      onnotice: () => {},
      debug: (_c, query, parameters) => {
        sent.push(query);
        args.set(query, parameters as unknown[]);
      }
    });
    app = new PgDataset({
      namespace: APP,
      sql: traced,
      fieldDefLookup: fieldDefLookupFor(APP),
      fieldDefLookupFor,
      typeDefLookup
    });
    ext = app.forNamespace(EXT) as PgDataset;
    await app.write('Invoice', [
      { id: I1, number: 'A-1', total: 100, due: 30 },
      { id: I2, number: 'A-2', total: 20, due: 7 }
    ]);
    // The same ids as app's invoices, in a same-named type of another namespace.
    await ext.write('Invoice', [
      { id: I1, number: 'E-1' },
      { id: I2, number: 'E-2' }
    ]);
    await ext.write('Payment', [
      { id: P1, invoice: I1, own: I2, amount: 60 },
      { id: P2, invoice: I1, own: I1, amount: 40 }
    ]);
    appInvoice = await relationOf(sql, APP, 'Invoice');
    extInvoice = await relationOf(sql, EXT, 'Invoice');
    extPayment = await relationOf(sql, EXT, 'Payment');
  }, 60_000);

  beforeEach(() => {
    sent = [];
  });

  afterAll(async () => {
    await dropNamespace(sql, APP);
    await dropNamespace(sql, EXT);
    await traced.end({ timeout: 5 });
    await sql.end({ timeout: 5 });
  });

  it('names each type table by its own namespace (layout.ts)', () => {
    expect(appInvoice).toBe(ident(typeTableName(APP, 'Invoice')));
    expect(extInvoice).toBe(ident(typeTableName(EXT, 'Invoice')));
    expect(appInvoice).not.toBe(extInvoice);
  });

  it("an out hop joins the far namespace's table on its id, live rows only", async () => {
    const rows = await read(ext, 'Payment', {
      where: { _walk: { out: 'invoice', where: { number: { eq: 'A-1' } } } }
    });
    expect(ids(rows)).toEqual([P1, P2].sort());
    expect(page()).toContain(
      `FROM ${appInvoice} w1 WHERE w1.deleted_at IS NULL AND w1.id = r.f_invoice AND`
    );
    expect(page()).not.toContain(extInvoice);
  });

  it("an in hop reads the far namespace's rows by their crossRef", async () => {
    const rows = await read(app, 'Invoice', {
      where: { _walk: { in: `${EXT}/Payment.invoice` } }
    });
    expect(ids(rows)).toEqual([I1]);
    expect(page()).toContain(
      `FROM ${extPayment} w1 WHERE w1.deleted_at IS NULL AND w1.f_invoice = r.id)`
    );
  });

  it('same-named types of two namespaces are two tables: nested lists read each', async () => {
    const rows = await read(ext, 'Payment', {
      ids: [P1],
      nested: {
        theirs: { _walk: { out: 'invoice' }, fields: { number: true } },
        mine: { _walk: { out: 'own' }, fields: { number: true } }
      }
    } as ReadParams);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.theirs).toEqual([{ id: I1, number: 'A-1' }]);
    expect(rows[0]?.mine).toEqual([{ id: I2, number: 'E-2' }]);
    expect(page()).toContain(`FROM ${appInvoice} w`);
    expect(page()).toContain(`FROM ${extInvoice} w`);
  });

  it("an _agg reads the far namespace's rows, in fields and in where", async () => {
    const paid = { in: `${EXT}/Payment.invoice`, sum: 'amount' };
    const rows = await read(app, 'Invoice', { agg: { paid } } as ReadParams);
    const byId = new Map(rows.map((r) => [String(r.id), r._agg as Record<string, unknown>]));
    expect(byId.get(I1)?.paid).toBe(100);
    expect(page()).toContain(`FROM ${extPayment} w`);
    const owed = await read(app, 'Invoice', {
      where: { _agg: paid, gte: 100 }
    } as unknown as ReadParams);
    expect(ids(owed)).toEqual([I1]);
    expect(page()).toContain(`FROM ${extPayment} w`);
  });

  it("casts a far type's field by its own namespace's definitions, never the seed's", async () => {
    // app declares `due` a number (days); ext's same-named Invoice declares it a date.
    const days = { due: { gte: 10 } };
    const rows = await read(ext, 'Payment', { where: { _walk: { out: 'invoice', where: days } } });
    expect(ids(rows)).toEqual([P1, P2].sort());
    expect(page()).toContain(`substrate_num(w1.extra -> 'due')`);
    expect(page()).not.toContain('substrate_ts');
    const date = { due: { gte: '2026-02-01T00:00:00Z' } };
    await read(ext, 'Payment', { where: { _walk: { out: 'own', where: date } } });
    expect(page()).toContain(`substrate_ts(w1.extra -> 'due')`);
  });

  it('without fieldDefLookupFor, refuses a walk that leaves its namespace before reading', async () => {
    const bare = (namespace: string) =>
      new PgDataset({
        namespace,
        sql: traced,
        fieldDefLookup: fieldDefLookupFor(namespace),
        typeDefLookup
      });
    const date = { due: { gte: '2026-02-01T00:00:00Z' } };
    const crossing: Array<[PgDataset, string, ReadParams]> = [
      [bare(EXT), 'Payment', { where: { _walk: { out: 'invoice', where: date } } }],
      [bare(EXT), 'Payment', { agg: { n: { out: 'invoice', count: true } } } as ReadParams],
      [
        bare(EXT),
        'Payment',
        {
          nested: { theirs: { _walk: { out: 'invoice' }, fields: { number: true } } }
        } as ReadParams
      ],
      // A hop out of the far type, whose fields this dataset does not know.
      [
        bare(APP),
        'Invoice',
        { where: { _walk: { in: `${EXT}/Payment.invoice`, where: { _walk: { out: 'own' } } } } }
      ]
    ];
    for (const [ds, type, params] of crossing) {
      sent = [];
      const err = await ds.read(type, params).then(
        () => undefined,
        (e: unknown) => e
      );
      expect(err, JSON.stringify(params)).toBeInstanceOf(UnsupportedFilterError);
      expect((err as UnsupportedFilterError).code).toBe('unsupported_filter');
      // The read's transaction opens, but no statement touches a type table.
      expect(sent.filter((q) => q.includes('"t__'))).toEqual([]);
    }
  });

  it('a single-namespace walk compiles the same with or without other namespaces wired', async () => {
    const frame = {
      where: { _walk: { out: 'own', where: { number: { eq: 'E-1' } } } },
      agg: { n: { out: 'own', count: true } },
      nested: { mine: { _walk: { out: 'own' }, fields: { number: true, due: true } } }
    } as ReadParams;
    const alone = new PgDataset({
      namespace: EXT,
      sql: traced,
      fieldDefLookup: fieldDefLookupFor(EXT),
      typeDefLookup
    });
    expect(ids(await read(alone, 'Payment', frame))).toEqual([P2]);
    const before = page();
    expect(ids(await read(ext, 'Payment', frame))).toEqual([P2]);
    expect(page()).toBe(before);
  });

  it("a frame mixing a crossing walk and a single-namespace one keeps the latter's SQL", async () => {
    const own = { _walk: { out: 'own', where: { number: { eq: 'E-1' } } } };
    await read(ext, 'Payment', { where: own });
    const alone = page();
    const at = alone.indexOf(`EXISTS (SELECT 1 FROM ${extInvoice} w1`);
    expect(at).toBeGreaterThan(-1);
    const walk = balanced(alone, at + 7);
    const rows = await read(ext, 'Payment', {
      where: { AND: [own, { _walk: { out: 'invoice', where: { number: { eq: 'A-1' } } } }] }
    });
    expect(ids(rows)).toEqual([P2]);
    // Byte for byte but the parameter numbers, which shift by the far table's guard entry.
    const unnumbered = (q: string) => q.replace(/\$\d+/g, '$');
    expect(unnumbered(page())).toContain(unnumbered(walk));
    expect(page()).toContain(`FROM ${appInvoice} w2`);
  });

  /**
   * The last read's page statement, planned with seq scans off (the tables are
   * tiny): every plan node's type, and the indexes it scans.
   */
  const plan = async (): Promise<{ shape: string[]; indexes: string[] }> => {
    const q = [...sent].reverse().find((s) => /FROM "t__[^"]+" r\b/.test(s));
    if (q === undefined) throw new Error('no page statement was sent');
    const literals = (args.get(q) ?? []).map((p) =>
      p === null ? 'NULL' : `'${String(p).replace(/'/g, "''")}'`
    );
    const list = literals.length === 0 ? '' : `(${literals.join(', ')})`;
    return sql.begin(async (tx) => {
      await tx.unsafe('SET LOCAL enable_seqscan = off');
      await tx.unsafe('SET LOCAL plan_cache_mode = force_custom_plan');
      await tx.unsafe(`PREPARE xwalk_plan AS ${q}`);
      const [row] = await tx.unsafe(`EXPLAIN (FORMAT JSON) EXECUTE xwalk_plan${list}`);
      await tx.unsafe('DEALLOCATE xwalk_plan');
      type Node = Record<string, unknown> & { Plans?: Node[] };
      const nodes = (n: Node): Node[] => [n, ...(n.Plans ?? []).flatMap(nodes)];
      const root = (row as Record<string, Array<{ Plan: Node }>>)['QUERY PLAN']?.[0]?.Plan;
      if (root === undefined) throw new Error('no plan');
      const all = nodes(root);
      return {
        shape: all.map((n) => String(n['Node Type'])),
        indexes: all.flatMap((n) =>
          n['Index Name'] === undefined ? [] : [String(n['Index Name'])]
        )
      };
    });
  };

  it('a crossing hop plans as the same-namespace hop does, on the crossRef or id index', async () => {
    // Tables a write creates have no indexes yet: build each type's, crossRef ones included.
    await app.ensureTypeStorage('Invoice');
    for (const type of ['Invoice', 'Payment']) await ext.ensureTypeStorage(type);
    const crossRefIndex = (field: string) => generatedIdentifier(EXT, 'Payment', field, 'idx');
    // An in hop reads ext's payments by a crossRef column: `invoice` crosses, `own` does not.
    await read(app, 'Invoice', { where: { _walk: { in: `${EXT}/Payment.invoice` } } });
    const crossingIn = await plan();
    await read(ext, 'Invoice', { where: { _walk: { in: `${EXT}/Payment.own` } } });
    const localIn = await plan();
    expect(crossingIn.shape).toEqual(localIn.shape);
    expect(crossingIn.shape).not.toContain('Seq Scan');
    expect(crossingIn.indexes).toContain(crossRefIndex('invoice'));
    expect(localIn.indexes).toContain(crossRefIndex('own'));
    // An out hop reads the far invoice by its id.
    await read(ext, 'Payment', { where: { _walk: { out: 'invoice' } } });
    const crossingOut = await plan();
    await read(ext, 'Payment', { where: { _walk: { out: 'own' } } });
    const localOut = await plan();
    expect(crossingOut.shape).toEqual(localOut.shape);
    expect(crossingOut.shape).not.toContain('Seq Scan');
  });

  it('every handle on one pool shares one walk store id: its txScopeId', async () => {
    expect(app.walkStoreId).toBe(app.txScopeId);
    expect(ext.walkStoreId).toBe(app.txScopeId);
    await app.withTransaction(async (tx) => {
      expect(tx.walkStoreId).toBe(app.txScopeId);
    });
    const other = new PgDataset({ namespace: APP, sql });
    expect(other.walkStoreId).not.toBe(app.walkStoreId);
  });
});

/**
 * Typed edge walks compiled to SQL (spec 2026-10-24-typed-edge-walks §3, §5).
 * The memory dataset's reference evaluator is the oracle: every case runs the
 * same fixture and where through both and expects the same rows.
 */

import { createHash, randomBytes } from 'node:crypto';
import { MemoryDataset } from '@mnmal-ai/substrate-dataset-memory';
import { encodeCursor } from '@mnmal-ai/substrate-filter';
import {
  type FieldDef,
  type ReadParams,
  type ReadResult,
  ResolverFrameError,
  type Row,
  WALKS_NEED_PARTITIONED,
  type WhereClause
} from '@mnmal-ai/substrate-types';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PgDataset } from '../src/index.js';
import { generatedIdentifier } from '../src/migrate.js';

const POSTGRES_URL = process.env.POSTGRES_URL;
const PARTITIONED = process.env.SUBSTRATE_TEST_LAYOUT === 'partitioned';
const NS = `walk_${randomBytes(4).toString('hex')}`;

const num: FieldDef = { kind: 'scalar', type: 'number' };
const str: FieldDef = { kind: 'scalar', type: 'string' };
const date: FieldDef = { kind: 'scalar', type: 'date' };
const ref = (type: string): FieldDef => ({ kind: 'crossRef', ns: NS, type, onDelete: 'set_null' });
const SCHEMA: Record<string, Record<string, FieldDef>> = {
  Cert: { grade: num, ask: num, minObs: num },
  Listing: { cert: ref('Cert'), seller: ref('Seller'), price: num, firstSeen: date },
  Observation: {
    cert: ref('Cert'),
    price: num,
    observedAt: { ...date, indexed: true },
    status: str
  },
  Seller: { rating: num }
};
const fieldDefLookup = (type: string, field: string): FieldDef | undefined =>
  Object.hasOwn(SCHEMA, type) && Object.hasOwn(SCHEMA[type] ?? {}, field)
    ? SCHEMA[type]?.[field]
    : undefined;

/** A stable uuid per fixture name, since pg ids must be uuids. */
const names = new Map<string, string>();
function u(name: string): string {
  const h = createHash('sha1').update(name).digest('hex');
  const id = `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
  names.set(id, name);
  return id;
}
const REFS = new Set(['id', 'cert', 'seller']);
const fx = (rows: Array<Record<string, unknown>>) =>
  rows.map((r) =>
    Object.fromEntries(
      Object.entries(r).map(([k, v]) => [k, REFS.has(k) && typeof v === 'string' ? u(v) : v])
    )
  );

type Rows = Record<string, Array<Record<string, unknown>>>;
const IN = (t: string) => `${NS}/${t}.cert`;
const RECENT = '2026-10-22T00:00:00Z';
const obs = (where?: WhereClause, extra: Record<string, unknown> = {}): WhereClause =>
  ({ _walk: { in: IN('Observation'), ...(where ? { where } : {}), ...extra } }) as WhereClause;

let sql: Sql;
let traced: Sql;
let pg: PgDataset;
let mem: MemoryDataset;
/** Statements the traced client sent, with their bound values and types. */
let sent: Array<{ query: string; parameters: unknown[]; types: number[] }> = [];

/** Loads `rows` into both datasets, replacing what was there. */
async function load(rows: Rows, tombstoned: Record<string, string[]> = {}): Promise<void> {
  await sql`DELETE FROM rows WHERE namespace = ${NS}`;
  mem = new MemoryDataset({ namespace: NS, fieldDefLookup, walkReference: true });
  for (const [type, list] of Object.entries(rows)) {
    if (list.length === 0) continue;
    await pg.write(type, fx(list) as never);
    await mem.write(type, fx(list) as never);
  }
  for (const [type, ids] of Object.entries(tombstoned)) {
    await pg.tombstone(type, ids.map(u));
    await mem.tombstone(type, ids.map(u));
  }
}

/** The fixture names of the `type` rows matching `where`, asserting pg and memory agree. */
async function both(type: string, where: WhereClause, includeDeleted = false): Promise<string[]> {
  const read = async (ds: PgDataset | MemoryDataset) =>
    (await ds.read(type, { where, ...(includeDeleted ? { includeDeleted } : {}) })).rows
      .map((r) => names.get(String(r.id)) ?? String(r.id))
      .sort();
  const want = await read(mem);
  expect(await read(pg), JSON.stringify(where)).toEqual(want);
  return want;
}

beforeAll(async () => {
  if (!POSTGRES_URL) return;
  sql = postgres(POSTGRES_URL, { onnotice: () => {} });
  traced = postgres(POSTGRES_URL, {
    onnotice: () => {},
    debug: (_c, query, parameters, types) => {
      sent.push({ query, parameters: parameters as unknown[], types: types as number[] });
    }
  });
  pg = new PgDataset({
    namespace: NS,
    sql: traced,
    fieldDefLookup,
    typeDefLookup: (type) =>
      Object.hasOwn(SCHEMA, type) ? { fields: SCHEMA[type] ?? {} } : undefined
  });
  if (PARTITIONED) for (const type of Object.keys(SCHEMA)) await pg.ensureTypeStorage(type);
});

afterAll(async () => {
  if (!POSTGRES_URL) return;
  await sql`DELETE FROM rows WHERE namespace = ${NS}`;
  await traced.end({ timeout: 5 });
  await sql.end({ timeout: 5 });
});

/**
 * As index-use's plans: the statement `read` last sent, prepared, as
 * `EXPLAIN (VERBOSE)` JSON under a forced custom plan and a forced generic one.
 */
async function plansOf(): Promise<Array<[string, string]>> {
  const { query, parameters, types } = pageQuery();
  const conn = await sql.reserve();
  try {
    // An untyped (0) parameter is declared unknown, so PREPARE infers it.
    const typeNames = await conn<Array<{ t: string }>>`
      SELECT CASE oid WHEN 0 THEN 'unknown' ELSE format_type(oid, NULL) END AS t FROM unnest(${types}::oid[]) WITH ORDINALITY u(oid, k)
      ORDER BY k`;
    const list = (xs: string[]) => (xs.length === 0 ? '' : `(${xs.join(', ')})`);
    const literals = parameters.map((p) => `'${String(p).replace(/'/g, "''")}'`);
    await conn.unsafe(`PREPARE walk_stmt${list(typeNames.map((n) => n.t))} AS ${query}`);
    const out: Array<[string, string]> = [];
    for (const mode of ['force_custom_plan', 'force_generic_plan']) {
      await conn.unsafe(`SET plan_cache_mode = ${mode}`);
      const plan = await conn.unsafe(
        `EXPLAIN (VERBOSE, FORMAT JSON) EXECUTE walk_stmt${list(literals)}`
      );
      out.push([mode, JSON.stringify(plan)]);
    }
    return out;
  } finally {
    await conn.unsafe('DEALLOCATE ALL');
    await conn.unsafe('RESET plan_cache_mode');
    conn.release();
  }
}

/** The last `read`'s statement plans on index `idx`, custom and generic. */
async function expectPlanUses(idx: string): Promise<void> {
  for (const [mode, plan] of await plansOf()) expect(plan, mode).toContain(`"Index Name":"${idx}"`);
}

/** The page statement the last `read` sent. */
const pageQuery = () =>
  sent.find((s) => /FROM rows r/.test(s.query)) ?? { query: '', parameters: [], types: [] };

describe.skipIf(!POSTGRES_URL || PARTITIONED)('walks on a legacy store (pg)', () => {
  it('legacy store refuses walks_need_partitioned naming migrate-store', async () => {
    const err = await pg.read('Cert', { where: obs() }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ResolverFrameError);
    expect(err).toMatchObject({ code: WALKS_NEED_PARTITIONED });
    expect((err as Error).message).toContain('substrate-admin migrate-store');
    // A read without walks is untouched.
    await expect(pg.read('Cert', { where: { grade: { eq: 9 } } })).resolves.toBeDefined();
  });

  it('a read carrying count: false or empty walk params is a plain read', async () => {
    await expect(pg.read('Cert', { count: false })).resolves.toMatchObject({ rows: [] });
    await expect(pg.read('Cert', { agg: {}, nested: {} })).resolves.toMatchObject({ rows: [] });
  });
});

describe.skipIf(!POSTGRES_URL || !PARTITIONED)('walks in where (pg)', () => {
  it('declares the walks capability', () => {
    expect(pg.capabilities.walks).toBe(true);
  });

  it('yardstick count matches the memory fixture result', async () => {
    await load({
      Cert: [
        { id: 'c1', grade: 9 },
        { id: 'c2', grade: 9 },
        { id: 'c3', grade: 8 }
      ],
      Listing: [
        { id: 'l1', cert: 'c1', price: 100, firstSeen: '2026-10-23T00:00:00Z' },
        { id: 'l2a', cert: 'c2', price: 100, firstSeen: '2026-10-23T00:00:00Z' },
        { id: 'l2b', cert: 'c2', price: 50, firstSeen: '2026-10-01T00:00:00Z' },
        { id: 'l3', cert: 'c3', price: 100, firstSeen: '2026-10-23T00:00:00Z' }
      ],
      Observation: [
        { id: 'o1', cert: 'c1', price: 130 },
        { id: 'o2', cert: 'c2', price: 70 },
        { id: 'o3', cert: 'c3', price: 130 }
      ]
    });
    const where = {
      AND: [
        { grade: { eq: 9 } },
        { _walk: { as: 'L', in: IN('Listing'), where: { firstSeen: { gte: RECENT } } } },
        {
          _walk: {
            as: 'O',
            in: IN('Observation'),
            where: { price: { gte: { $ref: 'L.price', times: 1.25 } } }
          }
        }
      ]
    } as WhereClause;
    expect(await both('Cert', where)).toEqual(['c1']);
    const independent = {
      AND: [
        { grade: { eq: 9 } },
        { _walk: { in: IN('Listing'), where: { firstSeen: { gte: RECENT } } } },
        { _walk: { as: 'L', in: IN('Listing') } },
        {
          _walk: {
            in: IN('Observation'),
            where: { price: { gte: { $ref: 'L.price', times: 1.25 } } }
          }
        }
      ]
    } as WhereClause;
    expect(await both('Cert', independent)).toEqual(['c1', 'c2']);
    // A binding may reference a later sibling binding.
    const later = {
      AND: [
        { _walk: { as: 'L', in: IN('Listing'), where: { price: { gt: { $ref: 'O.price' } } } } },
        { _walk: { as: 'O', in: IN('Observation') } }
      ]
    } as WhereClause;
    // c2: its listing at 100 is dearer than its observation at 70.
    expect(await both('Cert', later)).toEqual(['c2']);
  });

  it('jointly bound walks compile to one EXISTS, under a statement timeout', async () => {
    sent = [];
    await pg.read('Cert', {
      where: {
        AND: [
          { grade: { eq: 9 } },
          { _walk: { as: 'L', in: IN('Listing') } },
          {
            _walk: {
              as: 'O',
              in: IN('Observation'),
              where: { price: { gte: { $ref: 'L.price' } } }
            }
          }
        ]
      } as WhereClause
    });
    const q = pageQuery().query;
    expect(q.match(/EXISTS/g)).toHaveLength(1);
    expect(q).toMatch(/FROM rows w1, rows w2/);
    expect(sent.some((s) => /set_config\('statement_timeout'/.test(s.query))).toBe(true);
  });

  it('the walk timeout lowers statement_timeout, never raises it', async () => {
    const shown = async (preset: string | null): Promise<string> =>
      sql.begin(async (tx) => {
        if (preset !== null) await tx.unsafe(`SET LOCAL statement_timeout = '${preset}'`);
        const inTx = new PgDataset({ namespace: NS, sql: tx, inTx: true, fieldDefLookup });
        await inTx.read('Cert', { where: obs() });
        const [row] = await tx<Array<{ statement_timeout: string }>>`SHOW statement_timeout`;
        return row?.statement_timeout ?? '';
      });
    expect(await shown('5s')).toBe('5s');
    expect(await shown(null)).toBe('30s');
    expect(await shown('2min')).toBe('30s');
  });

  it('none, all and any, and nulls under all', async () => {
    await load({
      Cert: [{ id: 'c1' }, { id: 'c2' }],
      Observation: [
        { id: 'o1', cert: 'c1', price: 100 },
        { id: 'o2', cert: 'c1', price: 150 },
        { id: 'o3', cert: 'c2', price: 50 },
        { id: 'o4', cert: 'c2', price: 250 }
      ]
    });
    expect(await both('Cert', obs({ price: { gt: 200 } }, { quantifier: 'none' }))).toEqual(['c1']);
    expect(await both('Cert', obs({ price: { gte: 100 } }, { quantifier: 'all' }))).toEqual(['c1']);
    expect(await both('Cert', obs({ price: { gt: 200 } }, { quantifier: 'any' }))).toEqual(['c2']);
    await pg.write('Observation', fx([{ id: 'o5', cert: 'c1', price: null }]) as never);
    await mem.write('Observation', fx([{ id: 'o5', cert: 'c1', price: null }]) as never);
    expect(await both('Cert', obs({ price: { gte: 100 } }, { quantifier: 'all' }))).toEqual([]);
  });

  it('empty neighbourhood: any and pick false, none and all true', async () => {
    await load({ Cert: [{ id: 'c1' }], Observation: [] });
    const p = { price: { gt: 0 } };
    expect(await both('Cert', obs(p))).toEqual([]);
    expect(await both('Cert', obs(p, { quantifier: 'none' }))).toEqual(['c1']);
    expect(await both('Cert', obs(p, { quantifier: 'all' }))).toEqual(['c1']);
    expect(await both('Cert', obs(undefined, { quantifier: 'all' }))).toEqual(['c1']);
    expect(await both('Cert', obs(p, { pick: { max: 'price' } }))).toEqual([]);
    expect(await both('Cert', obs(undefined, { pick: { latest: 'observedAt' } }))).toEqual([]);
    expect(await both('Cert', obs())).toEqual([]);
  });

  it('pick latest/max/min, nulls last, ties by id', async () => {
    await load({
      Cert: [{ id: 'c1' }],
      Observation: [
        { id: 'o1', cert: 'c1', price: 100, observedAt: '2026-10-20T00:00:00Z' },
        { id: 'o2', cert: 'c1', price: 300, observedAt: '2026-10-21T12:00:00+02:00' },
        { id: 'o3', cert: 'c1', price: 200, observedAt: '2026-10-21T09:00:00Z' },
        { id: 'o4', cert: 'c1', price: null, observedAt: null }
      ]
    });
    const pick = (p: Record<string, string>, price: number) =>
      both('Cert', obs({ price: { eq: price } }, { pick: p }));
    expect(await pick({ latest: 'observedAt' }, 300)).toEqual(['c1']);
    expect(await pick({ latest: 'observedAt' }, 200)).toEqual([]);
    expect(await pick({ max: 'price' }, 300)).toEqual(['c1']);
    expect(await pick({ min: 'price' }, 100)).toEqual(['c1']);
    expect(await pick({ min: 'observedAt' }, 100)).toEqual(['c1']);
    // Ties: whichever id sorts first wins, on both.
    const at = '2026-10-21T00:00:00Z';
    await load({
      Cert: [{ id: 'c1' }],
      Observation: [1, 2, 3, 4, 5].map((i) => ({
        id: `t${i}`,
        cert: 'c1',
        price: i,
        observedAt: at
      }))
    });
    const first = [1, 2, 3, 4, 5].sort((a, b) => (u(`t${a}`) < u(`t${b}`) ? -1 : 1))[0];
    for (const i of [1, 2, 3, 4, 5]) {
      for (const p of [{ latest: 'observedAt' }, { min: 'observedAt' }]) {
        expect(await pick(p, i)).toEqual(i === first ? ['c1'] : []);
      }
    }
  });

  it('a null $ref operand is never true, eq and neq included', async () => {
    await load({
      Cert: [{ id: 'c1', ask: null }, { id: 'c2' }],
      Listing: [{ id: 'l1', cert: 'c1', price: null }],
      Observation: [
        { id: 'o1', cert: 'c1', price: 100 },
        { id: 'o2', cert: 'c2', price: 100 },
        { id: 'o3', cert: 'c2' }
      ]
    });
    for (const op of ['eq', 'neq', 'gt', 'gte', 'lt', 'lte']) {
      const p = { price: { [op]: { $ref: '$.ask' } } } as WhereClause;
      expect(await both('Cert', obs(p)), `any ${op}`).toEqual([]);
      expect(await both('Cert', obs(p, { quantifier: 'none' })), `none ${op}`).toEqual([
        'c1',
        'c2'
      ]);
      expect(await both('Cert', obs(p, { quantifier: 'all' })), `all ${op}`).toEqual([]);
      expect(await both('Cert', { NOT: obs(p) } as WhereClause), `NOT any ${op}`).toEqual([
        'c1',
        'c2'
      ]);
      const bound = {
        AND: [
          { _walk: { as: 'L', in: IN('Listing') } },
          obs({ price: { [op]: { $ref: 'L.price' } } } as WhereClause)
        ]
      } as WhereClause;
      expect(await both('Cert', bound), `bound ${op}`).toEqual([]);
    }
    expect(await both('Cert', { ask: { eq: null } })).toEqual(['c1', 'c2']);
    // neq against a present $ref holds for an absent field, as memory's !equals.
    await load({
      Cert: [{ id: 'c1', ask: 100 }],
      Observation: [{ id: 'o1', cert: 'c1' }]
    });
    expect(await both('Cert', obs({ price: { neq: { $ref: '$.ask' } } } as WhereClause))).toEqual([
      'c1'
    ]);
  });

  it('$ref times and plus, dates to the microsecond, same-row compare', async () => {
    await load({
      Cert: [
        { id: 'c1', ask: 100 },
        { id: 'c2', ask: 100 },
        { id: 'c3', ask: 'not a number' }
      ],
      Listing: [
        { id: 'l1', cert: 'c1', price: 100, firstSeen: '2026-10-20T00:00:00.000001Z' },
        { id: 'l2', cert: 'c2', price: 100, firstSeen: '2026-10-20T00:00:00Z' }
      ],
      Observation: [
        { id: 'o1', cert: 'c1', price: 130, observedAt: '2026-10-21T00:00:00Z' },
        { id: 'o2', cert: 'c2', price: 129, observedAt: '2026-10-21T00:00:00Z' },
        { id: 'o3', cert: 'c3', price: 1000 }
      ]
    });
    expect(
      await both('Cert', obs({ price: { gte: { $ref: '$.ask', times: 1.25, plus: 5 } } }))
    ).toEqual(['c1']);
    expect(await both('Cert', obs({ price: { gt: { $ref: '$.ask', plus: 29 } } }))).toEqual(['c1']);
    const day = 86_400_000;
    for (const plus of [day, day - 0.0004, day + 0.0006, -day]) {
      await both('Cert', {
        AND: [
          { _walk: { as: 'L', in: IN('Listing') } },
          obs({ observedAt: { gte: { $ref: 'L.firstSeen', plus } } })
        ]
      } as WhereClause);
    }
    expect(
      await both('Cert', {
        AND: [
          { _walk: { as: 'L', in: IN('Listing') } },
          obs({ observedAt: { gte: { $ref: 'L.firstSeen', plus: day } } })
        ]
      } as WhereClause)
    ).toEqual(['c2']);
    expect(await both('Listing', { price: { eq: { $ref: '$.price' } } } as WhereClause)).toEqual([
      'l1',
      'l2'
    ]);
  });

  it('$ref arithmetic is float64', async () => {
    await load({
      Cert: [{ id: 'c1', ask: 0.1 }],
      Observation: [{ id: 'o1', cert: 'c1', price: 0.3 }]
    });
    const cmp = (op: string) =>
      both('Cert', obs({ price: { [op]: { $ref: '$.ask', times: 3 } } } as WhereClause));
    expect(await cmp('eq')).toEqual([]);
    expect(await cmp('gte')).toEqual([]);
    expect(await cmp('lt')).toEqual(['c1']);
  });

  it('outbound walks and tombstones', async () => {
    await load(
      {
        Cert: [
          { id: 'c1', grade: 9 },
          { id: 'c2', grade: 8 },
          { id: 'c3', grade: 9 }
        ],
        Observation: [
          { id: 'o1', cert: 'c1', price: 100 },
          { id: 'o2', cert: 'c2' },
          { id: 'o3', cert: 'missing' },
          { id: 'o4', cert: 'c3' },
          { id: 'o5' },
          { id: 'o6', cert: 'c1', price: 5 }
        ]
      },
      { Cert: ['c3'], Observation: ['o6'] }
    );
    const out = (q?: string) =>
      ({
        _walk: { out: 'cert', where: { grade: { eq: 9 } }, ...(q ? { quantifier: q } : {}) }
      }) as WhereClause;
    expect(await both('Observation', out())).toEqual(['o1']);
    expect(await both('Observation', out('none'))).toEqual(['o2', 'o3', 'o4', 'o5']);
    expect(await both('Observation', out('all'))).toEqual(['o1', 'o3', 'o4', 'o5']);
    // The tombstoned o6 is never walked, but still runs its own walks as a seed.
    expect(await both('Cert', obs({ price: { lt: 10 } }))).toEqual([]);
    expect(await both('Observation', { _walk: { out: 'cert' } } as WhereClause, true)).toEqual([
      'o1',
      'o2',
      'o6'
    ]);
  });

  it('three hops', async () => {
    await load({
      Seller: [
        { id: 's1', rating: 5 },
        { id: 's2', rating: 2 }
      ],
      Cert: [{ id: 'c1' }, { id: 'c2' }],
      Listing: [
        { id: 'l1', cert: 'c1', seller: 's1' },
        { id: 'l2', cert: 'c2', seller: 's2' }
      ],
      Observation: [
        { id: 'o1', cert: 'c1', price: 10 },
        { id: 'o2', cert: 'c2', price: 1 }
      ]
    });
    const where = {
      _walk: {
        out: 'cert',
        where: {
          _walk: {
            in: IN('Listing'),
            where: { _walk: { out: 'seller', where: { rating: { gte: 4 } } } }
          }
        }
      }
    } as WhereClause;
    expect(await both('Observation', where)).toEqual(['o1']);
    // A binding is visible two hops down.
    const deep = {
      AND: [
        { _walk: { as: 'O', in: IN('Observation') } },
        {
          _walk: {
            in: IN('Listing'),
            where: { _walk: { out: 'seller', where: { rating: { lt: { $ref: 'O.price' } } } } }
          }
        }
      ]
    } as WhereClause;
    expect(await both('Cert', deep)).toEqual(['c1']);
  });

  it('OR and NOT around walks', async () => {
    await load({
      Cert: [{ id: 'c1' }, { id: 'c2' }, { id: 'c3' }],
      Observation: [
        { id: 'o1', cert: 'c1', price: 100 },
        { id: 'o2', cert: 'c2', price: 5 }
      ]
    });
    const cheap = obs({ price: { lt: 10 } });
    expect(await both('Cert', { NOT: cheap } as WhereClause)).toEqual(['c1', 'c3']);
    expect(await both('Cert', { OR: [cheap, obs({ price: { gt: 50 } })] } as WhereClause)).toEqual([
      'c1',
      'c2'
    ]);
    const branch = {
      OR: [
        { AND: [{ _walk: { as: 'O', in: IN('Observation') } }, { id: { eq: u('c2') } }] },
        { id: { eq: u('c3') } }
      ]
    } as WhereClause;
    expect(await both('Cert', branch)).toEqual(['c2', 'c3']);
  });

  it('the inbound hop is served by the eager crossRef index', async () => {
    await load({
      Cert: Array.from({ length: 50 }, (_, i) => ({ id: `ix${i}` })),
      Observation: Array.from({ length: 5000 }, (_, i) => ({
        id: `ixo${i}`,
        cert: `ix${i % 50}`,
        price: i
      }))
    });
    await sql`ANALYZE rows`;
    sent = [];
    await pg.read('Cert', {
      where: { AND: [{ id: { eq: u('ix7') } }, obs({ price: { gt: 10 } })] } as WhereClause
    });
    const idx = generatedIdentifier(NS, 'Observation', 'cert', 'idx');
    expect(pageQuery().query).toContain(
      `((w1.body ->> 'cert') COLLATE "C") = (r.id::text COLLATE "C")`
    );
    await expectPlanUses(idx);
  }, 60_000);
});

/** A row without the columns only one dataset fills (`_metadata`, `shortId`). */
const strip = (r: Row): Row => {
  const { _metadata: _m, shortId: _s, ...rest } = r;
  return rest as Row;
};

/** The rows `params` reads from `type`, asserting pg and memory agree on every key. */
async function same(type: string, params: ReadParams): Promise<Row[]> {
  const read = async (ds: PgDataset | MemoryDataset) =>
    (await ds.read(type, params)).rows.map(strip);
  const want = await read(mem);
  expect(await read(pg), JSON.stringify(params)).toEqual(want);
  return want;
}
const name = (r: Row) => names.get(String(r.id)) ?? String(r.id);

describe.skipIf(!POSTGRES_URL || !PARTITIONED)('walk aggregates and nested projection (pg)', () => {
  const AGGS = {
    n: { in: IN('Observation'), count: true },
    sold: { in: IN('Observation'), where: { status: { eq: 'sold' } }, count: true },
    avg: { in: IN('Observation'), avg: 'price' },
    sum: { in: IN('Observation'), sum: 'price' },
    lo: { in: IN('Observation'), min: 'price' },
    hi: { in: IN('Observation'), max: 'price' },
    first: { in: IN('Observation'), min: 'observedAt' },
    last: { in: IN('Observation'), max: 'observedAt' },
    latestPrice: { in: IN('Observation'), latest: { by: 'observedAt', value: 'price' } },
    latestStatus: { in: IN('Observation'), latest: { by: 'observedAt', value: 'status' } },
    listings: { in: IN('Listing'), count: true }
  } as unknown as NonNullable<ReadParams['agg']>;

  it('feature row for 100 hubs equals memory', async () => {
    const day = (i: number) => `2026-10-${String(1 + (i % 28)).padStart(2, '0')}T0${i % 10}:00:00Z`;
    await load({
      Cert: Array.from({ length: 100 }, (_, i) => ({ id: `h${i}`, grade: i % 10, ask: i * 1.5 })),
      Observation: Array.from({ length: 400 }, (_, i) => ({
        id: `ho${i}`,
        cert: `h${(i * 7) % 97}`,
        ...(i % 11 === 0 ? {} : { price: (i % 13) * 2.5 }),
        ...(i % 17 === 0 ? {} : { observedAt: day(i) }),
        status: i % 3 === 0 ? 'sold' : 'listed'
      })),
      Listing: Array.from({ length: 60 }, (_, i) => ({
        id: `hl${i}`,
        cert: `h${i % 30}`,
        price: i
      }))
    });
    const rows = await same('Cert', {
      agg: AGGS,
      nested: {
        recent: {
          _walk: { in: IN('Observation') },
          fields: { price: true, observedAt: true, status: true },
          orderBy: [{ observedAt: 'desc' }],
          limit: 3
        }
      },
      limit: 200
    });
    expect(rows).toHaveLength(100);
    const h3 = rows.find((r) => name(r) === 'h3') as Row;
    expect((h3._agg as Record<string, unknown>).n).toBeGreaterThan(0);
    expect(rows.some((r) => r._truncated !== undefined)).toBe(true);
    expect(rows.some((r) => r._truncated === undefined)).toBe(true);
    // The three-hub cut is the same with a where and an orderBy on the seed.
    await same('Cert', {
      where: { grade: { gte: 5 } },
      orderBy: [{ ask: 'desc' }],
      agg: AGGS,
      limit: 10
    });
  });

  it('aggregates ignore nulls and count 0', async () => {
    await load(
      {
        Cert: [{ id: 'c1' }, { id: 'c2' }, { id: 'c3' }],
        Observation: [
          { id: 'o1', cert: 'c1', price: 10, observedAt: '2026-10-01T00:00:00Z', status: 'a' },
          { id: 'o2', cert: 'c1', price: null, observedAt: 'not a date', status: 'b' },
          { id: 'o3', cert: 'c1', price: 'x', observedAt: '2026-10-03T00:00:00.5Z' },
          { id: 'o4', cert: 'c1', price: 20.5, status: 'd' },
          { id: 'o5', cert: 'c2', price: null, observedAt: null },
          // Equal instants, differently written: the lower id wins.
          { id: 'o6', cert: 'c3', price: 1, observedAt: '2026-10-05T00:00:00Z', status: 'x' },
          { id: 'o7', cert: 'c3', price: 2, observedAt: '2026-10-05T01:00:00+01:00' },
          { id: 'o8', cert: 'c1', price: 99 }
        ]
      },
      { Observation: ['o8'] }
    );
    const rows = await same('Cert', { agg: AGGS });
    const agg = (n: string) =>
      (rows.find((r) => name(r) === n) as Row)._agg as Record<string, unknown>;
    expect(agg('c1')).toEqual({
      n: 4,
      sold: 0,
      avg: 15.25,
      sum: 30.5,
      lo: 10,
      hi: 20.5,
      first: '2026-10-01T00:00:00Z',
      last: '2026-10-03T00:00:00.5Z',
      latestPrice: 'x',
      latestStatus: null,
      listings: 0
    });
    expect(agg('c2')).toEqual({
      n: 1,
      sold: 0,
      avg: null,
      sum: null,
      lo: null,
      hi: null,
      first: null,
      last: null,
      latestPrice: null,
      latestStatus: null,
      listings: 0
    });
    const o6First = u('o6') < u('o7');
    expect(agg('c3').first).toEqual(o6First ? '2026-10-05T00:00:00Z' : '2026-10-05T01:00:00+01:00');
    expect(agg('c3').latestPrice).toEqual(o6First ? 1 : 2);
  });

  it('_agg in where', async () => {
    await load({
      Cert: [
        { id: 'c1', ask: 10, minObs: 2 },
        { id: 'c2', ask: 100, minObs: 1 },
        { id: 'c3', ask: 5, minObs: 0 }
      ],
      Observation: [
        { id: 'o1', cert: 'c1', price: 10, observedAt: '2026-10-01T00:00:00Z', status: 'sold' },
        { id: 'o2', cert: 'c1', price: 30, observedAt: '2026-10-09T00:00:00Z', status: 'listed' },
        { id: 'o3', cert: 'c2', price: 0.1, observedAt: '2026-10-05T00:00:00Z', status: 'sold' }
      ]
    });
    const a = (spec: Record<string, unknown>, cmp: Record<string, unknown>) =>
      ({ _agg: { in: IN('Observation'), ...spec }, ...cmp }) as unknown as WhereClause;
    expect(await both('Cert', a({ count: true }, { gte: 2 }))).toEqual(['c1']);
    expect(await both('Cert', a({ count: true }, { eq: 0 }))).toEqual(['c3']);
    expect(await both('Cert', a({ count: true }, { neq: 1 }))).toEqual(['c1', 'c3']);
    expect(await both('Cert', a({ avg: 'price' }, { gt: 15, lt: 25 }))).toEqual(['c1']);
    // A null aggregate matches nothing, neq included; NOT of it matches.
    expect(await both('Cert', a({ avg: 'price' }, { neq: 20 }))).toEqual(['c2']);
    expect(await both('Cert', { NOT: a({ avg: 'price' }, { gte: 0 }) } as WhereClause)).toEqual([
      'c3'
    ]);
    expect(await both('Cert', a({ max: 'observedAt' }, { gte: '2026-10-05' }))).toEqual([
      'c1',
      'c2'
    ]);
    expect(
      await both('Cert', a({ max: 'observedAt' }, { eq: '2026-10-05T00:00:00.000Z' }))
    ).toEqual(['c2']);
    expect(
      await both('Cert', a({ latest: { by: 'observedAt', value: 'status' } }, { eq: 'listed' }))
    ).toEqual(['c1']);
    expect(
      await both('Cert', a({ latest: { by: 'observedAt', value: 'status' } }, { gt: 'm' }))
    ).toEqual(['c2']);
    // Beside an `as` binding, the comparison stays whole in the group.
    expect(
      await both('Cert', {
        AND: [
          { _walk: { as: 'O', in: IN('Observation') } },
          { _agg: { in: IN('Observation'), count: true }, gte: 2 }
        ]
      } as unknown as WhereClause)
    ).toEqual(['c1']);
    // A $ref operand: the seed's field, float64.
    expect(await both('Cert', a({ sum: 'price' }, { gte: { $ref: '$.ask', times: 4 } }))).toEqual([
      'c1'
    ]);
    expect(await both('Cert', a({ sum: 'price' }, { lt: { $ref: '$.ask' } }))).toEqual(['c2']);
    expect(
      await both(
        'Cert',
        a({ latest: { by: 'observedAt', value: 'price' } }, { gte: { $ref: '$.ask', times: 3 } })
      )
    ).toEqual(['c1']);
    // `_agg.<name>` reads the frame's _agg for the same seed row.
    const agg = { n: { in: IN('Observation'), count: true } } as unknown as NonNullable<
      ReadParams['agg']
    >;
    const ref = async (where: WhereClause) => {
      const want = await same('Cert', { where, agg });
      return want.map(name).sort();
    };
    expect(await ref({ minObs: { lte: { $ref: '_agg.n' } } } as WhereClause)).toEqual([
      'c1',
      'c2',
      'c3'
    ]);
    expect(await ref({ minObs: { gte: { $ref: '_agg.n', times: 2 } } } as WhereClause)).toEqual([
      'c3'
    ]);
    expect(await ref(a({ count: true }, { gte: { $ref: '_agg.n' } }) as WhereClause)).toEqual([
      'c1',
      'c2',
      'c3'
    ]);
    // Inside a walk, `_agg.n` still reads the seed's.
    expect(await ref(obs({ price: { lt: { $ref: '_agg.n', times: 10 } } } as WhereClause))).toEqual(
      ['c1', 'c2']
    );
  });

  it('nested list ordered newest first, limited, _truncated set only when cut', async () => {
    await load({
      Cert: [{ id: 'c1' }, { id: 'c2' }, { id: 'c3' }],
      Observation: [
        { id: 'o1', cert: 'c1', price: 1, observedAt: '2026-10-01T00:00:00Z' },
        { id: 'o2', cert: 'c1', price: 2, observedAt: '2026-10-03T00:00:00Z' },
        { id: 'o3', cert: 'c1', price: 3, observedAt: '2026-10-02T00:00:00Z' },
        { id: 'o4', cert: 'c1', price: 4 },
        { id: 'o5', cert: 'c2', price: 5, observedAt: '2026-10-02T00:00:00Z' },
        { id: 'o6', cert: 'c2', price: 6, observedAt: '2026-10-04T00:00:00Z' }
      ]
    });
    const nested = (limit: number, extra: Record<string, unknown> = {}) =>
      ({
        recent: {
          _walk: { in: IN('Observation') },
          fields: { price: true },
          orderBy: [{ observedAt: 'desc' }],
          limit,
          ...extra
        }
      }) as unknown as NonNullable<ReadParams['nested']>;
    const by = (rows: Row[], n: string) => rows.find((r) => name(r) === n) as Row;
    const prices = (r: Row) => (r.recent as Row[]).map((o) => o.price);
    let rows = await same('Cert', { nested: nested(2) });
    expect(prices(by(rows, 'c1'))).toEqual([2, 3]);
    expect(by(rows, 'c1')._truncated).toEqual({ recent: true });
    expect(prices(by(rows, 'c2'))).toEqual([6, 5]);
    expect(by(rows, 'c2')).not.toHaveProperty('_truncated');
    expect(by(rows, 'c3').recent).toEqual([]);
    expect(by(rows, 'c3')).not.toHaveProperty('_truncated');
    // Nulls last; a where on the walk and on the selection; limit 0.
    rows = await same('Cert', { nested: nested(10) });
    expect(prices(by(rows, 'c1'))).toEqual([2, 3, 1, 4]);
    rows = await same('Cert', {
      nested: nested(10, {
        _walk: { in: IN('Observation'), where: { price: { gt: 1 } } },
        where: { price: { lt: 6 } }
      })
    });
    expect(prices(by(rows, 'c2'))).toEqual([5]);
    rows = await same('Cert', { nested: nested(0) });
    expect(by(rows, 'c1').recent).toEqual([]);
    expect(by(rows, 'c1')._truncated).toEqual({ recent: true });
    expect(by(rows, 'c3')).not.toHaveProperty('_truncated');
    // Two lists, one cut.
    rows = await same('Cert', {
      nested: {
        ...nested(1),
        all: { _walk: { in: IN('Observation') }, fields: {}, limit: 10 }
      } as unknown as NonNullable<ReadParams['nested']>
    });
    expect(by(rows, 'c1')._truncated).toEqual({ recent: true });
    const byId = ['o1', 'o2', 'o3', 'o4'].sort((x, y) => (u(x) < u(y) ? -1 : 1));
    expect((by(rows, 'c1').all as Row[]).map(name)).toEqual(byId);
  });

  it("nested projection rows are typed as the far type's schema", async () => {
    await load({
      Seller: [{ id: 's1', rating: 4.5 }],
      Cert: [{ id: 'c1', grade: 9, minObs: 1 }],
      Listing: [
        {
          id: 'l1',
          cert: 'c1',
          seller: 's1',
          price: 12.25,
          firstSeen: '2026-10-20T00:00:00.123456Z'
        },
        { id: 'l2', cert: 'c1', firstSeen: '2026-10-21' }
      ],
      Observation: [
        { id: 'o1', cert: 'c1', price: 3, observedAt: '2026-10-21T00:00:00Z' },
        { id: 'o2', cert: 'c1', price: 1, observedAt: '2026-10-22T00:00:00Z' }
      ]
    });
    const rows = await same('Cert', {
      agg: { n: { in: IN('Observation'), count: true } } as unknown as NonNullable<
        ReadParams['agg']
      >,
      nested: {
        listings: {
          _walk: { in: IN('Listing') },
          fields: {
            cert: true,
            seller: true,
            price: true,
            firstSeen: true,
            _agg: { obs: { out: 'cert', count: true } },
            sellerRow: { _walk: { out: 'seller' }, fields: { rating: true }, limit: 5 },
            certRow: {
              _walk: { out: 'cert' },
              fields: {
                grade: true,
                obs: {
                  _walk: { in: IN('Observation') },
                  // `_agg.n` is the top-level seed's.
                  where: { price: { lte: { $ref: '_agg.n', times: 2 } } },
                  fields: { price: true },
                  orderBy: [{ price: 'asc' }],
                  limit: 1
                }
              },
              limit: 5
            }
          },
          orderBy: [{ firstSeen: 'asc' }],
          limit: 5
        }
      } as unknown as NonNullable<ReadParams['nested']>
    });
    const ls = rows[0]?.listings as Row[];
    expect(ls[0]).toEqual({
      id: u('l1'),
      cert: u('c1'),
      seller: u('s1'),
      price: 12.25,
      firstSeen: '2026-10-20T00:00:00.123456Z',
      _agg: { obs: 1 },
      sellerRow: [{ id: u('s1'), rating: 4.5 }],
      certRow: [
        { id: u('c1'), grade: 9, obs: [{ id: u('o2'), price: 1 }], _truncated: { obs: true } }
      ]
    });
    expect(ls[1]).toMatchObject({ id: u('l2'), seller: null, price: null, sellerRow: [] });
    expect(ls[1]).not.toHaveProperty('_metadata');
  });

  it('metadata in nested orderBy and aggregates matches memory', async () => {
    const meta = (createdAt: string, by: string) => ({
      _metadata: {
        createdAt,
        updatedAt: createdAt,
        createdBy: { kind: 'agent', id: by },
        updatedBy: null
      }
    });
    await load({
      Cert: [{ id: 'c1' }, { id: 'c2' }],
      Observation: [
        { id: 'o1', cert: 'c1', price: 1, ...meta('2026-10-01T00:00:00.123Z', 'a') },
        { id: 'o2', cert: 'c1', price: 2, ...meta('2026-10-03T00:00:00.000Z', 'B') },
        { id: 'o3', cert: 'c1', price: 3, ...meta('2026-10-03T00:00:00.000Z', 'b') },
        { id: 'o4', cert: 'c2', price: 4, ...meta('2026-10-02T12:30:00.500Z', 'A') }
      ]
    });
    const rows = await same('Cert', {
      agg: {
        last: { in: IN('Observation'), latest: { by: 'createdAt', value: 'createdAt' } },
        newest: { in: IN('Observation'), max: 'createdAt' },
        oldest: { in: IN('Observation'), min: 'createdAt' },
        by: { in: IN('Observation'), latest: { by: 'createdAt', value: 'createdById' } }
      } as unknown as NonNullable<ReadParams['agg']>,
      nested: {
        obs: {
          _walk: { in: IN('Observation') },
          fields: { price: true },
          orderBy: [{ createdById: 'asc' }],
          limit: 10
        }
      } as unknown as NonNullable<ReadParams['nested']>
    });
    const c1 = rows.find((r) => name(r) === 'c1') as Row;
    // Byte order: 'B' before 'a' before 'b'.
    expect((c1.obs as Row[]).map((o) => o.price)).toEqual([2, 1, 3]);
    expect(c1._agg).toMatchObject({
      newest: '2026-10-03T00:00:00.000Z',
      oldest: '2026-10-01T00:00:00.123Z'
    });
  });
});

/** The whole-result answer `params` reads from `type`, asserting pg and memory agree. */
async function sameResult(type: string, params: ReadParams): Promise<ReadResult> {
  const pick = ({ rows, hasMore, count, groups, truncated }: ReadResult) =>
    ({ rows, hasMore, count, groups, truncated }) as ReadResult;
  const want = pick(await mem.read(type, params));
  expect(pick(await pg.read(type, params)), JSON.stringify(params)).toEqual(want);
  return want;
}

describe.skipIf(!POSTGRES_URL || !PARTITIONED)('count, aggregate and bucket (pg)', () => {
  const FRAME = {
    n: { count: true },
    avg: { avg: 'price' },
    sum: { sum: 'price' },
    lo: { min: 'price' },
    hi: { max: 'price' },
    first: { min: 'observedAt' },
    last: { max: 'observedAt' },
    firstMade: { min: 'createdAt' }
  } as unknown as NonNullable<ReadParams['aggregate']>;
  // Supplied, so pg and memory hold the same createdAt.
  const made = (i: number) => ({
    _metadata: {
      createdAt: `2026-10-0${1 + (i % 3)}T1${i}:00:00.000Z`,
      updatedAt: '2026-10-05T00:00:00.000Z',
      createdBy: null,
      updatedBy: null
    }
  });
  const fixture = () =>
    load(
      {
        Cert: [
          { id: 'c1', grade: 9 },
          { id: 'c2', grade: 9 },
          { id: 'c3', grade: 8 },
          { id: 'c4', grade: 9 }
        ],
        Observation: [
          {
            id: 'o1',
            cert: 'c1',
            price: 0.1,
            observedAt: '2026-10-01T23:59:59.999999Z',
            ...made(1)
          },
          { id: 'o2', cert: 'c1', price: 0.2, observedAt: '2026-10-02T00:00:00Z', ...made(2) },
          { id: 'o3', cert: 'c2', price: 'x', observedAt: '2026-10-02T01:30:00+02:00', ...made(3) },
          { id: 'o4', cert: 'c2', observedAt: '2026-10-01T22:00:00-03:00', ...made(4) },
          { id: 'o5', cert: 'c3', price: 7, ...made(5) },
          { id: 'o6', cert: 'c3', price: 8, observedAt: 'not a date', ...made(6) },
          { id: 'o7', cert: 'c3', price: 9, observedAt: '2026-10-02T00:00:00.000Z', ...made(7) },
          { id: 'o8', cert: 'c4', price: 100, observedAt: '2026-10-03T00:00:00Z', ...made(8) }
        ]
      },
      { Observation: ['o8'] }
    );

  it('count equals memory, with walks in where', async () => {
    await fixture();
    expect((await sameResult('Cert', { count: true })).count).toBe(4);
    const sold = { AND: [{ grade: { eq: 9 } }, obs({ price: { gt: 0.15 } })] } as WhereClause;
    expect((await sameResult('Cert', { count: true, where: sold })).count).toBe(1);
    // o8 is tombstoned: c4 has no live observation.
    expect((await sameResult('Cert', { count: true, where: obs() })).count).toBe(3);
    expect((await sameResult('Cert', { count: true, where: { grade: { eq: 1 } } })).count).toBe(0);
  });

  it('aggregate over the whole result', async () => {
    await fixture();
    const all = await sameResult('Observation', { aggregate: FRAME });
    expect(all.groups?.[0]).toMatchObject({ n: 7, hi: 9, first: '2026-10-02T01:30:00+02:00' });
    const one = await sameResult('Observation', {
      aggregate: FRAME,
      where: obs() as WhereClause,
      limit: 1
    });
    expect(one.groups).toHaveLength(1);
    await sameResult('Observation', {
      aggregate: FRAME,
      where: { cert: { eq: u('c3') } } as WhereClause
    });
    // An empty match is one group: count 0, the rest null.
    const none = await sameResult('Observation', {
      aggregate: FRAME,
      where: { price: { gt: 1000 } }
    });
    expect(none.groups).toEqual([
      { n: 0, avg: null, sum: null, lo: null, hi: null, first: null, last: null, firstMade: null }
    ]);
  });

  it('bucket by day crosses UTC midnight as memory does', async () => {
    await fixture();
    const day = await sameResult('Observation', {
      aggregate: FRAME,
      bucket: { field: 'observedAt', by: 'day' }
    });
    expect(day.groups?.map((g) => [g.bucket, g.n])).toEqual([
      ['2026-10-01', 2],
      ['2026-10-02', 3]
    ]);
    const hour = await sameResult('Observation', {
      aggregate: { n: { count: true }, avg: { avg: 'price' } } as unknown as NonNullable<
        ReadParams['aggregate']
      >,
      bucket: { field: 'observedAt', by: 'hour' }
    });
    expect(hour.groups?.map((g) => g.bucket)).toEqual([
      '2026-10-01T23',
      '2026-10-02T00',
      '2026-10-02T01'
    ]);
    await sameResult('Observation', {
      aggregate: { n: { count: true } } as unknown as NonNullable<ReadParams['aggregate']>,
      bucket: { field: 'createdAt', by: 'hour' }
    });
    const none = await sameResult('Observation', {
      aggregate: { n: { count: true } } as unknown as NonNullable<ReadParams['aggregate']>,
      bucket: { field: 'observedAt', by: 'day' },
      where: { price: { gt: 1000 } }
    });
    expect(none.groups).toEqual([]);
  });

  it('pick-only whole-result aggregates are one group', async () => {
    await fixture();
    const picks = { first: { min: 'observedAt' }, last: { max: 'observedAt' } };
    const only = await sameResult('Observation', {
      aggregate: picks as unknown as NonNullable<ReadParams['aggregate']>
    });
    expect(only.groups).toHaveLength(1);
    const empty = await sameResult('Observation', {
      aggregate: picks as unknown as NonNullable<ReadParams['aggregate']>,
      where: { price: { gt: 1000 } }
    });
    expect(empty.groups).toEqual([{ first: null, last: null }]);
    const mixed = await sameResult('Observation', {
      aggregate: { ...picks, n: { count: true } } as unknown as NonNullable<
        ReadParams['aggregate']
      >,
      where: { cert: { eq: u('c1') } } as WhereClause
    });
    expect(mixed.groups).toHaveLength(1);
  });

  it("a bucketed pick stays inside its bucket's rows", async () => {
    const at = (createdAt: string) => ({
      _metadata: { createdAt, updatedAt: createdAt, createdBy: null, updatedBy: null }
    });
    // The same instant stored two ways; pa (the lower id) sits in the other bucket.
    await load({
      Observation: [
        { id: 'pa', observedAt: '2026-10-02T00:00:00Z', ...at('2026-10-01T05:00:00.000Z') },
        { id: 'pb', observedAt: '2026-10-02T02:00:00+02:00', ...at('2026-10-02T05:00:00.000Z') }
      ]
    });
    const day = await sameResult('Observation', {
      aggregate: { first: { min: 'observedAt' } } as unknown as NonNullable<
        ReadParams['aggregate']
      >,
      bucket: { field: 'createdAt', by: 'day' }
    });
    expect(day.groups).toEqual([
      { bucket: '2026-10-01', first: '2026-10-02T00:00:00Z' },
      { bucket: '2026-10-02', first: '2026-10-02T02:00:00+02:00' }
    ]);
  });

  it('date picks are bounded top-1s, never array_agg', async () => {
    await fixture();
    sent = [];
    await pg.read('Observation', {
      aggregate: { first: { min: 'observedAt' } } as unknown as NonNullable<ReadParams['aggregate']>
    });
    for (const [mode, plan] of await plansOf()) expect(plan, mode).not.toContain('array_agg');
    sent = [];
    await pg.read('Cert', {
      agg: {
        last: { in: IN('Observation'), latest: { by: 'observedAt', value: 'price' } }
      } as unknown as NonNullable<ReadParams['agg']>
    });
    for (const [mode, plan] of await plansOf()) {
      expect(plan, mode).not.toContain('array_agg');
      expect(plan, mode).toContain('"Node Type":"Limit"');
    }
  });

  it('groups beyond the page max set truncated', async () => {
    await fixture();
    const params = {
      aggregate: { n: { count: true } } as unknown as NonNullable<ReadParams['aggregate']>,
      bucket: { field: 'observedAt', by: 'hour' as const }
    };
    const cut = await sameResult('Observation', { ...params, limit: 2 });
    expect(cut).toMatchObject({ truncated: true });
    expect(cut.groups).toHaveLength(2);
    expect(await sameResult('Observation', { ...params, limit: 3 })).not.toHaveProperty(
      'truncated',
      true
    );
    await sameResult('Observation', { ...params, limit: 0 });
  });

  it('a windowed bucket query is served by the date index', async () => {
    const at = (i: number) => new Date(Date.UTC(2026, 0, 1) + i * 3_600_000).toISOString();
    await load({
      Observation: Array.from({ length: 5000 }, (_, i) => ({
        id: `wo${i}`,
        price: i % 50,
        observedAt: at(i)
      }))
    });
    await sql`ANALYZE rows`;
    const params: ReadParams = {
      where: { observedAt: { gte: at(96), lt: at(144) } },
      aggregate: { n: { count: true }, avg: { avg: 'price' } } as unknown as NonNullable<
        ReadParams['aggregate']
      >,
      bucket: { field: 'observedAt', by: 'day' },
      limit: 100
    };
    expect((await sameResult('Observation', params)).groups).toHaveLength(2);
    sent = [];
    await pg.read('Observation', params);
    await expectPlanUses(generatedIdentifier(NS, 'Observation', 'observedAt', 'idx'));
  }, 60_000);
});

describe.skipIf(!POSTGRES_URL || !PARTITIONED)('derived ordering (pg)', () => {
  const DIFF = { d: { diff: ['$.ask', '$.grade'] } } as NonNullable<ReadParams['derive']>;
  const RATIO = { q: { ratio: ['$.ask', '$.grade'] } } as NonNullable<ReadParams['derive']>;
  // minObs 1 marks the result's rows; 0 marks the unrelated ones.
  const certs = () => [
    { id: 'd1', grade: 9, ask: 10, minObs: 1 },
    { id: 'd2', grade: 8, ask: 10, minObs: 1 },
    { id: 'd3', grade: 2, ask: 3, minObs: 1 },
    { id: 'd4', grade: 0, ask: 5, minObs: 1 },
    { id: 'd5', grade: 5, minObs: 1 },
    { id: 'd6', grade: 'x', ask: 4, minObs: 1 },
    { id: 'd7', grade: 1, ask: 3, minObs: 1 },
    { id: 'd8', grade: 7, ask: 9, minObs: 1 },
    { id: 'd9', grade: 0.1, ask: 0.3, minObs: 1 },
    { id: 'd10', grade: 3, ask: -6, minObs: 1 },
    { id: 'd11', ask: 1, minObs: 1 },
    { id: 'd12', grade: 4, ask: 1e-9, minObs: 1 },
    { id: 'u1', grade: 2, ask: 4, minObs: 0 },
    { id: 'u2', grade: 1, ask: 0, minObs: 0 }
  ];
  const ours = { minObs: { eq: 1 } } as WhereClause;

  /**
   * Every page of `params` from `ds`, with the (derived value, id) each page's
   * cursor carries; `between` runs after each page. Memory's cursor also lists
   * the id among its values and pg's does not, so the payloads are compared by key.
   */
  async function pages(
    ds: PgDataset | MemoryDataset,
    params: ReadParams,
    between?: () => Promise<void>
  ): Promise<{ ids: string[][]; cursors: unknown[] }> {
    const ids: string[][] = [];
    const cursors: unknown[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 30; i++) {
      const res = await ds.read('Cert', { ...params, ...(cursor === undefined ? {} : { cursor }) });
      ids.push(res.rows.map(name));
      if (res.nextCursor !== undefined) {
        const c = JSON.parse(Buffer.from(res.nextCursor, 'base64url').toString('utf8'));
        cursors.push([c.orderByValues[0], c.id]);
      }
      if (res.nextCursor === undefined) break;
      cursor = res.nextCursor;
      await between?.();
    }
    return { ids, cursors };
  }

  it('derive orders like memory, nulls and zero divisor last', async () => {
    await load({ Cert: certs() });
    for (const dir of ['asc', 'desc'] as const) {
      for (const derive of [DIFF, RATIO]) {
        const key = `$${Object.keys(derive)[0]}`;
        const order = (await same('Cert', { where: ours, derive, orderBy: [{ [key]: dir }] })).map(
          name
        );
        // d5 (no ask), d6 (non-numeric grade) and d11 (no grade) have no value, nor
        // d4 under ratio (zero divisor): they come last in both directions.
        const tail = derive === RATIO ? ['d11', 'd4', 'd5', 'd6'] : ['d11', 'd5', 'd6'];
        expect([...order.slice(-tail.length)].sort(), `${key} ${dir}`).toEqual(tail);
        await same('Cert', {
          where: ours,
          derive,
          orderBy: [{ minObs: 'asc' }, { [key]: dir }],
          limit: 5
        });
      }
    }
  });

  it('ratio against a pick-one _agg', async () => {
    const at = (d: number) => `2026-10-0${d}T00:00:00Z`;
    await load({
      Cert: certs(),
      Observation: [
        { id: 'p1', cert: 'd1', price: 4, observedAt: at(1) },
        { id: 'p2', cert: 'd1', price: 5, observedAt: at(2) },
        { id: 'p3', cert: 'd2', price: 0, observedAt: at(2) },
        { id: 'p4', cert: 'd3', price: 'x', observedAt: at(3) },
        { id: 'p5', cert: 'd7', price: 3, observedAt: at(1) },
        { id: 'p6', cert: 'd8', price: 0.7, observedAt: at(4) },
        { id: 'p7', cert: 'd9', price: 3, observedAt: at(4) },
        { id: 'p8', cert: 'd10', price: -2, observedAt: at(5) }
      ]
    });
    const agg = {
      lp: { in: IN('Observation'), latest: { by: 'observedAt', value: 'price' } }
    } as unknown as NonNullable<ReadParams['agg']>;
    const derive = { m: { ratio: ['$.ask', '_agg.lp'] } } as NonNullable<ReadParams['derive']>;
    for (const dir of ['asc', 'desc'] as const) {
      const rows = await same('Cert', { where: ours, agg, derive, orderBy: [{ $m: dir }] });
      // d1 10/5, d7 3/3, d8 9/0.7, d9 0.3/3, d10 -6/-2; the rest have no value.
      const valued =
        dir === 'desc' ? ['d8', 'd10', 'd1', 'd7', 'd9'] : ['d9', 'd7', 'd1', 'd10', 'd8'];
      expect(rows.map(name).slice(0, 5)).toEqual(valued);
      const paged = await pages(pg, { where: ours, agg, derive, orderBy: [{ $m: dir }], limit: 2 });
      expect(paged).toEqual(
        await pages(mem, { where: ours, agg, derive, orderBy: [{ $m: dir }], limit: 2 })
      );
      expect(paged.ids.flat()).toEqual(rows.map(name));
    }
  });

  it('derive keyset pages agree with the unpaged read, null tail included', async () => {
    await load({ Cert: certs() });
    for (const dir of ['asc', 'desc'] as const) {
      for (const derive of [DIFF, RATIO]) {
        const key = `$${Object.keys(derive)[0]}`;
        const base = { where: ours, derive, orderBy: [{ [key]: dir }] };
        const full = (await pg.read('Cert', base)).rows.map(name);
        for (const limit of [1, 2, 3, 5]) {
          const paged = await pages(pg, { ...base, limit });
          // Each cursor carries memory's value and id.
          expect(paged, `${key} ${dir} ${limit}`).toEqual(await pages(mem, { ...base, limit }));
          expect(paged.ids.flat()).toEqual(full);
        }
      }
    }
  });

  it('derive keyset pages agree with the unpaged read while unrelated rows change', async () => {
    await load({ Cert: certs() });
    const unpaged = { where: ours, derive: DIFF, orderBy: [{ $d: 'desc' as const }] };
    const base = { ...unpaged, limit: 2 };
    const full = (await pg.read('Cert', unpaged)).rows.map(name);
    // Unrelated rows whose values land among the result's, rewritten and added between pages.
    let n = 0;
    const churn = (ds: PgDataset | MemoryDataset) => async () => {
      n++;
      await ds.write(
        'Cert',
        fx([
          { id: 'u1', grade: n % 3, ask: 2 + (n % 5), minObs: 0 },
          { id: 'u2', grade: 1, ask: n, minObs: 0 },
          { id: `un${n}`, grade: 0, ask: n % 4, minObs: 0 }
        ]) as never
      );
    };
    const paged = await pages(pg, base, churn(pg));
    n = 0;
    expect(paged).toEqual(await pages(mem, base, churn(mem)));
    expect(paged.ids.flat()).toEqual(full);
    expect(n).toBeGreaterThan(3);
  });

  it('a cursor replayed in the other direction, or forged, is invalid_cursor', async () => {
    await load({ Cert: certs() });
    const base = { where: ours, derive: DIFF, limit: 2 };
    const first = await pg.read('Cert', { ...base, orderBy: [{ $d: 'desc' }] });
    expect(first.nextCursor).toBeDefined();
    const flipped = {
      ...base,
      orderBy: [{ $d: 'asc' as const }],
      cursor: String(first.nextCursor)
    };
    await expect(pg.read('Cert', flipped)).rejects.toMatchObject({ code: 'invalid_cursor' });
    await expect(mem.read('Cert', flipped)).rejects.toMatchObject({ code: 'invalid_cursor' });
    const forged = encodeCursor({
      orderByValues: ['1; DROP TABLE rows'],
      id: u('d1'),
      order: [
        ['$d', 'desc'],
        ['id', 'asc']
      ]
    });
    await expect(
      pg.read('Cert', { ...base, orderBy: [{ $d: 'desc' }], cursor: forged })
    ).rejects.toMatchObject({ code: 'invalid_cursor' });
  });
});

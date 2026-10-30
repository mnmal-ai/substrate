/**
 * Typed edge walks compiled to SQL (spec 2026-10-24-typed-edge-walks §3, §5).
 * The memory dataset's reference evaluator is the oracle: every case runs the
 * same fixture and where through both and expects the same rows.
 */

import { createHash, randomBytes } from 'node:crypto';
import { MemoryDataset } from '@mnmal-ai/substrate-dataset-memory';
import {
  type FieldDef,
  ResolverFrameError,
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
  Observation: { cert: ref('Cert'), price: num, observedAt: date, status: str },
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

  it('refuses what later tasks compile, by name', async () => {
    const refused = { code: 'walk_unsupported_ref' };
    await expect(pg.read('Cert', { count: true })).rejects.toMatchObject(refused);
    await expect(
      pg.read('Cert', {
        where: { _agg: { in: IN('Observation'), count: true }, gte: 1 } as unknown as WhereClause
      })
    ).rejects.toMatchObject(refused);
    await expect(
      pg.read('Cert', { agg: { n: { in: IN('Observation'), count: true } } })
    ).rejects.toMatchObject(refused);
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
    const { query, parameters, types } = pageQuery();
    const idx = generatedIdentifier(NS, 'Observation', 'cert', 'idx');
    expect(query).toContain(`((w1.body ->> 'cert') COLLATE "C") = (r.id::text COLLATE "C")`);
    // As index-use's expectServedBy: the statement read() sent, prepared, under
    // a forced custom plan and a forced generic one.
    const conn = await sql.reserve();
    try {
      const typeNames = await conn<Array<{ t: string }>>`
        SELECT format_type(oid, NULL) AS t FROM unnest(${types}::oid[]) WITH ORDINALITY u(oid, k)
        ORDER BY k`;
      const list = (xs: string[]) => (xs.length === 0 ? '' : `(${xs.join(', ')})`);
      const literals = parameters.map((p) => `'${String(p).replace(/'/g, "''")}'`);
      await conn.unsafe(`PREPARE walk_stmt${list(typeNames.map((n) => n.t))} AS ${query}`);
      for (const mode of ['force_custom_plan', 'force_generic_plan']) {
        await conn.unsafe(`SET plan_cache_mode = ${mode}`);
        const plan = JSON.stringify(
          await conn.unsafe(`EXPLAIN (FORMAT JSON) EXECUTE walk_stmt${list(literals)}`)
        );
        expect(plan, mode).toContain(`"Index Name":"${idx}"`);
      }
    } finally {
      await conn.unsafe('DEALLOCATE ALL');
      await conn.unsafe('RESET plan_cache_mode');
      conn.release();
    }
  }, 60_000);
});

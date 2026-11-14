/**
 * Walk parity on the far row's own columns (Todo #1829): its shortId (the
 * `short_ids` sidecar, looked up per far row), its row metadata (`created_at`,
 * `created_by_*`) and a field held first in `extra` (pending) and then in its
 * own column (promoted). Each read goes through pg and the memory reference,
 * which must agree, and the answer is checked.
 */

import { randomUUID } from 'node:crypto';
import { MemoryDataset } from '@mnmal-ai/substrate-dataset-memory';
import {
  type FieldDef,
  type MetadataHop,
  normaliseMetadataWhere,
  type ReadParams,
  type Row,
  type RowMetadata,
  type WhereClause
} from '@mnmal-ai/substrate-types';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PgDataset } from '../src/index.js';
import { loadTypeTable } from '../src/type-table.js';
import { dropNamespace } from './_layout.js';
import { walkComparers } from './_walk-helpers.js';

const POSTGRES_URL = process.env.POSTGRES_URL;
const NS = `wfar_${randomUUID().slice(0, 8)}`;
const num: FieldDef = { kind: 'scalar', type: 'number' };
const ref: FieldDef = { kind: 'crossRef', ns: NS, type: 'Cert', onDelete: 'set_null' };
const defs: Record<string, Record<string, FieldDef>> = {
  Cert: { grade: num },
  Observation: { cert: ref, price: num }
};
const lookup = {
  fieldDefLookup: (type: string, f: string) => defs[type]?.[f],
  typeDefLookup: (type: string) => (defs[type] ? { fields: defs[type] } : undefined)
};

const ids = new Map<string, string>();
const labels = new Map<string, string>();
const u = (name: string): string => {
  let id = ids.get(name);
  if (id === undefined) {
    id = randomUUID();
    ids.set(name, id);
    labels.set(id, name);
  }
  return id;
};
const label = (r: Row) => labels.get(String(r.id)) ?? String(r.id);

const meta = (day: number, by: string): RowMetadata => {
  const at = `2026-10-${String(day).padStart(2, '0')}T00:00:00.000Z`;
  const actor = { kind: 'agent' as const, id: by };
  return { createdAt: at, updatedAt: at, createdBy: actor, updatedBy: actor };
};

/**
 * c1 has o1 (#11, kid-a, day 1) and o2 (#12, kid-b, day 20); c2 has o3 (#13,
 * kid-a, day 5); c3 has o4 (#14, kid-b, day 25); c4 has none. `rank`
 * becomes a field after the rows exist, so it is pending until swept.
 */
const CERTS = [1, 2, 3, 4].map((n) => ({ id: `c${n}`, grade: 9 }));
const OBS = [
  { id: 'o1', cert: 'c1', price: 10, rank: 3, short: 11, meta: meta(1, 'kid-a') },
  { id: 'o2', cert: 'c1', price: 20, rank: 1, short: 12, meta: meta(20, 'kid-b') },
  { id: 'o3', cert: 'c2', price: 30, rank: 7, short: 13, meta: meta(5, 'kid-a') },
  { id: 'o4', cert: 'c3', price: 40, rank: null, short: 14, meta: meta(25, 'kid-b') }
];

let sql: Sql;
let pg: PgDataset;
let mem: MemoryDataset;
const { same } = walkComparers(
  () => ({ pg, mem }),
  (id) => labels.get(id) ?? id
);

const IN = `${NS}/Observation.cert`;
const obs = (where?: WhereClause, extra: Record<string, unknown> = {}) =>
  ({ _walk: { in: IN, ...(where ? { where } : {}), ...extra } }) as WhereClause;
/** The engine's metadata rewrite into the walk, with a hop to Observation's fields. */
const hop: MetadataHop = () => ({ fields: defs.Observation ?? {}, hop });
const normal = (where: WhereClause) =>
  normaliseMetadataWhere(where, defs.Cert ?? {}, hop) as WhereClause;
const nested = (n: Record<string, unknown>) => n as unknown as NonNullable<ReadParams['nested']>;
const agg = (a: Record<string, unknown>) => a as unknown as NonNullable<ReadParams['agg']>;

/** The cert labels `params` reads, sorted, asserting pg and memory agree. */
const certs = async (params: ReadParams) => (await same('Cert', params)).map(label).sort();
/** Per cert, the labels of a nested list `name`. */
const lists = async (params: ReadParams, name = 'obs') =>
  Object.fromEntries(
    (await same('Cert', params)).map((r) => [
      label(r),
      (r[name] as Row[]).map((o) => labels.get(String(o.id)))
    ])
  );

beforeAll(async () => {
  if (!POSTGRES_URL) return;
  sql = postgres(POSTGRES_URL, { onnotice: () => {} });
  pg = new PgDataset({ namespace: NS, sql, ...lookup });
  mem = new MemoryDataset({ namespace: NS, ...lookup, walkReference: true });
  for (const type of Object.keys(defs)) await pg.ensureTypeStorage(type);
  const certRows = CERTS.map((c) => ({ ...c, id: u(c.id) }));
  const obsRows = OBS.map((o) => ({
    id: u(o.id),
    cert: u(o.cert),
    price: o.price,
    ...(o.rank === null ? {} : { rank: o.rank }),
    _metadata: o.meta
  }));
  for (const ds of [pg, mem]) {
    await ds.write('Cert', certRows);
    await ds.write('Observation', obsRows as never);
    for (const o of OBS) await ds.bindShortId('Observation', o.short, u(o.id));
  }
  defs.Observation = { ...defs.Observation, rank: num };
  expect(await pg.ensureTypeStorage('Observation', { newFields: 'pending' })).toEqual({
    pending: ['rank']
  });
});

afterAll(async () => {
  if (!POSTGRES_URL) return;
  await dropNamespace(sql, NS);
  await sql.end({ timeout: 5 });
});

describe.skipIf(!POSTGRES_URL)('walk parity on far-row columns', () => {
  it('a walk where reads the far row shortId', async () => {
    expect(await certs({ where: obs({ shortId: { eq: 13 } }) })).toEqual(['c2']);
    expect(await certs({ where: obs({ shortId: { in: [11, 14] } }) })).toEqual(['c1', 'c3']);
    expect(await certs({ where: obs({ shortId: { gt: 11 } }, { quantifier: 'all' }) })).toEqual([
      'c2',
      'c3',
      'c4'
    ]);
    expect(await certs({ where: obs({ shortId: { gte: 12 } }, { quantifier: 'none' }) })).toEqual([
      'c4'
    ]);
    expect(
      await certs({
        where: {
          _agg: { in: IN, where: { shortId: { lt: 13 } }, count: true },
          eq: 2
        } as unknown as WhereClause
      })
    ).toEqual(['c1']);
  });

  it('a nested selection filters its far rows on shortId', async () => {
    const shape = (where: WhereClause) =>
      lists({
        nested: nested({
          obs: { _walk: { in: IN }, where, fields: { price: true }, orderBy: [{ price: 'asc' }] }
        })
      });
    expect(await shape({ shortId: { gte: 12 } })).toEqual({
      c1: ['o2'],
      c2: ['o3'],
      c3: ['o4'],
      c4: []
    });
    // The same filter on the nested _walk's own where.
    expect(
      await lists({
        nested: nested({
          obs: { _walk: { in: IN, where: { shortId: { neq: 12 } } }, fields: { price: true } }
        })
      })
    ).toEqual({ c1: ['o1'], c2: ['o3'], c3: ['o4'], c4: [] });
  });

  it('a walk where reads the far row createdAt and createdBy, in every spelling', async () => {
    const cases: Array<[WhereClause, string[]]> = [
      [{ createdAt: { gte: '2026-10-20T00:00:00Z' } }, ['c1', 'c3']],
      [{ _metadata: { createdAt: { lt: '2026-10-10T00:00:00Z' } } } as WhereClause, ['c1', 'c2']],
      [{ updatedAt: { gt: '2026-10-21T00:00:00Z' } }, ['c3']],
      [{ createdBy: { eq: 'kid-a' } } as WhereClause, ['c1', 'c2']],
      [{ createdBy: { eq: { kind: 'agent', id: 'kid-b' } } } as WhereClause, ['c1', 'c3']],
      [{ 'createdBy.id': { eq: 'kid-b' } } as WhereClause, ['c1', 'c3']],
      [{ createdById: { eq: 'nobody' } }, []]
    ];
    for (const [where, want] of cases) {
      expect(await certs({ where: normal(obs(where)) }), JSON.stringify(where)).toEqual(want);
    }
    // all: every live observation by kid-a (c4 vacuously).
    expect(
      await certs({
        where: normal(obs({ createdBy: { eq: 'kid-a' } } as WhereClause, { quantifier: 'all' }))
      })
    ).toEqual(['c2', 'c4']);
  });

  it('pick, a nested order and an _agg read the far row createdAt', async () => {
    // c1's latest observation by createdAt is o2, by kid-b.
    expect(
      await certs({
        where: normal(
          obs({ createdBy: { eq: 'kid-b' } } as WhereClause, { pick: { latest: 'createdAt' } })
        )
      })
    ).toEqual(['c1', 'c3']);
    expect(
      await certs({
        where: normal(
          obs({ createdBy: { eq: 'kid-a' } } as WhereClause, { pick: { min: 'createdAt' } })
        )
      })
    ).toEqual(['c1', 'c2']);
    expect(
      await lists({
        nested: nested({
          obs: { _walk: { in: IN }, fields: { price: true }, orderBy: [{ createdAt: 'desc' }] }
        })
      })
    ).toEqual({ c1: ['o2', 'o1'], c2: ['o3'], c3: ['o4'], c4: [] });
    const rows = await same('Cert', {
      agg: agg({ last: { in: IN, latest: { by: 'createdAt', value: 'price' } } })
    });
    expect(
      Object.fromEntries(rows.map((r) => [label(r), (r._agg as { last: unknown }).last]))
    ).toEqual({ c1: 20, c2: 30, c3: 40, c4: null });
  });

  /** Every walk shape over `rank`, run while it is pending and again once promoted. */
  async function rankReads(): Promise<void> {
    expect(await certs({ where: obs({ rank: { gte: 3 } }) })).toEqual(['c1', 'c2']);
    expect(await certs({ where: obs({ rank: { eq: null } }) })).toEqual(['c3']);
    expect(await certs({ where: obs({ rank: { lt: 5 } }, { pick: { max: 'rank' } }) })).toEqual([
      'c1'
    ]);
    expect(
      await certs({
        where: obs({ price: { eq: 10 } }, { pick: { max: 'rank' }, among: { rank: { gt: 0 } } })
      })
    ).toEqual(['c1']);
    expect(
      await certs({
        where: obs({ price: { lt: { $ref: '$.grade', times: 3 } } }, { pick: { min: 'rank' } })
      })
    ).toEqual(['c1']);
    expect(
      await lists({
        nested: nested({
          obs: { _walk: { in: IN }, fields: { rank: true }, orderBy: [{ rank: 'asc' }] }
        })
      })
    ).toEqual({ c1: ['o2', 'o1'], c2: ['o3'], c3: ['o4'], c4: [] });
    const rows = await same('Cert', {
      where: { _walk: { in: IN } } as WhereClause,
      agg: agg({ hi: { in: IN, max: 'rank' }, avg: { in: IN, avg: 'rank' } }),
      nested: nested({
        obs: { _walk: { in: IN }, fields: { rank: true }, orderBy: [{ rank: 'desc' }], limit: 1 }
      })
    });
    expect(Object.fromEntries(rows.map((r) => [label(r), [r._agg, r.obs]]))).toEqual({
      c1: [{ hi: 3, avg: 2 }, [{ id: u('o1'), rank: 3 }]],
      c2: [{ hi: 7, avg: 7 }, [{ id: u('o3'), rank: 7 }]],
      c3: [{ hi: null, avg: null }, [{ id: u('o4'), rank: null }]]
    });
  }

  it('a far field held in extra (pending), then in its column (promoted), reads the same', async () => {
    const table = async () => loadTypeTable(sql, NS, 'Observation');
    expect((await table())?.column('rank')).toBeUndefined();
    await rankReads();
    expect(
      await pg.promotePendingFields({ lockTimeoutMs: 2000, batchRows: 100, namespace: NS })
    ).toEqual([
      { kind: 'promoted', namespace: NS, type: 'Observation', field: 'rank', attempts: 1 }
    ]);
    expect((await table())?.column('rank')).toBeDefined();
    await rankReads();
  });
});

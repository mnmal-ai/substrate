/**
 * The SQL text the shared walk forms compile to (Todo #1815): a pick shared
 * through an outbound hop is one CTE of picks per distinct hub, joined back
 * on `__hub`; a frame `_agg` over the seeds' own window is one CTE grouped by
 * the crossRef, which the where reads as `id IN` its keys and the page LEFT
 * JOINs. A page of a few seeds keeps the per-seed probes.
 *
 * Pure: nothing connects to a database.
 */

import type { FieldDef, ReadParams, WalkAgg, WhereClause } from '@mnmal-ai/substrate-types';
import postgres from 'postgres';
import { afterAll, describe, expect, it } from 'vitest';
import { buildWalkProjection, prepareWindows } from '../src/pg-sql/aggregate.js';
import { resolveBodyOrderByCast } from '../src/pg-sql/sorting.js';
import { prepareSharedPicks, type WalkScope, walkScope, withCtes } from '../src/pg-sql/walk.js';
import { buildWhere } from '../src/pg-sql/where.js';

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
const ref = (type: string): FieldDef => ({ kind: 'crossRef', ns: NS, type, onDelete: 'set_null' });
const FIELDS: Record<string, Record<string, FieldDef>> = {
  Cert: {
    grade: { kind: 'scalar', type: 'number' },
    ask: { kind: 'scalar', type: 'number' },
    spec: ref('Spec')
  },
  Spec: { tier: { kind: 'scalar', type: 'number' } },
  Sale: {
    spec: ref('Spec'),
    at: { kind: 'scalar', type: 'date' },
    price: { kind: 'scalar', type: 'number' }
  },
  Obs: {
    cert: ref('Cert'),
    at: { kind: 'scalar', type: 'date', indexed: true },
    price: { kind: 'scalar', type: 'number' }
  }
};
const fieldDef = (t: string, f: string) => FIELDS[t]?.[f];
const castFor = (f: string) => resolveBodyOrderByCast(fieldDef('Cert', f));
const BASE = sql`r.namespace = 'ns' AND r.type = 'Cert'`;
const IDS = sql`r.id = ANY('{a,b}')`;
const seedBase = (ids = false) => ({ clauses: ids ? [BASE, IDS] : [BASE], ids });

/** The where (and the CTEs it reads) of a Cert read with `params`, as pg-dataset compiles them. */
function compileWhere(params: ReadParams, s: WalkScope = walkScope(NS, 'Cert', 'r', fieldDef)) {
  prepareSharedPicks(sql, params, seedBase(), castFor, () => undefined, s);
  const where = buildWhere(sql, params.where as WhereClause, castFor, () => undefined, s);
  return render(sql`${withCtes(sql, s)}SELECT 1 FROM rows r WHERE ${BASE} AND ${where}`);
}

const yardstick = {
  AND: [
    { grade: { eq: 9 } },
    {
      _walk: {
        out: 'spec',
        where: {
          _walk: {
            in: 'ns/Sale.spec',
            pick: { latest: 'at' },
            where: {
              AND: [
                { at: { gte: '2026-10-01' } },
                { price: { gte: { $ref: '$.ask', times: 1.25 } } }
              ]
            }
          }
        }
      }
    }
  ]
} as unknown as WhereClause;

describe('a pick shared through an outbound hop: one probe per hub', () => {
  it('a count compiles it once per distinct hub of the seeds, then joins on __hub', () => {
    const text = compileWhere({ where: yardstick, count: true });
    const [ctes, main] = text.split(') SELECT 1 FROM rows r WHERE');
    // The hubs: the distinct `spec` of the seeds passing the plain conjuncts.
    expect(ctes).toMatch(
      /^WITH pick_w1 AS MATERIALIZED \(SELECT h\.id AS __hub, w1\.\* FROM \(SELECT DISTINCT \(r\.body ->> 'spec'\) AS id FROM rows r WHERE \( r\.namespace = 'ns' AND r\.type = 'Cert' AND .*substrate_num\(r\.body -> 'grade'\).*\) h CROSS JOIN LATERAL/
    );
    // The pick, keyed on the hub and nothing of the seed.
    expect(ctes).toContain(`((w1.body ->> 'spec') COLLATE "C") = (h.id::text COLLATE "C")`);
    expect(ctes).toMatch(/\bmax\(substrate_ts\(w1\.body -> 'at'\)\)/);
    expect(ctes).not.toContain("r.body -> 'ask'");
    // Only hubs with a neighbour passing the pick's seed-independent `at` bound are
    // probed, and only picks passing it are kept; never the `$.ask` comparison.
    expect(ctes).toMatch(
      /\) w1 WHERE EXISTS \(SELECT 1 FROM rows w2 WHERE w2\.namespace = 'ns' AND w2\.type = 'Sale' .*= \(h\.id::text COLLATE "C"\) AND .*substrate_ts\(w2\.body -> 'at'\) >= .*\) AND .*substrate_ts\(w1\.body -> 'at'\) >= /
    );
    // Each seed joins its hub's picked row; the pick's where, $.ask included, is tested per seed.
    expect(main).toContain('FROM rows w3, pick_w1 w4 WHERE');
    expect(main).toContain('w4.__hub = w3.id::text');
    expect(main).toContain("substrate_num(w4.body -> 'price')");
    expect(main).toContain("substrate_num(r.body -> 'ask')");
    expect(main).not.toMatch(/\bmax\(/);
  });

  const pickAt = (pick: Record<string, unknown>) => ({
    in: 'ns/Sale.spec',
    pick,
    where: { at: { gte: '2026-10-01' } }
  });
  const hubWith = (where: unknown, extra: Record<string, unknown> = {}) =>
    ({ _walk: { out: 'spec', where, ...extra } }) as unknown as WhereClause;

  it('narrows the hubs by every other top-level conjunct, walks and _agg included, not by binds', () => {
    const recent = { _walk: { in: 'ns/Obs.cert', where: { at: { gte: '2026-10-30T00:00:00Z' } } } };
    const bind = { _walk: { in: 'ns/Obs.cert', as: 'o', where: { price: { gt: 1 } } } };
    const text = compileWhere({
      count: true,
      where: {
        AND: [
          recent,
          { _agg: { in: 'ns/Obs.cert', count: true }, gte: 2 },
          bind,
          { ask: { lte: { $ref: 'o.price' } } },
          hubWith({ _walk: pickAt({ latest: 'at' }) })
        ]
      } as unknown as WhereClause
    });
    const hubs = text.slice(
      text.indexOf('SELECT DISTINCT'),
      text.indexOf(') h CROSS JOIN LATERAL')
    );
    // The selective window walk and the _agg comparison narrow the hubs.
    expect(hubs).toMatch(
      /EXISTS \(SELECT 1 FROM rows w\d+ WHERE w\d+\.namespace = 'ns' AND w\d+\.type = 'Obs'.*>= /
    );
    expect(hubs).toMatch(/count\(\*\)/);
    // The bind and what reads it are quantified jointly, so they stay out; so does the hub walk.
    expect(hubs).not.toContain('price');
    expect(hubs).not.toContain('pick_');
    expect(hubs).not.toContain("'Spec'");
  });

  it("leaves a second shared hub walk out of each CTE's hub filter", () => {
    const other = {
      _walk: { out: 'spec', where: { _walk: { in: 'ns/Sale.spec', pick: { max: 'price' } } } }
    };
    const text = compileWhere({
      count: true,
      where: {
        AND: [hubWith({ _walk: pickAt({ latest: 'at' }) }), other]
      } as unknown as WhereClause
    });
    const ctes = text.slice(0, text.indexOf(') SELECT 1 FROM rows r WHERE'));
    expect(ctes.match(/pick_w\d+ AS MATERIALIZED/g)).toHaveLength(2);
    // Each hub set is the seeds' plain filter alone: no pick of the other hub walk, per seed.
    const hubSets = ctes
      .split('SELECT DISTINCT')
      .slice(1)
      .map((h) => h.slice(0, h.indexOf(') h CROSS JOIN LATERAL')));
    expect(hubSets).toHaveLength(2);
    for (const hubs of hubSets) {
      expect(hubs).not.toContain("'Sale'");
      expect(hubs).not.toContain("'Spec'");
    }
  });

  it('a hub walk reading a top-level bind is not shared', () => {
    const bind = { _walk: { in: 'ns/Obs.cert', as: 'o' } };
    const hub = hubWith({
      AND: [{ tier: { lte: { $ref: 'o.price' } } }, { _walk: pickAt({ latest: 'at' }) }]
    });
    const text = compileWhere({
      count: true,
      where: { AND: [bind, hub] } as unknown as WhereClause
    });
    expect(text).not.toContain('WITH');
  });

  it("keeps the hub where's other conjuncts and binds, and joins two picks of one hub", () => {
    const text = compileWhere({
      count: true,
      where: hubWith({
        AND: [
          { _walk: { in: 'ns/Sale.spec', as: 's', where: { price: { gte: 5 } } } },
          { tier: { lte: { $ref: 's.price' } } },
          { tier: { gte: 1 } },
          { _walk: pickAt({ latest: 'at' }) },
          { _walk: { in: 'ns/Sale.spec', pick: { max: 'price' } } }
        ]
      })
    });
    const main = text.slice(text.indexOf(') SELECT 1 FROM rows r WHERE'));
    expect(text.match(/pick_w\d+ AS MATERIALIZED/g)).toHaveLength(2);
    // One EXISTS: the hub row and both picked rows, each on __hub.
    expect(main).toMatch(
      /EXISTS \(SELECT 1 FROM rows (w\d+), pick_w\d+ (w\d+), pick_w\d+ (w\d+) WHERE .*\2\.__hub = \1\.id::text AND .*\3\.__hub = \1\.id::text/
    );
    // The rest of the hub's where: its plain conjunct and the bind's jointly quantified EXISTS.
    expect(main).toMatch(/substrate_num\(w\d+\.body -> 'tier'\)/);
    expect(main).toMatch(
      /EXISTS \(SELECT 1 FROM rows w\d+ WHERE .*'Sale'.*substrate_num\(w\d+\.body -> 'price'\)/
    );
    // The unfiltered pick has no candidate filter.
    expect(text).toMatch(
      /pick_w\d+ AS MATERIALIZED \(SELECT h\.id AS __hub, (w\d+)\.\* FROM .* LIMIT 1\) \1\)/
    );
  });

  it('a none or all hub walk, or one under OR, keeps the per-seed probe', () => {
    const pick = { _walk: pickAt({ latest: 'at' }) };
    for (const where of [
      hubWith(pick, { quantifier: 'none' }),
      hubWith(pick, { quantifier: 'all' }),
      { OR: [hubWith(pick), { grade: { eq: 1 } }] } as unknown as WhereClause
    ]) {
      expect(compileWhere({ count: true, where })).not.toContain('WITH');
    }
  });

  it('a page of a few seeds keeps the per-seed probe', () => {
    const text = compileWhere({ where: yardstick, limit: 20 });
    expect(text).not.toContain('WITH');
    expect(text).toMatch(/EXISTS \(SELECT 1 FROM \(\(SELECT w2\.\* FROM rows w2 .*max\(/);
  });
});

describe('a frame _agg over its seeds window: one group-by pass', () => {
  const OBS = 'ns/Obs.cert';
  const w = { at: { gte: '2026-10-29T00:00:00Z' } };
  const params = (limit?: number): ReadParams =>
    ({
      where: { _walk: { in: OBS, where: w } },
      agg: {
        n: { in: OBS, where: w, count: true },
        avg: { in: OBS, where: w, avg: 'price' },
        last: { in: OBS, where: w, max: 'at' }
      } as Record<string, WalkAgg>,
      ...(limit === undefined ? {} : { limit })
    }) as ReadParams;
  function page(p: ReadParams, ids = false): string {
    const s = walkScope(NS, 'Cert', 'r', fieldDef);
    const joins = prepareWindows(
      sql,
      p,
      seedBase(ids),
      castFor,
      () => undefined,
      s,
      (t: string, f: string) => t === 'Obs' && f === 'at'
    );
    const where = buildWhere(sql, p.where as WhereClause, castFor, () => undefined, s);
    const proj = buildWalkProjection(sql, p.agg, {}, () => undefined, s);
    return render(
      sql`${withCtes(sql, s)}SELECT ${proj} AS w FROM rows r${joins} WHERE ${BASE} AND ${where}`
    );
  }

  it('aggregates the window once, GROUP BY the crossRef, null keys left out', () => {
    const text = page(params());
    expect(text).toMatch(
      /^WITH win_w1 AS MATERIALIZED \(SELECT \(\(w1\.body ->> 'cert'\) COLLATE "C"\) AS __k, .*count\(\*\).*avg\(.* AS __g FROM rows w1 WHERE \( w1\.namespace = 'ns' AND w1\.type = 'Obs' AND w1\.deleted_at IS NULL AND \(\(w1\.body ->> 'cert'\) COLLATE "C"\) IS NOT NULL AND .*substrate_ts\(w1\.body -> 'at'\) >= .* GROUP BY 1\)/s
    );
    // The seeds are the window's keys, and each reads its group, or the aggregates of none.
    expect(text).toContain(`((r.id::text COLLATE "C") IN (SELECT __k FROM win_w1))`);
    expect(text).toContain(`LEFT JOIN win_w1 ON win_w1.__k = (r.id::text COLLATE "C")`);
    expect(text).toMatch(/COALESCE\(win_w1\.__g, \(SELECT .*count\(\*\).* WHERE FALSE\)\)/s);
    // One read of Obs for the window; the date max stays a per-seed top-1.
    const correlated = text.match(/= \(r\.id::text COLLATE "C"\) AND/g) ?? [];
    expect(correlated).toHaveLength(1);
    expect(text).toMatch(/ORDER BY substrate_ts\(w\d+\.body -> 'at'\) DESC NULLS LAST/);
  });

  it('semi-joins the window keys to the seeds when ids or another conjunct narrows them', () => {
    const own = page(params());
    expect(own).not.toContain('IN (SELECT r.id::text');
    const ids = page(params(), true);
    expect(ids).toMatch(/WITH win_w1 AS MATERIALIZED \(.* GROUP BY 1\)/s);
    const cte = ids.slice(0, ids.indexOf('GROUP BY 1'));
    expect(cte).toContain(
      `((w1.body ->> 'cert') COLLATE "C") IN (SELECT r.id::text COLLATE "C" FROM rows r WHERE ( r.namespace = 'ns' AND r.type = 'Cert' AND r.id = ANY('{a,b}')))`
    );
    const graded = page({
      ...params(),
      where: { AND: [{ grade: { eq: 9 } }, params().where] } as unknown as WhereClause
    });
    const gcte = graded.slice(0, graded.indexOf('GROUP BY 1'));
    expect(gcte).toMatch(
      /IN \(SELECT r\.id::text COLLATE "C" FROM rows r WHERE .*substrate_num\(r\.body -> 'grade'\)/s
    );
    // The window's own walk is implied by the key, so it is not repeated there.
    expect(gcte.match(/'Obs'/g)).toHaveLength(1);
  });

  it("leaves a shared pick's hub walk out of the window's seed semi-join", () => {
    const s = walkScope(NS, 'Cert', 'r', fieldDef);
    const pickHub = {
      _walk: {
        out: 'spec',
        where: {
          _walk: {
            in: 'ns/Sale.spec',
            pick: { latest: 'at' },
            where: { at: { gte: '2026-10-01' } }
          }
        }
      }
    };
    const p = {
      ...params(),
      where: { AND: [{ grade: { eq: 9 } }, pickHub, params().where] }
    } as unknown as ReadParams;
    const base = seedBase();
    prepareWindows(
      sql,
      p,
      base,
      castFor,
      () => undefined,
      s,
      (t: string, f: string) => t === 'Obs' && f === 'at'
    );
    prepareSharedPicks(sql, p, base, castFor, () => undefined, s);
    const text = render(withCtes(sql, s));
    const win = text.slice(text.indexOf('win_w'), text.indexOf('GROUP BY 1'));
    // Narrowed by the plain conjunct, but no per-seed pick inside the window's CTE.
    expect(win).toMatch(/IN \(SELECT r\.id::text COLLATE "C" FROM rows r WHERE .*'grade'/s);
    expect(win).not.toContain("'Sale'");
    expect(win).not.toContain("'Spec'");
    expect(text).toMatch(/pick_w\d+ AS MATERIALIZED/);
  });

  it('a page of a few seeds keeps the per-seed aggregates', () => {
    const text = page(params(20));
    expect(text).not.toContain('WITH');
    expect(text).not.toContain('GROUP BY');
    expect(text).toContain('EXISTS (SELECT 1 FROM rows w');
  });
});

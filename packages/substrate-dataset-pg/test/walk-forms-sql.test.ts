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
  Spec: {},
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

/** The where (and the CTEs it reads) of a Cert read with `params`, as pg-dataset compiles them. */
function compileWhere(params: ReadParams, s: WalkScope = walkScope(NS, 'Cert', 'r', fieldDef)) {
  prepareSharedPicks(sql, params, [BASE], castFor, () => undefined, s);
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
    // Each seed joins its hub's picked row; the pick's where, $.ask included, is tested per seed.
    expect(main).toContain('FROM rows w2, pick_w1 w3 WHERE');
    expect(main).toContain('w3.__hub = w2.id::text');
    expect(main).toContain("substrate_num(w3.body -> 'price')");
    expect(main).toContain("substrate_num(r.body -> 'ask')");
    expect(main).not.toMatch(/\bmax\(/);
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
  function page(p: ReadParams): string {
    const s = walkScope(NS, 'Cert', 'r', fieldDef);
    const joins = prepareWindows(
      sql,
      p,
      () => undefined,
      s,
      (t, f) => t === 'Obs' && f === 'at'
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

  it('a page of a few seeds keeps the per-seed aggregates', () => {
    const text = page(params(20));
    expect(text).not.toContain('WITH');
    expect(text).not.toContain('GROUP BY');
    expect(text).toContain('EXISTS (SELECT 1 FROM rows w');
  });
});

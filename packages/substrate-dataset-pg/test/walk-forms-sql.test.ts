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

/** Paren depth before each index of `text`, skipping quoted literals. */
function depths(text: string): number[] {
  const out: number[] = [];
  let d = 0;
  let quoted = false;
  for (const ch of text) {
    out.push(d);
    if (ch === "'") quoted = !quoted;
    else if (!quoted && ch === '(') d++;
    else if (!quoted && ch === ')') d--;
  }
  return out;
}

/** The statement after `WITH …`, and each CTE's name and body, by structure alone. */
function split(text: string): { main: string; ctes: Array<{ name: string; body: string }> } {
  const d = depths(text);
  const ctes: Array<{ name: string; body: string }> = [];
  const head = /(\w+) AS MATERIALIZED \(/g;
  let end = 0;
  for (let m = head.exec(text); m !== null; m = head.exec(text)) {
    if (d[m.index] !== 0) continue;
    const open = m.index + m[0].length - 1;
    let close = open + 1;
    while (close < text.length && !(text[close] === ')' && d[close] === 1)) close++;
    ctes.push({ name: m[1] as string, body: text.slice(open + 1, close) });
    end = close + 1;
  }
  return { main: text.slice(end), ctes };
}

/** Balanced `( … )` substrings holding a comparison or an AND at their own top level. */
function predicates(text: string): string[] {
  const out: string[] = [];
  const stack: number[] = [];
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "'") quoted = !quoted;
    if (quoted) continue;
    if (ch === '(') stack.push(i);
    else if (ch === ')') {
      const inner = text.slice((stack.pop() as number) + 1, i);
      let flat = inner;
      for (let prev = ''; prev !== flat; ) {
        prev = flat;
        flat = flat.replace(/\([^()]*\)/g, '_');
      }
      if (/ AND | >= | <= | = | > | < /.test(flat)) out.push(inner);
    }
  }
  return out;
}

/**
 * The per-hub form's structure (#1815 measure): each CTE the main statement
 * reads is a relation of its FROM/JOIN at depth 0, never inside a (correlated)
 * subquery pg may nest-loop over, and no predicate reading a CTE's row in
 * the main statement is also in that CTE: each conjunct is evaluated once.
 * Keyed on structure, with aliases normalised; never on a type or field.
 */
function expectJoinedOnce(text: string): void {
  const { main, ctes } = split(text);
  expect(ctes.length).toBeGreaterThan(0);
  const d = depths(main);
  for (const { name, body } of ctes) {
    const rel = new RegExp(`(FROM|JOIN|,)\\s+${name}\\b(?!\\.)`, 'g');
    let seen = 0;
    for (let m = rel.exec(main); m !== null; m = rel.exec(main)) {
      seen++;
      expect(d[m.index], `${name} read inside a subquery`).toBe(0);
      expect(m[1], `${name} read but not joined`).toBe('JOIN');
    }
    expect(seen, `${name} joined once`).toBe(1);
    const norm = (t: string) => t.replace(new RegExp(`\\b(${name}|w\\d+)\\b`, 'g'), 'X');
    const inCte = norm(body);
    for (const p of predicates(main).filter((x) => x.includes(`${name}.`))) {
      expect(inCte.includes(norm(p)), `evaluated twice: ${p}`).toBe(false);
    }
  }
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
  const joins = prepareSharedPicks(sql, params, seedBase(), castFor, () => undefined, s);
  const where = buildWhere(sql, params.where as WhereClause, castFor, () => undefined, s);
  return render(sql`${withCtes(sql, s)}SELECT 1 FROM rows r${joins} WHERE ${BASE} AND ${where}`);
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
  it('the structure check rejects a CTE read in a subquery, or a conjunct read twice', () => {
    const cte =
      'WITH c_1 AS MATERIALIZED (SELECT h.id AS __hub, w1.* FROM rows w1 WHERE (f(w1.body) >= $)) ';
    // The pre-measure shape: the CTE inside a correlated EXISTS, its conjunct repeated.
    const nested = `${cte}SELECT 1 FROM rows r WHERE EXISTS (SELECT 1 FROM rows w2, c_1 w3 WHERE w3.__hub = w2.id AND (f(w3.body) >= $))`;
    expect(() => expectJoinedOnce(nested)).toThrow();
    const twice = `${cte}SELECT 1 FROM rows r LEFT JOIN c_1 ON c_1.__hub = r.x WHERE (f(c_1.body) >= $)`;
    expect(() => expectJoinedOnce(twice)).toThrow(/evaluated twice/);
    expectJoinedOnce(
      `${cte}SELECT 1 FROM rows r LEFT JOIN c_1 ON c_1.__hub = r.x WHERE (g(c_1.body) >= r.y)`
    );
  });

  it('a count compiles it once per distinct hub of the seeds, then LEFT JOINs it on __hub', () => {
    const text = compileWhere({ where: yardstick, count: true });
    expectJoinedOnce(text);
    const [ctes, main] = text.split(') SELECT 1 FROM rows r');
    // The hubs: the distinct `spec` of the seeds passing the plain conjuncts, whose hub row is live.
    expect(ctes).toMatch(
      /^WITH pick_w1 AS MATERIALIZED \(SELECT h\.id AS __hub, w1\.\* FROM \(SELECT DISTINCT \(r\.body ->> 'spec'\) AS id FROM rows r WHERE \( r\.namespace = 'ns' AND r\.type = 'Cert' AND .*substrate_num\(r\.body -> 'grade'\).*\) h JOIN rows (w\d+) ON \1\.namespace = 'ns' AND \1\.type = 'Spec' AND \1\.deleted_at IS NULL AND \1\.id::text = h\.id CROSS JOIN LATERAL/
    );
    // The pick, keyed on the hub and nothing of the seed.
    expect(ctes).toContain(`((w1.body ->> 'spec') COLLATE "C") = (h.id::text COLLATE "C")`);
    expect(ctes).toMatch(/\bmax\(substrate_ts\(w1\.body -> 'at'\)\)/);
    expect(ctes).not.toContain("r.body -> 'ask'");
    // Only hubs with a neighbour passing the pick's seed-independent `at` bound are
    // probed, and only picks passing it are kept; never the `$.ask` comparison.
    expect(ctes).toMatch(
      /\) w1 WHERE \( EXISTS \(SELECT 1 FROM rows w2 WHERE w2\.namespace = 'ns' AND w2\.type = 'Sale' .*= \(h\.id::text COLLATE "C"\) AND .*substrate_ts\(w2\.body -> 'at'\) >= .*\) AND .*substrate_ts\(w1\.body -> 'at'\) >= /
    );
    // Each seed joins its hub's row of the CTE; only the pick's $-reading conjunct is left.
    expect(main).toMatch(/^ LEFT JOIN pick_w1 ON pick_w1\.__hub = \(r\.body ->> 'spec'\) WHERE /);
    expect(main).toContain('pick_w1.__hub IS NOT NULL');
    expect(main).toContain("substrate_num(pick_w1.body -> 'price')");
    expect(main).toContain("substrate_num(r.body -> 'ask')");
    expect(main).not.toContain("'at'");
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
    expectJoinedOnce(text);
    const hubs = text.slice(text.indexOf('SELECT DISTINCT'), text.indexOf(') h JOIN rows'));
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
    expectJoinedOnce(text);
    const ctes = text.slice(0, text.indexOf(') SELECT 1 FROM rows r'));
    expect(ctes.match(/pick_w\d+ AS MATERIALIZED/g)).toHaveLength(2);
    // Each hub set is the seeds' plain filter alone: no pick of the other hub walk, per seed.
    const hubSets = ctes
      .split('SELECT DISTINCT')
      .slice(1)
      .map((h) => h.slice(0, h.indexOf(') h JOIN rows')));
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
    expectJoinedOnce(text);
    const main = text.slice(text.indexOf(') SELECT 1 FROM rows r'));
    expect(text.match(/pick_w\d+ AS MATERIALIZED/g)).toHaveLength(2);
    // Both picks' CTEs joined on the seed's hub; each must be present.
    expect(main).toMatch(
      /LEFT JOIN (pick_w\d+) ON \1\.__hub = \(r\.body ->> 'spec'\) LEFT JOIN (pick_w\d+) ON \2\.__hub = \(r\.body ->> 'spec'\) WHERE .*\1\.__hub IS NOT NULL.*\2\.__hub IS NOT NULL/
    );
    // The rest of the hub's where, on the hub row: its plain conjunct and the bind's EXISTS.
    expect(main).toMatch(
      /EXISTS \(SELECT 1 FROM rows (w\d+) WHERE \1\.namespace = 'ns' AND \1\.type = 'Spec' .*substrate_num\(\1\.body -> 'tier'\)/
    );
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

/**
 * The SQL text a walk `_agg` pick compiles to (Todo #1819): a latest or a
 * date min/max is `ORDER BY key, id LIMIT 1` in the (crossRef, key) index's
 * own direction, one probe per hub, never a max(key) subquery, which pg reads
 * as a full Aggregate over the hub wherever its min/max rewrite does not fire.
 * Projected, in `_agg` where predicates and inside `derive` alike.
 *
 * Pure: nothing connects to a database.
 */

import type { FieldDef, WalkAgg, WalkAggPredicate } from '@mnmal-ai/substrate-types';
import postgres from 'postgres';
import { afterAll, describe, expect, it } from 'vitest';
import { buildAggPredicate, buildWalkAgg, buildWalkProjection } from '../src/pg-sql/aggregate.js';
import { buildDerive, type WalkScope, walkScope } from '../src/pg-sql/walk.js';

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
const FIELDS: Record<string, Record<string, FieldDef>> = {
  Hub: { ask: { kind: 'scalar', type: 'number' } },
  Nbr: {
    hub: { kind: 'crossRef', ns: NS, type: 'Hub', onDelete: 'set_null' },
    at: { kind: 'scalar', type: 'date' },
    price: { kind: 'scalar', type: 'number' }
  }
};
const IN = `${NS}/Nbr.hub`;

/** A seed scope over Hub whose (hub, `key`) index runs in `dirs[key]`. */
function scope(dirs: Record<string, 'asc' | 'desc'>): WalkScope {
  const s = walkScope(NS, 'Hub', 'r', (t, f) => FIELDS[t]?.[f]);
  s.indexDir = (t, crossRef, key) =>
    t === 'Nbr' && crossRef === 'hub' && Object.hasOwn(dirs, key) ? dirs[key] : undefined;
  return s;
}
const project = (aggs: Record<string, WalkAgg>, s: WalkScope) =>
  render(buildWalkProjection(sql, aggs, {}, () => undefined, s));

const latestAt: WalkAgg = { in: IN, latest: { by: 'at', value: 'price' } } as WalkAgg;
const AT = `substrate_ts(w1.body -> 'at')`;
const BY_ID = `w1.id COLLATE "C" ASC LIMIT 1`;

describe('walk _agg picks compile to an index-order top-1', () => {
  it('on an index in the pick direction: one ORDER BY … NULLS LAST, id LIMIT 1, no max()', () => {
    const text = project({ lp: latestAt }, scope({ at: 'desc' }));
    expect(text).toContain(`ORDER BY ${AT} DESC NULLS LAST, ${BY_ID}`);
    expect(text).not.toMatch(/\bmax\(/);
    // Nulls last is the order itself, so no null branch.
    expect(text).not.toContain('UNION ALL');
  });

  it('on an index the other way: non-null keys nulls first (its backward scan), then the null tail', () => {
    const text = project({ lp: latestAt }, scope({ at: 'asc' }));
    expect(text).toContain(`${AT} IS NOT NULL) ORDER BY ${AT} DESC NULLS FIRST, ${BY_ID}`);
    expect(text).toContain(`${AT} IS NULL ORDER BY ${BY_ID}) LIMIT 1`);
    expect(text).not.toMatch(/\bmax\(/);
  });

  it('a date min/max is the same top-1, its null filter standing in for the null tail', () => {
    const min = { in: IN, min: 'at' } as WalkAgg;
    const max = { in: IN, max: 'at' } as WalkAgg;
    const same = project({ first: min }, scope({ at: 'asc' }));
    expect(same).toContain(`ORDER BY ${AT} ASC NULLS LAST, ${BY_ID}`);
    const other = project({ last: max }, scope({ at: 'asc' }));
    expect(other).toContain(`ORDER BY ${AT} DESC NULLS FIRST, ${BY_ID}`);
    for (const text of [same, other]) {
      expect(text).not.toMatch(/\b(min|max)\(/);
      expect(text).not.toContain('UNION ALL');
    }
  });

  it('with no (crossRef, key) index: the nulls-last top-1', () => {
    const text = project({ lp: latestAt }, scope({}));
    expect(text).toContain(`ORDER BY ${AT} DESC NULLS LAST, ${BY_ID}`);
    expect(text).not.toMatch(/\bmax\(/);
  });

  it('the far where stays inside the probe', () => {
    const filtered = { ...latestAt, where: { price: { lt: 90 } } } as WalkAgg;
    const text = project({ lp: filtered }, scope({ at: 'asc' }));
    const price = `substrate_num(w1.body -> 'price') < `;
    // In the keyed branch and in the null tail alike.
    expect(text.split(price)).toHaveLength(3);
  });

  it('inside derive and an _agg predicate', () => {
    const s = scope({ at: 'desc' });
    // As the pg dataset wires it.
    s.aggValue = (name) => {
      if (name !== 'lp') throw new Error(name);
      return buildWalkAgg(sql, latestAt, () => undefined, s).value;
    };
    const derive = render(buildDerive(sql, 'm', { diff: ['_agg.lp', '$.ask'] }, s));
    const pred = render(
      buildAggPredicate(
        sql,
        { _agg: latestAt, gte: 50 } as WalkAggPredicate,
        () => undefined,
        scope({ at: 'desc' })
      )
    );
    for (const text of [derive, pred]) {
      expect(text).toMatch(/ORDER BY substrate_ts\(w\d+\.body -> 'at'\) DESC NULLS LAST/);
      expect(text).not.toMatch(/\bmax\(/);
    }
  });
});

/**
 * The SQL text the filter compiler emits for body fields. Expression indexes
 * only serve a filter whose expression matches theirs, so field names are
 * inlined literals (never bind parameters), numbers and dates go through the
 * safe casts, and text compares under one collation.
 *
 * Pure: nothing connects to a database.
 */

import type { WhereClause } from '@mnmal-ai/substrate-types';
import postgres from 'postgres';
import { afterAll, describe, expect, it } from 'vitest';
import {
  type BodyOrderByCast,
  bodyNum,
  bodyText,
  bodyTs,
  type Fragment,
  fieldLit,
  indexExpressionSql
} from '../src/pg-sql/primitives.js';
import { buildWhere } from '../src/pg-sql.js';

const sql = postgres('postgres://nobody@127.0.0.1:1/none');
afterAll(() => sql.end());

interface QueryParts {
  strings: readonly string[];
  args: readonly unknown[];
}

/** Fragment → SQL text, with every bound value shown as `$`. */
function render(q: QueryParts): string {
  let out = q.strings[0] ?? '';
  for (let i = 1; i < q.strings.length; i++) out += renderValue(q.args[i - 1]) + q.strings[i];
  return out;
}

function renderValue(v: unknown): string {
  if (isQuery(v)) return render(v);
  if (Array.isArray(v) && v.length > 0 && isQuery(v[0])) {
    return v.map((x) => ` ${render(x as QueryParts)}`).join('');
  }
  return '$';
}

function isQuery(v: unknown): v is QueryParts {
  return typeof v === 'object' && v !== null && 'strings' in v && 'args' in v;
}

const casts: Record<string, BodyOrderByCast> = { price: 'numeric', at: 'timestamptz' };
const compile = (where: WhereClause): string =>
  render(
    buildWhere(
      sql,
      where,
      (f) => casts[f] ?? null,
      () => undefined
    ) as unknown as QueryParts
  );

describe('compiled body-field expressions', () => {
  it('numbers go through substrate_num with an inlined name', () => {
    const text = compile({ price: { gt: 5 } });
    expect(text).toContain(`substrate_num(body -> 'price')`);
    expect(text).not.toMatch(/->>? \$/);
  });

  it('declared dates go through substrate_ts', () => {
    const text = compile({ at: { gte: '2026-10-24T00:00:00Z' } });
    expect(text).toContain(`substrate_ts(body -> 'at')`);
    expect(text).not.toMatch(/->>? \$/);
  });

  it('text eq and ranges share one collated expression', () => {
    for (const where of [{ title: { eq: 'x' } }, { title: { between: ['a', 'b'] } }]) {
      const text = compile(where as WhereClause);
      expect(text).toContain(`((body ->> 'title') COLLATE "C")`);
      expect(text).not.toMatch(/->>? \$/);
    }
  });

  it('pattern operators stay on the uncollated text', () => {
    const text = compile({ title: { contains: 'x' } });
    expect(text).toContain(`(body ->> 'title') ILIKE`);
    expect(text).not.toContain('COLLATE');
  });

  it('struct paths inline every segment', () => {
    const text = compile({ meta: { region: { eq: 'x' } } } as WhereClause);
    expect(text).toContain(`((body -> 'meta' ->> 'region') COLLATE "C")`);
  });

  it('json path segments are inlined', () => {
    const text = compile({ values: { path: ['a', 'b'], gt: 1 } } as WhereClause);
    expect(text).toContain(`(body -> 'values' -> 'a' -> 'b')`);
    expect(text).not.toMatch(/-> \$/);
  });

  it('escapes a quote in a field name', () => {
    expect(compile({ "o'neil": { eq: 'x' } })).toContain(`'o''neil'`);
  });

  it('refuses a field name containing NUL', () => {
    expect(() => compile({ 'a\0b': { eq: 'x' } })).toThrow(/cannot be honoured/);
  });

  it('indexExpressionSql is the text the compiler emits', () => {
    const r = (f: Fragment): string => render(f as unknown as QueryParts);
    expect(indexExpressionSql('text', 'f')).toBe(`((body ->> 'f') COLLATE "C")`);
    expect(indexExpressionSql('number', 'f')).toBe(`substrate_num(body -> 'f')`);
    expect(indexExpressionSql('date', 'f')).toBe(`substrate_ts(body -> 'f')`);
    expect(r(bodyText(sql, ['f']))).toBe(indexExpressionSql('text', 'f'));
    expect(r(bodyNum(sql, ['f']))).toBe(indexExpressionSql('number', 'f'));
    expect(r(bodyTs(sql, ['f']))).toBe(indexExpressionSql('date', 'f'));
    expect(r(fieldLit(sql, "o'neil"))).toBe(`'o''neil'`);
    // A backslash takes the E'' form, which reads the same whatever
    // standard_conforming_strings says.
    expect(r(fieldLit(sql, "a\\'b"))).toBe(`E'a\\\\''b'`);
    expect(indexExpressionSql('text', 'a\\b')).toBe(`((body ->> E'a\\\\b') COLLATE "C")`);
  });
});

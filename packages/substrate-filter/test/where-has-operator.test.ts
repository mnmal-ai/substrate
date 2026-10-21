/**
 * `has` — list-element membership operator. `where: { tags: { has:
 * 'x' } }` matches rows whose list field contains the element. Element type
 * follows the list's declared `of`. Empty/null lists never match.
 */

import type { Row, WhereClause } from '@mnmal-ai/substrate-types';
import { describe, expect, it } from 'vitest';
import { evaluateWhere } from '../src/index.js';

describe('evaluateWhere — has (list element membership)', () => {
  const rows: Row[] = [
    { id: '1', tags: ['urgent', 'review'] },
    { id: '2', tags: ['done'] },
    { id: '3', tags: ['urgent', 'blocked'] },
    { id: '4', tags: [] },
    { id: '5', tags: null }
  ];
  const match = (w: WhereClause): string[] =>
    rows.filter((r) => evaluateWhere(r, w)).map((r) => String(r.id));

  it('matches rows whose list contains the element', () => {
    expect(match({ tags: { has: 'urgent' } })).toEqual(['1', '3']);
    expect(match({ tags: { has: 'done' } })).toEqual(['2']);
  });

  it('returns no rows when nothing contains the element', () => {
    expect(match({ tags: { has: 'nope' } })).toEqual([]);
  });

  it('an empty list or null list never matches has', () => {
    const got = match({ tags: { has: 'urgent' } });
    expect(got).not.toContain('4');
    expect(got).not.toContain('5');
  });

  it('matches by element type (numbers, not stringified)', () => {
    const nrows: Row[] = [
      { id: 'a', nums: [1, 2, 10] },
      { id: 'b', nums: [3] }
    ];
    const m = (w: WhereClause): string[] =>
      nrows.filter((r) => evaluateWhere(r, w)).map((r) => String(r.id));
    expect(m({ nums: { has: 10 } })).toEqual(['a']);
    expect(m({ nums: { has: 3 } })).toEqual(['b']);
    expect(m({ nums: { has: 99 } })).toEqual([]);
  });
});

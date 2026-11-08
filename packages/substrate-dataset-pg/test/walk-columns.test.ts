/**
 * `mergeWalkColumns` rebuilds the `extra || walk` object SQL used to build: lists cut to
 * their limit, `_truncated` for the cut ones, the walk winning, keys in jsonb's order.
 */

import { describe, expect, it } from 'vitest';
import { jsonbKeyOrder, mergeWalkColumns } from '../src/pg-sql/aggregate.js';

describe('jsonbKeyOrder', () => {
  it('orders shorter keys first, then bytewise', () => {
    expect(['latest', '_agg', 'b', 'aa', '_truncated', 'Z'].sort(jsonbKeyOrder)).toEqual([
      'Z',
      'b',
      'aa',
      '_agg',
      'latest',
      '_truncated'
    ]);
  });
  it('measures non-ASCII keys in UTF-8 bytes', () => {
    // 'é' is two bytes, so it sorts after a one-byte key of the same JS length.
    expect(['é', 'ab', 'z'].sort(jsonbKeyOrder)).toEqual(['z', 'ab', 'é']);
  });
});

describe('mergeWalkColumns', () => {
  const columns = [
    { name: '_agg', column: '__walk_agg' },
    { name: 'latest', column: '__walk_0', limit: 1 },
    { name: 'all', column: '__walk_1' },
    { name: 'few', column: '__walk_2', limit: 2 }
  ];
  it('cuts lists over their limit, names them in _truncated and orders keys as jsonb', () => {
    const record = {
      extra: { title: 'x', all: 'body value' },
      __walk_agg: { n: 3 },
      __walk_0: [{ id: 'a' }, { id: 'b' }],
      __walk_1: [{ id: 'c' }],
      __walk_2: [{ id: 'd' }, { id: 'e' }]
    };
    const out = mergeWalkColumns(record, columns);
    expect(out.extra).toEqual({
      all: [{ id: 'c' }],
      few: [{ id: 'd' }, { id: 'e' }],
      _agg: { n: 3 },
      title: 'x',
      latest: [{ id: 'a' }],
      _truncated: { latest: true }
    });
    expect(Object.keys(out.extra)).toEqual(['all', 'few', '_agg', 'title', 'latest', '_truncated']);
  });
  it('adds no _truncated when nothing was cut, and reads a null extra as empty', () => {
    const out = mergeWalkColumns(
      { extra: null, __walk_agg: null, __walk_0: [], __walk_1: [], __walk_2: [{ id: 'd' }] },
      columns
    );
    expect(out.extra).toEqual({ all: [], few: [{ id: 'd' }], _agg: null, latest: [] });
  });
});

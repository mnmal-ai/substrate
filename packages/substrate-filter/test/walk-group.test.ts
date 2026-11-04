import type { Row } from '@mnmal-ai/substrate-types';
import { describe, expect, it } from 'vitest';
import { groupConjuncts, refNames } from '../src/index.js';
import { pickOne } from '../src/walk.js';

describe('groupConjuncts', () => {
  it('keeps an _agg comparison whole beside an as binding', () => {
    const agg = { _agg: { in: 'n/O.cert', count: true }, gte: { $ref: 'O.price' } };
    const { binds, items } = groupConjuncts({ AND: [{ _walk: { as: 'O', in: 'n/O.cert' } }, agg] });
    expect(binds).toHaveLength(1);
    expect(items).toEqual([agg]);
    expect([...refNames(items[0])]).toEqual(['O']);
  });
});

describe('pickOne', () => {
  it('orders by a metadata date field', () => {
    const row = (id: string, createdAt: string) =>
      ({
        id,
        _metadata: { createdAt, updatedAt: createdAt, createdBy: null, updatedBy: null }
      }) as Row;
    const rows = [row('a', '2026-10-01T00:00:00Z'), row('b', '2026-10-03T00:00:00Z')];
    expect(pickOne(rows, { min: 'createdAt' }, () => undefined)?.id).toBe('a');
    expect(pickOne(rows, { latest: 'createdAt' }, () => undefined)?.id).toBe('b');
  });
});

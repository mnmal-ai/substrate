import { describe, expect, it } from 'vitest';
import { formatValue, parseTui } from '../src/ask/present.js';

describe('parseTui', () => {
  it('normalises a declared type: formats, currency and row entries', () => {
    const p = parseTui({
      currency: 'EUR',
      formats: { 'Item.price': 'money', 'Other.n': 'int' },
      rows: {
        Item: {
          title: 'name',
          tags: [{ field: 'grade', template: 'G{}' }],
          value: 'price',
          details: ['cost', { field: 'ask', label: 'ask' }]
        }
      }
    });
    expect(p.problems).toEqual([]);
    expect(p.types.Item).toEqual({
      currency: 'EUR',
      formats: { price: 'money' },
      row: {
        title: { field: 'name' },
        tags: [{ field: 'grade', template: 'G{}' }],
        value: { field: 'price' },
        details: [{ field: 'cost' }, { field: 'ask', label: 'ask' }]
      }
    });
    expect(p.types.Other).toEqual({ currency: 'EUR', formats: { n: 'int' } });
  });
  it('defaults the currency to USD and accepts no block at all', () => {
    expect(parseTui({ formats: { 'T.a': 'pct' } }).types.T?.currency).toBe('USD');
    expect(parseTui(undefined)).toEqual({ types: {}, problems: [] });
  });
  it('a malformed block is ignored whole, with a reason', () => {
    for (const bad of ['x', { currency: 7 }, { currency: 'NOPE!' }, { formats: [] }, { rows: 1 }]) {
      const p = parseTui(bad);
      expect(p.types).toEqual({});
      expect(p.problems.length).toBe(1);
    }
  });
  it('a malformed entry drops only its type, never throws', () => {
    const p = parseTui({
      formats: { 'Item.price': 3, 'Ok.n': 'int', nodot: 'int' },
      rows: { Bad: { tags: 'grade' }, Worse: null, Fine: { title: 'name', details: [{ x: 1 }] } }
    });
    expect(Object.keys(p.types).sort()).toEqual(['Ok']);
    expect(p.problems.join('\n')).toMatch(/Item\.price/);
    expect(p.problems.join('\n')).toMatch(/nodot/);
    expect(p.problems.join('\n')).toMatch(/Bad/);
    expect(p.problems.join('\n')).toMatch(/Worse/);
    expect(p.problems.join('\n')).toMatch(/Fine/);
  });
  it('an entry that crosses a reference is left out and noted', () => {
    const p = parseTui({ rows: { Item: { title: 'name', details: ['card.cardName', 'cost'] } } });
    expect(p.types.Item?.row?.details).toEqual([{ field: 'cost' }]);
    expect(p.problems.join('\n')).toMatch(/card\.cardName/);
  });
});

describe('formatValue', () => {
  it('formats money, int, number and pct', () => {
    expect(formatValue(1234.5, 'money', 'USD')).toBe('$1,234.50');
    expect(formatValue('84', 'money', 'USD')).toBe('$84.00');
    expect(formatValue(1234567.8, 'int', 'USD')).toBe('1,234,568');
    expect(formatValue(1234.5678, 'number', 'USD')).toBe('1,234.57');
    expect(formatValue(12.5, 'pct', 'USD')).toBe('12.5%');
  });
  it('formats dates and date-times in the local zone; a bare date stays put', () => {
    expect(formatValue('2026-03-04', 'date', 'USD')).toBe('2026-03-04');
    const d = new Date('2026-03-04T10:20:00Z');
    const p = (n: number) => String(n).padStart(2, '0');
    const day = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
    expect(formatValue('2026-03-04T10:20:00Z', 'date', 'USD')).toBe(day);
    expect(formatValue('2026-03-04T10:20:00Z', 'datetime', 'USD')).toBe(
      `${day} ${p(d.getHours())}:${p(d.getMinutes())}`
    );
  });
  it('an unknown format, no format or an unformattable value comes back raw', () => {
    expect(formatValue(2.71, 'weird', 'USD')).toBe('2.71');
    expect(formatValue(2.71, undefined, 'USD')).toBe('2.71');
    expect(formatValue('n/a', 'money', 'USD')).toBe('n/a');
    expect(formatValue('soon', 'date', 'USD')).toBe('soon');
    expect(formatValue(true, 'int', 'USD')).toBe('true');
  });
});

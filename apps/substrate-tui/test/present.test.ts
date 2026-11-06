import { describe, expect, it } from 'vitest';
import { formatValue, type Presentation, parseTui } from '../src/ask/present.js';

const txt = (p: Presentation) => p.problems.map((x) => x.text).join('\n');

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
    expect(txt(p)).toMatch(/Item\.price/);
    expect(txt(p)).toMatch(/nodot/);
    expect(txt(p)).toMatch(/Bad/);
    expect(txt(p)).toMatch(/Worse/);
    expect(txt(p)).toMatch(/Fine/);
  });
  it('an entry that crosses a reference is left out and noted', () => {
    const p = parseTui({ rows: { Item: { title: 'name', details: ['card.cardName', 'cost'] } } });
    expect(p.types.Item?.row?.details).toEqual([{ field: 'cost' }]);
    expect(txt(p)).toMatch(/card\.cardName/);
  });
  it('problems name the type they are about; block-wide ones name none', () => {
    const p = parseTui({ formats: { 'Item.price': 3, nodot: 'int' } });
    expect(p.problems.find((x) => /Item/.test(x.text))?.type).toBe('Item');
    expect(p.problems.find((x) => /nodot/.test(x.text))?.type).toBeUndefined();
    expect(parseTui('x').problems[0]?.type).toBeUndefined();
  });
  it('reserved and inherited keys never reach Object.prototype and never throw', () => {
    const raw = JSON.parse(
      '{"formats":{"constructor.x":"money","toString.x":"int","__proto__.x":"int","Item.constructor":"int","Item.price":"money"},' +
        '"rows":{"__proto__":{"title":"name"},"toString":{"title":"n"},"prototype":{},"Item":{"title":"__proto__","value":"price"}}}'
    );
    const p = parseTui(raw);
    expect(({} as { row?: unknown }).row).toBeUndefined();
    expect(Object.hasOwn(Object.prototype, 'row')).toBe(false);
    expect(typeof Object.prototype.toString).toBe('function');
    // An inherited name that is not reserved is an ordinary own type.
    expect(Object.keys(p.types).sort()).toEqual(['Item', 'toString']);
    expect(p.types['toString' as string]?.row?.title).toEqual({ field: 'n' });
    expect(p.types.constructor).toBeUndefined();
    expect(Object.keys(p.types.Item?.formats ?? {})).toEqual(['price']);
    expect(p.types.Item?.formats.toString).toBeUndefined();
    expect(p.types.Item?.row?.title).toBeUndefined();
    expect(txt(p)).toMatch(/__proto__/);
    expect(txt(p)).toMatch(/constructor/);
  });
});

describe('formatValue', () => {
  it('formats money, int, number and pct', () => {
    expect(formatValue(1234.5, 'money', 'USD')).toBe('$1,234.50');
    expect(formatValue('84', 'money', 'USD')).toBe('$84.00');
    expect(formatValue(1234567.8, 'int', 'USD')).toBe('1,234,568');
    expect(formatValue(1234.5678, 'number', 'USD')).toBe('1,234.57');
    expect(formatValue(12.5, 'pct', 'USD')).toBe('12.5%');
    expect(formatValue('-12.5', 'money', 'USD')).toBe('-$12.50');
  });
  it('money takes the currency own minor units', () => {
    expect(formatValue(1234.5, 'money', 'JPY')).toBe('¥1,235');
  });
  it('a value that rounds to zero shows no minus sign', () => {
    expect(formatValue(-0.001, 'pct', 'USD')).toBe('0%');
    expect(formatValue(-0.001, 'number', 'USD')).toBe('0');
  });
  it('only plain decimal strings are read as numbers', () => {
    expect(formatValue('0x10', 'money', 'USD')).toBe('0x10');
    expect(formatValue('1e3', 'int', 'USD')).toBe('1e3');
  });
  it('a date stored as a UTC-midnight instant keeps its calendar day', () => {
    expect(formatValue('2024-03-01T00:00:00.000Z', 'date', 'USD')).toBe('2024-03-01');
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
